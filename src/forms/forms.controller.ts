import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Logger,
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
import { getFormFieldMap, hasFormFieldOverrides } from './form-field-map';
import { parseFormResponse } from './form-response.parser';
import { FormsWebhookGuard } from './forms-webhook.guard';

/**
 * Responses (all JSON, written into the sheet's Status column by the Apps Script):
 *   200 { ok: true, outcome, events, teamId, memberCount, queuedEmails, warnings }
 *   400 { ok: false, errors }  malformed payload (script bug)
 *   401                        wrong secret
 *   409 { ok: false, errors }  conflicts with a verified registration; needs a human
 *   422 { ok: false, errors }  answers fail validation; fix the row or contact the team
 *   503 { ok: false, retry }   concurrent write; the script retries
 */
@Controller('webhooks/forms')
@UseGuards(FormsWebhookGuard)
export class FormsController {
  private readonly logger = new Logger(FormsController.name);

  constructor(private readonly registrations: RegistrationsService) {}

  @Post('submit')
  @HttpCode(200)
  async submit(
    @Body(new ZodValidationPipe(formSubmissionSchema)) body: FormSubmission,
  ) {
    // TEMPORARY diagnostic (sport/event import): what arrived, without answer values except Sports.
    this.logger.log(
      `Form row ${body.responseId} (sheet row ${body.sourceRow ?? '?'}): answers.Sports=${JSON.stringify(body.answers.Sports ?? null)}; columns=[${Object.keys(body.answers).join(' | ')}]`,
    );
    const context = { respondentEmail: body.respondentEmail || undefined };
    let parsed = parseFormResponse(body.answers, getFormFieldMap(), context);
    // The Sports answer is the only source of the event. A row for exactly one sport is
    // re-parsed with that event's field-map overrides (team size etc.), if any.
    if (parsed.ok && parsed.value.eventSlugs.length === 1 && hasFormFieldOverrides(parsed.value.eventSlugs[0])) {
      parsed = parseFormResponse(body.answers, getFormFieldMap(parsed.value.eventSlugs[0]), context);
    }
    if (!parsed.ok) {
      throw new UnprocessableEntityException({ ok: false, errors: parsed.errors });
    }

    try {
      const result = await this.registrations.ingest(
        {
          eventSlugs: parsed.value.eventSlugs,
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
