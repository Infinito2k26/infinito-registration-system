import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { ManualRegistrationService } from './manual-registration.service';
import { ParticipantsService } from './participants.service';
import { RegistrationsService } from './registrations.service';

@Module({
  imports: [EmailsModule],
  providers: [RegistrationsService, ParticipantsService, ManualRegistrationService],
  exports: [RegistrationsService, ParticipantsService, ManualRegistrationService],
})
export class RegistrationsModule {}
