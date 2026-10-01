import { Body, Controller, Get, Param, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { PaymentStatus, StaffRole } from '@prisma/client';
import { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { StaffRequest } from '../auth/auth.types';
import { StaffGuard } from '../auth/staff.guard';
import { AppConfig } from '../config/app-config.service';
import { DriveService } from '../drive/drive.service';
import { setFlash, takeFlash } from '../web/cookies';
import { html } from '../web/html';
import { csrfField, fmtDate, page, paymentBadge } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { EntryService } from './entry.service';

/** Pulls the token out of a scanned/pasted pass URL, or accepts a bare token. */
export function extractQrToken(code: string): string | null {
  const trimmed = code.trim();
  const fromUrl = trimmed.match(/\/p\/([\w-]{16,200})(?:[/?#]|$)/);
  if (fromUrl) return fromUrl[1];
  return /^[\w-]{16,200}$/.test(trimmed) ? trimmed : null;
}

@Controller()
@UseFilters(WebExceptionFilter)
export class ScanController {
  constructor(
    private readonly entry: EntryService,
    private readonly auth: AuthService,
    private readonly drive: DriveService,
    private readonly config: AppConfig,
  ) {}

  @Get('scan')
  @UseGuards(StaffGuard)
  scanPage(@Req() req: StaffRequest, @Res() res: Response) {
    res.type('html').send(
      page({
        title: 'Scan',
        section: 'scan',
        staff: req.staff,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        flash: takeFlash(req, res),
        scripts: ['/assets/vendor/jsQR.js', '/assets/scan.js'],
        body: html`<section class="card narrow">
          <h1>Scan pass</h1>
          <label class="gate">Gate <input id="gate" placeholder="e.g. Main gate" maxlength="60"></label>
          <div class="scanner">
            <video id="video" playsinline muted></video>
            <canvas id="canvas" hidden></canvas>
            <p id="scan-status" class="muted">Starting camera…</p>
          </div>
          <button id="start" class="primary big" hidden>Start camera</button>
          <p class="muted small">You can also scan with the phone's normal camera app; the pass opens here if you're signed in in this browser.</p>
          <form method="get" action="/scan/go" class="row-form">
            <label>Or paste the pass link / code <input name="code" required autocomplete="off"></label>
            <button>Open</button>
          </form>
        </section>`,
      }),
    );
  }

  @Get('scan/go')
  @UseGuards(StaffGuard)
  go(@Query('code') code: string | undefined, @Res() res: Response) {
    const token = code ? extractQrToken(code) : null;
    if (!token) {
      setFlash(res, { type: 'error', text: 'That is not an Infinito pass code' }, this.config.secureCookies);
      return res.redirect(303, '/scan');
    }
    res.redirect(303, `/p/${token}`);
  }

  /** The URL inside every QR. Anonymous visitors learn nothing; staff see the entry card. */
  @Get('p/:token')
  async pass(@Param('token') token: string, @Req() req: StaffRequest, @Res() res: Response) {
    res.set('Cache-Control', 'no-store');
    const staff = req.staff;
    if (!staff) {
      return res.type('html').send(
        page({
          title: 'Entry pass',
          body: html`<section class="card narrow center">
            <h1>Infinito 2K26 entry pass</h1>
            <p>Show this QR to a volunteer at the gate.</p>
            <p class="muted small">Volunteers: <a href="/login?next=${encodeURIComponent(`/p/${token}`)}">sign in</a> to check this pass.</p>
          </section>`,
        }),
      );
    }

    const csrf = this.auth.csrfToken(staff.sessionId);
    const person = await this.entry.lookup(token);
    const flash = takeFlash(req, res);
    if (!person) {
      return res.status(404).type('html').send(
        page({
          title: 'Invalid pass',
          section: 'scan',
          staff,
          csrf,
          flash,
          body: html`<section class="verdict verdict-bad"><h1>NOT A VALID PASS</h1><p>Do not admit. Ask for the email with their QR, or send them to the help desk.</p></section>
            <p class="center"><a class="button big" href="/scan">Scan next</a></p>`,
        }),
      );
    }

    const manage = staff.role !== StaffRole.VOLUNTEER;
    const photo =
      this.drive.enabled && person.photoDriveId
        ? html`<img class="photo" src="/staff/files/${person.id}/photo" alt="Photo of ${person.name}">`
        : html`<div class="photo photo-missing">No photo</div>`;
    const idDoc =
      this.drive.enabled && person.idDocumentDriveId
        ? html`<a href="/staff/files/${person.id}/id" target="_blank" rel="noopener">View ID document</a>`
        : html`<span class="muted">No ID document on file</span>`;

    const rows = person.registrations.map((reg) => {
      const eventName = this.config.eventName(reg.eventSlug);
      let verdict;
      if (reg.paymentStatus !== PaymentStatus.VERIFIED) {
        verdict = html`<div class="verdict verdict-bad"><b>DO NOT ADMIT</b> · payment ${paymentBadge(reg.paymentStatus)}</div>`;
      } else if (reg.enteredAt) {
        verdict = html`<div class="verdict verdict-warn"><b>ALREADY ENTERED</b><br>
          ${fmtDate(reg.enteredAt)} by ${reg.enteredBy?.name || reg.enteredBy?.email || 'unknown'}${reg.entryLogs[0]?.gate ? html` at ${reg.entryLogs[0].gate}` : null}</div>`;
      } else {
        verdict = html`<form method="post" action="/p/${token}/enter" class="enter-form">
          ${csrfField(csrf)}
          <input type="hidden" name="registrationId" value="${reg.id}">
          <input type="hidden" name="gate" class="gate-field">
          <button class="enter big">MARK ENTERED</button>
        </form>`;
      }
      return html`<section class="card registration">
        <div class="reg-head"><h2>${eventName}</h2>${reg.team ? html`<span class="muted">Team ${reg.team.name}</span>` : null}</div>
        ${verdict}
        ${manage && reg.team ? html`<p class="small"><a href="/admin/teams/${reg.team.id}">Open registration</a></p>` : null}
      </section>`;
    });

    res.type('html').send(
      page({
        title: person.name ?? 'Pass',
        section: 'scan',
        staff,
        csrf,
        flash,
        scripts: ['/assets/pass.js'],
        body: html`<section class="card person">
            ${photo}
            <div>
              <h1>${person.name}</h1>
              <p>${person.college || html`<span class="muted">College not given</span>`}</p>
              <p class="small">${idDoc}</p>
            </div>
          </section>
          ${rows.length ? rows : html`<p class="muted">No registrations for this pass.</p>`}
          <p class="center"><a class="button big" href="/scan">Scan next</a></p>`,
      }),
    );
  }

  @Post('p/:token/enter')
  @UseGuards(StaffGuard)
  async enter(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    const outcome = await this.entry.markEntered({
      qrToken: token,
      registrationId: typeof body.registrationId === 'string' ? body.registrationId : '',
      staffId: req.staff!.id,
      gate: typeof body.gate === 'string' ? body.gate : undefined,
    });
    const secure = this.config.secureCookies;
    switch (outcome.result) {
      case 'entered':
        setFlash(res, { type: 'ok', text: `✅ ENTERED at ${fmtDate(outcome.enteredAt)}` }, secure);
        break;
      case 'already-entered':
        setFlash(
          res,
          {
            type: 'error',
            text: `ALREADY ENTERED at ${fmtDate(outcome.enteredAt)}${outcome.byName ? ` by ${outcome.byName}` : ''}${outcome.gate ? ` (${outcome.gate})` : ''}. Do not admit again.`,
          },
          secure,
        );
        break;
      case 'not-verified':
        setFlash(res, { type: 'error', text: 'Payment is not verified. Do not admit.' }, secure);
        break;
      default:
        setFlash(res, { type: 'error', text: 'Registration not found for this pass' }, secure);
    }
    res.redirect(303, `/p/${token}`);
  }
}
