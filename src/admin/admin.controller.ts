import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { StaffRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { MANAGE_ROLES, Roles, StaffRequest } from '../auth/auth.types';
import { StaffGuard } from '../auth/staff.guard';
import { AppConfig } from '../config/app-config.service';
import { DriveService } from '../drive/drive.service';
import { CollegeEmailService } from '../emails/college-email.service';
import { QrEmailError, QrEmailService } from '../emails/qr-email.service';
import { checkInFlash, checkOutFlash } from '../entry/entry-messages';
import { EntryService } from '../entry/entry.service';
import { BULK_VERIFY_MAX, BulkVerificationService } from '../payments/bulk-verification.service';
import { PaymentActionError, PaymentsService } from '../payments/payments.service';
import { ParticipantActionError, ParticipantsService, changeEmailMessage } from '../registrations/participants.service';
import { Flash, setFlash, takeFlash } from '../web/cookies';
import { SafeHtml } from '../web/html';
import { NavSection, page } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { dateOnly } from '../forms/form-response.parser';
import { decryptAadhaar } from '../registrations/aadhaar-crypto';
import { ManualRegistrationError, ManualRegistrationService, sanitize } from '../registrations/manual-registration.service';
import { AadhaarDuplicatesService, AadhaarSearchError } from './aadhaar-duplicates.service';
import { AdminQueryService, ExpectedKind, REGISTRATION_VIEWS, RegistrationView } from './admin-query.service';
import {
  collegePage,
  collegesPage,
  entriesPage,
  expectedPage,
  participantPage,
  registrationsPage,
  teamPage,
  aadhaarDuplicatesPage,
  manualParticipantPage,
  verificationBatchPage,
  verificationReportPage,
} from './admin.views';

type Decision = 'verify' | 'reject' | 'undo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parsePage = (value: string | undefined) => Math.max(1, Math.min(10_000, Number.parseInt(value ?? '1', 10) || 1));
/** ?status=pending|verified|rejected|blocked|inside|outside|entered (any case); ?blocked=1 is kept as an alias. */
const parseView = (status: string | undefined, blocked: string | undefined): RegistrationView | undefined => {
  const value = status?.toUpperCase();
  if (REGISTRATION_VIEWS.includes(value as RegistrationView)) return value as RegistrationView;
  return blocked === '1' ? 'BLOCKED' : undefined;
};
const parseEvent = (value: unknown) =>
  typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : undefined;
const parseUuid = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : undefined);
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Today's / tomorrow's date at the fest (India), as YYYY-MM-DD. */
const festDay = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offsetDays * 86_400_000));

/** The instant a fest (India) day begins, from its DATE value (UTC midnight of that day). */
const festDayStart = (day: Date) => new Date(day.getTime() - 330 * 60_000);

/** "today" | "tomorrow" | "YYYY-MM-DD" -> a DATE-column value; anything else -> undefined. */
function parseDay(value: unknown): Date | undefined {
  if (value === 'today') return dateOnly(festDay());
  if (value === 'tomorrow') return dateOnly(festDay(1));
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = dateOnly(value);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? undefined : d;
}

/** Errors that are shown to the coordinator as a message instead of an error page. */
const USER_ERRORS = [PaymentActionError, QrEmailError, ParticipantActionError];

/** Coordinator/admin dashboard. Volunteers are refused by @Roles on every route. */
@Controller('admin')
@UseGuards(StaffGuard)
@Roles(...MANAGE_ROLES)
@UseFilters(WebExceptionFilter)
export class AdminController {
  constructor(
    private readonly queries: AdminQueryService,
    private readonly payments: PaymentsService,
    private readonly bulkVerification: BulkVerificationService,
    private readonly manualRegistrations: ManualRegistrationService,
    private readonly aadhaarDuplicates: AadhaarDuplicatesService,
    private readonly qrEmails: QrEmailService,
    private readonly collegeEmails: CollegeEmailService,
    private readonly participants: ParticipantsService,
    private readonly entry: EntryService,
    private readonly auth: AuthService,
    private readonly drive: DriveService,
    private readonly config: AppConfig,
  ) {}

