import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { StaffRole } from '@prisma/client';
import { Response } from 'express';
import { AppConfig } from '../config/app-config.service';
import { SESSION_COOKIE, clearCookie, setCookie, takeFlash } from '../web/cookies';
import { html } from '../web/html';
import { landingPage } from '../web/landing';
import { page } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { AuthService } from './auth.service';
import { StaffRequest } from './auth.types';
import { StaffGuard } from './staff.guard';

/** Only same-site relative paths, so ?next= cannot redirect off-site. */
function safeNext(next: unknown): string | undefined {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : undefined;
}

const homeFor = (role: StaffRole) => (role === StaffRole.VOLUNTEER ? '/scan' : '/admin/registrations');

@Controller()
@UseFilters(WebExceptionFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  /** Public landing page for visitors; signed-in staff still go straight to their home page. */
  @Get()
  root(@Req() req: StaffRequest, @Res() res: Response) {
    if (req.staff) return res.redirect(303, homeFor(req.staff.role));
    res.type('html').send(landingPage());
  }

  @Get('login')
  loginPage(@Req() req: StaffRequest, @Res() res: Response, @Query('next') next?: string) {
    if (req.staff) return res.redirect(303, safeNext(next) ?? homeFor(req.staff.role));
    res.type('html').send(
      page({
        title: 'Sign in',
        flash: takeFlash(req, res),
        body: html`<section class="card narrow">
          <h1>Staff sign in</h1>
          <p class="muted">Coordinators and volunteers: enter the email you were registered with. We'll email you a sign-in link.</p>
          <form method="post" action="/login" class="stack">
            <label>Email <input type="email" name="email" required autocomplete="email" autofocus></label>
            <button class="primary">Email me a sign-in link</button>
          </form>
        </section>`,
      }),
    );
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestLink(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const email = typeof body.email === 'string' ? body.email.slice(0, 320) : '';
    if (email) await this.auth.requestLoginLink(email);
    res.type('html').send(
      page({
        title: 'Check your email',
        body: html`<section class="card narrow">
          <h1>Check your email</h1>
          <p>If <b>${email}</b> belongs to Infinito staff, a sign-in link is on its way. It works once and expires in ${this.config.magicLinkTtlMinutes} minutes.</p>
          <p class="muted">Open it on the phone or laptop you want to use. Nothing arrived? Check spam, or ask an admin to add you.</p>
        </section>`,
      }),
    );
  }

  /**
   * GET only shows a button: mail scanners (e.g. Outlook Safe Links) prefetch links,
   * and consuming the token on GET would burn it before the person clicks.
   */
  @Get('auth/magic')
  confirmPage(@Query('token') token: string | undefined, @Res() res: Response) {
    res.type('html').send(
      page({
        title: 'Sign in',
        body: html`<section class="card narrow">
          <h1>Sign in to Infinito</h1>
          <form method="post" action="/auth/magic" class="stack">
            <input type="hidden" name="token" value="${token ?? ''}">
            <button class="primary big">Continue</button>
          </form>
        </section>`,
      }),
    );
  }

  @Post('auth/magic')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async signIn(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const result = typeof body.token === 'string' ? await this.auth.signIn(body.token) : null;
    if (!result) {
      res.status(400).type('html').send(
        page({
          title: 'Link expired',
          body: html`<section class="card narrow"><h1>This link has expired or was already used</h1>
            <p><a href="/login">Request a new sign-in link</a></p></section>`,
        }),
      );
      return;
    }
    setCookie(res, SESSION_COOKIE, result.sessionToken, {
      secure: this.config.secureCookies,
      maxAgeMs: this.config.sessionTtlHours * 3_600_000,
    });
    res.redirect(303, homeFor(result.staff.role));
  }

  @Post('logout')
  @UseGuards(StaffGuard)
  async signOut(@Req() req: StaffRequest, @Res() res: Response) {
    await this.auth.signOut(req.staff!.sessionId);
    clearCookie(res, SESSION_COOKIE);
    res.redirect(303, '/login');
  }
}
