import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { EmailsModule } from '../emails/emails.module';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { EntryService } from './entry.service';
import { ScanController } from './scan.controller';

@Module({
  imports: [DriveModule, EmailsModule, PaymentsModule, RegistrationsModule],
  controllers: [ScanController],
  providers: [EntryService],
  exports: [EntryService],
})
export class EntryModule {}
