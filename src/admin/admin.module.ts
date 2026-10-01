import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { EmailsModule } from '../emails/emails.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminQueryService } from './admin-query.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [PaymentsModule, EmailsModule, DriveModule],
  controllers: [AdminController],
  providers: [AdminQueryService],
})
export class AdminModule {}
