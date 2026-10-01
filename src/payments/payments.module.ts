import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { PaymentsService } from './payments.service';

@Module({
  imports: [EmailsModule],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
