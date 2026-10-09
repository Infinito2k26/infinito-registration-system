import { EmailDeliveryStatus, EmailStatus, NoticeStatus, PaymentStatus } from '@prisma/client';
import { buildQuery } from '../admin/admin.views';
import { noticeBodyHtml } from '../emails/email-templates';
import { SafeHtml, html, raw } from '../web/html';
import { BadgeTone, badge, csrfField, fmtExact } from '../web/layout';
import {
  NOTICE_ADD_ALL_MAX,
  NOTICE_LIMITS,
  NOTICE_PAGE_SIZE,
  NoticeCandidate,
  NoticeCounts,
  NoticeDisplayStatus,
  NoticeFilter,
  NoticesService,
  RecipientState,
} from './notices.service';

type NoticeList = Awaited<ReturnType<NoticesService['list']>>;
type Notice = NonNullable<Awaited<ReturnType<NoticesService['get']>>>;
type RecipientRows = Awaited<ReturnType<NoticesService['recipients']>>['rows'];
type RecipientDetail = NonNullable<Awaited<ReturnType<NoticesService['recipient']>>>;
type History = Awaited<ReturnType<NoticesService['history']>>;
type FilterOptions = Awaited<ReturnType<NoticesService['filterOptions']>>;
type EventName = (slug: string) => string;

export type NoticeTab = 'not-selected' | 'selected' | 'pending' | 'sent' | 'failed' | 'ineligible' | 'history';
export const NOTICE_TABS: NoticeTab[] = ['not-selected', 'selected', 'pending', 'sent', 'failed', 'ineligible', 'history'];
export const TAB_STATE: Partial<Record<NoticeTab, RecipientState>> = { selected: 'SELECTED', pending: 'PENDING', sent: 'SENT', failed: 'FAILED' };

const who = (u: { name: string | null; email: string } | null | undefined) => (u ? u.name || u.email : 'unknown');

const STATUS_TONE: Record<NoticeDisplayStatus, BadgeTone> = {
  Draft: 'muted',
  Ready: 'info',
  Sending: 'warn',
  'Partially sent': 'warn',
  Completed: 'ok',
  Failed: 'bad',
};
export const statusBadge = (s: NoticeDisplayStatus) => badge(s, STATUS_TONE[s]);

const STATE_BADGE: Record<RecipientState, [string, BadgeTone]> = {
  SELECTED: ['Selected, not queued', 'muted'],
  PENDING: ['Pending', 'warn'],
  SENT: ['Sent', 'ok'],
  FAILED: ['Failed', 'bad'],
};
const stateBadge = (s: RecipientState) => badge(...STATE_BADGE[s]);

/** What Resend reported after accepting the email (via its webhook); SMTP reports nothing. */
const providerReport = (d: EmailDeliveryStatus | null) => (d ? html`<span class="small">provider reported: ${d.toLowerCase()}</span>` : null);

function pager(path: string, params: Record<string, string | undefined>, page: number, total: number) {
  const pages = Math.max(1, Math.ceil(total / NOTICE_PAGE_SIZE));
  if (pages === 1) return null;
  return html`<nav class="pager">
    ${page > 1 ? html`<a href="${path}${buildQuery({ ...params, page: page - 1 })}">← Prev</a>` : null}
    <span>Page ${page} of ${pages}</span>
    ${page < pages ? html`<a href="${path}${buildQuery({ ...params, page: page + 1 })}">Next →</a>` : null}
  </nav>`;
}

const tile = (label: string, value: number | string, tone = '') =>
  html`<div class="counter ${tone}"><div class="label">${label}</div><div class="value">${value}</div></div>`;

/** The message exactly as recipients see it (same renderer as the email). */
export function messagePreview(subject: string, body: string) {
  return html`<section class="card">
    <h2>Email preview</h2>
    <p><b>Subject:</b> ${subject}</p>
    <div class="notice-preview">${raw(noticeBodyHtml(body))}</div>
  </section>`;
}

// ---------- list ----------

