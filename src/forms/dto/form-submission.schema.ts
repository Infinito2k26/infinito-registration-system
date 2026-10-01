import { z } from 'zod';

/** Body POSTed by the Apps Script in apps-script/registration-form.gs. */
export const formSubmissionSchema = z.object({
  eventSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a slug like "code-sprint"'),
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
