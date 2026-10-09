import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { NoticeStatus, PaymentStatus, StaffRole } from '@prisma/client';
import { Response } from 'express';
import { buildQuery } from '../admin/admin.views';
import { AuthService } from '../auth/auth.service';
import { Roles, StaffRequest } from '../auth/auth.types';
import { StaffGuard } from '../auth/staff.guard';
import { AppConfig } from '../config/app-config.service';
import { providerLabel } from '../emails/email-provider.service';
import { EmailWorkerService } from '../emails/email-worker.service';
import { Flash, setFlash, takeFlash } from '../web/cookies';
import { SafeHtml } from '../web/html';
import { fmtExact, page } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { NOTICE_ADD_ALL_MAX, NoticeError, NoticeFilter, NoticesService, RECIPIENT_STATES, RecipientState, noticeDisplayStatus } from './notices.service';
import {
  NOTICE_TABS,
  NoticeTab,
  TAB_STATE,
  noticeDetailPage,
  noticeFormPage,
  noticeRecipientPage,
  noticeReportPage,
  noticeReviewPage,
  noticeTabs,
  noticesListPage,
} from './notices.views';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENTS: string[] = [PaymentStatus.VERIFIED, PaymentStatus.PENDING, PaymentStatus.REJECTED];
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const parsePage = (value: unknown) => Math.max(1, Math.min(10_000, Number.parseInt(typeof value === 'string' ? value : '1', 10) || 1));
const parseTab = (value: unknown): NoticeTab => (NOTICE_TABS.includes(value as NoticeTab) ? (value as NoticeTab) : 'not-selected');
const parseState = (value: unknown): RecipientState | undefined => {
  const v = typeof value === 'string' ? value.toUpperCase() : '';
  return RECIPIENT_STATES.includes(v as RecipientState) ? (v as RecipientState) : undefined;
};
/** Search/filter fields of the participant lists (query string or a form body). */
const parseFilter = (src: Record<string, unknown>): NoticeFilter => ({
  q: text(src.q, 100) || undefined,
  collegeId: typeof src.college === 'string' && UUID.test(src.college) ? src.college : undefined,
  event: typeof src.event === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(src.event) ? src.event : undefined,
  payment: typeof src.payment === 'string' && PAYMENTS.includes(src.payment) ? (src.payment as PaymentStatus) : undefined,
});
const filterQuery = (f: NoticeFilter) => ({ q: f.q, college: f.collegeId, event: f.event, payment: f.payment });
/** Ticked ids (one value or several), valid UUIDs only. */
const parseIds = (value: unknown) =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === 'string' && UUID.test(v)).slice(0, NOTICE_ADD_ALL_MAX);

/** CSV cell; a leading = + - @ is neutralised so spreadsheets never run it as a formula. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Admin → Notices. ADMIN only, on every route (class-level @Roles; coordinators and volunteers
 * get 403). All state is in the database: notices, their recipients and the EmailOutbox rows.
 */
