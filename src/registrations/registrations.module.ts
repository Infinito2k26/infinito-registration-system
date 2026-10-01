import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { RegistrationsService } from './registrations.service';

@Module({
  imports: [EmailsModule],
  providers: [RegistrationsService],
  exports: [RegistrationsService],
})
export class RegistrationsModule {}