  private readonly eventName = (slug: string) => this.config.eventName(slug);

  private readonly gateEventName = (slug: string) => this.config.eventName(slug);

  private render(
    req: StaffRequest,
    res: Response,
    title: string,
    section: NavSection,
    body: SafeHtml,
  ) {
    res.type('html').send(
      page({
        title,
        section,
        scripts: ['/assets/admin.js'],
        staff: req.staff,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        flash: takeFlash(req, res),
        body,
      }),
    );
  }

  @Get()
  home(@Res() res: Response) {
    res.redirect(303, '/admin/registrations');
  }

  // ---------- registrations ----------

  @Get('registrations')
  async registrations(
    @Req() req: StaffRequest,
    @Res() res: Response,
    @Query('event') event?: string,
    @Query('college') college?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') pageParam?: string,
    @Query('arrival') arrival?: string,
    @Query('departure') departure?: string,
    @Query('blocked') blocked?: string,
  ) {
    const filters = {
      event: parseEvent(event),
      college: parseUuid(college),
      arrival: parseDay(arrival),
      departure: parseDay(departure),
      view: parseView(status, blocked),
      q: q?.trim().slice(0, 200) || undefined,
      page: parsePage(pageParam),
    };
    const [list, events, collegeRow] = await Promise.all([
      this.queries.listRegistrations(filters),
      this.queries.eventSummary(),
      filters.college ? this.queries.collegeName(filters.college) : Promise.resolve(null),
    ]);
    this.render(
      req,
      res,
      filters.event ? this.eventName(filters.event) : 'Registrations',
      filters.view === 'INSIDE' || filters.view === 'OUTSIDE' || filters.view === 'ENTERED' || filters.view === 'BLOCKED'
        ? (filters.view.toLowerCase() as NavSection)
        : 'registrations',
      registrationsPage({
        filters,
        list,
        events,
        collegeName: collegeRow ?? undefined,
        eventName: this.eventName,
        // Bulk verify and Add Participant Manually: admins only (their routes check the role again).
        bulkVerifyCsrf: req.staff!.role === StaffRole.ADMIN ? this.auth.csrfToken(req.staff!.sessionId) : undefined,
        canAddManually: req.staff!.role === StaffRole.ADMIN,
      }),
    );
  }

  // ---------- add participant manually (ADMIN only; declared before registrations/:id) ----------

  @Get('registrations/new')
  @Roles(StaffRole.ADMIN)
  async newParticipant(@Req() req: StaffRequest, @Res() res: Response) {
    const events = await this.queries.eventSummary();
    this.render(req, res, 'Add participant', 'registrations', manualParticipantPage({ submissionId: randomUUID(), values: sanitize({}), errors: [], events, eventName: this.eventName, csrf: this.auth.csrfToken(req.staff!.sessionId) }));
  }

  /**
   * Creates the participant through the normal import (see ManualRegistrationService): PENDING,
   * then the usual Verify / Reject / QR flow. The submission ID makes a double submit harmless.
   */
  @Post('registrations/new')
  @Roles(StaffRole.ADMIN)
  async createParticipant(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const submissionId = typeof body.submissionId === 'string' && UUID.test(body.submissionId) ? body.submissionId : randomUUID();
    try {
      const { registrationIds, warnings } = await this.manualRegistrations.create(body, submissionId, req.staff!.id);
      const text = `Participant added (pending verification)${registrationIds.length > 1 ? `, ${registrationIds.length} events` : ''}${warnings.length ? `. Note: ${warnings.join('; ')}` : ''}`;
      this.flashAndBack(res, { type: 'ok', text }, `/admin/registrations/${registrationIds[0]}`);
    } catch (error) {
      if (!(error instanceof ManualRegistrationError)) throw error;
      const events = await this.queries.eventSummary();
      res.status(422);
      this.render(req, res, 'Add participant', 'registrations', manualParticipantPage({ submissionId, values: sanitize(body), errors: error.errors, events, eventName: this.eventName, csrf: this.auth.csrfToken(req.staff!.sessionId) }));
    }
  }

