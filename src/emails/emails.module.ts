import { Module } from '@nestjs/common';
import { EmailOutboxService } from './email-outbox.service';
import { EmailWorkerService } from './email-worker.service';
import { QrEmailService } from './qr-email.service';
import { ResendWebhookController } from './resend-webhook.controller';

@Module({
  controllers: [ResendWebhookController],
  providers: [EmailOutboxService, EmailWorkerService, QrEmailService],
  exports: [EmailOutboxService, EmailWorkerService, QrEmailService],
})
export class EmailsModule {}
