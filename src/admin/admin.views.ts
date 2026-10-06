import { ActivityType, EmailDeliveryStatus, EmailStatus, EntryKind, PaymentStatus } from '@prisma/client';
import { CollegeEmailService } from '../emails/college-email.service';
import { EmailTemplate } from '../emails/email-templates';
import { formatAadhaar, maskAadhaar } from '../registrations/aadhaar-crypto';
import { QrEmailSummary } from '../emails/qr-email.service';
import { BULK_VERIFY_MAX, BulkVerificationService, ReportEmailStatus, reportEmailStatus } from '../payments/bulk-verification.service';
import { SafeHtml, html } from '../web/html';
import { BadgeTone, badge, csrfField, fmtDate, fmtDay, fmtExact, paymentBadge } from '../web/layout';
import {
  AdminQueryService,
  CollegeRow,
  Counters,
  ExpectedKind,
  ExpectedSummary,
  PAGE_SIZE,
  RegistrationFilters,
  RegistrationView,
  teamPaymentState,
} from './admin-query.service';

type EventSummary = Awaited<ReturnType<AdminQueryService['eventSummary']>>;
type RegistrationList = Awaited<ReturnType<AdminQueryService['listRegistrations']>>;
type TeamDetail = NonNullable<Awaited<ReturnType<AdminQueryService['teamDetail']>>>;
type ParticipantDetail = NonNullable<Awaited<ReturnType<AdminQueryService['participantDetail']>>>;
type CollegeDetail = NonNullable<Awaited<ReturnType<AdminQueryService['collegeParticipants']>>>;
type Batches = Awaited<ReturnType<CollegeEmailService['batches']>>;
type EntryList = Awaited<ReturnType<AdminQueryService['entries']>>;
type ExpectedList = Awaited<ReturnType<AdminQueryService['expected']>>;
type VerificationBatches = Awaited<ReturnType<BulkVerificationService['batches']>>;
type VerificationBatchDetail = NonNullable<Awaited<ReturnType<BulkVerificationService['batch']>>>;
type EventName = (slug: string) => string;

const who = (u: { name: string | null; email: string } | null | undefined) => (u ? u.name || u.email : 'system');

export function buildQuery(params: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function pager(base: Record<string, string | undefined>, page: number, total: number, path: string) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages === 1) return null;
  return html`<nav class="pager">
    ${page > 1 ? html`<a href="${path}${buildQuery({ ...base, page: page - 1 })}">← Prev</a>` : null}
    <span>Page ${page} of ${pages}</span>
    ${page < pages ? html`<a href="${path}${buildQuery({ ...base, page: page + 1 })}">Next →</a>` : null}
  </nav>`;
}

/**
 * TOTAL / VERIFIED / PENDING / REJECTED / BLOCKED / INSIDE / OUTSIDE / EVER ENTERED (see Counters for definitions).
 * With `link`, every tile is a filter (TOTAL = all) and the active one is highlighted.
 */
export function countersBar(
  c: Counters,
  link?: { href: (view: RegistrationView | undefined) => string; active: RegistrationView | undefined },
) {
  const item = (label: string, value: number, view: RegistrationView | undefined, tone = '', title = '') => {
    const inner = html`<div class="label">${label}</div><div class="value">${value}</div>`;
    if (!link) return html`<div class="counter ${tone}" title="${title}">${inner}</div>`;
    const active = link.active === view;
    return html`<a class="counter ${tone} ${active ? 'active' : ''}" title="${title}" href="${link.href(view)}" ${active ? html`aria-current="true"` : null}>${inner}</a>`;
  };
  return html`<div class="counters">
    ${item('Total', c.total, undefined, '', 'All registrations (one per participant per event)')}
    ${item('Verified', c.verified, 'VERIFIED', 'ok', 'Manually verified by a coordinator/admin')}
    ${item('Pending', c.pending, 'PENDING', 'warn', 'Not yet verified')}
    ${item('Rejected', c.rejected, 'REJECTED', '', 'Rejected during verification')}
    ${item('Blocked', c.blocked, 'BLOCKED', c.blocked ? 'bad' : '', 'Participant blocked at the gate (cannot check in or out)')}
    ${item('Inside', c.inside, 'INSIDE', 'info', 'Checked in and not checked out since')}
    ${item('Outside', c.outside, 'OUTSIDE', '', 'Not currently inside (never checked in, or checked out)')}
    ${item('Ever entered', c.everEntered, 'ENTERED', '', 'Checked in at the gate at least once (stays here after checking out)')}
  </div>`;
}

const blockedBadge = (p: { blockedAt: Date | null }) => (p.blockedAt ? badge('BLOCKED', 'bad') : null);

/** "YYYY-MM-DD" for <input type="date"> from a DATE column value. */
const isoDay = (d: Date | undefined) => (d ? d.toISOString().slice(0, 10) : '');

function presenceBadge(r: { insideSince: Date | null; enteredAt?: Date | null }) {
  if (r.insideSince) return badge('Inside', 'ok');
  return r.enteredAt ? badge('Outside (checked out)', 'muted') : badge('Outside', 'muted');
}

export function eventSidebar(
  events: EventSummary,
  current: string | undefined,
  eventName: EventName,
  path: string,
  keep: Record<string, string | undefined> = {},
) {
  const all = events.reduce((n, e) => n + e.teams, 0);
  const allPending = events.reduce((n, e) => n + e.pendingTeams, 0);
  return html`<aside class="events">
    <h2>Events</h2>
    <a href="${path}${buildQuery(keep)}" class="${!current ? 'active' : ''}">All events <span class="count">${all}</span>${allPending ? html`<span class="pending">${allPending}</span>` : null}</a>
    ${events.map(
      (e) => html`<a href="${path}${buildQuery({ ...keep, event: e.slug })}" class="${current === e.slug ? 'active' : ''}">
        ${eventName(e.slug)} <span class="count">${e.teams}</span>${e.pendingTeams ? html`<span class="pending" title="Awaiting verification">${e.pendingTeams}</span>` : null}
      </a>`,
    )}
    ${events.length === 0 ? html`<p class="muted small">No registrations yet.</p>` : null}
  </aside>`;
}

const VIEW_LABEL: Record<RegistrationView, string> = {
  PENDING: 'Pending',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  BLOCKED: 'Blocked',
  INSIDE: 'Inside',
  OUTSIDE: 'Outside',
  ENTERED: 'Ever entered',
};