  @Get('registrations/:id')
  async participant(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const detail = await this.queries.participantDetail(id);
    if (!detail) throw new NotFoundException('Participant not found');
    const qr = (await this.qrEmails.summaries([id])).get(id);
    const isAdmin = req.staff!.role === StaffRole.ADMIN;
    // Role-filtered on the server: only an admin's page gets the decrypted number; for everyone
    // else the encrypted value is dropped before rendering and only the last 4 digits remain.
    const aadhaarFull = isAdmin ? decryptAadhaar(detail.reg.person.aadhaarEncrypted, this.config.aadhaarKey) : null;
    detail.reg.person.aadhaarEncrypted = null;
    this.render(
      req,
      res,
      detail.reg.person.name ?? 'Participant',
      'registrations',
      participantPage({
        detail,
        qr,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        isAdmin,
        aadhaarFull,
        eventName: this.eventName,
        driveEnabled: this.drive.enabled,
        delaySeconds: this.config.decisionEmailDelaySeconds,
      }),
    );
  }

  /** Blocks the participant's QR at the gate (all events). Coordinators and admins. */
  @Post('registrations/:id/block')
  async block(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const personId = await this.queries.personIdForRegistration(id);
    if (!personId) throw new NotFoundException('Participant not found');
    await this.act(res, `/admin/registrations/${id}`, async () => {
      await this.participants.block(personId, req.staff!.id, text(body.reason, 500));
      return { message: 'Participant blocked: the QR is refused at the gate until unblocked' };
    });
  }

  @Post('registrations/:id/unblock')
  async unblock(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const personId = await this.queries.personIdForRegistration(id);
    if (!personId) throw new NotFoundException('Participant not found');
    await this.act(res, `/admin/registrations/${id}`, async () => {
      await this.participants.unblock(personId, req.staff!.id);
      return { message: 'Participant unblocked: the QR works again (same pass)' };
    });
  }

  /** Admin-only: record that a BLOCKED participant who is inside has left. Logged as an override. */
  @Post('registrations/:id/check-out-override')
  @Roles(StaffRole.ADMIN)
  async checkOutOverride(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const outcome = await this.entry.checkOut({ registrationId: id, staffId: req.staff!.id, gate: 'Admin override', adminOverride: true });
    this.flashAndBack(res, checkOutFlash(outcome, this.gateEventName), `/admin/registrations/${id}`);
  }

  // Verify / reject / undo from the participant page apply to the participant's form response.
  @Post('registrations/:id/verify')
  verifyParticipant(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.participantDecision(id, 'verify', body, req, res);
  }

  @Post('registrations/:id/reject')
  rejectParticipant(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.participantDecision(id, 'reject', body, req, res);
  }

  @Post('registrations/:id/undo')
  undoParticipant(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.participantDecision(id, 'undo', body, req, res);
  }

  private async participantDecision(id: string, decision: Decision, body: Record<string, unknown>, req: StaffRequest, res: Response) {
    const teamId = await this.queries.teamIdForRegistration(id);
    if (!teamId) throw new NotFoundException('Participant not found');
    await this.decide(teamId, decision, body, req, res, `/admin/registrations/${id}`);
  }

  @Post('registrations/:id/change-email')
  async changeEmail(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    const personId = await this.queries.personIdForRegistration(id);
    if (!personId) throw new NotFoundException('Participant not found');
    await this.act(res, `/admin/registrations/${id}`, async () => {
      return { message: changeEmailMessage(await this.participants.changeEmail(personId, text(body.email, 320), req.staff!.id)) };
    });
  }