export function noticesListPage(args: { notices: NoticeList }): SafeHtml {
  const { notices } = args;
  return html`<div class="title-row"><h1>Notices</h1><a class="button primary" href="/admin/notices/new">Create notice</a></div>
    <p class="muted">Write and save a notice first, then choose its recipients and confirm sending. Each recipient gets a private email (one recipient per email) through the email queue and the active email provider. You can add more recipients to a notice at any time; nobody gets the same notice twice.</p>
    <div class="table-wrap">
    <table class="table rows-clickable">
      <thead><tr><th>Notice</th><th>Email subject</th><th>Created by</th><th>Created</th><th class="num">Selected</th><th class="num">Sent</th><th class="num">Pending</th><th class="num">Failed</th><th class="num">Not yet selected</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${notices.map(
          (n) => html`<tr data-href="/admin/notices/${n.id}">
            <td><a href="/admin/notices/${n.id}">${n.title}</a></td>
            <td class="small">${n.subject}</td>
            <td class="small">${who(n.createdBy)}</td>
            <td class="small">${fmtExact(n.createdAt)}</td>
            <td class="num">${n.counts.selected}</td>
            <td class="num">${n.counts.sent}</td>
            <td class="num">${n.counts.pending}</td>
            <td class="num">${n.counts.failed}</td>
            <td class="num">${n.notSelected}</td>
            <td>${statusBadge(n.display)}</td>
            <td class="small actions">
              ${n.lockedAt ? null : html`<a href="/admin/notices/${n.id}/edit">Edit</a>`}
              <a href="/admin/notices/${n.id}?tab=not-selected">Recipients</a>
              ${n.counts.awaiting && n.status === NoticeStatus.READY ? html`<a href="/admin/notices/${n.id}/send">Send (${n.counts.awaiting})</a>` : null}
              ${n.counts.failed ? html`<a href="/admin/notices/${n.id}?tab=failed">Retry failed</a>` : null}
              <a href="/admin/notices/${n.id}/report">Report</a>
            </td>
          </tr>`,
        )}
        ${notices.length === 0 ? html`<tr><td colspan="11" class="muted center">No notices yet. Create one to get started.</td></tr>` : null}
      </tbody>
    </table>
    </div>`;
}

// ---------- create / edit ----------

