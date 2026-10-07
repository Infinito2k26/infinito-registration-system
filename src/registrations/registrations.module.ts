import { Module } from '@nestjs/common';
import { EmailsModule } from '../emails/emails.module';
import { ManualRegistrationService } from './manual-registration.service';
import { ParticipantProfileService } from './participant-profile.service';
import { RegistrationDeletionService } from './registration-deletion.service';
import { ParticipantsService } from './participants.service';
import { RegistrationsService } from './registrations.service';

@Module({
  imports: [EmailsModule],
  providers: [RegistrationsService, ParticipantsService, ManualRegistrationService, ParticipantProfileService, RegistrationDeletionService],
  exports: [RegistrationsService, ParticipantsService, ManualRegistrationService, ParticipantProfileService, RegistrationDeletionService],
})
export class RegistrationsModule {}