  @Post('registrations/:id/resend-qr')
  async resendQr(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const back = req.get('referer')?.includes(`/admin/registrations/${id}`) ? `/admin/registrations/${id}` : undefined;
    const teamId = await this.queries.teamIdForRegistration(id);
    await this.act(res, back ?? (teamId ? `/admin/teams/${teamId}` : `/admin/registrations/${id}`), async () => {
      const { toEmail } = await this.qrEmails.resend(id, req.staff!.id);
      return { message: `QR email queued to ${toEmail}; it goes out within a minute` };
    });
  }

  @Post('registrations/:id/check-in')
  async checkIn(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const outcome = await this.entry.checkIn({ registrationId: id, staffId: req.staff!.id, gate: text(body.gate, 60) });
    this.flashAndBack(res, checkInFlash(outcome, this.gateEventName), `/admin/registrations/${id}`);
  }

  @Post('registrations/:id/check-out')
  async checkOut(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const outcome = await this.entry.checkOut({ registrationId: id, staffId: req.staff!.id, gate: text(body.gate, 60) });
    this.flashAndBack(res, checkOutFlash(outcome, this.gateEventName), `/admin/registrations/${id}`);
  }

  // ---------- teams (multi-member responses) ----------

  @Get('teams/:id')
  async team(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const detail = await this.queries.teamDetail(id);
    if (!detail || detail.team.registrations.length === 0) throw new NotFoundException('Registration not found');
    const qr = await this.qrEmails.summaries(detail.team.registrations.map((r) => r.id));
    this.render(
      req,
      res,
      detail.team.name,
      'registrations',
      teamPage({
        detail,
        qr,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        eventName: this.eventName,
        driveEnabled: this.drive.enabled,
        delaySeconds: this.config.decisionEmailDelaySeconds,
      }),
    );
  }

  @Post('teams/:id/verify')
  verifyTeam(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.decide(id, 'verify', body, req, res, `/admin/teams/${id}`);
  }

  @Post('teams/:id/reject')
  rejectTeam(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.decide(id, 'reject', body, req, res, `/admin/teams/${id}`);
  }

  @Post('teams/:id/undo')
  undoTeam(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    return this.decide(id, 'undo', body, req, res, `/admin/teams/${id}`);
  }

  // ---------- colleges ----------

  @Get('colleges')
  async colleges(@Req() req: StaffRequest, @Res() res: Response, @Query('event') event?: string, @Query('q') q?: string) {
    const slug = parseEvent(event);
    const search = q?.trim().slice(0, 120) || undefined;
    const [colleges, events] = await Promise.all([
      this.queries.colleges({ event: slug, q: search }),
      this.queries.eventSummary(),
    ]);
    this.render(req, res, 'Colleges', 'colleges', collegesPage({ colleges, event: slug, q: search, events, eventName: this.eventName }));
  }

  @Get('colleges/:id')
  async college(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response, @Query('event') event?: string) {
    const slug = parseEvent(event);
    const detail = await this.queries.collegeParticipants(id, slug);
    if (!detail) throw new NotFoundException('College not found');
    const [counters, qr, batches] = await Promise.all([
      this.queries.counters({ event: slug, college: id }),
      this.qrEmails.summaries(detail.registrations.map((r) => r.id)),
      this.collegeEmails.batches(id),
    ]);
    this.render(
      req,
      res,
      detail.college.name,
      'colleges',
      collegePage({ detail, counters, qr, batches, event: slug, csrf: this.auth.csrfToken(req.staff!.sessionId), eventName: this.eventName }),
    );
  }

  /** Every verified student of the college: their own QR to their own email. */
  @Post('colleges/:id/send-each')
  async sendEach(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const event = parseEvent(body.event);
    await this.act(res, `/admin/colleges/${id}${event ? `?event=${event}` : ''}`, () =>
      this.collegeEmails.sendToEach(id, event, req.staff!.id),
    );
  }

