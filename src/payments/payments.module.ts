import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { BulkVerificationService } from './bulk-verification.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [EmailsModule],
  providers: [PaymentsService, BulkVerificationService],
  exports: [PaymentsService, BulkVerificationService],
})
export class PaymentsModule {}
