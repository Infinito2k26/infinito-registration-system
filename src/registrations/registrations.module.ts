import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { ParticipantsService } from './participants.service';
import { RegistrationsService } from './registrations.service';

@Module({
  imports: [EmailsModule],
  providers: [RegistrationsService, ParticipantsService],
  exports: [RegistrationsService, ParticipantsService],
})
export class RegistrationsModule {}