@Controller('admin/notices')
@UseGuards(StaffGuard)
@Roles(StaffRole.ADMIN)
@UseFilters(WebExceptionFilter)
export class NoticesController {
  constructor(
    private readonly notices: NoticesService,
    private readonly worker: EmailWorkerService,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  private readonly eventName = (slug: string) => this.config.eventName(slug);

  private csrf(req: StaffRequest) {
    return this.auth.csrfToken(req.staff!.sessionId);
  }

  private render(req: StaffRequest, res: Response, title: string, body: SafeHtml) {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(page({ title, section: 'notices', scripts: ['/assets/admin.js'], staff: req.staff, csrf: this.csrf(req), flash: takeFlash(req, res), body }));
  }

  private back(res: Response, flash: Flash, to: string) {
    setFlash(res, flash, this.config.secureCookies);
    res.redirect(303, to);
  }

  /** Runs an action; a NoticeError becomes an error message on `to` instead of an error page. */
  private async act(res: Response, to: string, fn: () => Promise<Flash & { to?: string }>) {
    try {
      const { to: next, ...flash } = await fn();
      this.back(res, flash, next ?? to);
    } catch (error) {
      if (!(error instanceof NoticeError)) throw error;
      this.back(res, { type: 'error', text: error.message }, to);
    }
  }

  private async notice(id: string) {
    const notice = await this.notices.get(id);
    if (!notice) throw new NotFoundException('Notice not found');
    return notice;
  }

  @Get()
  async list(@Req() req: StaffRequest, @Res() res: Response) {
    this.render(req, res, 'Notices', noticesListPage({ notices: await this.notices.list() }));
  }

  // ---------- create / edit ----------

  @Get('new')
  newNotice(@Req() req: StaffRequest, @Res() res: Response) {
    this.render(req, res, 'Create notice', noticeFormPage({ values: { title: '', subject: '', body: '' }, errors: [], preview: false, csrf: this.csrf(req) }));
  }

  /** action = ready (Save notice) | draft (Save as draft) | preview (nothing saved) | test (save + test email to me). */
  @Post()
  async create(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const action = text(body.action, 10);
    const { input, errors } = this.notices.validate(body);
    if (action === 'preview' || errors.length) {
      res.status(action === 'preview' ? 200 : 422);
      return this.render(req, res, 'Create notice', noticeFormPage({ values: input, errors: action === 'preview' && input.subject && input.body ? [] : errors, preview: action === 'preview', csrf: this.csrf(req) }));
    }
    const id = await this.notices.create(input, action === 'ready' ? NoticeStatus.READY : NoticeStatus.DRAFT, req.staff!.id);
    const saved = action === 'ready' ? 'Notice saved' : 'Notice saved as draft';
    if (action === 'test') {
      const to = await this.notices.sendTest(id, req.staff!);
      return this.back(res, { type: 'ok', text: `${saved}. Test email queued to ${to}` }, `/admin/notices/${id}`);
    }
    this.back(res, { type: 'ok', text: `${saved}. Now choose its recipients.` }, `/admin/notices/${id}`);
  }

  @Get(':id/edit')
  async edit(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const notice = await this.notice(id);
    if (notice.lockedAt) return this.back(res, { type: 'error', text: 'This notice can no longer be edited: sending has started, so every recipient gets the same version' }, `/admin/notices/${id}`);
    this.render(req, res, 'Edit notice', noticeFormPage({ noticeId: id, values: notice, status: notice.status, errors: [], preview: false, csrf: this.csrf(req) }));
  }

  @Post(':id/edit')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const notice = await this.notice(id);
    const action = text(body.action, 10);
    const { input, errors } = this.notices.validate(body);
    if (action === 'preview' || errors.length) {
      res.status(action === 'preview' ? 200 : 422);
      return this.render(req, res, 'Edit notice', noticeFormPage({ noticeId: id, values: input, status: notice.status, errors: action === 'preview' && input.subject && input.body ? [] : errors, preview: action === 'preview', csrf: this.csrf(req) }));
    }
    const status = action === 'ready' ? NoticeStatus.READY : action === 'draft' ? NoticeStatus.DRAFT : notice.status;
    await this.act(res, `/admin/notices/${id}`, async () => {
      await this.notices.update(id, input, status, req.staff!.id);
      if (action === 'test') return { type: 'ok', text: `Notice saved. Test email queued to ${await this.notices.sendTest(id, req.staff!)}` };
      return { type: 'ok', text: status === NoticeStatus.READY ? 'Notice saved' : 'Notice saved as draft' };
    });
  }

