import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

export const EMAIL_PROVIDERS = ['smtp', 'resend'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];
export const EMAIL_PROVIDER_SETTING = 'email.provider';

export const isEmailProvider = (value: unknown): value is EmailProvider =>
  typeof value === 'string' && (EMAIL_PROVIDERS as readonly string[]).includes(value);

export const providerLabel = (provider: EmailProvider) => (provider === 'smtp' ? 'SMTP' : 'Resend');

/** "SMTP is selected but SMTP is not configured." (no silent fallback to the other provider) */
export const notConfiguredMessage = (provider: EmailProvider) =>
  `${providerLabel(provider)} is selected but ${providerLabel(provider)} is not configured.`;

/** Shown to the admin as-is. Nothing was changed. */
export class EmailProviderError extends Error {}

export interface ProviderStatus {
  provider: EmailProvider;
  configured: boolean;
  /** Settings problems (e.g. MAIL_FROM format); empty when it can send. */
  problems: string[];
  /** Non-secret description: SMTP host, port and sender; never passwords or API keys. */
  detail: string;
}

/**
 * Which already-configured provider sends the email queue: the admin's saved choice
 * (SystemSetting "email.provider"), otherwise EMAIL_PROVIDER from .env. Only the choice is
 * stored; credentials always come from .env.
 */
@Injectable()
export class EmailProviderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** The .env default (EMAIL_PROVIDER); "resend" if it is missing or not a known provider. */
  get envDefault(): EmailProvider {
    const provider = this.config.email.provider;
    return isEmailProvider(provider) ? provider : 'resend';
  }

  async active(): Promise<{
    provider: EmailProvider;
    source: 'admin' | 'env';
    updatedAt: Date | null;
    updatedBy: { name: string | null; email: string } | null;
  }> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: EMAIL_PROVIDER_SETTING },
      include: { updatedBy: { select: { name: true, email: true } } },
    });
    if (row && isEmailProvider(row.value)) {
      return { provider: row.value, source: 'admin', updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    }
    return { provider: this.envDefault, source: 'env', updatedAt: null, updatedBy: null };
  }

  status(provider: EmailProvider): ProviderStatus {
    const configured = this.config.emailProviderConfigured(provider);
    const { smtp } = this.config.email;
    const from = this.config.emailFrom(provider);
    const detail = !configured
      ? provider === 'smtp'
        ? 'Not configured: set SMTP_HOST, SMTP_USER and SMTP_PASS in .env'
        : 'Not configured: set RESEND_API_KEY in .env'
      : provider === 'smtp'
        ? `${smtp.host}:${smtp.port} as ${from || '(no sender)'}`
        : `as ${from || '(no sender)'}`;
    return { provider, configured, problems: configured ? this.config.emailConfigProblems(provider) : [], detail };
  }

  /** Saves the admin's choice. Refuses a provider whose .env settings are missing or invalid. */
  async set(provider: EmailProvider, actorId: string): Promise<void> {
    const status = this.status(provider);
    if (!status.configured) {
      throw new EmailProviderError(`${providerLabel(provider)} is not configured in .env, so it cannot be selected. ${status.detail}.`);
    }
    if (status.problems.length) {
      throw new EmailProviderError(`${providerLabel(provider)} cannot be selected: ${status.problems.join('; ')}`);
    }
    await this.prisma.systemSetting.upsert({
      where: { key: EMAIL_PROVIDER_SETTING },
      create: { key: EMAIL_PROVIDER_SETTING, value: provider, updatedById: actorId },
      update: { value: provider, updatedById: actorId },
    });
  }
}
