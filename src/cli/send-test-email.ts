/**
 * Sends one real sample QR-pass email with the current .env settings, bypassing the
 * database and outbox, to check the email settings: EMAIL_PROVIDER with RESEND_API_KEY or
 * SMTP_HOST / SMTP_USER / SMTP_PASS, and MAIL_FROM / MAIL_REPLY_TO.
 *
 *   npm run email:test -- you@example.com
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { AppConfig } from '../config/app-config.service';
import { EmailTemplate, renderEmail } from '../emails/email-templates';
import { MailTransport, ResendTransport, SmtpTransport } from '../emails/mail-transport';

async function main() {
  const to = process.argv[2];
  if (!to) throw new Error('Usage: npm run email:test -- you@example.com');

  const config = new AppConfig(new ConfigService());
  const { provider, smtp, resendApiKey, from, replyTo } = config.email;
  if (!config.emailProviderConfigured()) {
    throw new Error(provider === 'smtp' ? 'SMTP_HOST / SMTP_USER / SMTP_PASS are empty in .env' : 'RESEND_API_KEY is empty in .env');
  }
  const problems = config.emailConfigProblems();
  if (problems.length) throw new Error(problems.join('; '));

  const rendered = await renderEmail(EmailTemplate.QrPass, {
    name: 'Test Participant',
    eventName: 'Sample Event',
    team: 'Sample Team',
    qrToken: 'sample-token-not-a-real-pass',
  });
  const transport: MailTransport =
    provider === 'smtp' ? new SmtpTransport(smtp, from, replyTo) : new ResendTransport(resendApiKey, from, replyTo);
  const id = await transport.send({
    ...rendered,
    to,
    subject: '[Infinito test] Sample entry pass email',
    idempotencyKey: `cli-test:${randomUUID()}`,
    tags: { template: 'cli-test' },
  });
  // The SMTP connection pool would otherwise keep this one-off script running.
  if (transport instanceof SmtpTransport) transport.close();
  console.log(`Sent via ${transport.name}. Message id: ${id}\nFrom: ${from}${replyTo ? `\nReply-To: ${replyTo}` : ''}\nTo: ${to}`);
}

main().catch((error: unknown) => {
  console.error(`Test email failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
