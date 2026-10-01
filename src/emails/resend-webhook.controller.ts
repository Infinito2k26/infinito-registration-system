import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailDeliveryStatus } from '@prisma/client';
import { Request } from 'express';
import { Resend } from 'resend';
import { AppConfig } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';

const STATUS_BY_EVENT: Record<string, EmailDeliveryStatus> = {
  'email.delivered': EmailDeliveryStatus.DELIVERED,
  'email.delivery_delayed': EmailDeliveryStatus.DELAYED,
  'email.bounced': EmailDeliveryStatus.BOUNCED,
  'email.complained': EmailDeliveryStatus.COMPLAINED,
  'email.failed': EmailDeliveryStatus.FAILED,
  // Resend refused to send because the address bounced/complained before.
  'email.suppressed': EmailDeliveryStatus.BOUNCED,
};

/** Final states win over DELAYED even if webhooks arrive out of order. */
const FINAL = new Set<EmailDeliveryStatus>([
  EmailDeliveryStatus.DELIVERED,
  EmailDeliveryStatus.BOUNCED,
  EmailDeliveryStatus.COMPLAINED,
  EmailDeliveryStatus.FAILED,
]);

interface DeliveryEvent {
  type: string;
  created_at: string;
  data: { email_id: string; bounce?: { message?: string; type?: string } };
}

/**
 * Configure in Resend -> Webhooks: POST <APP_BASE_URL>/webhooks/resend with events
 * email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed,
 * email.suppressed. Copy the signing secret (whsec_...) into RESEND_WEBHOOK_SECRET.
 * Re-deliveries are harmless: every update is idempotent.
 */
@Controller('webhooks/resend')
export class ResendWebhookController {
  private readonly logger = new Logger(ResendWebhookController.name);
  // Signature verification is local; the API key is never used here.
  private readonly resend = new Resend('re_webhook_verification_only');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>) {
    const secret = this.config.email.webhookSecret;
    if (!secret) throw new ServiceUnavailableException('RESEND_WEBHOOK_SECRET not configured');

    let event: DeliveryEvent;
    try {
      event = this.resend.webhooks.verify({
        payload: req.rawBody?.toString('utf8') ?? '',
        headers: {
          id: req.header('svix-id') ?? req.header('webhook-id') ?? '',
          timestamp: req.header('svix-timestamp') ?? req.header('webhook-timestamp') ?? '',
          signature: req.header('svix-signature') ?? req.header('webhook-signature') ?? '',
        },
        webhookSecret: secret,
      }) as unknown as DeliveryEvent;
    } catch {
      throw new BadRequestException('Invalid signature');
    }

    const status = STATUS_BY_EVENT[event.type];
    if (!status || !event.data?.email_id) return { ok: true, ignored: event.type };

    const row = await this.prisma.emailOutbox.findUnique({
      where: { providerMessageId: event.data.email_id },
    });
    if (!row) return { ok: true, ignored: 'unknown email' };

    if (!(row.deliveryStatus && FINAL.has(row.deliveryStatus) && status === EmailDeliveryStatus.DELAYED)) {
      await this.prisma.emailOutbox.update({
        where: { id: row.id },
        data: { deliveryStatus: status, deliveryUpdatedAt: new Date(event.created_at || Date.now()) },
      });
    }

    if ((status === EmailDeliveryStatus.BOUNCED || status === EmailDeliveryStatus.COMPLAINED) && row.personId) {
      const reason =
        event.type === 'email.suppressed'
          ? 'Suppressed by Resend (address bounced or complained earlier)'
          : status === EmailDeliveryStatus.BOUNCED
            ? `Bounced: ${event.data.bounce?.message ?? event.data.bounce?.type ?? 'unknown'}`
            : 'Marked as spam by recipient';
      await this.prisma.person.update({
        where: { id: row.personId },
        data: { emailBouncedAt: new Date(), emailBounceReason: reason.slice(0, 500) },
      });
      this.logger.warn(`${row.toEmail}: ${reason}`);
    }
    return { ok: true };
  }
}
