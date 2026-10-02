import { z } from 'zod';

/** Body POSTed by the Apps Script in apps-script/registration-form.gs. */
export const formSubmissionSchema = z.object({
  /**
   * Ignored. Older versions of the Apps Script sent the sheet's EVENT_SLUG; the event now comes
   * only from the form's Sports answer. Still accepted so an old script keeps syncing.
   */
  eventSlug: z.string().max(100).optional(),
  /** Response sheet's spreadsheet ID; together with responseId identifies the row. */
  sourceForm: z.string().trim().min(1).max(200),
  sourceSheet: z.string().trim().max(200).optional(),
  sourceRow: z.number().int().positive().optional(),
  /** UUID the script stamps into the row's "Response ID" column. Stable across resyncs. */
  responseId: z.string().trim().min(1).max(100),
  submittedAt: z.iso.datetime({ offset: true }).optional(),
  respondentEmail: z.string().trim().max(320).optional(),
  answers: z.record(
    z.string().max(500),
    z.union([z.string().max(5000), z.array(z.string().max(5000)).max(50)]),
  ),
});

export type FormSubmission = z.infer<typeof formSubmissionSchema>;
