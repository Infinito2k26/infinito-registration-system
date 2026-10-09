import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { AppConfig } from '../config/app-config.service';
import {
  EMAIL_PROVIDERS,
  EmailProviderError,
  EmailProviderService,
  isEmailProvider,
  notConfiguredMessage,
  providerLabel,
  providerOptionLabel,
} from '../emails/email-provider.service';
import { EmailWorkerService } from '../emails/email-worker.service';
import { PrismaService } from '../prisma/prisma.service';
import { setFlash, takeFlash } from '../web/cookies';
import { html } from '../web/html';
import { badge, csrfField, fmtDate, page } from '../web/layout';
import { WebExceptionFilter } from '../web/web-exception.filter';
import { AuthService } from './auth.service';
import { Roles, StaffRequest } from './auth.types';
import { StaffGuard } from './staff.guard';

const staffForm = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().max(120).optional(),
  role: z.enum(StaffRole),
});

/** Admins add coordinators/volunteers and switch accounts on or off. */
@Controller('admin/staff')
@UseGuards(StaffGuard)
@Roles(StaffRole.ADMIN)
@UseFilters(WebExceptionFilter)
export class StaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly emailProviders: EmailProviderService,
    private readonly emailWorker: EmailWorkerService,
  ) {}

  /** Active email provider and both providers' (non-secret) status. */
  private async emailProviderState() {
    const active = await this.emailProviders.active();
    const providers = EMAIL_PROVIDERS.map((p) => this.emailProviders.status(p));
    return { ...active, providers, activeConfigured: providers.find((p) => p.provider === active.provider)!.configured };
  }

  @Get()
  async list(@Req() req: StaffRequest, @Res() res: Response) {
    const staff = await this.prisma.staffUser.findMany({
      orderBy: [{ active: 'desc' }, { role: 'asc' }, { email: 'asc' }],
      include: { sessions: { where: { revokedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 1 } },
    });
    const csrf = this.auth.csrfToken(req.staff!.sessionId);
    const email = await this.emailProviderState();
    const roleOptions = (selected: StaffRole) =>
      Object.values(StaffRole).map(
        (r) => html`<option value="${r}" ${r === selected ? 'selected' : ''}>${r.toLowerCase()}</option>`,
      );

    res.type('html').send(
      page({
        title: 'Staff',
        section: 'staff',
        staff: req.staff,
        csrf,
        flash: takeFlash(req, res),
        body: html`<h1>Staff</h1>
        <section class="card">
          <h2>Add or update</h2>
          <form method="post" action="/admin/staff" class="row-form">
            ${csrfField(csrf)}
            <label>Email <input type="email" name="email" required></label>
            <label>Name <input name="name" maxlength="120"></label>
            <label>Role <select name="role">${roleOptions(StaffRole.VOLUNTEER)}</select></label>
            <button class="primary">Save</button>
          </form>
          <p class="muted small">Volunteers can only scan and mark entry. Coordinators manage registrations and payments. Admins also manage staff. People sign in with an emailed link; no passwords.</p>
        </section>
        <section class="card">
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${staff.map(
                (s) => html`<tr class="${s.active ? '' : 'dim'}">
                  <td>${s.email}</td><td>${s.name}</td><td>${s.role.toLowerCase()}</td>
                  <td>${fmtDate(s.sessions[0]?.lastSeenAt) || html`<span class="muted">never</span>`}</td>
                  <td>${s.active ? badge('Active', 'ok') : badge('Disabled', 'muted')}</td>
                  <td>${
                    s.id === req.staff!.id
                      ? html`<span class="muted small">you</span>`
                      : html`<form method="post" action="/admin/staff/${s.id}/toggle" class="inline">
                          ${csrfField(csrf)}<button class="small">${s.active ? 'Disable' : 'Enable'}</button></form>`
                  }</td>
                </tr>`,
              )}
            </tbody>
          </table></div>
        </section>
        <section class="card">
          <h2>Email provider</h2>
          <p>Active: <b>${providerLabel(email.provider)}</b> · ${
            email.source === 'admin'
              ? html`chosen by ${email.updatedBy?.name || email.updatedBy?.email || 'an admin'}, ${fmtDate(email.updatedAt)}`
              : html`<span class="muted">from .env (EMAIL_PROVIDER)</span>`
          }</p>
          ${email.activeConfigured ? null : html`<div class="warning">${notConfiguredMessage(email.provider)} Emails stay queued until it is configured or another provider is chosen.</div>`}
          <form method="post" action="/admin/staff/email-provider" class="row-form">
            ${csrfField(csrf)}
            ${email.providers.map(
              (p) => html`<label><input type="radio" name="provider" value="${p.provider}" ${p.provider === email.provider ? 'checked' : ''}>
                ${providerOptionLabel(p.provider)} <span class="muted small">(${p.detail}${p.problems.length ? `; ${p.problems.join('; ')}` : ''})</span></label>`,
            )}
            <button class="primary">Save</button>
          </form>
          <p class="muted small">Credentials stay in .env; only this choice is saved, and it takes precedence over EMAIL_PROVIDER. Emails already queued go out with the selected provider; nothing is sent twice.</p>
        </section>`,
      }),
    );
  }

  /** Admin-only: the active email provider (JSON). Never includes credentials. */
  @Get('email-provider')
  async getEmailProvider(@Res() res: Response) {
    const state = await this.emailProviderState();
    res.set('Cache-Control', 'no-store').json({
      provider: state.provider,
      source: state.source,
      updatedAt: state.updatedAt,
      updatedBy: state.updatedBy?.email ?? null,
      sending: this.emailWorker.transportName,
      providers: state.providers,
    });
  }

  /** Admin-only: choose the active email provider ("smtp" | "resend" | "brevo"); it must be configured in .env. */
  @Post('email-provider')
  async setEmailProvider(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const provider = body.provider;
    if (!isEmailProvider(provider)) {
      setFlash(res, { type: 'error', text: 'Choose SMTP, Resend or Brevo' }, this.config.secureCookies);
      return res.redirect(303, '/admin/staff');
    }
    try {
      await this.emailProviders.set(provider, req.staff!.id);
      await this.emailWorker.refreshProvider();
      setFlash(res, { type: 'ok', text: `Email provider set to ${providerLabel(provider)}` }, this.config.secureCookies);
    } catch (error) {
      if (!(error instanceof EmailProviderError)) throw error;
      setFlash(res, { type: 'error', text: error.message }, this.config.secureCookies);
    }
    res.redirect(303, '/admin/staff');
  }

  @Post()
  async save(@Body() body: Record<string, unknown>, @Req() req: StaffRequest, @Res() res: Response) {
    const parsed = staffForm.safeParse(body);
    if (!parsed.success) {
      setFlash(res, { type: 'error', text: 'Enter a valid email and role' }, this.config.secureCookies);
      return res.redirect(303, '/admin/staff');
    }
    const { email, name, role } = parsed.data;
    if (email === req.staff!.email && role !== StaffRole.ADMIN) {
      setFlash(res, { type: 'error', text: "You can't remove your own admin role" }, this.config.secureCookies);
      return res.redirect(303, '/admin/staff');
    }
    await this.prisma.staffUser.upsert({
      where: { email },
      create: { email, name: name || null, role },
      update: { role, active: true, ...(name ? { name } : {}) },
    });
    setFlash(res, { type: 'ok', text: `${email} saved as ${role.toLowerCase()}` }, this.config.secureCookies);
    res.redirect(303, '/admin/staff');
  }

  @Post(':id/toggle')
  async toggle(@Param('id', ParseUUIDPipe) id: string, @Req() req: StaffRequest, @Res() res: Response) {
    if (id === req.staff!.id) {
      setFlash(res, { type: 'error', text: "You can't disable yourself" }, this.config.secureCookies);
      return res.redirect(303, '/admin/staff');
    }
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction([
      this.prisma.staffUser.update({
        where: { id },
        data: { active: !user.active, magicTokenHash: null, tokenExpiry: null },
      }),
      // Disabling signs the person out everywhere.
      this.prisma.staffSession.updateMany({
        where: { staffUserId: id, revokedAt: null },
        data: { revokedAt: user.active ? new Date() : undefined },
      }),
    ]);
    setFlash(res, { type: 'ok', text: `${user.email} ${user.active ? 'disabled' : 'enabled'}` }, this.config.secureCookies);
    res.redirect(303, '/admin/staff');
  }
}
