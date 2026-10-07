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
  section?: NavSection;
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

const exactFormat = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Exact gate time (IST, seconds), e.g. "05 Oct 2026, 14:05:09". */
export const fmtExact = (d: Date | null | undefined) => (d ? exactFormat.format(d) : '');

const dayFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

/** A DATE column (planned day, stored as UTC midnight), e.g. "05 Oct 2026". */
export const fmtDay = (d: Date | null | undefined) => (d ? dayFormat.format(d) : '');

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

export type NavSection =
  | 'registrations'
  | 'inside'
  | 'outside'
  | 'entered'
  | 'blocked'
  | 'colleges'
  | 'expected'
  | 'entries'
  | 'scan'
  | 'find'
  | 'verifications'
  | 'aadhaar'
  | 'staff';

/**
 * Navigation per role. This only decides what is shown; every target route is also protected
 * on the server (@Roles / StaffGuard), so a hidden item is never the only barrier.
 *   ADMIN:       Dashboard, Inside, Outside, Ever entered, Blocked, Arrivals, Gate log, Colleges, Scan,
 *                Verification log, Aadhaar duplicates, Staff
 *   COORDINATOR: the same without Staff
 *   VOLUNTEER:   Scan, Find participant
 */
export function navItems(role: StaffRole): { key: NavSection; href: string; label: string }[] {
  if (role === StaffRole.VOLUNTEER) {
    return [
      { key: 'scan', href: '/scan', label: 'Scan' },
      { key: 'find', href: '/scan/find', label: 'Find participant' },
    ];
  }
  return [
    { key: 'registrations', href: '/admin/registrations', label: 'Dashboard' },
    { key: 'inside', href: '/admin/registrations?status=inside', label: 'Inside' },
    { key: 'outside', href: '/admin/registrations?status=outside', label: 'Outside' },
    { key: 'entered', href: '/admin/registrations?status=entered', label: 'Ever entered' },
    { key: 'blocked', href: '/admin/registrations?status=blocked', label: 'Blocked' },
    { key: 'expected', href: '/admin/arrivals', label: 'Arrivals' },
    { key: 'entries', href: '/admin/entries', label: 'Gate log' },
    { key: 'colleges', href: '/admin/colleges', label: 'Colleges' },
    { key: 'scan', href: '/scan', label: 'Scan' },
    ...(role === StaffRole.ADMIN
      ? [
          { key: 'verifications' as const, href: '/admin/verification-report', label: 'Verification log' },
          { key: 'aadhaar' as const, href: '/admin/aadhaar-duplicates', label: 'Aadhaar duplicates' },
          { key: 'staff' as const, href: '/admin/staff', label: 'Staff' },
        ]
      : []),
  ];
}

function nav(staff: AuthStaff, csrf: string | undefined, section: PageOptions['section']) {
  const item = (key: PageOptions['section'], href: string, label: string) =>
    html`<a href="${href}" class="${section === key ? 'active' : ''}">${label}</a>`;
  return html`<nav class="topnav">
    <span class="brand">Infinito 2K26</span>
    ${navItems(staff.role).map((i) => item(i.key, i.href, i.label))}
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
