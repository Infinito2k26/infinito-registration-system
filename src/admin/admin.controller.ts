import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { MANAGE_ROLES, Roles, StaffRequest } from '../auth/auth.types';
import { StaffGuard } from '../auth/staff.guard';
import { AppConfig } from '../config/app-config.service';
import { DriveService } from '../drive/drive.service';
import { QrEmailError, QrEmailService } from '../emails/qr-email.service';
import { PaymentActionError, PaymentsService } from '../payments/payments.service';
import { setFlash, takeFlash } from '../web/cookies';
import { page } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { AdminQueryService } from './admin-query.service';
import { entriesPage, registrationsPage, teamPage } from './admin.views';

const parsePage = (value: string | undefined) => Math.max(1, Math.min(10_000, Number.parseInt(value ?? '1', 10) || 1));
const parseStatus = (value: string | undefined) =>
  Object.values(PaymentStatus).includes(value as PaymentStatus) ? (value as PaymentStatus) : undefined;
const parseEvent = (value: string | undefined) =>
  value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : undefined;

/** Coordinator/admin dashboard. Volunteers are refused by @Roles. */
@Controller('admin')
@UseGuards(StaffGuard)
@Roles(...MANAGE_ROLES)
@UseFilters(WebExceptionFilter)
export class AdminController {
  constructor(
    private readonly queries: AdminQueryService,
    private readonly payments: PaymentsService,
    private readonly qrEmails: QrEmailService,
    private readonly auth: AuthService,
    private readonly drive: DriveService,
    private readonly config: AppConfig,
  ) {}

  private readonly eventName = (slug: string) => this.config.eventName(slug);

  @Get()
  home(@Res() res: Response) {
    res.redirect(303, '/admin/registrations');
  }

  @Get('registrations')
  async registrations(
    @Req() req: StaffRequest,
    @Res() res: Response,
    @Query('event') event?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') pageParam?: string,
  ) {
    const filters = {
      event: parseEvent(event),
      status: parseStatus(status),
      q: q?.trim().slice(0, 200) || undefined,
      page: parsePage(pageParam),
    };
    const [list, events] = await Promise.all([this.queries.listTeams(filters), this.queries.eventSummary()]);
    res.type('html').send(
      page({
        title: filters.event ? this.eventName(filters.event) : 'Registrations',
        section: 'registrations',
        staff: req.staff,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        flash: takeFlash(req, res),
        body: registrationsPage({ filters, list, events, eventName: this.eventName }),
      }),
    );
  }

  @Get('teams/:id')
  async team(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const detail = await this.queries.teamDetail(id);
    if (!detail || detail.team.registrations.length === 0) throw new NotFoundException('Registration not found');
    const qr = await this.qrEmails.summaries(detail.team.registrations.map((r) => r.id));
    const csrf = this.auth.csrfToken(req.staff!.sessionId);
    res.type('html').send(
      page({
        title: detail.team.name,
        section: 'registrations',
        staff: req.staff,
        csrf,
        flash: takeFlash(req, res),
        body: teamPage({
          detail,
          qr,
          csrf,
          eventName: this.eventName,
          driveEnabled: this.drive.enabled,
          delaySeconds: this.config.decisionEmailDelaySeconds,
        }),
      }),
    );
  }

  @Post('teams/:id/verify')
  async verify(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/teams/${id}`, () => this.payments.verifyTeam(id, req.staff!.id));
  }

  @Post('teams/:id/reject')
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    const remarks = typeof body.remarks === 'string' ? body.remarks.slice(0, 500) : '';
    await this.act(res, `/admin/teams/${id}`, () => this.payments.rejectTeam(id, req.staff!.id, remarks));
  }

  @Post('teams/:id/undo')
  async undo(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/teams/${id}`, () => this.payments.undoVerification(id, req.staff!.id));
  }

  @Post('registrations/:id/resend-qr')
  async resendQr(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const teamId = await this.queries.teamIdForRegistration(id);
    await this.act(res, teamId ? `/admin/teams/${teamId}` : '/admin/registrations', async () => {
      await this.qrEmails.resend(id, req.staff!.id);
      return { message: 'QR email queued; it goes out within a minute' };
    });
  }

  @Get('entries')
  async entries(
    @Req() req: StaffRequest,
    @Res() res: Response,
    @Query('event') event?: string,
    @Query('page') pageParam?: string,
  ) {
    const slug = parseEvent(event);
    const pageNo = parsePage(pageParam);
    const [list, events] = await Promise.all([this.queries.entries(slug, pageNo), this.queries.eventSummary()]);
    res.type('html').send(
      page({
        title: 'Entries',
        section: 'entries',
        staff: req.staff,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        flash: takeFlash(req, res),
        body: entriesPage({ event: slug, page: pageNo, list, events, eventName: this.eventName }),
      }),
    );
  }

  /** Runs a state change and reports the outcome on the next page (post/redirect/get). */
  private async act(res: Response, redirectTo: string, fn: () => Promise<{ message: string }>) {
    const secure = this.config.secureCookies;
    try {
      const { message } = await fn();
      setFlash(res, { type: 'ok', text: message }, secure);
    } catch (error) {
      if (!(error instanceof PaymentActionError || error instanceof QrEmailError)) throw error;
      setFlash(res, { type: 'error', text: error.message }, secure);
    }
    res.redirect(303, redirectTo);
  }
}
