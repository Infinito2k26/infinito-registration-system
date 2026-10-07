import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { EmailsModule } from '../emails/emails.module';
import { EntryModule } from '../entry/entry.module';
import { PaymentsModule } from '../payments/payments.module';
import { RegistrationsModule } from '../registrations/registrations.module';
import { AadhaarDuplicatesService } from './aadhaar-duplicates.service';
import { AdminQueryService } from './admin-query.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [PaymentsModule, EmailsModule, DriveModule, EntryModule, RegistrationsModule],
  controllers: [AdminController],
  providers: [AdminQueryService, AadhaarDuplicatesService],
})
export class AdminModule {}