  @Post(':id/test')
  async test(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/notices/${id}`, async () => ({ type: 'ok', text: `Test email queued to ${await this.notices.sendTest(id, req.staff!)} (only to you; it is not counted as a recipient)` }));
  }

  // ---------- detail ----------

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const notice = await this.notice(id);
    const tab = parseTab(query.tab);
    const pageNo = parsePage(query.page);
    const csrf = this.csrf(req);
    const [counts, notSelected, ineligible] = await Promise.all([this.notices.counts([id]).then((m) => m.get(id)!), this.notices.candidateCount(id, {}), this.notices.ineligibleCount()]);

    let content: SafeHtml;
    if (tab === 'not-selected' || tab === 'ineligible') {
      const filter = parseFilter(query);
      const options = await this.notices.filterOptions();
      if (tab === 'not-selected') {
        const { rows, total } = await this.notices.candidates(id, filter, pageNo);
        content = noticeTabs.notSelectedTab({ noticeId: id, rows, total, page: pageNo, filter, options, eventName: this.eventName, csrf });
      } else {
        const { rows, total } = await this.notices.ineligible(filter, pageNo);
        content = noticeTabs.ineligibleTab({ noticeId: id, rows, total, page: pageNo, filter, options, eventName: this.eventName });
      }
    } else if (tab === 'history') {
      content = noticeTabs.historyTab(await this.notices.history(id));
    } else {
      const q = text(query.q, 100);
      const { rows, total } = await this.notices.recipients(id, TAB_STATE[tab], q, pageNo);
      content = noticeTabs.recipientsTab({ noticeId: id, tab, rows, total, page: pageNo, q, csrf, canSend: notice.status === NoticeStatus.READY, awaiting: counts.awaiting });
    }
    this.render(
      req,
      res,
      notice.title,
      noticeDetailPage({ notice, counts, display: noticeDisplayStatus(notice, counts), notSelected, ineligible, tab, content, pausedUntil: this.worker.pausedUntilAt, provider: providerLabel(this.worker.provider), csrf }),
    );
  }

  // ---------- recipients ----------

  /** Adds the ticked participants (ids) or all=1 every participant matching the filter. Sends nothing. */
  @Post(':id/recipients')
  async addRecipients(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const filter = parseFilter(body);
    const to = `/admin/notices/${id}${buildQuery({ tab: 'not-selected', ...filterQuery(filter) })}`;
    await this.act(res, to, async () => {
      const ids = parseIds(body.ids);
      if (body.all !== '1' && ids.length === 0) throw new NoticeError('Tick at least one participant to add');
      const r = await this.notices.addRecipients(id, body.all === '1' ? { all: filter } : { personIds: ids }, req.staff!.id);
      const notes = [
        r.alreadySelected ? `${r.alreadySelected} already selected (same email or record) skipped` : '',
        r.ineligible ? `${r.ineligible} without a valid email skipped` : '',
        r.capped ? `only the first ${NOTICE_ADD_ALL_MAX} were added; repeat to add more` : '',
      ].filter(Boolean);
      return {
        type: r.added ? 'ok' : 'error',
        text: `Added ${r.added} recipient(s)${notes.length ? ` (${notes.join('; ')})` : ''}. Nothing is sent until you review and confirm.`,
      };
    });
  }

  @Post(':id/recipients/remove')
  async removeRecipients(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/notices/${id}?tab=selected`, async () => {
      const ids = parseIds(body.ids);
      if (ids.length === 0) throw new NoticeError('Tick at least one recipient to remove');
      const removed = await this.notices.removeRecipients(id, ids, req.staff!.id);
      return { type: 'ok', text: `Removed ${removed} recipient(s) (queued or sent recipients are kept)` };
    });
  }

  // ---------- sending ----------

  @Get(':id/send')
  async review(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    const notice = await this.notice(id);
    const reviewedAt = new Date();
    const [awaiting, counts] = await Promise.all([this.notices.awaiting(id), this.notices.counts([id]).then((m) => m.get(id)!)]);
    this.render(
      req,
      res,
      'Review and send',
      noticeReviewPage({ notice, awaiting, reviewedAt, alreadyQueued: counts.selected - counts.awaiting, provider: providerLabel(this.worker.provider), csrf: this.csrf(req) }),
    );
  }

  @Post(':id/send')
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/notices/${id}/send`, async () => {
      if (body.confirm !== 'yes') throw new NoticeError('Tick the confirmation to queue the emails');
      const reviewedAt = new Date(text(body.reviewedAt, 40));
      if (Number.isNaN(reviewedAt.getTime())) throw new NoticeError('Open the review page again and confirm from there');
      const queued = await this.notices.queue(id, reviewedAt, req.staff!.id);
      if (!queued) return { type: 'error', text: 'Nothing new to queue: every reviewed recipient was already queued', to: `/admin/notices/${id}?tab=pending` };
      return { type: 'ok', text: `Queued ${queued} email(s). The email queue sends them one by one; follow progress under Pending and Sent.`, to: `/admin/notices/${id}?tab=pending` };
    });
  }

  @Post(':id/retry')
  async retryAll(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    await this.act(res, `/admin/notices/${id}?tab=failed`, async () => {
      const retried = await this.notices.retryFailed(id, req.staff!.id);
      return retried ? { type: 'ok', text: `Retrying ${retried} failed delivery(ies)`, to: `/admin/notices/${id}?tab=pending` } : { type: 'error', text: 'No failed deliveries to retry' };
    });
  }

  @Post(':id/recipients/:recipientId/retry')
  async retryOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    await this.act(res, `/admin/notices/${id}?tab=failed`, async () => {
      const retried = await this.notices.retryFailed(id, req.staff!.id, recipientId);
      return retried ? { type: 'ok', text: 'Retry queued' } : { type: 'error', text: 'This recipient has no failed delivery to retry' };
    });
  }

  @Post(':id/resume')
  async resume(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    await this.notice(id);
    const { pending, pausedUntil } = await this.notices.resume(id, req.staff!.id);
    this.back(
      res,
      {
        type: 'ok',
        text: pausedUntil
          ? `${pending} pending email(s) stay queued: the provider paused sending until about ${fmtExact(pausedUntil)}; they resume automatically then`
          : `Sending resumed: ${pending} pending email(s) are being processed by the email queue`,
      },
      `/admin/notices/${id}?tab=pending`,
    );
  }

  // ---------- report ----------

  @Get(':id/report')
  async report(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const notice = await this.notice(id);
    const state = parseState(query.state);
    const q = text(query.q, 100);
    const pageNo = parsePage(query.page);
    const [counts, notSelected, ineligible, list] = await Promise.all([
      this.notices.counts([id]).then((m) => m.get(id)!),
      this.notices.candidateCount(id, {}),
      this.notices.ineligibleCount(),
      this.notices.recipients(id, state, q, pageNo),
    ]);
    this.render(req, res, 'Delivery report', noticeReportPage({ notice, counts, display: noticeDisplayStatus(notice, counts), notSelected, ineligible, rows: list.rows, total: list.total, page: pageNo, state, q }));
  }

  @Get(':id/report.csv')
  async reportCsv(@Param('id', ParseUUIDPipe) id: string, @Query() query: Record<string, unknown>, @Res() res: Response) {
    const notice = await this.notice(id);
    const rows = await this.notices.allRecipients(id, parseState(query.state), text(query.q, 100));
    const lines = [
      ['name', 'email', 'status', 'added_at', 'queued_at', 'sent_at', 'attempts', 'deliveries', 'provider_message_id', 'provider_delivery_report', 'last_error'],
      ...rows.map((r) => [r.name, r.email, r.state, r.addedAt, r.queuedAt, r.outbox?.sentAt, r.outbox?.attempts ?? 0, r._count.deliveries, r.outbox?.providerMessageId, r.outbox?.deliveryStatus, r.state === 'SENT' ? '' : r.outbox?.lastError]),
    ];
    res.set('Cache-Control', 'no-store');
    res.attachment(`notice-${notice.id.slice(0, 8)}-report.csv`);
    res.type('text/csv').send(lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n');
  }

  @Get(':id/recipients/:recipientId')
  async recipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    const notice = await this.notice(id);
    const recipient = await this.notices.recipient(id, recipientId);
    if (!recipient) throw new NotFoundException('Recipient not found');
    this.render(req, res, 'Notice recipient', noticeRecipientPage({ notice, recipient, csrf: this.csrf(req) }));
  }
}
