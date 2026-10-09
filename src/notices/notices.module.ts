import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';

/** Admin → Notices: admin-written emails to selected participants, through the email queue. */
@Module({
  imports: [EmailsModule],
  controllers: [NoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