  /** All verified students' passes, in one email, to one selected student of the same college. */
  @Post('colleges/:id/send-to-one')
  async sendToOne(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const event = parseEvent(body.event);
    const personId = parseUuid(body.personId);
    await this.act(res, `/admin/colleges/${id}${event ? `?event=${event}` : ''}`, async () => {
      if (!personId) throw new QrEmailError('Choose the student who should receive the passes');
      return this.collegeEmails.sendAllToOne(id, personId, event, req.staff!.id);
    });
  }

  // ---------- expected (planned) arrivals / departures ----------

  @Get('arrivals')
  arrivals(@Req() req: StaffRequest, @Res() res: Response, @Query() query: Record<string, string>) {
    return this.expected('arrival', req, res, query);
  }

  @Get('departures')
  departures(@Req() req: StaffRequest, @Res() res: Response, @Query() query: Record<string, string>) {
    return this.expected('departure', req, res, query);
  }

  private async expected(kind: ExpectedKind, req: StaffRequest, res: Response, query: Record<string, string>) {
    const day = parseDay(query.date) ?? dateOnly(festDay());
    const event = parseEvent(query.event);
    const college = parseUuid(query.college);
    const [list, events, colleges] = await Promise.all([
      this.queries.expected(kind, day, { event, college }),
      this.queries.eventSummary(),
      this.queries.collegeOptions(),
    ]);
    this.render(
      req,
      res,
      kind === 'arrival' ? 'Expected arrivals' : 'Expected departures',
      'expected',
      expectedPage({ kind, day, today: festDay(), tomorrow: festDay(1), list, event, college, events, colleges, eventName: this.eventName }),
    );
  }

  // ---------- bulk verification (ADMIN only) ----------

  /**
   * "Verify Selected" on the Pending list. Each selected registration goes through the normal
   * Verify (PaymentsService.verifyTeam via BulkVerificationService); the result opens as a report.
   */
  @Post('registrations/bulk-verify')
  @Roles(StaffRole.ADMIN)
  async bulkVerify(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const raw = Array.isArray(body.ids) ? body.ids : body.ids === undefined ? [] : [body.ids];
    const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string' && UUID.test(id)))];
    const back = typeof body.back === 'string' && body.back.startsWith('/admin/registrations') ? body.back : '/admin/registrations?status=pending';
    if (ids.length === 0) {
      this.flashAndBack(res, { type: 'error', text: 'No registrations selected' }, back);
      return;
    }
    if (ids.length > BULK_VERIFY_MAX) {
      this.flashAndBack(res, { type: 'error', text: `Select at most ${BULK_VERIFY_MAX} registrations at a time` }, back);
      return;
    }
    const r = await this.bulkVerification.verifySelected(ids, req.staff!.id);
    const text =
      `Bulk verify: ${r.selected} selected, ${r.verified} verified${r.teammates ? ` (incl. ${r.teammates} teammate(s))` : ''}, ` +
      `${r.skipped} skipped, ${r.failed} failed, ${r.qrEmailsQueued} QR email(s) queued, ${r.noEmail} without email`;
    this.flashAndBack(res, { type: r.failed ? 'error' : 'ok', text }, `/admin/verification-report/${r.batchId}`);
  }

  /** Bulk verification / QR email report. Default: today (fest time); ?from=&to= for a range. */
  @Get('verification-report')
  @Roles(StaffRole.ADMIN)
  async verificationReport(@Req() req: StaffRequest, @Res() res: Response, @Query('from') fromParam?: string, @Query('to') toParam?: string) {
    const from = parseDay(fromParam) ?? dateOnly(festDay());
    let to = parseDay(toParam) ?? from;
    if (to < from) to = from;
    const batches = await this.bulkVerification.batches(festDayStart(from), festDayStart(new Date(to.getTime() + 86_400_000)));
    this.render(req, res, 'Verification log', 'verifications', verificationReportPage({ from, to, batches }));
  }

