import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  RegistrationConflictError,
  RegistrationRetryableError,
  RegistrationsService,
} from '../registrations/registrations.service';
import { FormSubmission, formSubmissionSchema } from './dto/form-submission.schema';
import { getFormFieldMap } from './form-field-map';
import { parseFormResponse } from './form-response.parser';
import { FormsWebhookGuard } from './forms-webhook.guard';

/**
 * Responses (all JSON, written into the sheet's Status column by the Apps Script):
 *   200 { ok: true, outcome, teamId, memberCount, queuedEmails, warnings }
 *   400 { ok: false, errors }  malformed payload (script bug)
 *   401                        wrong secret
 *   409 { ok: false, errors }  conflicts with a verified registration; needs a human
 *   422 { ok: false, errors }  answers fail validation; fix the row or contact the team
 *   503 { ok: false, retry }   concurrent write; the script retries
 */
@Controller('webhooks/forms')
@UseGuards(FormsWebhookGuard)
export class FormsController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Post('submit')
  @HttpCode(200)
  async submit(
    @Body(new ZodValidationPipe(formSubmissionSchema)) body: FormSubmission,
  ) {
    const parsed = parseFormResponse(body.answers, getFormFieldMap(body.eventSlug), {
      respondentEmail: body.respondentEmail || undefined,
    });
    if (!parsed.ok) {
      throw new UnprocessableEntityException({ ok: false, errors: parsed.errors });
    }

    try {
      const result = await this.registrations.ingest(
        {
          eventSlug: body.eventSlug,
          sourceForm: body.sourceForm,
          sourceSheet: body.sourceSheet,
          sourceRow: body.sourceRow,
          responseId: body.responseId,
        },
        parsed.value,
      );
      return { ok: true, ...result, warnings: [...parsed.warnings, ...result.warnings] };
    } catch (error) {
      if (error instanceof RegistrationConflictError) {
        throw new ConflictException({ ok: false, errors: error.errors });
      }
      if (error instanceof RegistrationRetryableError) {
        throw new ServiceUnavailableException({ ok: false, retry: true, errors: [error.message] });
      }
      throw error;
    }
  }
}
