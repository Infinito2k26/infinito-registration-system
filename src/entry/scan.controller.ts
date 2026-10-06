import {
  Body,
  Controller,
  ForbiddenException,
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
import { PaymentStatus, StaffRole } from '@prisma/client';
import { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { StaffRequest } from '../auth/auth.types';
import { StaffGuard } from '../auth/staff.guard';
import { AppConfig } from '../config/app-config.service';
import { DriveService } from '../drive/drive.service';
import { QrEmailError, QrEmailService } from '../emails/qr-email.service';
import { PaymentActionError, PaymentsService } from '../payments/payments.service';
import { extractQrToken } from '../qr/qr-token';
import { scanDetails } from '../admin/admin.views';
import { decryptAadhaar, formatAadhaar, maskAadhaar } from '../registrations/aadhaar-crypto';
import { ParticipantActionError, ParticipantsService, changeEmailMessage } from '../registrations/participants.service';
import { setFlash, takeFlash } from '../web/cookies';
import { SafeHtml, html } from '../web/html';
import { badge, csrfField, fmtDate, page, paymentBadge } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { checkInFlash, checkOutFlash } from './entry-messages';
import { EntryService, GATE_PAGE_SIZE } from './entry.service';


/** "2/4 of team entered" for multi-member teams; the team counts as entered once all members are in. */
function teamProgress(team: { registrations: { enteredAt: Date | null }[] } | null) {
  if (!team || team.registrations.length < 2) return null;
  const total = team.registrations.length;
  const entered = team.registrations.filter((r) => r.enteredAt).length;
  return html`<p class="small ${entered === total ? '' : 'muted'}">${entered === total ? `Whole team entered (${total}/${total})` : `${entered}/${total} of team entered`}</p>`;
}

type GatePerson = NonNullable<Awaited<ReturnType<EntryService['lookup']>>>;

/**
 * The gate: QR pass pages (/p/<token>) and the manual gate (/gate/<registrationId>, no QR).
 * Both render the same card and call the same EntryService, so IN/OUT state, EntryLog and
 * history are shared; manual actions are recorded as "manual (no QR scan)".
 * Any signed-in staff role (volunteer, coordinator, admin) may operate the gate.
 */
@Controller()
@UseFilters(WebExceptionFilter)
export class ScanController {
  constructor(
    private readonly entry: EntryService,
    private readonly auth: AuthService,
    private readonly drive: DriveService,
    private readonly config: AppConfig,
    private readonly qrEmails: QrEmailService,
    private readonly payments: PaymentsService,
    private readonly participants: ParticipantsService,
  ) {}

  private readonly eventName = (slug: string) => this.config.eventName(slug);

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
          <p class="muted small">Scan passes with this scanner (a pass QR holds only a code, not a link). Older passes with a link also work here.</p>
          <form method="get" action="/scan/go" class="row-form">
            <label>Or paste the pass link / code <input name="code" required autocomplete="off"></label>
            <button>Open</button>
          </form>
          <form method="get" action="/scan/find" class="row-form">
            <label>No QR? Find the participant by name or college <input name="q" required minlength="2" autocomplete="off"></label>
            <button>Find</button>
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

  /**
   * Participant directory (any staff role): every participant, searchable by name, college or
   * event, paged. Rows open the gate card. Only gate-safe columns are queried.
   */
  @Get('scan/find')
  @UseGuards(StaffGuard)
  async find(@Query('q') q: string | undefined, @Query('page') pageParam: string | undefined, @Req() req: StaffRequest, @Res() res: Response) {
    res.set('Cache-Control', 'no-store');
    const query = (q ?? '').trim().slice(0, 100);
    const pageNo = Math.max(1, Math.min(10_000, Number.parseInt(pageParam ?? '1', 10) || 1));
    const { rows: results, total } = await this.entry.searchForGate(query, pageNo);
    const pages = Math.max(1, Math.ceil(total / GATE_PAGE_SIZE));
    const pageLink = (n: number) => `/scan/find?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(n) }).toString()}`;
    res.type('html').send(
      page({
        title: 'Find participant',
        section: 'find',
        staff: req.staff,
        csrf: this.auth.csrfToken(req.staff!.sessionId),
        body: html`<p class="small"><a href="/scan">← Scan</a></p>
          <h1>Find participant</h1>
          <form method="get" action="/scan/find" class="row-form search">
            <input type="search" name="q" value="${query}" placeholder="Name, college or event">
            <button>Search</button>
            ${query ? html`<a href="/scan/find">Clear</a>` : null}
          </form>
          <p class="muted small">${total} participant registration(s)${query ? html` matching “${query}”` : null}. Open one to check in/out, send their QR email${this.canVerify(req) ? ', verify' : ''} or change their email.</p>
          <section class="card"><div class="table-wrap"><table class="table rows-clickable">
            <thead><tr><th>Name</th><th>College</th><th>Event</th><th>Status</th></tr></thead>
            <tbody>
              ${results.map(
                (r) => html`<tr data-href="/gate/${r.id}">
                  <td><a href="/gate/${r.id}">${r.person.name}</a></td>
                  <td class="small">${r.person.college}</td>
                  <td class="small">${this.eventName(r.eventSlug)}</td>
                  <td>${
                    r.person.blockedAt
                      ? badge('Blocked', 'bad')
                      : r.paymentStatus !== PaymentStatus.VERIFIED
                        ? badge('Not verified', 'warn')
                        : r.insideSince
                          ? badge('Inside', 'ok')
                          : badge('Outside', 'muted')
                  }</td>
                </tr>`,
              )}
              ${results.length === 0 ? html`<tr><td colspan="4" class="muted center">${query ? 'No one found.' : 'No participants yet.'}</td></tr>` : null}
            </tbody>
          </table></div></section>
          ${
            pages > 1
              ? html`<nav class="pager">
                  ${pageNo > 1 ? html`<a href="${pageLink(pageNo - 1)}">← Prev</a>` : null}
                  <span>Page ${pageNo} of ${pages}</span>
                  ${pageNo < pages ? html`<a href="${pageLink(pageNo + 1)}">Next →</a>` : null}
                </nav>`
              : null
          }`,
        scripts: ['/assets/admin.js'],
      }),
    );
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

    const person = await this.entry.lookup(token);
    if (!person) {
      return res.status(404).type('html').send(
        page({
          title: 'Invalid pass',
          section: 'scan',
          staff,
          csrf: this.auth.csrfToken(staff.sessionId),
          flash: takeFlash(req, res),
          body: html`<section class="verdict verdict-bad"><h1>INVALID QR</h1><p>Not an Infinito pass. Do not admit. Ask for the email with their QR, or send them to the help desk.</p></section>
            <p class="center"><a class="button big" href="/scan">Scan next</a></p>`,
        }),
      );
    }
    await this.sendGateCard(req, res, person, (path) => `/p/${token}/${path}`, null);
  }

  /** Manual gate (no QR): the same card, reached from /scan/find or the participant page. */
  @Get('gate/:registrationId')
  @UseGuards(StaffGuard)
  async manualGate(@Param('registrationId', ParseUUIDPipe) registrationId: string, @Req() req: StaffRequest, @Res() res: Response) {
    res.set('Cache-Control', 'no-store');
    const person = await this.entry.lookupByRegistration(registrationId);
    if (!person) throw new NotFoundException('Participant not found');
    await this.sendGateCard(req, res, person, (path) => `/gate/${path}`, registrationId);
  }

  @Post('p/:token/enter')
  @UseGuards(StaffGuard)
  async enter(@Param('token') token: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const outcome = await this.entry.checkIn(this.gateAction(body, req, token));
    setFlash(res, checkInFlash(outcome, this.eventName), this.config.secureCookies);
    res.redirect(303, `/p/${token}`);
  }

  /** Gate check-out. Any signed-in staff, like check-in (the exit gate is staffed by volunteers). */
  @Post('p/:token/exit')
  @UseGuards(StaffGuard)
  async exit(@Param('token') token: string, @Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const outcome = await this.entry.checkOut(this.gateAction(body, req, token));
    setFlash(res, checkOutFlash(outcome, this.eventName), this.config.secureCookies);
    res.redirect(303, `/p/${token}`);
  }

  /** Manual check-in without a QR scan; same rules (verified, not blocked, atomic) as a scan. */
  @Post('gate/enter')
  @UseGuards(StaffGuard)
  async manualEnter(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const action = this.gateAction(body, req);
    const outcome = await this.entry.checkIn(action);
    setFlash(res, checkInFlash(outcome, this.eventName), this.config.secureCookies);
    res.redirect(303, outcome.result === 'not-found' ? '/scan' : `/gate/${action.registrationId}`);
  }

  @Post('gate/exit')
  @UseGuards(StaffGuard)
  async manualExit(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const action = this.gateAction(body, req);
    const outcome = await this.entry.checkOut(action);
    setFlash(res, checkOutFlash(outcome, this.eventName), this.config.secureCookies);
    res.redirect(303, outcome.result === 'not-found' ? '/scan' : `/gate/${action.registrationId}`);
  }

  /**
   * Individual QR email from the gate card: this participant's own pass to their own current
   * address (same rules as the dashboard: verified only, one queued at a time). Any staff role.
   * There is no bulk or college-wide email here.
   */
  @Post('gate/:registrationId/send-qr')
  @UseGuards(StaffGuard)
  async sendQr(@Param('registrationId', ParseUUIDPipe) registrationId: string, @Req() req: StaffRequest, @Res() res: Response) {
    try {
      const { toEmail } = await this.qrEmails.resend(registrationId, req.staff!.id);
      setFlash(res, { type: 'ok', text: `QR email queued to ${toEmail}` }, this.config.secureCookies);
    } catch (error) {
      if (!(error instanceof QrEmailError)) throw error;
      setFlash(res, { type: 'error', text: error.message }, this.config.secureCookies);
    }
    res.redirect(303, `/gate/${registrationId}`);
  }

  /**
   * Change email from the gate card (any staff role, incl. volunteers). Same service, checks and
   * audit as the dashboard: same person, QR token, verification and gate history; old address
   * kept as an alias; queued emails redirected. Changing an email sends nothing; adding the
   * first email queues the QR email if the participant is verified.
   */
  @Post('gate/:registrationId/change-email')
  @UseGuards(StaffGuard)
  async changeEmail(
    @Param('registrationId', ParseUUIDPipe) registrationId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: StaffRequest,
    @Res() res: Response,
  ) {
    const personId = await this.entry.personIdFor(registrationId);
    if (!personId) throw new NotFoundException('Participant not found');
    try {
      const result = await this.participants.changeEmail(personId, typeof body.email === 'string' ? body.email.slice(0, 320) : '', req.staff!.id);
      setFlash(res, { type: 'ok', text: changeEmailMessage(result) }, this.config.secureCookies);
    } catch (error) {
      if (!(error instanceof ParticipantActionError)) throw error;
      setFlash(res, { type: 'error', text: error.message }, this.config.secureCookies);
    }
    res.redirect(303, `/gate/${registrationId}`);
  }

  /**
   * Verify from the gate card. Coordinators/admins always; volunteers only when
   * VOLUNTEERS_CAN_VERIFY=true (off by default). Same atomic verification as the dashboard.
   */
  @Post('gate/:registrationId/verify')
  @UseGuards(StaffGuard)
  async verify(@Param('registrationId', ParseUUIDPipe) registrationId: string, @Req() req: StaffRequest, @Res() res: Response) {
    if (!this.canVerify(req)) throw new ForbiddenException('Volunteers cannot verify registrations');
    const teamId = await this.entry.teamIdFor(registrationId);
    if (!teamId) throw new NotFoundException('Participant not found');
    try {
      const { message } = await this.payments.verifyTeam(teamId, req.staff!.id);
      setFlash(res, { type: 'ok', text: message }, this.config.secureCookies);
    } catch (error) {
      if (!(error instanceof PaymentActionError)) throw error;
      setFlash(res, { type: 'error', text: error.message }, this.config.secureCookies);
    }
    res.redirect(303, `/gate/${registrationId}`);
  }

  private canVerify(req: StaffRequest) {
    return req.staff!.role !== StaffRole.VOLUNTEER || this.config.volunteersCanVerify;
  }

  private gateAction(body: Record<string, unknown>, req: StaffRequest, qrToken?: string) {
    const registrationId = typeof body.registrationId === 'string' && /^[0-9a-f-]{36}$/i.test(body.registrationId) ? body.registrationId : '';
    return {
      qrToken,
      registrationId,
      staffId: req.staff!.id,
      gate: typeof body.gate === 'string' ? body.gate : undefined,
    };
  }

  /**
   * The gate card: photo, name, college and, per event, the one action the current state allows.
   * Checks shown in the server's order: verified -> not blocked -> IN/OUT state.
   * Below it, the same participant details for every role (contents per role permissions).
   */
  private async sendGateCard(
    req: StaffRequest,
    res: Response,
    person: GatePerson,
    actionUrl: (path: 'enter' | 'exit') => string,
    manualRegistrationId: string | null,
  ) {
    const staff = req.staff!;
    const csrf = this.auth.csrfToken(staff.sessionId);
    const manage = staff.role !== StaffRole.VOLUNTEER;
    const canVerify = this.canVerify(req);
    // Full Aadhaar number and Aadhaar card: admins and volunteers (existing permissions), never
    // coordinators. Decrypted on the server for this signed-in request only; the encrypted
    // value itself is never rendered, for any role.
    const aadhaarAccess = staff.role === StaffRole.ADMIN || staff.role === StaffRole.VOLUNTEER;
    const aadhaarFull = aadhaarAccess ? decryptAadhaar(person.aadhaarEncrypted, this.config.aadhaarKey) : null;
    person.aadhaarEncrypted = null;
    // The same details section (and document previews) for every role.
    const details = scanDetails({
      person,
      aadhaarFull,
      aadhaarAccess,
      history: await this.entry.historyFor(person.id),
      eventName: this.eventName,
      driveEnabled: this.drive.enabled,
    });
    const photo =
      this.drive.enabled && person.photoDriveId
        ? html`<img class="photo" src="/staff/files/${person.id}/photo" alt="Photo of ${person.name}">`
        : html`<div class="photo photo-missing">No photo</div>`;
    const idDoc =
      this.drive.enabled && person.idDocumentDriveId
        ? html`<a href="/staff/files/${person.id}/id" target="_blank" rel="noopener">View College ID card</a>`
        : html`<span class="muted">No ID document on file</span>`;

    const rows: SafeHtml[] = person.registrations.map((reg) => {
      const action = (path: 'enter' | 'exit', label: string, cls: string) => html`<form method="post" action="${actionUrl(path)}" class="enter-form">
          ${csrfField(csrf)}
          <input type="hidden" name="registrationId" value="${reg.id}">
          <input type="hidden" name="gate" class="gate-field">
          <button class="${cls} big">${label}</button>
        </form>`;
      let verdict;
      if (reg.paymentStatus !== PaymentStatus.VERIFIED) {
        verdict = html`<div class="verdict verdict-bad"><b>NOT VERIFIED</b> · DO NOT ADMIT · ${paymentBadge(reg.paymentStatus)}</div>`;
      } else if (person.blockedAt) {
        // The reason is internal; the gate only learns that access is blocked.
        verdict = html`<div class="verdict verdict-bad"><b>ACCESS BLOCKED</b><br>Registration access has been blocked. Please contact the coordinator/admin.</div>`;
      } else if (reg.insideSince) {
        const last = reg.entryLogs[0];
        verdict = html`<div class="verdict verdict-warn"><b>ALREADY ENTERED</b> · INSIDE<br>
          since ${fmtDate(reg.insideSince)}${last?.volunteer ? html` by ${last.volunteer.name || last.volunteer.email}` : null}${last?.gate ? html` at ${last.gate}` : null}</div>
          ${action('exit', 'CHECK OUT (OUT)', 'exit')}`;
      } else {
        verdict = html`${reg.lastCheckOutAt ? html`<p class="small muted">OUTSIDE · checked out at ${fmtDate(reg.lastCheckOutAt)}</p>` : null}
          ${action('enter', 'MARK ENTERED (CHECK IN)', 'enter')}`;
      }
      const small = (path: string, label: string, cls = '') => html`<form method="post" action="/gate/${reg.id}/${path}" class="inline">
          ${csrfField(csrf)}<button class="small ${cls}">${label}</button></form>`;
      const tools = [
        reg.paymentStatus !== PaymentStatus.VERIFIED && reg.paymentStatus !== PaymentStatus.REJECTED && canVerify ? small('verify', 'Verify', 'primary') : null,
        reg.paymentStatus === PaymentStatus.VERIFIED ? small('send-qr', 'Send QR email') : null,
      ].filter(Boolean);
      return html`<section class="card registration ${manualRegistrationId === reg.id ? 'highlight' : ''}">
        <div class="reg-head"><h2>${this.eventName(reg.eventSlug)}</h2>${reg.team && reg.team.name !== person.name ? html`<span class="muted">Team ${reg.team.name}</span>` : null}</div>
        ${teamProgress(reg.team)}
        ${verdict}
        ${tools.length ? html`<div class="actions">${tools}</div>` : null}
        ${manage ? html`<p class="small"><a href="/admin/registrations/${reg.id}">Open full participant page</a></p>` : null}
      </section>`;
    });

    res.type('html').send(
      page({
        title: person.name ?? 'Pass',
        section: 'scan',
        staff,
        csrf,
        flash: takeFlash(req, res),
        scripts: ['/assets/pass.js'],
        body: html`${manualRegistrationId ? html`<p class="warning small"><b>Manual gate (no QR scanned).</b> Check the photo and college ID before admitting. Actions are recorded under your name as manual.</p>` : null}
          <section class="card person">
            ${photo}
            <div>
              <h1>${person.name}</h1>
              <p>${person.college || html`<span class="muted">College not given</span>`}</p>
              ${aadhaarFull ? html`<p class="small mono">Aadhaar ${formatAadhaar(aadhaarFull)}</p>` : person.aadhaarLast4 ? html`<p class="small mono">Aadhaar ${maskAadhaar(person.aadhaarLast4)}</p>` : null}
              <p class="small">${person.email ? html`Email ${person.email}` : html`<span class="muted">No email</span>`}</p>
              <p class="small">${idDoc}</p>
            </div>
          </section>
          ${rows.length ? rows : html`<p class="muted">No registrations for this pass.</p>`}
          ${details}
          ${
            person.registrations[0]
              ? html`<section class="card">
                  <form method="post" action="/gate/${manualRegistrationId ?? person.registrations[0].id}/change-email" class="row-form">
                    ${csrfField(csrf)}
                    <label>Change email <input type="email" name="email" required placeholder="new@example.com"></label>
                    <button>Change email</button>
                  </form>
                  <p class="muted small">${person.email ? 'Keeps the same participant, QR pass and history. Nothing is emailed automatically; use Send QR email afterwards.' : 'No email yet. Adding one keeps the same participant, QR pass and history, and emails the QR pass if the registration is verified.'}</p>
                </section>`
              : null
          }
          <p class="center"><a class="button big" href="/scan">Scan next</a></p>`,
      }),
    );
  }
}