export function noticeFormPage(args: {
  noticeId?: string;
  values: { title: string; subject: string; body: string };
  status?: NoticeStatus;
  errors: string[];
  preview: boolean;
  csrf: string;
}): SafeHtml {
  const { values: v, noticeId } = args;
  const action = noticeId ? `/admin/notices/${noticeId}/edit` : '/admin/notices';
  return html`<p class="small"><a href="${noticeId ? `/admin/notices/${noticeId}` : '/admin/notices'}">← ${noticeId ? 'Back to the notice' : 'Notices'}</a></p>
    <h1>${noticeId ? 'Edit notice' : 'Create notice'}</h1>
    <p class="muted">Recipients are chosen after the notice is saved. Nothing is sent to participants until you confirm sending. The message is plain text: line breaks are kept and web links become clickable; HTML is shown as typed, never run. Every recipient gets exactly this subject and message.</p>
    ${args.errors.length ? html`<div class="warning"><b>Not saved:</b><ul>${args.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : null}
    ${args.preview && v.subject && v.body ? messagePreview(v.subject, v.body) : null}
    <section class="card">
      <form method="post" action="${action}" class="stack" data-notice-form>
        ${csrfField(args.csrf)}
        <label>Notice title (internal) <input name="title" value="${v.title}" required maxlength="${NOTICE_LIMITS.title}"></label>
        <label>Email subject <input name="subject" value="${v.subject}" required maxlength="${NOTICE_LIMITS.subject}"></label>
        <label>Email message <textarea name="body" rows="14" required maxlength="${NOTICE_LIMITS.body}">${v.body}</textarea></label>
        <div class="actions">
          <button name="action" value="ready" class="primary" data-submit-once>Save notice</button>
          <button name="action" value="draft" data-submit-once>Save as draft</button>
          <button name="action" value="preview" formnovalidate>Preview</button>
          <button name="action" value="test" data-submit-once>Save and send a test email to me</button>
        </div>
        <p class="muted small">Save notice = final, ready to send. Save as draft = keep working on it (it can be test-sent but not sent to participants). ${args.status ? html`Currently: <b>${args.status === NoticeStatus.DRAFT ? 'Draft' : 'Ready'}</b>.` : null}</p>
      </form>
    </section>`;
}

// ---------- detail ----------

function filterForm(args: { noticeId: string; tab: NoticeTab; filter: NoticeFilter; options: FilterOptions; eventName: EventName }) {
  const { filter: f, options } = args;
  const statuses: [PaymentStatus, string][] = [
    [PaymentStatus.VERIFIED, 'Verified'],
    [PaymentStatus.PENDING, 'Pending'],
    [PaymentStatus.REJECTED, 'Rejected'],
  ];
  return html`<form method="get" action="/admin/notices/${args.noticeId}" class="row-form search">
    <input type="hidden" name="tab" value="${args.tab}">
    <input type="search" name="q" value="${f.q ?? ''}" placeholder="Name, email, mobile, college, roll no." maxlength="100">
    <select name="college" aria-label="College"><option value="">All colleges</option>${options.colleges.map((c) => html`<option value="${c.id}" ${f.collegeId === c.id ? 'selected' : ''}>${c.name}</option>`)}</select>
    <select name="event" aria-label="Sport / event"><option value="">All events</option>${options.events.map((e) => html`<option value="${e}" ${f.event === e ? 'selected' : ''}>${args.eventName(e)}</option>`)}</select>
    <select name="payment" aria-label="Registration status"><option value="">Any registration status</option>${statuses.map(([s, label]) => html`<option value="${s}" ${f.payment === s ? 'selected' : ''}>${label}</option>`)}</select>
    <button>Filter</button>
    ${f.q || f.collegeId || f.event || f.payment ? html`<a href="/admin/notices/${args.noticeId}?tab=${args.tab}">Clear filters</a>` : null}
  </form>`;
}

const filterParams = (f: NoticeFilter) => ({ q: f.q || undefined, college: f.collegeId, event: f.event, payment: f.payment });

function personCells(p: NoticeCandidate, eventName: EventName) {
  return html`<td>${p.name ?? html`<span class="muted">no name</span>`}${p.blockedAt ? html` ${badge('Blocked', 'bad')}` : null}</td>
    <td class="small">${p.email ?? html`<span class="muted">none</span>`}${p.emailBouncedAt ? html` ${badge('bounced before', 'warn')}` : null}</td>
    <td class="small">${p.phone ?? ''}</td>
    <td class="small">${p.college ?? ''}</td>
    <td class="small">${p.events.map(eventName).join(', ')}</td>`;
}

function notSelectedTab(args: {
  noticeId: string;
  rows: NoticeCandidate[];
  total: number;
  page: number;
  filter: NoticeFilter;
  options: FilterOptions;
  eventName: EventName;
  csrf: string;
}) {
  const { noticeId, rows, filter } = args;
  const params = { tab: 'not-selected', ...filterParams(filter) };
  return html`<h2>Not yet selected (${args.total}${filter.q || filter.collegeId || filter.event || filter.payment ? ' matching' : ''})</h2>
    <p class="muted small">Participants with a valid email who are not recipients of this notice yet (read from the database on every visit). Tick participants on as many pages as you like (ticks are kept while you change pages or filters), then add them. Adding never sends anything: you review and confirm sending afterwards. One email per address: someone whose address is already a recipient is skipped.</p>
    ${filterForm({ noticeId, tab: 'not-selected', filter, options: args.options, eventName: args.eventName })}
    <form method="post" action="/admin/notices/${noticeId}/recipients" id="notice-add" data-notice-select="${noticeId}">
      ${csrfField(args.csrf)}
      ${Object.entries(filterParams(filter)).map(([k, v]) => (v ? html`<input type="hidden" name="${k}" value="${v}">` : null))}
      <div class="row-form">
        <span data-notice-count class="small">0 selected</span>
        <button class="primary" data-notice-submit>Add selected recipients</button>
        <button type="button" data-notice-clear>Clear selection</button>
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th><input type="checkbox" data-notice-all aria-label="Select all on this page"></th><th>Name</th><th>Email</th><th>Mobile</th><th>College</th><th>Events</th></tr></thead>
        <tbody>
          ${rows.map((p) => html`<tr><td><input type="checkbox" name="ids" value="${p.id}" data-notice-row aria-label="Select ${p.name ?? p.email ?? ''}"></td>${personCells(p, args.eventName)}</tr>`)}
          ${rows.length === 0 ? html`<tr><td colspan="6" class="muted center">Everyone eligible${filter.q || filter.collegeId || filter.event || filter.payment ? ' matching these filters' : ''} is already a recipient.</td></tr>` : null}
        </tbody>
      </table></div>
    </form>
    ${pager(`/admin/notices/${noticeId}`, params, args.page, args.total)}
    ${
      args.total > 0
        ? html`<form method="post" action="/admin/notices/${noticeId}/recipients" class="row-form" data-confirm="Add all ${Math.min(args.total, NOTICE_ADD_ALL_MAX)} matching participants as recipients? Nothing is sent yet.">
            ${csrfField(args.csrf)}
            <input type="hidden" name="all" value="1">
            ${Object.entries(filterParams(filter)).map(([k, v]) => (v ? html`<input type="hidden" name="${k}" value="${v}">` : null))}
            <button>Add all ${Math.min(args.total, NOTICE_ADD_ALL_MAX)} matching${args.total > NOTICE_ADD_ALL_MAX ? ` (first ${NOTICE_ADD_ALL_MAX}; repeat for more)` : ''}</button>
          </form>`
        : null
    }`;
}

function recipientLink(noticeId: string, r: { id: string; name: string | null; email: string }) {
  return html`<a href="/admin/notices/${noticeId}/recipients/${r.id}">${r.name ?? r.email}</a>`;
}

function pendingState(o: NonNullable<RecipientRows[number]['outbox']>) {
  if (o.status === EmailStatus.PROCESSING) return 'Sending now';
  if (o.lastError) return o.sendAt > new Date() ? 'Waiting to retry' : 'Queued (paused or retrying)';
  return 'Queued';
}

function recipientsTab(args: { noticeId: string; tab: NoticeTab; rows: RecipientRows; total: number; page: number; q: string; csrf: string; canSend: boolean; awaiting: number }) {
  const { noticeId, tab, rows } = args;
  const state = TAB_STATE[tab]!;
  const empty = { SELECTED: 'No one is waiting to be queued.', PENDING: 'Nothing is pending.', SENT: 'Nothing sent yet.', FAILED: 'No failed deliveries.' }[state];
  const search = html`<form method="get" action="/admin/notices/${noticeId}" class="row-form search">
    <input type="hidden" name="tab" value="${tab}">
    <input type="search" name="q" value="${args.q}" placeholder="Name or email" maxlength="100"><button>Search</button>
    ${args.q ? html`<a href="/admin/notices/${noticeId}?tab=${tab}">Clear</a>` : null}
  </form>`;
  const pages = pager(`/admin/notices/${noticeId}`, { tab, q: args.q || undefined }, args.page, args.total);
  const table = (head: SafeHtml, cols: number, row: (r: RecipientRows[number]) => SafeHtml) => html`<div class="table-wrap"><table class="table">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows.map(row)}${rows.length === 0 ? html`<tr><td colspan="${cols}" class="muted center">${empty}</td></tr>` : null}</tbody>
    </table></div>`;

  switch (state) {
    case 'SELECTED':
      return html`<h2>Selected, awaiting confirmation (${args.total})</h2>
        <p class="muted small">Recipients you added that have not been queued yet. Nothing has been sent to them. ${args.canSend ? html`<a href="/admin/notices/${noticeId}/send">Review and send (${args.awaiting})</a>` : html`<b>Save the notice as ready (Edit → Save notice) to send it.</b>`}</p>
        ${search}
        <form method="post" action="/admin/notices/${noticeId}/recipients/remove" data-confirm="Remove the ticked recipients from this notice? (They were never sent anything.)">
          ${csrfField(args.csrf)}
          ${table(
            html`<th></th><th>Name</th><th>Email</th><th>Added</th>`,
            4,
            (r) => html`<tr><td><input type="checkbox" name="ids" value="${r.id}" aria-label="Select ${r.email}"></td><td>${recipientLink(noticeId, r)}</td><td class="small">${r.email}</td><td class="small">${fmtExact(r.addedAt)}</td></tr>`,
          )}
          ${rows.length ? html`<button>Remove ticked recipients</button>` : null}
        </form>${pages}`;
    case 'PENDING':
      return html`<h2>Pending / queued (${args.total})</h2>
        <p class="muted small">Queued in the email queue, not sent yet: waiting for the worker, for a retry after an error, or for a provider quota/rate-limit pause to end. They are sent automatically; nothing here has been sent.</p>
        ${search}
        ${table(
          html`<th>Name</th><th>Email</th><th>Queued</th><th>State</th><th class="num">Failed tries</th><th>Next try</th><th>Last error / pause reason</th>`,
          7,
          (r) => html`<tr><td>${recipientLink(noticeId, r)}</td><td class="small">${r.email}</td><td class="small">${fmtExact(r.queuedAt)}</td>
            <td>${badge(pendingState(r.outbox!), 'warn')}</td><td class="num">${r.outbox!.lastError ? r.outbox!.attempts : 0}</td>
            <td class="small">${r.outbox!.sendAt > new Date() ? fmtExact(r.outbox!.sendAt) : 'as soon as the queue allows'}</td>
            <td class="small">${r.outbox!.lastError ? html`<span class="error-text">${r.outbox!.lastError}</span>` : ''}</td></tr>`,
        )}${pages}`;
    case 'SENT':
      return html`<h2>Sent (${args.total})</h2>
        <p class="muted small">Accepted by the email provider. This is not proof that the email was delivered, opened or read; Resend's delivery reports are shown when available.</p>
        ${search}
        ${table(
          html`<th>Name</th><th>Email</th><th>Sent</th><th>Provider message ID</th><th class="num">Attempts</th><th>Delivery report</th>`,
          6,
          (r) => html`<tr><td>${recipientLink(noticeId, r)}</td><td class="small">${r.email}</td><td class="small">${fmtExact(r.outbox!.sentAt)}</td>
            <td class="small mono">${r.outbox!.providerMessageId ?? html`<span class="muted">not given</span>`}</td>
            <td class="num">${r.outbox!.attempts}${r._count.deliveries > 1 ? html`<br><span class="muted small">${r._count.deliveries} deliveries</span>` : null}</td>
            <td>${providerReport(r.outbox!.deliveryStatus)}</td></tr>`,
        )}${pages}`;
    case 'FAILED':
      return html`<h2>Failed (${args.total})</h2>
        <p class="muted small">Failed permanently or out of retries. Retry adds a new attempt for the same recipient; sent recipients are never sent again.</p>
        ${
          args.total
            ? html`<form method="post" action="/admin/notices/${noticeId}/retry" class="row-form" data-confirm="Retry all ${args.total} failed deliveries of this notice?">${csrfField(args.csrf)}<button class="primary" data-submit-once>Retry all failed (${args.total})</button></form>`
            : null
        }
        ${search}
        ${table(
          html`<th>Name</th><th>Email</th><th>Failure reason</th><th class="num">Attempts</th><th>Last attempt</th><th></th>`,
          6,
          (r) => html`<tr><td>${recipientLink(noticeId, r)}</td><td class="small">${r.email}</td>
            <td class="small"><span class="error-text">${r.outbox!.lastError ?? (r.outbox!.status === EmailStatus.CANCELLED ? 'cancelled' : 'unknown')}</span></td>
            <td class="num">${r.outbox!.attempts}${r._count.deliveries > 1 ? html`<br><span class="muted small">${r._count.deliveries} deliveries</span>` : null}</td>
            <td class="small">${fmtExact(r.outbox!.updatedAt)}</td>
            <td><form method="post" action="/admin/notices/${noticeId}/recipients/${r.id}/retry" class="inline">${csrfField(args.csrf)}<button data-submit-once>Retry</button></form></td></tr>`,
        )}${pages}`;
  }
}

function ineligibleTab(args: { noticeId: string; rows: NoticeCandidate[]; total: number; page: number; filter: NoticeFilter; options: FilterOptions; eventName: EventName }) {
  return html`<h2>Ineligible (${args.total})</h2>
    <p class="muted small">Participants without a usable email address. They cannot be selected and are not counted as sent, pending or failed. Add or fix their email on their participant page (Change email) and they appear under Not yet selected.</p>
    ${filterForm({ noticeId: args.noticeId, tab: 'ineligible', filter: args.filter, options: args.options, eventName: args.eventName })}
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Mobile</th><th>College</th><th>Events</th><th>Reason</th></tr></thead>
      <tbody>
        ${args.rows.map((p) => html`<tr>${personCells(p, args.eventName)}<td class="small">${p.email ? 'Invalid email address' : 'No email address'}</td></tr>`)}
        ${args.rows.length === 0 ? html`<tr><td colspan="6" class="muted center">No one.</td></tr>` : null}
      </tbody>
    </table></div>
    ${pager(`/admin/notices/${args.noticeId}`, { tab: 'ineligible', ...filterParams(args.filter) }, args.page, args.total)}`;
}

const EVENT_TEXT: Record<string, string> = {
  CREATED: 'Created the notice',
  EDITED: 'Edited the notice',
  RECIPIENTS_ADDED: 'Added recipients',
  RECIPIENTS_REMOVED: 'Removed recipients',
  QUEUED: 'Confirmed sending (queued)',
  RETRIED: 'Retried failed deliveries',
  RESUMED: 'Resumed sending',
  TEST_SENT: 'Sent a test email',
};

function historyText(e: History[number]): string {
  const d = (e.details ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'CREATED':
    case 'EDITED':
      return `${Array.isArray(d.changed) && d.changed.length ? `changed ${d.changed.join(', ')}; ` : ''}saved as ${d.status === NoticeStatus.DRAFT ? 'draft' : 'ready'}`;
    case 'RECIPIENTS_ADDED':
      return `${String(d.added)} added${Number(d.alreadySelected) ? `, ${String(d.alreadySelected)} already selected` : ''}${Number(d.ineligible) ? `, ${String(d.ineligible)} without a valid email` : ''}${d.allMatching ? ' (all matching)' : ''}`;
    case 'RECIPIENTS_REMOVED':
      return `${String(d.removed)} removed`;
    case 'QUEUED':
      return `${String(d.queued)} email(s) queued`;
    case 'RETRIED':
      return `${String(d.retried)} retried${d.recipient ? ` (${String(d.recipient)})` : ''}`;
    case 'RESUMED':
      return `${String(d.pending)} pending`;
    case 'TEST_SENT':
      return `to ${String(d.to)}`;
    default:
      return '';
  }
}

function historyTab(history: History) {
  return html`<h2>History</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>When</th><th>By</th><th>Action</th><th>Details</th></tr></thead>
      <tbody>${history.map((e) => html`<tr><td class="small">${fmtExact(e.createdAt)}</td><td class="small">${who(e.actor)}</td><td>${EVENT_TEXT[e.type] ?? e.type}</td><td class="small">${historyText(e)}</td></tr>`)}</tbody>
    </table></div>`;
}

export function noticeDetailPage(args: {
  notice: Notice;
  counts: NoticeCounts;
  display: NoticeDisplayStatus;
  notSelected: number;
  ineligible: number;
  tab: NoticeTab;
  content: SafeHtml;
  pausedUntil: Date | null;
  provider: string;
  csrf: string;
}): SafeHtml {
  const { notice: n, counts: c } = args;
  const canSend = n.status === NoticeStatus.READY;
  const tabLink = (tab: NoticeTab, label: string, value: number | string, tone = '') => {
    const active = args.tab === tab;
    return html`<a class="counter ${tone} ${active ? 'active' : ''}" href="/admin/notices/${n.id}?tab=${tab}" ${active ? html`aria-current="true"` : null}><div class="label">${label}</div><div class="value">${value}</div></a>`;
  };
  return html`<p class="small"><a href="/admin/notices">← Notices</a></p>
    <div class="title-row"><h1>${n.title}</h1>${statusBadge(args.display)}</div>
    <p class="muted">Created ${fmtExact(n.createdAt)} by ${who(n.createdBy)}${n.lockedAt ? html` · sending started ${fmtExact(n.lockedAt)}: the subject and message are locked, so every recipient gets the same version` : null}</p>
    ${n.status === NoticeStatus.DRAFT ? html`<div class="warning">This notice is a <b>draft</b>: you can select recipients and send yourself a test, but it cannot be sent to participants until you choose <b>Save notice</b> (Edit).</div>` : null}
    ${args.pausedUntil && c.pending ? html`<div class="warning">Email sending is paused by the provider (quota or rate limit) until about ${fmtExact(args.pausedUntil)}. Pending emails stay queued and resume automatically.</div>` : null}
    <div class="actions">
      ${n.lockedAt ? null : html`<a class="button" href="/admin/notices/${n.id}/edit">Edit notice</a>`}
      ${canSend && c.awaiting ? html`<a class="button primary" href="/admin/notices/${n.id}/send">Review and send (${c.awaiting})</a>` : null}
      <form method="post" action="/admin/notices/${n.id}/test" class="inline">${csrfField(args.csrf)}<button data-submit-once>Send a test email to me</button></form>
      ${c.pending ? html`<form method="post" action="/admin/notices/${n.id}/resume" class="inline">${csrfField(args.csrf)}<button data-submit-once>Resume sending (${c.pending} pending)</button></form>` : null}
      ${c.failed ? html`<form method="post" action="/admin/notices/${n.id}/retry" class="inline" data-confirm="Retry all ${c.failed} failed deliveries?">${csrfField(args.csrf)}<button data-submit-once>Retry failed (${c.failed})</button></form>` : null}
      <a class="button" href="/admin/notices/${n.id}/report">Delivery report</a>
    </div>
    <p class="muted small">Emails go through the email queue with the active provider (now: ${args.provider}), one private email per recipient.</p>
    ${messagePreview(n.subject, n.body)}
    <div class="counters">
      ${tabLink('not-selected', 'Not yet selected', args.notSelected, 'info')}
      ${tabLink('selected', 'Selected, not queued', c.awaiting)}
      ${tabLink('pending', 'Pending / queued', c.pending, 'warn')}
      ${tabLink('sent', 'Sent', c.sent, 'ok')}
      ${tabLink('failed', 'Failed', c.failed, c.failed ? 'bad' : '')}
      ${tabLink('ineligible', 'Ineligible', args.ineligible)}
      ${tabLink('history', 'History', '…')}
    </div>
    ${args.content}`;
}

export const noticeTabs = { notSelectedTab, recipientsTab, ineligibleTab, historyTab };

// ---------- review & confirm ----------

export function noticeReviewPage(args: {
  notice: Notice;
  awaiting: { id: string; name: string | null; email: string; addedAt: Date }[];
  reviewedAt: Date;
  alreadyQueued: number;
  provider: string;
  csrf: string;
}): SafeHtml {
  const { notice: n, awaiting } = args;
  const shown = awaiting.slice(0, 2000);
  return html`<p class="small"><a href="/admin/notices/${n.id}">← Back to the notice</a></p>
    <h1>Review and send</h1>
    ${
      n.status === NoticeStatus.DRAFT
        ? html`<div class="warning">This notice is a draft. <a href="/admin/notices/${n.id}/edit">Edit it</a> and choose <b>Save notice</b> before sending.</div>`
        : null
    }
    <p>You are about to queue <b>${awaiting.length}</b> private email(s) for <b>${n.title}</b>, one per recipient (no recipient sees any other address), through the email queue with the active provider (${args.provider}).
      ${args.alreadyQueued ? html`The ${args.alreadyQueued} recipient(s) already queued, sent or failed are not included and get nothing again.` : null}
      Once you confirm, the subject and message can no longer be changed.</p>
    ${messagePreview(n.subject, n.body)}
    <section class="card">
      <h2>Recipients to queue (${awaiting.length})</h2>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Name</th><th>Email</th></tr></thead>
        <tbody>
          ${shown.map((r, i) => html`<tr><td class="num">${i + 1}</td><td>${r.name ?? ''}</td><td class="small">${r.email}</td></tr>`)}
          ${awaiting.length === 0 ? html`<tr><td colspan="3" class="muted center">No selected recipients are waiting. Add some under Not yet selected.</td></tr>` : null}
        </tbody>
      </table></div>
      ${awaiting.length > shown.length ? html`<p class="muted small">…and ${awaiting.length - shown.length} more.</p>` : null}
    </section>
    ${
      awaiting.length && n.status === NoticeStatus.READY
        ? html`<form method="post" action="/admin/notices/${n.id}/send" class="stack" data-confirm="Queue ${awaiting.length} email(s) now?">
            ${csrfField(args.csrf)}
            <input type="hidden" name="reviewedAt" value="${args.reviewedAt.toISOString()}">
            <label><input type="checkbox" name="confirm" value="yes" required> I have checked the message and the ${awaiting.length} recipient(s) above.</label>
            <button class="primary big" data-submit-once>Confirm and queue ${awaiting.length} email(s)</button>
          </form>`
        : null
    }`;
}

// ---------- report ----------

export function noticeReportPage(args: {
  notice: Notice;
  counts: NoticeCounts;
  display: NoticeDisplayStatus;
  notSelected: number;
  ineligible: number;
  rows: RecipientRows;
  total: number;
  page: number;
  state: RecipientState | undefined;
  q: string;
}): SafeHtml {
  const { notice: n, counts: c } = args;
  const queued = c.pending + c.sent + c.failed;
  const pct = c.selected ? `${Math.round((c.sent / c.selected) * 1000) / 10}%` : '0%';
  const params = { state: args.state?.toLowerCase(), q: args.q || undefined };
  const chip = (state: RecipientState | undefined, label: string) =>
    html`<a class="chip ${args.state === state ? 'active' : ''}" href="/admin/notices/${n.id}/report${buildQuery({ state: state?.toLowerCase(), q: args.q || undefined })}">${label}</a>`;
  return html`<p class="small"><a href="/admin/notices/${n.id}">← Back to the notice</a></p>
    <div class="title-row"><h1>Delivery report: ${n.title}</h1>${statusBadge(args.display)}</div>
    <p class="muted">Created ${fmtExact(n.createdAt)} by ${who(n.createdBy)}${c.firstSentAt ? html` · first sent ${fmtExact(c.firstSentAt)} · last sent ${fmtExact(c.lastSentAt)}` : null}. Read live from the email queue; "Sent" means accepted by the provider, not opened or read.</p>
    <div class="counters">
      ${tile('Selected', c.selected)}
      ${tile('Unique emails', c.selected)}
      ${tile('Queued so far', queued, 'info')}
      ${tile('Sent', c.sent, 'ok')}
      ${tile('Pending', c.pending, 'warn')}
      ${tile('Failed', c.failed, c.failed ? 'bad' : '')}
      ${tile('Selected, not queued', c.awaiting)}
      ${tile('Not yet selected', args.notSelected)}
      ${tile('Ineligible', args.ineligible)}
      ${tile('Sent %', pct, 'ok')}
    </div>
    <div class="chips">
      ${chip(undefined, 'All')}${chip('SENT', 'Sent')}${chip('PENDING', 'Pending')}${chip('FAILED', 'Failed')}${chip('SELECTED', 'Selected, not queued')}
    </div>
    <form method="get" action="/admin/notices/${n.id}/report" class="row-form search">
      ${args.state ? html`<input type="hidden" name="state" value="${args.state.toLowerCase()}">` : null}
      <input type="search" name="q" value="${args.q}" placeholder="Name or email" maxlength="100"><button>Search</button>
      <a href="/admin/notices/${n.id}/report.csv${buildQuery(params)}">Download CSV</a>
    </form>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Added</th><th>Queued</th><th>Sent</th><th class="num">Attempts</th><th>Provider message ID</th><th>Error</th></tr></thead>
      <tbody>
        ${args.rows.map(
          (r) => html`<tr><td><a href="/admin/notices/${n.id}/recipients/${r.id}">${r.name ?? r.email}</a></td><td class="small">${r.email}</td><td>${stateBadge(r.state)}</td>
            <td class="small">${fmtExact(r.addedAt)}</td><td class="small">${fmtExact(r.queuedAt)}</td><td class="small">${fmtExact(r.outbox?.sentAt)}</td>
            <td class="num">${r.outbox?.attempts ?? 0}</td><td class="small mono">${r.outbox?.providerMessageId ?? ''}</td>
            <td class="small">${r.outbox?.lastError && r.state !== 'SENT' ? html`<span class="error-text">${r.outbox.lastError}</span>` : ''}</td></tr>`,
        )}
        ${args.rows.length === 0 ? html`<tr><td colspan="9" class="muted center">No recipients.</td></tr>` : null}
      </tbody>
    </table></div>
    ${pager(`/admin/notices/${n.id}/report`, params, args.page, args.total)}`;
}

export function noticeRecipientPage(args: { notice: Notice; recipient: RecipientDetail; csrf: string }): SafeHtml {
  const { notice: n, recipient: r } = args;
  return html`<p class="small"><a href="/admin/notices/${n.id}/report">← Delivery report</a></p>
    <div class="title-row"><h1>${r.name ?? r.email}</h1>${stateBadge(r.state)}</div>
    <dl class="facts">
      <dt>Notice</dt><dd><a href="/admin/notices/${n.id}">${n.title}</a></dd>
      <dt>Recipient email</dt><dd>${r.email} <span class="muted small">(address at selection time)</span></dd>
      <dt>Participant</dt><dd>${r.person?.registrations[0] ? html`<a href="/admin/registrations/${r.person.registrations[0].id}">open participant</a>` : html`<span class="muted">${r.personId ? 'no registrations' : 'record no longer exists'}</span>`}</dd>
      <dt>Added</dt><dd>${fmtExact(r.addedAt)}</dd>
      <dt>Queued</dt><dd>${r.queuedAt ? fmtExact(r.queuedAt) : html`<span class="muted">not queued yet</span>`}</dd>
    </dl>
    ${
      r.state === 'FAILED'
        ? html`<form method="post" action="/admin/notices/${n.id}/recipients/${r.id}/retry" class="inline">${csrfField(args.csrf)}<button class="primary" data-submit-once>Retry this recipient</button></form>`
        : null
    }
    <h2>Delivery attempts</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>#</th><th>Status</th><th>Queued</th><th>By</th><th class="num">Tries</th><th>Last update</th><th>Sent</th><th>Provider message ID</th><th>Delivery report</th><th>Error</th></tr></thead>
      <tbody>
        ${r.deliveries.map(
          (d, i) => html`<tr><td class="num">${i + 1}</td><td>${badge(d.status.toLowerCase(), d.status === EmailStatus.SENT ? 'ok' : d.status === EmailStatus.FAILED ? 'bad' : d.status === EmailStatus.CANCELLED ? 'muted' : 'warn')}</td>
            <td class="small">${fmtExact(d.createdAt)}</td><td class="small">${who(d.triggeredBy)}</td><td class="num">${d.attempts}</td><td class="small">${fmtExact(d.updatedAt)}</td>
            <td class="small">${fmtExact(d.sentAt)}</td><td class="small mono">${d.providerMessageId ?? ''}</td><td>${providerReport(d.deliveryStatus)}</td>
            <td class="small">${d.lastError ? html`<span class="error-text">${d.lastError}</span>` : ''}</td></tr>`,
        )}
        ${r.deliveries.length === 0 ? html`<tr><td colspan="10" class="muted center">Not queued yet.</td></tr>` : null}
      </tbody>
    </table></div>`;
}