/** One row per registration; every row opens the participant page. */
export function registrationsPage(args: {
  filters: RegistrationFilters;
  list: RegistrationList;
  events: EventSummary;
  collegeName?: string;
  eventName: EventName;
  /** Set for ADMINs only: enables "Verify Selected" on the Pending view. */
  bulkVerifyCsrf?: string;
}): SafeHtml {
  const { filters, list, events, eventName } = args;
  const bulk = args.bulkVerifyCsrf && filters.view === 'PENDING' ? args.bulkVerifyCsrf : null;
  const base = {
    event: filters.event,
    college: filters.college,
    q: filters.q,
    arrival: isoDay(filters.arrival) || undefined,
    departure: isoDay(filters.departure) || undefined,
  };
  const href = (view: RegistrationView | undefined) =>
    `/admin/registrations${buildQuery({ ...base, status: view?.toLowerCase() })}`;
  const c = list.counters;
  const counts: Record<RegistrationView, number> = {
    PENDING: c.pending,
    VERIFIED: c.verified,
    REJECTED: c.rejected,
    BLOCKED: c.blocked,
    INSIDE: c.inside,
    OUTSIDE: c.outside,
    ENTERED: c.everEntered,
  };
  const chip = (view: RegistrationView | undefined, label: string, count: number) =>
    html`<a class="chip ${filters.view === view ? 'active' : ''}" href="${href(view)}" ${filters.view === view ? html`aria-current="true"` : null}>${label} <b>${count}</b></a>`;
  const empty =
    list.total > 0
      ? null
      : filters.view && c.total > 0
        ? html`No registrations are <b>${VIEW_LABEL[filters.view].toLowerCase()}</b> under these filters. ${c.total} registration(s) match otherwise: <a href="${href(undefined)}">show all</a>.`
        : 'No registrations match.';

  return html`<div class="with-sidebar">
    ${eventSidebar(events, filters.event, eventName, '/admin/registrations', { college: filters.college })}
    <div class="content">
      <h1>${filters.event ? eventName(filters.event) : 'All registrations'}${filters.view ? html` <span class="muted">· ${VIEW_LABEL[filters.view]}</span>` : null}</h1>
      ${args.collegeName ? html`<p>College: <b>${args.collegeName}</b> · <a href="/admin/registrations${buildQuery({ event: filters.event })}">all colleges</a> · <a href="/admin/colleges/${filters.college}${buildQuery({ event: filters.event })}">college page</a></p>` : null}
      ${countersBar(c, { href, active: filters.view })}
      <form method="get" action="/admin/registrations" class="row-form search">
        ${filters.event ? html`<input type="hidden" name="event" value="${filters.event}">` : null}
        ${filters.college ? html`<input type="hidden" name="college" value="${filters.college}">` : null}
        ${filters.view ? html`<input type="hidden" name="status" value="${filters.view.toLowerCase()}">` : null}
        <input type="search" name="q" value="${filters.q ?? ''}" placeholder="Name, email, mobile, roll no., college, team or registration ID">
        <label class="small">Expected arrival <input type="date" name="arrival" value="${isoDay(filters.arrival)}"></label>
        <label class="small">Expected departure <input type="date" name="departure" value="${isoDay(filters.departure)}"></label>
        <button>Search</button>
        ${filters.q || filters.arrival || filters.departure ? html`<a href="/admin/registrations${buildQuery({ event: filters.event, college: filters.college, status: filters.view?.toLowerCase() })}">Clear</a>` : null}
      </form>
      <div class="chips">
        ${chip(undefined, 'All', c.total)}
        ${(Object.keys(VIEW_LABEL) as RegistrationView[]).map((v) => chip(v, VIEW_LABEL[v], counts[v]))}
      </div>
      ${
        bulk && list.registrations.length
          ? html`<form id="bulk-verify" method="post" action="/admin/registrations/bulk-verify" class="row-form" data-bulk-verify>
              ${csrfField(bulk)}
              <input type="hidden" name="back" value="/admin/registrations${buildQuery({ ...base, status: 'pending', page: filters.page > 1 ? filters.page : undefined })}">
              <button class="primary" data-bulk-submit>Verify selected</button>
              <span class="muted small">Admins only. Each selected registration is verified exactly like its Verify button (its whole form response) and gets the same QR email. Up to ${BULK_VERIFY_MAX} at a time.</span>
            </form>`
          : null
      }
      <div class="table-wrap">
      <table class="table rows-clickable">
        <thead><tr>${bulk ? html`<th><input type="checkbox" data-select-all aria-label="Select all registrations on this page"></th>` : null}<th>Participant</th>${filters.event ? null : html`<th>Event</th>`}<th>College</th><th>Contact</th><th>Status</th><th>Gate</th><th>Registered</th></tr></thead>
        <tbody>
          ${list.registrations.map((r) => {
            const team = r.team && r.team._count.registrations > 1 ? r.team : null;
            return html`<tr data-href="/admin/registrations/${r.id}">
              ${bulk ? html`<td><input type="checkbox" name="ids" value="${r.id}" form="bulk-verify" data-bulk-row aria-label="Select ${r.person.name ?? 'participant'}"></td>` : null}
              <td><a href="/admin/registrations/${r.id}">${r.person.name ?? r.person.email}</a>${
                team
                  ? html`<br><span class="small">team <a href="/admin/teams/${team.id}">${team.name}</a> (${team._count.registrations})</span>`
                  : r.team && r.team.name !== r.person.name
                    ? html` <span class="muted small">(${r.team.name})</span>`
                    : null
              }${r.transactionId ? html`<br><span class="mono small">${r.transactionId}</span>${list.duplicateTxns.has(r.transactionId) ? html` ${badge('Duplicate txn', 'bad')}` : null}` : null}</td>
              ${filters.event ? null : html`<td>${eventName(r.eventSlug)}</td>`}
              <td class="small">${r.person.collegeId ? html`<a href="/admin/colleges/${r.person.collegeId}">${r.person.college}</a>` : r.person.college}</td>
              <td class="small">${r.person.email}${r.person.phone ? html`<br>${r.person.phone}` : null}</td>
              <td>${paymentBadge(r.paymentStatus)} ${blockedBadge(r.person)}</td>
              <td>${presenceBadge(r)}${
                filters.view === 'ENTERED' && r.enteredAt
                  ? html`<br><span class="small">first in ${fmtExact(r.enteredAt)} by ${who(r.enteredBy)}${r.entryLogs[0]?.gate ? html` (${r.entryLogs[0].gate})` : null}</span>`
                  : null
              }</td>
              <td class="small">${fmtDate(r.createdAt)}</td>
            </tr>`;
          })}
          ${empty ? html`<tr><td colspan="${bulk ? 8 : 7}" class="muted center">${empty}</td></tr>` : null}
        </tbody>
      </table>
      </div>
      ${pager({ ...base, status: filters.view?.toLowerCase() }, filters.page, list.total, '/admin/registrations')}
    </div>
  </div>`;
}

function deliveryBadge(status: EmailStatus, delivery: EmailDeliveryStatus | null) {
  if (delivery) {
    const tone: Record<EmailDeliveryStatus, BadgeTone> = {
      DELIVERED: 'ok',
      DELAYED: 'warn',
      BOUNCED: 'bad',
      COMPLAINED: 'bad',
      FAILED: 'bad',
    };
    return badge(delivery.toLowerCase(), tone[delivery]);
  }
  const tone: Record<EmailStatus, BadgeTone> = {
    PENDING: 'info',
    PROCESSING: 'info',
    SENT: 'ok',
    FAILED: 'bad',
    CANCELLED: 'muted',
  };
  return badge(status === 'PENDING' ? 'queued' : status.toLowerCase(), tone[status]);
}

/** QR email status + the individual Send/Resend button (one participant, their email, their QR). */
function qrCell(reg: { id: string; paymentStatus: PaymentStatus }, summary: QrEmailSummary | undefined, csrf: string) {
  if (reg.paymentStatus !== PaymentStatus.VERIFIED || !summary) return html`<span class="muted small">after verification</span>`;
  const unlimited = summary.manualResendLimit === 0;
  const canSend = !summary.queued && (unlimited || summary.manualResendsUsed < summary.manualResendLimit);
  return html`<div class="small">
      <div>Sent <b>${summary.sentCount}</b>×${summary.lastSentAt ? html` · last ${fmtDate(summary.lastSentAt)}` : null}</div>
      ${summary.lastDeliveryStatus ? html`<div>${deliveryBadge(EmailStatus.SENT, summary.lastDeliveryStatus)}</div>` : null}
      ${summary.queued ? html`<div>${badge('queued', 'info')} sends ${fmtDate(summary.queued.sendAt)}</div>` : null}
      ${summary.lastFailure ? html`<div class="error-text">Failed: ${summary.lastFailure}</div>` : null}
      <div class="muted">Manual sends ${summary.manualResendsUsed}${unlimited ? ' (no limit)' : `/${summary.manualResendLimit}`}</div>
    </div>
    ${
      canSend
        ? html`<form method="post" action="/admin/registrations/${reg.id}/resend-qr" class="inline">${csrfField(csrf)}<button class="small">${summary.sentCount ? 'Resend QR email' : 'Send QR email'}</button></form>`
        : null
    }`;
}

