import { PaymentStatus, StaffRole } from '@prisma/client';
import { AuthStaff } from '../auth/auth.service';
import { Flash } from './cookies';
import { SafeHtml, html } from './html';

export interface PageOptions {
  title: string;
  body: SafeHtml;
  staff?: AuthStaff;
  csrf?: string;
  flash?: Flash;
  scripts?: string[];
  /** Highlights the current nav item. */
  section?: 'registrations' | 'entries' | 'scan' | 'staff';
}

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Fest-local time (IST), e.g. "10 Oct, 10:32". */
export const fmtDate = (d: Date | null | undefined) => (d ? dateFormat.format(d) : '');

export function csrfField(csrf: string | undefined) {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

export function badge(text: string, tone: BadgeTone) {
  return html`<span class="badge badge-${tone}">${text}</span>`;
}

export function paymentBadge(status: PaymentStatus | 'MIXED') {
  switch (status) {
    case 'VERIFIED':
      return badge('Verified', 'ok');
    case 'REJECTED':
      return badge('Rejected', 'bad');
    case 'MIXED':
      return badge('Partly verified', 'warn');
    default:
      return badge('Pending', 'warn');
  }
}

function nav(staff: AuthStaff, csrf: string | undefined, section: PageOptions['section']) {
  const manage = staff.role !== StaffRole.VOLUNTEER;
  const item = (key: PageOptions['section'], href: string, label: string) =>
    html`<a href="${href}" class="${section === key ? 'active' : ''}">${label}</a>`;
  return html`<nav class="topnav">
    <span class="brand">Infinito 2K26</span>
    ${manage ? item('registrations', '/admin/registrations', 'Registrations') : null}
    ${manage ? item('entries', '/admin/entries', 'Entries') : null}
    ${item('scan', '/scan', 'Scan')}
    ${staff.role === StaffRole.ADMIN ? item('staff', '/admin/staff', 'Staff') : null}
    <span class="spacer"></span>
    <span class="who">${staff.name || staff.email} · ${staff.role.toLowerCase()}</span>
    <form method="post" action="/logout" class="inline">${csrfField(csrf)}<button class="link">Sign out</button></form>
  </nav>`;
}

export function page(opts: PageOptions): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.title} · Infinito 2K26</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
${opts.staff ? nav(opts.staff, opts.csrf, opts.section) : null}
<main>
${opts.flash ? html`<div class="flash flash-${opts.flash.type}" role="status">${opts.flash.text}</div>` : null}
${opts.body}
</main>
${(opts.scripts ?? []).map((src) => html`<script src="${src}"></script>`)}
</body>
</html>`.toString();
}
