import { Module } from '@nestjs/common';
import { RegistrationsModule } from '../registrations/registrations.module';
import { FormsController } from './forms.controller';
import { FormsWebhookGuard } from './forms-webhook.guard';

@Module({
  imports: [RegistrationsModule],
  controllers: [FormsController],
  providers: [FormsWebhookGuard],
})
export class FormsModule {}