function activityText(a: { type: ActivityType; details: unknown }): SafeHtml {
  const d = (a.details ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  switch (a.type) {
    case ActivityType.SUBMITTED:
      return html`Imported from the form${d.sourceRow ? ` (sheet row ${str(d.sourceRow)})` : ''}${d.expectedArrival ? ` · expected arrival ${str(d.expectedArrival)}` : ''}${d.expectedDeparture ? ` · expected departure ${str(d.expectedDeparture)}` : ''}`;
    case ActivityType.UPDATED:
      return html`Form response re-synced${d.movedFromTeamId ? ' · moved from another response' : ''}${d.transactionId !== undefined ? ` · txn now ${str(d.transactionId)}` : ''}${d.paymentResetFromRejected ? ' · back to pending' : ''}${d.expectedArrival !== undefined ? ` · expected arrival now ${str(d.expectedArrival)}` : ''}${d.expectedDeparture !== undefined ? ` · expected departure now ${str(d.expectedDeparture)}` : ''}`;
    case ActivityType.PAYMENT_VERIFIED:
      return html`<b>Verified</b>${d.qrTokenCreated ? ' · QR pass created' : ''}`;
    case ActivityType.PAYMENT_REJECTED:
      return html`<b>Rejected</b>: ${str(d.remarks)}`;
    case ActivityType.PAYMENT_UNVERIFIED:
      return html`Verification undone`;
    case ActivityType.QR_EMAIL_QUEUED:
      return html`QR email queued to ${str(d.toEmail)}`;
    case ActivityType.QR_EMAIL_RESENT:
      return html`QR email sent manually to ${str(d.toEmail)} (#${str(d.resend)}${d.limit ? `/${str(d.limit)}` : ''})`;
    case ActivityType.QR_EMAIL_BULK_QUEUED:
      return html`QR email queued to ${str(d.toEmail)} by a college bulk send`;
    case ActivityType.QR_PASSES_FORWARDED:
      return html`Pass included in a college email to ${str(d.recipientEmail)} (${str(d.passes)} passes)`;
    case ActivityType.EMAIL_CHANGED:
      return d.from ? html`<b>Email changed</b> ${str(d.from)} → ${str(d.to)}` : html`<b>Email added</b> ${str(d.to)}${d.source === 'form' ? ' (from the form)' : ''}`;
    case ActivityType.ENTERED:
      return html`<b>Checked in</b>${d.gate ? ` at ${str(d.gate)}` : ''}`;
    case ActivityType.ENTRY_DENIED:
      return html`Check-in refused: ${str(d.reason)}${d.gate ? ` (${str(d.gate)})` : ''}`;
    case ActivityType.CHECKED_OUT:
      return html`<b>Checked out</b>${d.gate ? ` at ${str(d.gate)}` : ''}${d.adminOverride ? ' (admin override while blocked)' : ''}`;
    case ActivityType.BLOCKED:
      return html`<b>Blocked</b>${d.reason ? `: ${str(d.reason)}` : ''}${d.wasInside ? ' (was inside)' : ''}`;
    case ActivityType.UNBLOCKED:
      return html`<b>Unblocked</b>${d.previousReason ? ` (was: ${str(d.previousReason)})` : ''}`;
    case ActivityType.CHECKOUT_DENIED:
      return html`Check-out refused: ${str(d.reason)}`;
    default:
      return html`${String(a.type)}`;
  }
}

function emailsTable(emails: TeamDetail['emails']) {
  if (!emails.length) return html`<p class="muted">No emails yet.</p>`;
  return html`<div class="table-wrap"><table class="table small">
    <thead><tr><th>Email</th><th>To</th><th>Status</th><th>Sent</th><th>Triggered by</th></tr></thead>
    <tbody>${emails.map(
      (e) => html`<tr>
        <td>${e.template}${e.batchId ? html` ${badge('college', 'info')}` : null}</td><td>${e.toEmail}</td>
        <td>${deliveryBadge(e.status, e.deliveryStatus)}${e.lastError && e.status !== EmailStatus.SENT ? html`<br><span class="error-text">${e.lastError}</span>` : null}</td>
        <td>${fmtDate(e.sentAt) || (e.status === EmailStatus.PENDING ? html`<span class="muted">at ${fmtDate(e.sendAt)}</span>` : null)}</td>
        <td>${e.triggeredBy ? who(e.triggeredBy) : html`<span class="muted">automatic</span>`}</td>
      </tr>`,
    )}</tbody></table></div>`;
}

/** Verify / Undo / Reject. Decisions apply to the whole response (a team of one for individual forms). */
function verificationActions(args: {
  actionBase: string;
  state: PaymentStatus | 'MIXED';
  members: number;
  canUndo: boolean;
  entered: boolean;
  remarks: string | null;
  verifiedClash: boolean;
  csrf: string;
}) {
  const { actionBase, state, csrf } = args;
  const scope = args.members > 1 ? ` (all ${args.members} members)` : '';
  return html`<div class="actions">
      ${
        state !== PaymentStatus.VERIFIED
          ? html`<form method="post" action="${actionBase}/verify" class="inline">${csrfField(csrf)}
              <button class="primary" ${args.verifiedClash ? 'disabled' : ''}>Verify${scope}</button></form>`
          : null
      }
      ${args.canUndo ? html`<form method="post" action="${actionBase}/undo" class="inline">${csrfField(csrf)}<button>Undo verification</button></form>` : null}
    </div>
    ${
      !args.entered
        ? html`<form method="post" action="${actionBase}/reject" class="stack reject">${csrfField(csrf)}
            <label>Rejection reason (emailed to the participant)
              <textarea name="remarks" required maxlength="500" rows="2">${state === PaymentStatus.REJECTED ? args.remarks : ''}</textarea></label>
            <button class="danger">${state === PaymentStatus.REJECTED ? 'Update rejection' : `Reject${scope}`}</button>
          </form>`
        : null
    }`;
}

export function teamPage(args: {
  detail: TeamDetail;
  qr: Map<string, QrEmailSummary>;
  csrf: string;
  eventName: EventName;
  driveEnabled: boolean;
  delaySeconds: number;
}): SafeHtml {
  const { detail, qr, csrf, eventName, driveEnabled } = args;
  const { team, txn, activity, emails, otherTeamsWithTxn } = detail;
  const regs = team.registrations;
  const state = teamPaymentState(regs);
  const entered = regs.filter((r) => r.enteredAt).length;
  const inside = regs.filter((r) => r.insideSince).length;
  const lastReview = [...regs]
    .filter((r) => r.paymentReviewedAt)
    .sort((a, b) => b.paymentReviewedAt!.getTime() - a.paymentReviewedAt!.getTime())[0];
  const verifiedClash = otherTeamsWithTxn.find((o) => o.paymentStatus === PaymentStatus.VERIFIED);
  const qrSent = emails.some(
    (e) => e.template === EmailTemplate.QrPass && (e.status === EmailStatus.SENT || e.status === EmailStatus.PROCESSING),
  );
  const canUndo = regs.some((r) => r.paymentStatus === PaymentStatus.VERIFIED) && !qrSent && entered === 0;

  return html`<p class="small"><a href="/admin/registrations${buildQuery({ event: team.eventSlug })}">← ${eventName(team.eventSlug)}</a></p>
  <div class="title-row">
    <h1>${team.name}</h1>${paymentBadge(state)}
  </div>
  <p class="muted">${eventName(team.eventSlug)} · ${regs.length} member(s) · ${entered}/${regs.length} entered${entered === regs.length ? ' · team entered' : ''} · ${inside} inside now · submitted ${fmtDate(team.createdAt)} · <span class="mono small">${team.id}</span></p>

  <section class="card">
    <h2>Verification</h2>
    <dl class="facts">
      ${txn ? html`<dt>Transaction ID</dt><dd class="mono">${txn}</dd>` : null}
      ${lastReview ? html`<dt>Last decision</dt><dd>${paymentBadge(lastReview.paymentStatus)} by ${who(lastReview.paymentReviewedBy)}, ${fmtDate(lastReview.paymentReviewedAt)}</dd>` : null}
      ${regs[0]?.paymentRemarks ? html`<dt>Rejection reason</dt><dd>${regs[0].paymentRemarks}</dd>` : null}
    </dl>
    ${
      otherTeamsWithTxn.length
        ? html`<div class="warning"><b>Duplicate transaction ID.</b> Also used by:
            <ul>${otherTeamsWithTxn.map(
              (o) => html`<li><a href="/admin/teams/${o.team?.id}">${o.team?.name}</a> (${eventName(o.eventSlug)}) ${paymentBadge(o.paymentStatus)}</li>`,
            )}</ul>
            ${verifiedClash ? html`<p>It is already verified for another team, so this one cannot be verified.</p>` : null}</div>`
        : null
    }
    ${verificationActions({
      actionBase: `/admin/teams/${team.id}`,
      state,
      members: regs.length,
      canUndo,
      entered: entered > 0,
      remarks: regs[0]?.paymentRemarks ?? null,
      verifiedClash: Boolean(verifiedClash),
      csrf,
    })}
    <p class="muted small">QR and rejection emails wait ${args.delaySeconds}s before sending, so a mis-click can be undone.</p>
  </section>

  <section class="card">
    <h2>Members</h2>
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>Participant</th><th>Contact</th><th>Files</th><th>Status</th><th>QR email</th><th>Gate</th></tr></thead>
      <tbody>
        ${regs.map(
          (r) => html`<tr>
            <td><a href="/admin/registrations/${r.id}"><b>${r.person.name}</b></a>${r.person.email === team.captainEmail && regs.length > 1 ? html` ${badge('Captain', 'info')}` : null}<br><span class="small">${r.person.college}</span><br><span class="mono small muted">${r.id}</span></td>
            <td class="small">${r.person.email}${r.person.emailBouncedAt ? html`<br>${badge('Email bounced', 'bad')} <span class="error-text">${r.person.emailBounceReason}</span>` : null}<br>${r.person.phone}</td>
            <td class="small">${
              driveEnabled
                ? html`${r.person.photoDriveId ? html`<a href="/staff/files/${r.person.id}/photo" target="_blank" rel="noopener">Photo</a>` : html`<span class="muted">no photo</span>`}<br>
                   ${r.person.idDocumentDriveId ? html`<a href="/staff/files/${r.person.id}/id" target="_blank" rel="noopener">ID</a>` : html`<span class="muted">no ID</span>`}`
                : html`<span class="muted">Drive not configured</span>`
            }</td>
            <td>${paymentBadge(r.paymentStatus)}</td>
            <td>${qrCell(r, qr.get(r.id), csrf)}</td>
            <td class="small">${presenceBadge(r)}${r.enteredAt ? html`<br>first in ${fmtDate(r.enteredAt)} by ${who(r.enteredBy)}${r.entryLogs[0]?.gate ? html` (${r.entryLogs[0].gate})` : null}` : null}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    </div>
  </section>

  <section class="card">
    <h2>Emails</h2>
    ${emailsTable(emails)}
  </section>

  <section class="card">
    <h2>History</h2>
    <ol class="timeline">
      ${activity.map(
        (a) => html`<li><span class="when">${fmtDate(a.createdAt)}</span>
          <span>${activityText(a)}</span>
          <span class="muted small">${regs.length > 1 ? `${a.registration.person.name ?? a.registration.person.email} · ` : ''}${who(a.actor)}</span></li>`,
      )}
    </ol>
  </section>`;
}

/** Individual participant (one registration): all form data, verification, email, QR, gate, history. */
export function participantPage(args: {
  detail: ParticipantDetail;
  qr: QrEmailSummary | undefined;
  csrf: string;
  /** Only admins see the check-out override for blocked participants. */
  isAdmin: boolean;
  /** Decrypted full Aadhaar, passed ONLY for admins (null otherwise). */
  aadhaarFull: string | null;
  eventName: EventName;
  driveEnabled: boolean;
  delaySeconds: number;
}): SafeHtml {
  const { detail, csrf, eventName, driveEnabled } = args;
  const { reg, activity, emails } = detail;
  const p = reg.person;
  const members = reg.team?.registrations.length ?? 1;
  const qrSent = emails.some(
    (e) => e.template === EmailTemplate.QrPass && (e.status === EmailStatus.SENT || e.status === EmailStatus.PROCESSING),
  );
  const file = (kind: 'photo' | 'id' | 'aadhaar', id: string | null, label: string) =>
    !driveEnabled
      ? html`<span class="muted">Drive not configured</span>`
      : id
        ? html`<a href="/staff/files/${p.id}/${kind}" target="_blank" rel="noopener">${label}</a>`
        : html`<span class="muted">not uploaded</span>`;
  const fact = (label: string, value: unknown) =>
    value === null || value === undefined || value === '' ? null : html`<dt>${label}</dt><dd>${String(value)}</dd>`;
  const gateForm = (path: 'check-in' | 'check-out', label: string, cls: string) =>
    html`<form method="post" action="/admin/registrations/${reg.id}/${path}" class="inline">${csrfField(csrf)}
      <input type="hidden" name="gate" value="Manual (participant page)"><button class="${cls}">${label}</button></form>`;

  return html`<p class="small"><a href="/admin/registrations${buildQuery({ event: reg.eventSlug })}">← ${eventName(reg.eventSlug)}</a>
    ${p.collegeRef ? html` · <a href="/admin/colleges/${p.collegeRef.id}${buildQuery({ event: reg.eventSlug })}">${p.collegeRef.name}</a>` : null}</p>
  <div class="title-row">
    <h1>${p.name ?? p.email}</h1>${paymentBadge(reg.paymentStatus)} ${blockedBadge(p)} ${presenceBadge(reg)}
  </div>
  <p class="muted">${eventName(reg.eventSlug)}${members > 1 && reg.team ? html` · team <a href="/admin/teams/${reg.team.id}">${reg.team.name}</a> (${members})` : null} · registered ${fmtDate(reg.createdAt)} · <span class="mono small">${reg.id}</span></p>
  ${p.registrations.length > 1 ? html`<p class="small">Other events: ${p.registrations.filter((o) => o.id !== reg.id).map((o) => html`<a href="/admin/registrations/${o.id}">${eventName(o.eventSlug)}</a> `)}</p>` : null}

  <section class="card">
    <h2>Participant</h2>
    <dl class="facts">
      <dt>Email</dt><dd>${p.email ?? html`<span class="muted">No email</span>`}${p.emailBouncedAt ? html` ${badge('bounced', 'bad')} <span class="error-text">${p.emailBounceReason}</span>` : null}</dd>
      ${fact('College', p.college)}
      <dt>Sport / event</dt><dd>${eventName(reg.eventSlug)}</dd>
      ${fact('Mobile', p.phone)}
      ${fact('College roll no.', p.rollNumber)}
      ${
        args.aadhaarFull
          ? html`<dt>Aadhaar</dt><dd class="mono">${formatAadhaar(args.aadhaarFull)} <span class="muted small">(admin only)</span></dd>`
          : p.aadhaarLast4
            ? html`<dt>Aadhaar</dt><dd class="mono">${maskAadhaar(p.aadhaarLast4)}</dd>`
            : null
      }
      ${fact('Accommodation', reg.accommodation)}
      ${fact('Accommodation period', reg.accommodationPeriod)}
      <dt>Expected arrival</dt><dd>${reg.expectedArrivalDate ? fmtDay(reg.expectedArrivalDate) : html`<span class="muted">${reg.expectedArrivalText ? `"${reg.expectedArrivalText}" (not a date)` : 'not given'}</span>`} <span class="muted small">(planned, from the form)</span></dd>
      <dt>Expected departure</dt><dd>${reg.expectedDepartureDate ? fmtDay(reg.expectedDepartureDate) : html`<span class="muted">${reg.expectedDepartureText ? `"${reg.expectedDepartureText}" (not a date)` : 'not given'}</span>`} <span class="muted small">(planned, from the form)</span></dd>
      ${fact('Remark', reg.remark)}
      ${fact('Transaction ID', reg.transactionId)}
      <dt>Files</dt><dd>${file('photo', p.photoDriveId, 'Photo')} · ${file('id', p.idDocumentDriveId, 'College ID card')}${args.isAdmin ? html` · ${file('aadhaar', p.aadhaarDriveId, 'Aadhaar card')}` : null}</dd>
    </dl>
    <form method="post" action="/admin/registrations/${reg.id}/change-email" class="row-form">
      ${csrfField(csrf)}
      <label>Change email <input type="email" name="email" required placeholder="new@example.com"></label>
      <button>Change email</button>
    </form>
    <p class="muted small">${p.email ? 'Keeps the same participant, QR pass and history. Nothing is emailed automatically; use Send QR email afterwards.' : 'No email yet. Adding one keeps the same participant, QR pass and history, and emails the QR pass if the registration is verified.'}</p>
  </section>

  <section class="card">
    <h2>Verification</h2>
    <dl class="facts">
      <dt>Status</dt><dd>${paymentBadge(reg.paymentStatus)}${reg.paymentReviewedAt ? html` by ${who(reg.paymentReviewedBy)}, ${fmtDate(reg.paymentReviewedAt)}` : null}</dd>
      ${fact('Rejection reason', reg.paymentRemarks)}
      <dt>QR pass</dt><dd>${p.qrToken ? 'created' : html`<span class="muted">created on verification</span>`}</dd>
    </dl>
    ${reg.team
      ? verificationActions({
          actionBase: `/admin/registrations/${reg.id}`,
          state: reg.paymentStatus,
          members,
          canUndo: reg.paymentStatus === PaymentStatus.VERIFIED && !qrSent && !reg.enteredAt,
          entered: Boolean(reg.enteredAt),
          remarks: reg.paymentRemarks,
          verifiedClash: false,
          csrf,
        })
      : null}
    <p class="muted small">Verifying creates the QR pass (if needed) and emails it after ${args.delaySeconds}s.</p>
  </section>

  <section class="card">
    <h2>QR email</h2>
    ${qrCell(reg, args.qr, csrf)}
  </section>

  <section class="card">
    <h2>Gate access</h2>
    ${
      p.blockedAt
        ? html`<div class="warning"><b>BLOCKED</b> since ${fmtDate(p.blockedAt)} by ${who(p.blockedBy)}${p.blockReason ? html`<br>Reason: ${p.blockReason}` : null}<br>
            <span class="small">The QR is refused for check-in and check-out at the gate (all events) until unblocked.</span></div>
          <form method="post" action="/admin/registrations/${reg.id}/unblock" class="inline">${csrfField(csrf)}<button>Unblock participant</button></form>`
        : html`<form method="post" action="/admin/registrations/${reg.id}/block" class="row-form">${csrfField(csrf)}
            <label>Block reason (optional, internal) <input name="reason" maxlength="500" placeholder="e.g. Registration issue"></label>
            <button class="danger">Block participant</button></form>
          <p class="muted small">Blocking stops check-in and check-out with this QR for every event. Verification, QR and history are kept.</p>`
    }
  </section>

  <section class="card">
    <h2>Gate (actual IN / OUT)</h2>
    <p class="muted small">CHECK IN / CHECK OUT here works without scanning the QR. It follows the same rules as a scan (verified, not blocked, current state) and is recorded as a manual action under your name.</p>
    <dl class="facts">
      <dt>Now</dt><dd>${presenceBadge(reg)}${reg.insideSince ? html` since ${fmtExact(reg.insideSince)}` : null}</dd>
      <dt>Actual check-in</dt><dd>${reg.lastCheckInAt ? fmtExact(reg.lastCheckInAt) : html`<span class="muted">Not yet</span>`}${reg.enteredAt && reg.lastCheckInAt && reg.enteredAt.getTime() !== reg.lastCheckInAt.getTime() ? html` <span class="muted small">(first entry ${fmtExact(reg.enteredAt)})</span>` : null}</dd>
      <dt>Actual check-out</dt><dd>${reg.lastCheckOutAt ? fmtExact(reg.lastCheckOutAt) : html`<span class="muted">Not yet</span>`}</dd>
    </dl>
    <div class="actions">
      ${reg.paymentStatus === PaymentStatus.VERIFIED && !reg.insideSince && !p.blockedAt ? gateForm('check-in', 'CHECK IN', 'primary') : null}
      ${reg.insideSince && !p.blockedAt ? gateForm('check-out', 'CHECK OUT', '') : null}
      ${
        reg.insideSince && p.blockedAt && args.isAdmin
          ? html`<form method="post" action="/admin/registrations/${reg.id}/check-out-override" class="inline">${csrfField(csrf)}
              <input type="hidden" name="gate" value="Admin override"><button class="danger">Admin override: record check-out</button></form>`
          : null
      }
    </div>
    ${
      reg.entryLogs.length
        ? html`<div class="table-wrap"><table class="table small"><thead><tr><th>Time</th><th>Action</th><th>Result</th><th>Gate</th><th>Staff</th></tr></thead><tbody>
          ${reg.entryLogs.map(
            (l) => html`<tr><td>${fmtExact(l.enteredAt)}</td><td>${l.kind === EntryKind.CHECK_IN ? 'IN' : 'OUT'}</td>
              <td>${l.status === 'ENTERED' ? badge('ok', 'ok') : badge(`refused: ${l.notes ?? ''}`, 'bad')}</td><td>${l.gate}</td><td>${who(l.volunteer)}</td></tr>`,
          )}</tbody></table></div>`
        : null
    }
  </section>

  <section class="card">
    <h2>Emails</h2>
    ${emailsTable(emails)}
  </section>

  <section class="card">
    <h2>History</h2>
    <ol class="timeline">
      ${activity.map(
        (a) => html`<li><span class="when">${fmtDate(a.createdAt)}</span><span>${activityText(a)}</span><span class="muted small">${who(a.actor)}</span></li>`,
      )}
    </ol>
  </section>`;
}

/**
 * Participant details on the scanned-participant page (gate card), the same section for every
 * staff role. What it contains follows each role's existing permissions: `aadhaarAccess` (full
 * Aadhaar number + Aadhaar card) is true for admins and volunteers only; `aadhaarFull` is
 * decrypted on the server for that signed-in request only.
 */
export function scanDetails(args: {
  person: {
    id: string;
    name: string | null;
    email: string | null;
    emailBouncedAt: Date | null;
    emailBounceReason: string | null;
    phone: string | null;
    college: string | null;
    rollNumber: string | null;
    aadhaarLast4: string | null;
    aadhaarDriveId: string | null;
    idDocumentDriveId: string | null;
    qrToken: string | null;
    blockedAt: Date | null;
    blockReason: string | null;
    registrations: {
      id: string;
      eventSlug: string;
      paymentStatus: PaymentStatus;
      paymentRemarks: string | null;
      paymentReviewedAt: Date | null;
      transactionId: string | null;
      accommodation: string | null;
      accommodationPeriod: string | null;
      expectedArrivalText: string | null;
      expectedDepartureText: string | null;
      expectedArrivalDate: Date | null;
      expectedDepartureDate: Date | null;
      remark: string | null;
      insideSince: Date | null;
      enteredAt: Date | null;
      lastCheckInAt: Date | null;
      lastCheckOutAt: Date | null;
    }[];
  };
  aadhaarFull: string | null;
  aadhaarAccess: boolean;
  history: {
    entryLogs: { id: string; eventSlug: string; kind: EntryKind; status: string; notes: string | null; gate: string | null; enteredAt: Date; volunteer: { name: string | null; email: string } | null }[];
    activity: { id: string; type: ActivityType; details: unknown; createdAt: Date; actor: { name: string | null; email: string } | null; registration: { eventSlug: string } }[];
  };
  eventName: EventName;
  driveEnabled: boolean;
}): SafeHtml {
  const { person: p, history, eventName } = args;
  const fact = (label: string, value: unknown) =>
    value === null || value === undefined || value === '' ? null : html`<dt>${label}</dt><dd>${String(value)}</dd>`;
  // The document is shown as a preview (loaded when scrolled to); the link and the preview open it full size.
  const file = (kind: 'id' | 'aadhaar', id: string | null, label: string) =>
    !args.driveEnabled
      ? html`<span class="muted">Drive not configured</span>`
      : id
        ? html`<a href="/staff/files/${p.id}/${kind}" target="_blank" rel="noopener">${label}</a>
            <a class="doc-preview" href="/staff/files/${p.id}/${kind}" target="_blank" rel="noopener"><img src="/staff/files/${p.id}/${kind}" alt="${label}" loading="lazy"></a>`
        : html`<span class="muted">not uploaded</span>`;
  const planned = (date: Date | null, text: string | null) =>
    date ? fmtDay(date) : html`<span class="muted">${text ? `"${text}" (not a date)` : 'not given'}</span>`;

  return html`<section class="card">
    <h2>Participant details</h2>
    <dl class="facts">
      ${fact('Full name', p.name)}
      <dt>Email</dt><dd>${p.email ?? html`<span class="muted">No email</span>`}${p.emailBouncedAt ? html` ${badge('bounced', 'bad')} <span class="error-text">${p.emailBounceReason}</span>` : null}</dd>
      ${fact('Mobile', p.phone)}
      ${fact('College', p.college)}
      ${fact('College roll no.', p.rollNumber)}
      <dt>College ID card</dt><dd>${file('id', p.idDocumentDriveId, 'View College ID card')}</dd>
      ${
        args.aadhaarFull
          ? html`<dt>Aadhaar</dt><dd class="mono">${formatAadhaar(args.aadhaarFull)}</dd>`
          : p.aadhaarLast4
            ? html`<dt>Aadhaar</dt><dd class="mono">${maskAadhaar(p.aadhaarLast4)}${args.aadhaarAccess ? html` <span class="muted small">(only the last 4 digits are on file)</span>` : null}</dd>`
            : null
      }
      ${args.aadhaarAccess ? html`<dt>Aadhaar card</dt><dd>${file('aadhaar', p.aadhaarDriveId, 'View Aadhaar card')}</dd>` : null}
      <dt>Gate access</dt><dd>${p.blockedAt ? html`${badge('BLOCKED', 'bad')} since ${fmtDate(p.blockedAt)}${p.blockReason ? html`<br>Reason: ${p.blockReason}` : null}` : 'Not blocked'}</dd>
      <dt>QR pass</dt><dd>${p.qrToken ? 'created' : html`<span class="muted">created on verification</span>`}</dd>
    </dl>
  </section>
  ${p.registrations.map(
    (reg) => html`<section class="card">
      <h2>${eventName(reg.eventSlug)}: details</h2>
      <dl class="facts">
        <dt>Sport / event</dt><dd>${eventName(reg.eventSlug)}</dd>
        <dt>Verification</dt><dd>${paymentBadge(reg.paymentStatus)}${reg.paymentReviewedAt ? html` ${fmtDate(reg.paymentReviewedAt)}` : null}</dd>
        ${fact('Rejection reason', reg.paymentRemarks)}
        ${fact('Transaction ID', reg.transactionId)}
        <dt>Expected arrival</dt><dd>${planned(reg.expectedArrivalDate, reg.expectedArrivalText)} <span class="muted small">(planned, from the form)</span></dd>
        <dt>Expected departure</dt><dd>${planned(reg.expectedDepartureDate, reg.expectedDepartureText)} <span class="muted small">(planned, from the form)</span></dd>
        ${fact('Accommodation', reg.accommodation)}
        ${fact('Accommodation period', reg.accommodationPeriod)}
        ${fact('Remark', reg.remark)}
        <dt>Now</dt><dd>${presenceBadge(reg)}${reg.insideSince ? html` since ${fmtExact(reg.insideSince)}` : null}</dd>
        <dt>Actual check-in</dt><dd>${reg.lastCheckInAt ? fmtExact(reg.lastCheckInAt) : html`<span class="muted">Not yet</span>`}${reg.enteredAt && reg.lastCheckInAt && reg.enteredAt.getTime() !== reg.lastCheckInAt.getTime() ? html` <span class="muted small">(first entry ${fmtExact(reg.enteredAt)})</span>` : null}</dd>
        <dt>Actual check-out</dt><dd>${reg.lastCheckOutAt ? fmtExact(reg.lastCheckOutAt) : html`<span class="muted">Not yet</span>`}</dd>
      </dl>
    </section>`,
  )}
  ${
    history.entryLogs.length
      ? html`<section class="card">
          <h2>Gate log</h2>
          <div class="table-wrap"><table class="table small"><thead><tr><th>Time</th><th>Event</th><th>Action</th><th>Result</th><th>Gate</th><th>Staff</th></tr></thead><tbody>
          ${history.entryLogs.map(
            (l) => html`<tr><td>${fmtExact(l.enteredAt)}</td><td>${eventName(l.eventSlug)}</td><td>${l.kind === EntryKind.CHECK_IN ? 'IN' : 'OUT'}</td>
              <td>${l.status === 'ENTERED' ? badge('ok', 'ok') : badge(`refused: ${l.notes ?? ''}`, 'bad')}</td><td>${l.gate}</td><td>${who(l.volunteer)}</td></tr>`,
          )}</tbody></table></div>
        </section>`
      : null
  }
  <section class="card">
    <h2>History</h2>
    <ol class="timeline">
      ${history.activity.map(
        (a) => html`<li><span class="when">${fmtDate(a.createdAt)}</span><span>${p.registrations.length > 1 ? `${eventName(a.registration.eventSlug)}: ` : ''}${activityText(a)}</span><span class="muted small">${who(a.actor)}</span></li>`,
      )}
    </ol>
  </section>`;
}

export function collegesPage(args: {
  colleges: CollegeRow[];
  event?: string;
  q?: string;
  events: EventSummary;
  eventName: EventName;
}): SafeHtml {
  const { colleges, event, q, eventName } = args;
  const totals = colleges.reduce(
    (t, c) => ({
      total: t.total + c.total,
      verified: t.verified + c.verified,
      pending: t.pending + c.pending,
      rejected: t.rejected + c.rejected,
      blocked: t.blocked + c.blocked,
      inside: t.inside + c.inside,
      outside: t.outside + c.outside,
      everEntered: t.everEntered + c.everEntered,
    }),
    { total: 0, verified: 0, pending: 0, rejected: 0, blocked: 0, inside: 0, outside: 0, everEntered: 0 },
  );
  return html`<div class="with-sidebar">
    ${eventSidebar(args.events, event, eventName, '/admin/colleges')}
    <div class="content">
      <h1>Colleges${event ? html`: ${eventName(event)}` : null}</h1>
      ${countersBar(totals)}
      <form method="get" action="/admin/colleges" class="row-form search">
        ${event ? html`<input type="hidden" name="event" value="${event}">` : null}
        <input type="search" name="q" value="${q ?? ''}" placeholder="College name">
        <button>Search</button>
        ${q ? html`<a href="/admin/colleges${buildQuery({ event })}">Clear</a>` : null}
      </form>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>College</th><th class="num">Total</th><th class="num">Verified</th><th class="num">Pending</th><th class="num">Inside</th><th class="num">Outside</th><th class="num">Blocked</th></tr></thead>
        <tbody>
          ${colleges.map(
            (c) => html`<tr><td><a href="/admin/colleges/${c.id}${buildQuery({ event })}">${c.name}</a></td>
              <td class="num">${c.total}</td><td class="num">${c.verified}</td><td class="num">${c.pending}</td><td class="num">${c.inside}</td><td class="num">${c.outside}</td><td class="num">${c.blocked}</td></tr>`,
          )}
          ${colleges.length === 0 ? html`<tr><td colspan="7" class="muted center">No colleges match.</td></tr>` : null}
        </tbody>
      </table></div>
    </div>
  </div>`;
}

export function collegePage(args: {
  detail: CollegeDetail;
  counters: Counters;
  qr: Map<string, QrEmailSummary>;
  batches: Batches;
  event?: string;
  csrf: string;
  eventName: EventName;
}): SafeHtml {
  const { detail, event, csrf, eventName } = args;
  const { college, registrations } = detail;
  const eligible = registrations.filter((r) => r.paymentStatus === PaymentStatus.VERIFIED && r.person.qrToken);
  // Only students with an email can receive the college email (everyone's passes are included).
  const recipients = [...new Map(eligible.filter((r) => r.person.email).map((r) => [r.person.id, r.person])).values()];
  const scope = event ? eventName(event) : 'all events';

  return html`<p class="small"><a href="/admin/colleges${buildQuery({ event })}">← Colleges</a></p>
  <h1>${college.name}</h1>
  <div class="chips">
    <a class="chip ${!event ? 'active' : ''}" href="/admin/colleges/${college.id}">All events</a>
    ${detail.events.map((e) => html`<a class="chip ${event === e.slug ? 'active' : ''}" href="/admin/colleges/${college.id}${buildQuery({ event: e.slug })}">${eventName(e.slug)} <b>${e.count}</b></a>`)}
  </div>
  ${countersBar(args.counters)}
  <p class="small"><a href="/admin/registrations${buildQuery({ college: college.id, event })}">Search / filter these registrations</a> ·
    <a href="/admin/arrivals${buildQuery({ college: college.id, event })}">Expected arrivals</a> ·
    <a href="/admin/departures${buildQuery({ college: college.id, event })}">Expected departures</a></p>

  <section class="card bulk">
    <div>
      <h3>Send QR to all verified students</h3>
      <p class="small muted">Each of the <b>${eligible.length}</b> verified registration(s) (${scope}) gets THEIR OWN pass at THEIR OWN email. Unverified and rejected students are excluded.</p>
      <form method="post" action="/admin/colleges/${college.id}/send-each" class="inline">${csrfField(csrf)}
        ${event ? html`<input type="hidden" name="event" value="${event}">` : null}
        <button class="primary" ${eligible.length ? '' : 'disabled'}>Send QR to all verified students</button></form>
    </div>
    <div>
      <h3>Send all college QR passes to one student</h3>
      <p class="small muted">One email to the selected student containing every verified student's own pass (${scope}). Each QR still admits only its owner.</p>
      <form method="post" action="/admin/colleges/${college.id}/send-to-one" class="row-form">${csrfField(csrf)}
        ${event ? html`<input type="hidden" name="event" value="${event}">` : null}
        <label>Recipient <select name="personId" required ${recipients.length ? '' : 'disabled'}>
          <option value="">Choose a verified student…</option>
          ${recipients.map((p) => html`<option value="${p.id}">${p.name ?? p.email} (${p.email})</option>`)}
        </select></label>
        <button ${recipients.length ? '' : 'disabled'}>Send all passes to this student</button>
      </form>
    </div>
  </section>

  ${
    args.batches.length
      ? html`<section class="card"><h2>College email runs</h2><div class="table-wrap"><table class="table small">
        <thead><tr><th>When</th><th>Type</th><th>Event</th><th>Recipient</th><th class="num">Eligible</th><th class="num">Queued</th><th class="num">Sent</th><th class="num">Failed</th><th class="num">Waiting</th><th>By</th></tr></thead>
        <tbody>${args.batches.map(
          (b) => html`<tr><td>${fmtDate(b.createdAt)}</td>
            <td>${b.kind === 'COLLEGE_EACH' ? 'Each student, own email' : 'All passes to one student'}</td>
            <td>${b.eventSlug ? eventName(b.eventSlug) : 'all'}</td>
            <td>${b.recipientEmail ? html`${b.recipientPerson?.name ?? ''} ${b.recipientEmail}` : html`<span class="muted">each student</span>`}</td>
            <td class="num">${b.eligibleCount}</td><td class="num">${b.queuedCount}</td><td class="num">${b.sent}</td>
            <td class="num">${b.failed ? html`<span class="error-text">${b.failed}</span>` : 0}</td><td class="num">${b.pending}</td>
            <td>${who(b.triggeredBy)}</td></tr>`,
        )}</tbody></table></div></section>`
      : null
  }

  <section class="card">
    <h2>Participants (${registrations.length})</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th>${event ? null : html`<th>Event</th>`}<th>Contact</th><th>Roll no.</th><th>Status</th><th>Gate</th><th>QR email</th></tr></thead>
      <tbody>${registrations.map(
        (r) => html`<tr>
          <td><a href="/admin/registrations/${r.id}">${r.person.name ?? r.person.email}</a></td>
          ${event ? null : html`<td>${eventName(r.eventSlug)}</td>`}
          <td class="small">${r.person.email}<br>${r.person.phone}</td>
          <td class="small">${r.person.rollNumber}</td>
          <td>${paymentBadge(r.paymentStatus)} ${blockedBadge(r.person)}</td>
          <td>${presenceBadge(r)}</td>
          <td>${qrCell(r, args.qr.get(r.id), csrf)}</td>
        </tr>`,
      )}</tbody>
    </table></div>
  </section>`;
}

export function entriesPage(args: {
  event: string | undefined;
  page: number;
  list: EntryList;
  events: EventSummary;
  counters: Counters;
  eventName: EventName;
}): SafeHtml {
  const { event, page, list, events, eventName } = args;
  return html`<div class="with-sidebar">
    ${eventSidebar(events, event, eventName, '/admin/entries')}
    <div class="content">
      <h1>Gate log${event ? html`: ${eventName(event)}` : null}</h1>
      ${countersBar(args.counters)}
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Time</th><th>Participant</th>${event ? null : html`<th>Event</th>`}<th>Action</th><th>Result</th><th>Gate</th><th>Staff</th></tr></thead>
        <tbody>
          ${list.logs.map(
            (l) => html`<tr>
              <td class="small">${fmtDate(l.enteredAt)}</td>
              <td>${l.registrationId ? html`<a href="/admin/registrations/${l.registrationId}">${l.person.name}</a>` : l.person.name}<br><span class="muted small">${l.person.email}</span></td>
              ${event ? null : html`<td>${eventName(l.eventSlug)}</td>`}
              <td>${l.kind === EntryKind.CHECK_IN ? 'IN' : 'OUT'}</td>
              <td>${l.status === 'ENTERED' ? badge(l.kind === EntryKind.CHECK_IN ? 'Checked in' : 'Checked out', 'ok') : badge(`Refused: ${l.notes ?? ''}`, 'bad')}</td>
              <td>${l.gate}</td>
              <td class="small">${who(l.volunteer)}</td>
            </tr>`,
          )}
          ${list.logs.length === 0 ? html`<tr><td colspan="7" class="muted center">No scans yet.</td></tr>` : null}
        </tbody>
      </table>
      </div>
      ${pager({ event }, page, list.total, '/admin/entries')}
    </div>
  </div>`;
}

/**
 * Expected arrivals/departures for one day. "Expected" = the participant's planned date from
 * the form; the arrived / checked-out / inside columns come only from actual QR gate scans.
 */
export function expectedPage(args: {
  kind: ExpectedKind;
  day: Date;
  today: string;
  tomorrow: string;
  list: ExpectedList;
  event?: string;
  college?: string;
  events: EventSummary;
  colleges: { id: string; name: string }[];
  eventName: EventName;
}): SafeHtml {
  const { kind, day, list, event, college, eventName } = args;
  const arrivals = kind === 'arrival';
  const path = arrivals ? '/admin/arrivals' : '/admin/departures';
  const iso = isoDay(day);
  const title = arrivals ? 'Expected arrivals' : 'Expected departures';
  const sum = (x: ExpectedSummary) =>
    arrivals
      ? [
          ['Expected arrivals', x.expected],
          ['Already arrived', x.arrived],
          ['Not arrived yet', x.notArrived],
          ['Blocked', x.blocked],
        ]
      : [
          ['Expected departures', x.expected],
          ['Checked out', x.checkedOut],
          ['Still inside', x.stillInside],
          ['Never arrived', x.notArrived],
          ['Blocked', x.blocked],
        ];
  const keep = { event, college };
  return html`<div class="chips">
      <a class="chip ${arrivals ? 'active' : ''}" href="/admin/arrivals${buildQuery({ ...keep, date: iso })}">Expected arrivals</a>
      <a class="chip ${arrivals ? '' : 'active'}" href="/admin/departures${buildQuery({ ...keep, date: iso })}">Expected departures</a>
    </div>
    <h1>${title}: ${fmtDay(day)}</h1>
    <p class="muted small">"Expected" is the participant's planned date from the form (${arrivals ? 'Check In Date' : 'Check Out Date'}).
      ${arrivals ? 'Arrived = checked in with the QR at least once.' : 'Checked out / still inside = actual QR gate scans.'}</p>
    <form method="get" action="${path}" class="row-form">
      <label>Date <input type="date" name="date" value="${iso}" required></label>
      <label>Event <select name="event"><option value="">All events</option>
        ${args.events.map((e) => html`<option value="${e.slug}" ${e.slug === event ? 'selected' : ''}>${eventName(e.slug)}</option>`)}</select></label>
      <label>College <select name="college"><option value="">All colleges</option>
        ${args.colleges.map((c) => html`<option value="${c.id}" ${c.id === college ? 'selected' : ''}>${c.name}</option>`)}</select></label>
      <button>Show</button>
      <a href="${path}${buildQuery({ ...keep, date: args.today })}">Today</a>
      <a href="${path}${buildQuery({ ...keep, date: args.tomorrow })}">Tomorrow</a>
    </form>
    <div class="counters">${sum(list.summary).map(
      ([label, value]) => html`<div class="counter"><div class="label">${label}</div><div class="value">${value}</div></div>`,
    )}</div>

    ${
      list.colleges.length > 1
        ? html`<section class="card"><h2>By college</h2><div class="table-wrap"><table class="table small">
          <thead><tr><th>College</th>${sum(list.summary).map(([label]) => html`<th class="num">${label}</th>`)}</tr></thead>
          <tbody>${list.colleges.map(
            (c) => html`<tr><td>${c.id ? html`<a href="${path}${buildQuery({ event, college: c.id, date: iso })}">${c.name}</a>` : c.name}</td>
              ${sum(c.summary).map(([, value]) => html`<td class="num">${value}</td>`)}</tr>`,
          )}</tbody></table></div></section>`
        : null
    }

    <section class="card"><div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>College</th><th>Event</th>${arrivals ? html`<th>Mobile</th>` : null}
        <th>${arrivals ? 'Expected arrival' : 'Expected departure'}</th>
        <th>${arrivals ? 'Actual IN' : 'Actual OUT'}</th><th>Now</th><th>Status</th></tr></thead>
      <tbody>
        ${list.rows.map(
          (r) => html`<tr>
            <td><a href="/admin/registrations/${r.id}">${r.person.name ?? r.person.email}</a></td>
            <td class="small">${r.person.college}</td>
            <td class="small">${eventName(r.eventSlug)}</td>
            ${arrivals ? html`<td class="small">${r.person.phone}</td>` : null}
            <td class="small">${fmtDay(arrivals ? r.expectedArrivalDate : r.expectedDepartureDate)}</td>
            <td class="small">${
              arrivals
                ? r.enteredAt
                  ? html`${badge('Arrived', 'ok')}<br>${fmtExact(r.enteredAt)}`
                  : html`<span class="muted">Not arrived</span>`
                : r.lastCheckOutAt && !r.insideSince
                  ? html`${badge('Checked out', 'ok')}<br>${fmtExact(r.lastCheckOutAt)}`
                  : html`<span class="muted">Not checked out</span>`
            }</td>
            <td>${presenceBadge(r)}</td>
            <td>${paymentBadge(r.paymentStatus)} ${blockedBadge(r.person)}</td>
          </tr>`,
        )}
        ${list.rows.length === 0 ? html`<tr><td colspan="8" class="muted center">No one has this planned date.</td></tr>` : null}
      </tbody>
    </table></div></section>`;
}

const REPORT_EMAIL: Record<ReportEmailStatus, [string, BadgeTone]> = {
  NO_EMAIL: ['No email address', 'muted'],
  NOT_QUEUED: ['Not queued', 'muted'],
  QUEUED: ['Queued', 'warn'],
  SENDING: ['Sending', 'warn'],
  SENT: ['Sent (accepted by mail server)', 'ok'],
  DELIVERED: ['Delivered', 'ok'],
  DELAYED: ['Sent, delivery delayed', 'warn'],
  FAILED: ['Failed', 'bad'],
  BOUNCED: ['Bounced after sending', 'bad'],
  CANCELLED: ['Cancelled (verification undone/rejected)', 'muted'],
};

const OUTCOME_BADGE: Record<string, BadgeTone> = { VERIFIED: 'ok', SKIPPED: 'muted', FAILED: 'bad' };

/** Admin report of bulk verifications and their QR emails, for a day / date range. */
export function verificationReportPage(args: { from: Date; to: Date; batches: VerificationBatches }): SafeHtml {
  const { batches } = args;
  const sum = (pick: (b: VerificationBatches[number]) => number) => batches.reduce((n, b) => n + pick(b), 0);
  const tile = (label: string, value: number, tone = '') => html`<div class="counter ${tone}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  const range = isoDay(args.from) === isoDay(args.to) ? fmtDay(args.from) : `${fmtDay(args.from)} to ${fmtDay(args.to)}`;
  return html`<h1>Verification log</h1>
    <form method="get" action="/admin/verification-report" class="row-form search">
      <label class="small">From <input type="date" name="from" value="${isoDay(args.from)}"></label>
      <label class="small">To <input type="date" name="to" value="${isoDay(args.to)}"></label>
      <button>Show</button>
      <a href="/admin/verification-report">Today</a>
    </form>
    <p class="muted">${range} (India time): ${batches.length} bulk verification(s). Email progress is read live from the email queue.</p>
    <div class="counters">
      ${tile('Selected', sum((b) => b.selectedCount))}
      ${tile('Verified', sum((b) => b.verifiedCount), 'ok')}
      ${tile('Skipped', sum((b) => b.skippedCount))}
      ${tile('Failed', sum((b) => b.failedCount), sum((b) => b.failedCount) ? 'bad' : '')}
      ${tile('QR emails queued', sum((b) => b.qrEmailsQueued), 'info')}
      ${tile('Emails sent', sum((b) => b.email.sent), 'ok')}
      ${tile('Emails pending', sum((b) => b.email.pending), 'warn')}
      ${tile('Email failures', sum((b) => b.email.failed), sum((b) => b.email.failed) ? 'bad' : '')}
      ${tile('No email', sum((b) => b.noEmailCount))}
    </div>
    <div class="table-wrap">
    <table class="table rows-clickable">
      <thead><tr><th>Date / time</th><th>By</th><th class="num">Selected</th><th class="num">Verified</th><th class="num">Skipped</th><th class="num">Failed</th><th class="num">QR queued</th><th class="num">Sent</th><th class="num">Pending</th><th class="num">Email failed</th><th class="num">No email</th></tr></thead>
      <tbody>
        ${batches.map(
          (b) => html`<tr data-href="/admin/verification-report/${b.id}">
            <td><a href="/admin/verification-report/${b.id}">${fmtExact(b.createdAt)}</a></td><td class="small">${who(b.triggeredBy)}</td>
            <td class="num">${b.selectedCount}</td><td class="num">${b.verifiedCount}</td><td class="num">${b.skippedCount}</td><td class="num">${b.failedCount}</td>
            <td class="num">${b.qrEmailsQueued}</td><td class="num">${b.email.sent}</td><td class="num">${b.email.pending}</td><td class="num">${b.email.failed}</td><td class="num">${b.noEmailCount}</td>
          </tr>`,
        )}
        ${batches.length === 0 ? html`<tr><td colspan="11" class="muted center">No bulk verifications in this period.</td></tr>` : null}
      </tbody>
    </table>
    </div>`;
}

/** One bulk verification: totals and every registration with its verification and email status. */
export function verificationBatchPage(args: { batch: VerificationBatchDetail; eventName: EventName }): SafeHtml {
  const { batch, eventName } = args;
  const tile = (label: string, value: number, tone = '') => html`<div class="counter ${tone}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  return html`<p class="small"><a href="/admin/verification-report">← Verification log</a></p>
    <h1>Bulk verification</h1>
    <p class="muted">${fmtExact(batch.createdAt)} by ${who(batch.triggeredBy)} · <span class="mono small">${batch.id}</span></p>
    <div class="counters">
      ${tile('Selected', batch.selectedCount)}
      ${tile('Verified', batch.verifiedCount, 'ok')}
      ${tile('Skipped', batch.skippedCount)}
      ${tile('Failed', batch.failedCount, batch.failedCount ? 'bad' : '')}
      ${tile('QR emails queued', batch.qrEmailsQueued, 'info')}
      ${tile('Emails sent', batch.email.sent, 'ok')}
      ${tile('Emails pending', batch.email.pending, 'warn')}
      ${tile('Email failures', batch.email.failed, batch.email.failed ? 'bad' : '')}
      ${tile('No email', batch.noEmailCount)}
    </div>
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>Participant</th><th>Email</th><th>Event</th><th>Verification</th><th>Email status</th><th>Queued</th><th>Sent</th><th>Reason / error</th></tr></thead>
      <tbody>
        ${batch.items.map((i) => {
          const [label, tone] = REPORT_EMAIL[reportEmailStatus(i)];
          const row = i.emailOutbox;
          return html`<tr>
            <td>${i.registrationId ? html`<a href="/admin/registrations/${i.registrationId}">${i.personName ?? 'Participant'}</a>` : i.personName ?? html`<span class="muted">unknown</span>`}${i.selected ? null : html`<br><span class="muted small">teammate (not selected)</span>`}</td>
            <td class="small">${i.email ?? html`<span class="muted">none</span>`}</td>
            <td class="small">${i.eventSlug ? eventName(i.eventSlug) : ''}</td>
            <td>${badge(i.outcome.charAt(0) + i.outcome.slice(1).toLowerCase(), OUTCOME_BADGE[i.outcome])}${i.registration && i.registration.paymentStatus !== PaymentStatus.VERIFIED && i.outcome === 'VERIFIED' ? html`<br><span class="muted small">now ${i.registration.paymentStatus.toLowerCase()}</span>` : null}</td>
            <td>${badge(label, tone)}</td>
            <td class="small">${row ? fmtExact(row.sendAt > row.createdAt ? row.sendAt : row.createdAt) : ''}</td>
            <td class="small">${row?.sentAt ? fmtExact(row.sentAt) : ''}</td>
            <td class="small">${i.reason ?? ''}${row?.status === 'FAILED' && row.lastError ? html`${i.reason ? html`<br>` : null}<span class="error-text">${row.lastError}</span>` : null}</td>
          </tr>`;
        })}
      </tbody>
    </table>
    </div>`;
}