  @Get('verification-report/:id')
  @Roles(StaffRole.ADMIN)
  async verificationBatch(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const batch = await this.bulkVerification.batch(id);
    if (!batch) throw new NotFoundException('Bulk verification not found');
    this.render(req, res, 'Bulk verification', 'verifications', verificationBatchPage({ batch, eventName: this.eventName }));
  }

  // ---------- Aadhaar duplicate check (ADMIN only) ----------

  /** Aadhaar numbers shared by more than one registration. Report only: nothing is changed. */
  @Get('aadhaar-duplicates')
  @Roles(StaffRole.ADMIN)
  async aadhaarDuplicateReport(@Req() req: StaffRequest, @Res() res: Response, @Query('people') people?: string) {
    res.set('Cache-Control', 'no-store');
    const onlyDifferentParticipants = people === '1';
    const report = await this.aadhaarDuplicates.duplicates(onlyDifferentParticipants);
    this.render(req, res, 'Aadhaar duplicates', 'aadhaar', aadhaarDuplicatesPage({ report, onlyDifferentParticipants, canCompare: this.aadhaarDuplicates.canCompare, csrf: this.auth.csrfToken(req.staff!.sessionId), eventName: this.eventName }));
  }

  /** Search by full number or last 4 digits. POST, so the number never appears in URLs or access logs. */
  @Post('aadhaar-duplicates/search')
  @HttpCode(200)
  @Roles(StaffRole.ADMIN)
  async aadhaarSearch(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    res.set('Cache-Control', 'no-store');
    const report = await this.aadhaarDuplicates.duplicates(false);
    let search: Awaited<ReturnType<AadhaarDuplicatesService['search']>> | undefined;
    let error: string | undefined;
    try {
      search = await this.aadhaarDuplicates.search(text(body.aadhaar, 40));
    } catch (e) {
      if (!(e instanceof AadhaarSearchError)) throw e;
      error = e.message;
    }
    this.render(req, res, 'Aadhaar duplicates', 'aadhaar', aadhaarDuplicatesPage({ report, onlyDifferentParticipants: false, canCompare: this.aadhaarDuplicates.canCompare, csrf: this.auth.csrfToken(req.staff!.sessionId), eventName: this.eventName, search, searchError: error }));
  }

  // ---------- gate log ----------

  @Get('entries')
  async entries(@Req() req: StaffRequest, @Res() res: Response, @Query('event') event?: string, @Query('page') pageParam?: string) {
    const slug = parseEvent(event);
    const pageNo = parsePage(pageParam);
    const [list, events, counters] = await Promise.all([
      this.queries.entries(slug, pageNo),
      this.queries.eventSummary(),
      this.queries.counters({ event: slug }),
    ]);
    this.render(req, res, 'Gate log', 'entries', entriesPage({ event: slug, page: pageNo, list, events, counters, eventName: this.eventName }));
  }

  // ---------- helpers ----------

  private async decide(
    teamId: string,
    decision: Decision,
    body: Record<string, unknown>,
    req: StaffRequest,
    res: Response,
    back: string,
  ) {
    const actor = req.staff!.id;
    await this.act(res, back, () => {
      if (decision === 'verify') return this.payments.verifyTeam(teamId, actor);
      if (decision === 'undo') return this.payments.undoVerification(teamId, actor);
      return this.payments.rejectTeam(teamId, actor, text(body.remarks, 500));
    });
  }

  private flashAndBack(res: Response, flash: Flash, back: string) {
    setFlash(res, flash, this.config.secureCookies);
    res.redirect(303, back);
  }

  /** Runs a state change and reports the outcome on the next page (post/redirect/get). */
  private async act(res: Response, redirectTo: string, fn: () => Promise<{ message: string }>) {
    try {
      const { message } = await fn();
      setFlash(res, { type: 'ok', text: message }, this.config.secureCookies);
    } catch (error) {
      if (!USER_ERRORS.some((E) => error instanceof E)) throw error;
      setFlash(res, { type: 'error', text: (error as Error).message }, this.config.secureCookies);
    }
    res.redirect(303, redirectTo);
  }
}
