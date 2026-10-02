import { ActivityType, EmailDeliveryStatus, EmailStatus, PaymentStatus } from '@prisma/client';
import { EmailTemplate } from '../emails/email-templates';
import { QrEmailSummary } from '../emails/qr-email.service';
import { SafeHtml, html } from '../web/html';
import { BadgeTone, badge, csrfField, fmtDate, paymentBadge } from '../web/layout';
import { AdminQueryService, PAGE_SIZE, TeamFilters, teamPaymentState } from './admin-query.service';

type EventSummary = Awaited<ReturnType<AdminQueryService['eventSummary']>>;
type TeamList = Awaited<ReturnType<AdminQueryService['listTeams']>>;
type TeamDetail = NonNullable<Awaited<ReturnType<AdminQueryService['teamDetail']>>>;
type EntryList = Awaited<ReturnType<AdminQueryService['entries']>>;
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

export function eventSidebar(events: EventSummary, current: string | undefined, eventName: EventName, path: string) {
  const all = events.reduce((n, e) => n + e.teams, 0);
  const allPending = events.reduce((n, e) => n + e.pendingTeams, 0);
  return html`<aside class="events">
    <h2>Events</h2>
    <a href="${path}" class="${!current ? 'active' : ''}">All events <span class="count">${all}</span>${allPending ? html`<span class="pending">${allPending}</span>` : null}</a>
    ${events.map(
      (e) => html`<a href="${path}${buildQuery({ event: e.slug })}" class="${current === e.slug ? 'active' : ''}">
        ${eventName(e.slug)} <span class="count">${e.teams}</span>${e.pendingTeams ? html`<span class="pending" title="Awaiting verification">${e.pendingTeams}</span>` : null}
      </a>`,
    )}
    ${events.length === 0 ? html`<p class="muted small">No registrations yet.</p>` : null}
  </aside>`;
}

