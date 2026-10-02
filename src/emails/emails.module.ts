import { Module } from '@nestjs/common';
import { CollegeEmailService } from './college-email.service';
import { EmailOutboxService } from './email-outbox.service';
import { EmailWorkerService } from './email-worker.service';
import { QrEmailService } from './qr-email.service';
import { ResendWebhookController } from './resend-webhook.controller';

@Module({
  controllers: [ResendWebhookController],
  providers: [EmailOutboxService, EmailWorkerService, QrEmailService, CollegeEmailService],
  exports: [EmailOutboxService, EmailWorkerService, QrEmailService, CollegeEmailService],
})
export class EmailsModule {}
