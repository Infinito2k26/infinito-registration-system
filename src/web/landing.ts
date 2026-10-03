import { html } from './html';

const MAIN_SITE = 'https://infinito2k26.com/';
const INSTAGRAM = 'https://www.instagram.com/infinito_iitp/';

const FEATURES: { title: string; text: string }[] = [
  {
    title: 'Participant Registration',
    text: 'Registrations submitted through the official Infinito forms are collected in one place for the organising team.',
  },
  {
    title: 'Registration Verification',
    text: 'Authorised staff review each registration before a participant receives an entry pass.',
  },
  {
    title: 'QR Pass Management',
    text: 'Verified participants receive a personal QR entry pass by email.',
  },
  {
    title: 'Entry & Exit Tracking',
    text: 'At the venue gates, staff scan QR passes to record entry and exit.',
  },
  {
    title: 'Staff Operations',
    text: 'Coordinators and volunteers sign in to carry out the tasks assigned to their role.',
  },
];

/**
 * Public landing page for "/" (signed-out visitors). Static content only: no participant,
 * staff or system data is read or shown. Styles live in /assets/landing.css, scoped to
 * `.landing`, so no other page is affected.
 */
export function landingPage(): string {
  const external = (href: string, label: string) =>
    html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}<span class="sr-only"> (opens in a new tab)</span></a>`;

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Infinito 2K26 · Registration System</title>
<meta name="description" content="Infinito 2K26 Registration System: participant registration, verification, QR pass management and entry/exit operations.">
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/landing.css">
</head>
<body class="landing">
<a class="skip-link" href="#main">Skip to content</a>
<header class="lp-header">
  <div class="lp-wrap lp-header-row">
    <a class="lp-brand" href="/" aria-label="Infinito 2K26 home">Infinito <span>2K26</span></a>
    <a class="lp-btn lp-btn-ghost" href="/login">Staff Login</a>
  </div>
</header>

<main id="main">
  <section class="lp-hero" aria-labelledby="hero-title">
    <div class="lp-wrap">
      <p class="lp-eyebrow">IIT Patna</p>
      <h1 id="hero-title">Infinito 2K26</h1>
      <p class="lp-subtitle">Registration System</p>
      <p class="lp-lead">Welcome to the Infinito 2K26 Registration System, the portal for participant registration, verification, QR pass management and entry/exit operations.</p>
      <a class="lp-btn lp-btn-primary" href="/login">Admin / Staff Login</a>
    </div>
  </section>

  <section class="lp-section" aria-labelledby="welcome-title">
    <div class="lp-wrap lp-narrow">
      <h2 id="welcome-title">Welcome to Infinito 2K26 Registration System</h2>
      <p>This portal is used by authorised Infinito staff to manage participant registrations, verify them, issue QR entry passes and record entry and exit at the venue.</p>
      <p>Participants register through the official Infinito registration forms. After verification, each participant receives a personal QR pass by email to present at the gate.</p>
    </div>
  </section>

  <section class="lp-section lp-alt" aria-labelledby="features-title">
    <div class="lp-wrap">
      <h2 id="features-title">What the system covers</h2>
      <ul class="lp-cards">
        ${FEATURES.map((f) => html`<li class="lp-card"><h3>${f.title}</h3><p>${f.text}</p></li>`)}
      </ul>
    </div>
  </section>

  <section class="lp-section" aria-labelledby="staff-title">
    <div class="lp-wrap lp-narrow lp-staff">
      <h2 id="staff-title">Staff Portal</h2>
      <p>Authorized Infinito staff can access participant verification and entry/exit operations.</p>
      <a class="lp-btn lp-btn-primary" href="/login">Staff Login →</a>
    </div>
  </section>
</main>

<footer class="lp-footer">
  <div class="lp-wrap lp-footer-grid">
    <div>
      <p class="lp-footer-brand">Infinito 2K26</p>
      <p>IIT Patna</p>
      <p class="lp-muted">Registration &amp; Entry-Exit Management System</p>
    </div>
    <nav aria-label="Footer">
      <ul class="lp-links">
        <li>${external(MAIN_SITE, 'Main Infinito Website')}</li>
        <li>${external(INSTAGRAM, 'Instagram')}</li>
        <li><a href="/login">Staff Login</a></li>
      </ul>
    </nav>
  </div>
  <div class="lp-wrap"><p class="lp-copy">© 2026 Infinito 2K26, IIT Patna. All rights reserved.</p></div>
</footer>
</body>
</html>`.toString();
}