export function registrationsPage(args: {
  filters: TeamFilters;
  list: TeamList;
  events: EventSummary;
  eventName: EventName;
}): SafeHtml {
  const { filters, list, events, eventName } = args;
  const current = events.find((e) => e.slug === filters.event);
  const base = { event: filters.event, q: filters.q, status: filters.status };
  const chip = (status: PaymentStatus | undefined, label: string, count: number) =>
    html`<a class="chip ${filters.status === status ? 'active' : ''}" href="/admin/registrations${buildQuery({ ...base, status, page: undefined })}">${label} <b>${count}</b></a>`;

  return html`<div class="with-sidebar">
    ${eventSidebar(events, filters.event, eventName, '/admin/registrations')}
    <div class="content">
      <h1>${filters.event ? eventName(filters.event) : 'All registrations'}</h1>
      ${current ? html`<p class="muted">${current.teams} teams · ${current.participants} participants · ${current.entered} entered</p>` : null}
      <form method="get" action="/admin/registrations" class="row-form search">
        ${filters.event ? html`<input type="hidden" name="event" value="${filters.event}">` : null}
        ${filters.status ? html`<input type="hidden" name="status" value="${filters.status}">` : null}
        <input type="search" name="q" value="${filters.q ?? ''}" placeholder="Name, email, team, transaction ID or registration ID">
        <button>Search</button>
        ${filters.q ? html`<a href="/admin/registrations${buildQuery({ event: filters.event, status: filters.status })}">Clear</a>` : null}
      </form>
      <div class="chips">
        ${chip(undefined, 'All', list.statusCounts.all)}
        ${chip(PaymentStatus.PENDING, 'Pending', list.statusCounts.PENDING)}
        ${chip(PaymentStatus.VERIFIED, 'Verified', list.statusCounts.VERIFIED)}
        ${chip(PaymentStatus.REJECTED, 'Rejected', list.statusCounts.REJECTED)}
      </div>
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Team</th>${filters.event ? null : html`<th>Event</th>`}<th>Captain</th><th>Members</th><th>Transaction ID</th><th>Payment</th><th>Submitted</th></tr></thead>
        <tbody>
          ${list.teams.map((t) => {
            const txn = t.registrations.find((r) => r.transactionId)?.transactionId;
            const entered = t.registrations.filter((r) => r.enteredAt).length;
            const captain = t.registrations.find((r) => r.person.email === t.captainEmail) ?? t.registrations[0];
            return html`<tr>
              <td><a href="/admin/teams/${t.id}">${t.name}</a></td>
              ${filters.event ? null : html`<td>${eventName(t.eventSlug)}</td>`}
              <td>${captain?.person.name}<br><span class="muted small">${captain?.person.email}</span></td>
              <td>${t.registrations.length}${entered ? html` <span class="muted small">(${entered} in)</span>` : null}</td>
              <td class="mono">${txn ?? html`<span class="muted">none</span>`}${txn && list.duplicateTxns.has(txn) ? html` ${badge('Duplicate', 'bad')}` : null}</td>
              <td>${paymentBadge(teamPaymentState(t.registrations))}</td>
              <td class="small">${fmtDate(t.createdAt)}</td>
            </tr>`;
          })}
          ${list.teams.length === 0 ? html`<tr><td colspan="7" class="muted center">No registrations match.</td></tr>` : null}
        </tbody>
      </table>
      </div>
      ${pager(base, filters.page, list.total, '/admin/registrations')}
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

function qrCell(
  reg: TeamDetail['team']['registrations'][number],
  summary: QrEmailSummary | undefined,
  csrf: string,
) {
  if (reg.paymentStatus !== PaymentStatus.VERIFIED || !summary) return html`<span class="muted small">after verification</span>`;
  const canResend = !summary.queued && summary.manualResendsUsed < summary.manualResendLimit;
  return html`<div class="small">
      <div>Sent <b>${summary.sentCount}</b>×${summary.lastSentAt ? html` · last ${fmtDate(summary.lastSentAt)}` : null}</div>
      ${summary.lastDeliveryStatus ? html`<div>${deliveryBadge(EmailStatus.SENT, summary.lastDeliveryStatus)}</div>` : null}
      ${summary.queued ? html`<div>${badge('queued', 'info')} sends ${fmtDate(summary.queued.sendAt)}</div>` : null}
      ${summary.lastFailure ? html`<div class="error-text">Failed: ${summary.lastFailure}</div>` : null}
      <div class="muted">Manual resends ${summary.manualResendsUsed}/${summary.manualResendLimit}</div>
    </div>
    ${
      canResend
        ? html`<form method="post" action="/admin/registrations/${reg.id}/resend-qr" class="inline">${csrfField(csrf)}<button class="small">Resend QR email</button></form>`
        : null
    }`;
}

function activityText(a: TeamDetail['activity'][number]): SafeHtml {
  const d = (a.details ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case ActivityType.SUBMITTED:
      return html`Submitted via form${d.sourceRow ? ` (sheet row ${String(d.sourceRow)})` : ''}`;
    case ActivityType.UPDATED:
      return html`Form response re-synced${d.movedFromTeamId ? ' · moved from another team' : ''}${d.transactionId !== undefined ? ` · txn now ${String(d.transactionId)}` : ''}${d.paymentResetFromRejected ? ' · back to pending' : ''}`;
    case ActivityType.PAYMENT_VERIFIED:
      return html`<b>Payment verified</b>`;
    case ActivityType.PAYMENT_REJECTED:
      return html`<b>Payment rejected</b>: ${String(d.remarks ?? '')}`;
    case ActivityType.PAYMENT_UNVERIFIED:
      return html`Verification undone`;
    case ActivityType.QR_EMAIL_QUEUED:
      return html`QR email queued`;
    case ActivityType.QR_EMAIL_RESENT:
      return html`QR email resent manually (${String(d.resend)}/${String(d.limit)})`;
    case ActivityType.ENTERED:
      return html`<b>Entered</b>${d.gate ? ` at ${String(d.gate)}` : ''}`;
    case ActivityType.ENTRY_DENIED:
      return html`Entry refused: ${String(d.reason ?? '')}${d.gate ? ` (${String(d.gate)})` : ''}`;
    default:
      return html`${String(a.type)}`;
  }
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
  <p class="muted">${eventName(team.eventSlug)} · ${regs.length} member(s) · ${entered}/${regs.length} entered${entered === regs.length ? ' · team entered' : ''} · submitted ${fmtDate(team.createdAt)} · <span class="mono small">${team.id}</span></p>

  <section class="card">
    <h2>Payment</h2>
    <dl class="facts">
      <dt>Transaction ID</dt><dd class="mono">${txn ?? html`<span class="muted">none given</span>`}</dd>
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
    <div class="actions">
      ${
        state !== PaymentStatus.VERIFIED
          ? html`<form method="post" action="/admin/teams/${team.id}/verify" class="inline">${csrfField(csrf)}
              <button class="primary" ${verifiedClash ? 'disabled' : ''}>Verify payment</button></form>`
          : null
      }
      ${
        canUndo
          ? html`<form method="post" action="/admin/teams/${team.id}/undo" class="inline">${csrfField(csrf)}
              <button>Undo verification</button></form>`
          : null
      }
    </div>
    ${
      entered === 0
        ? html`<form method="post" action="/admin/teams/${team.id}/reject" class="stack reject">${csrfField(csrf)}
            <label>Rejection reason (sent to the captain)
              <textarea name="remarks" required maxlength="500" rows="2" placeholder="e.g. Amount short by ₹200 / transaction ID not found in statement">${state === PaymentStatus.REJECTED ? regs[0]?.paymentRemarks : ''}</textarea></label>
            <button class="danger">${state === PaymentStatus.REJECTED ? 'Update rejection' : 'Reject payment'}</button>
          </form>`
        : null
    }
    <p class="muted small">QR and payment-issue emails wait ${args.delaySeconds}s before sending, so a mis-click can be undone.</p>
  </section>

  <section class="card">
    <h2>Members</h2>
    <div class="table-wrap">
    <table class="table">
      <thead><tr><th>Participant</th><th>Contact</th><th>Files</th><th>Payment</th><th>QR email</th><th>Entry</th></tr></thead>
      <tbody>
        ${regs.map(
          (r) => html`<tr>
            <td><b>${r.person.name}</b>${r.person.email === team.captainEmail ? html` ${badge('Captain', 'info')}` : null}<br><span class="small">${r.person.college}</span><br><span class="mono small muted">${r.id}</span></td>
            <td class="small">${r.person.email}${r.person.emailBouncedAt ? html`<br>${badge('Email bounced', 'bad')} <span class="error-text">${r.person.emailBounceReason}</span>` : null}<br>${r.person.phone}</td>
            <td class="small">${
              driveEnabled
                ? html`${r.person.photoDriveId ? html`<a href="/staff/files/${r.person.id}/photo" target="_blank" rel="noopener">Photo</a>` : html`<span class="muted">no photo</span>`}<br>
                   ${r.person.idDocumentDriveId ? html`<a href="/staff/files/${r.person.id}/id" target="_blank" rel="noopener">ID</a>` : html`<span class="muted">no ID</span>`}`
                : html`<span class="muted">Drive not configured</span>`
            }</td>
            <td>${paymentBadge(r.paymentStatus)}</td>
            <td>${qrCell(r, qr.get(r.id), csrf)}</td>
            <td class="small">${
              r.enteredAt
                ? html`${badge('Entered', 'ok')}<br>${fmtDate(r.enteredAt)} by ${who(r.enteredBy)}${r.entryLogs[0]?.gate ? html`<br>${r.entryLogs[0].gate}` : null}`
                : html`<span class="muted">not yet</span>`
            }</td>
          </tr>`,
        )}
      </tbody>
    </table>
    </div>
  </section>

  <section class="card">
    <h2>Emails</h2>
    ${
      emails.length
        ? html`<div class="table-wrap"><table class="table small">
            <thead><tr><th>Email</th><th>To</th><th>Status</th><th>Sent</th><th>Triggered by</th></tr></thead>
            <tbody>${emails.map(
              (e) => html`<tr>
                <td>${e.template}</td><td>${e.toEmail}</td>
                <td>${deliveryBadge(e.status, e.deliveryStatus)}${e.lastError && e.status !== EmailStatus.SENT ? html`<br><span class="error-text">${e.lastError}</span>` : null}</td>
                <td>${fmtDate(e.sentAt) || (e.status === EmailStatus.PENDING ? html`<span class="muted">at ${fmtDate(e.sendAt)}</span>` : null)}</td>
                <td>${e.triggeredBy ? who(e.triggeredBy) : html`<span class="muted">automatic</span>`}</td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<p class="muted">No emails yet.</p>`
    }
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

export function entriesPage(args: {
  event: string | undefined;
  page: number;
  list: EntryList;
  events: Awaited<ReturnType<AdminQueryService['eventSummary']>>;
  eventName: EventName;
}): SafeHtml {
  const { event, page, list, events, eventName } = args;
  const current = events.find((e) => e.slug === event);
  return html`<div class="with-sidebar">
    ${eventSidebar(events, event, eventName, '/admin/entries')}
    <div class="content">
      <h1>Entries${event ? html`: ${eventName(event)}` : null}</h1>
      ${current ? html`<p class="muted">${current.entered} of ${current.participants} participants entered</p>` : null}
      <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Time</th><th>Participant</th><th>Team</th>${event ? null : html`<th>Event</th>`}<th>Result</th><th>Gate</th><th>Volunteer</th></tr></thead>
        <tbody>
          ${list.logs.map(
            (l) => html`<tr>
              <td class="small">${fmtDate(l.enteredAt)}</td>
              <td>${l.person.name}<br><span class="muted small">${l.person.email}</span></td>
              <td>${l.registration?.team ? html`<a href="/admin/teams/${l.registration.team.id}">${l.registration.team.name}</a>` : null}</td>
              ${event ? null : html`<td>${eventName(l.eventSlug)}</td>`}
              <td>${l.status === 'ENTERED' ? badge('Entered', 'ok') : badge(`Refused: ${l.notes ?? ''}`, 'bad')}</td>
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

