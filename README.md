# Infinito Registration System

Standalone registration, payment verification, QR pass and gate-entry system for Infinito 2K26.

## Technical foundation

This service follows the existing Infinito backend conventions:

- Node.js
- NestJS 11
- TypeScript
- Prisma 7.8
- PostgreSQL
- Resend
- QRCode

## Business flow

Google Forms -> Google Sheets -> Apps Script -> NestJS webhook -> PostgreSQL

Google Sheets is only the import layer. After sync, PostgreSQL is the source of truth and staff
work in the web app:

- **Coordinators / admins** (`/admin/registrations`): sport-wise lists, search, payment
  verify / reject / undo, QR email status and resends, history, entries (`/admin/entries`).
- **Volunteers** (`/scan`): scan a pass (`/p/<token>`), see photo/name/college/team/event, mark entered.
- **Admins** (`/admin/staff`): add staff and set roles. Everyone signs in with an emailed magic link.

Emails go through `EmailOutbox` and a background worker (Resend). See `.env.example` for limits,
the undo window and the resend cap.

## Local setup

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate dev --name init
npm run start:dev
```

Set `BOOTSTRAP_ADMIN_EMAILS` to your email, open http://localhost:3000/login, and copy the sign-in
link from the server log (no `RESEND_API_KEY` in development = emails are logged, not sent).

Health check:

```text
GET http://localhost:3000/health
```

## Registration webhook

`POST /webhooks/forms/submit` with header `X-Webhook-Secret: <FORMS_WEBHOOK_SECRET>`, called by
[apps-script/registration-form.gs](apps-script/registration-form.gs) installed in each form's
response spreadsheet (setup steps are at the top of that file). The server's reply is written into
the row's `Status` column.

- Question titles -> fields: [src/forms/form-field-map.ts](src/forms/form-field-map.ts). Update the
  aliases there once the form template is frozen; per-event differences (team size, free events)
  go in `EVENT_FORM_FIELD_OVERRIDES`.
- Re-sending a row (retry, `Infinito -> Resync`, or an edited response) updates the same team via
  its `Response ID`; it never duplicates people or emails.
- A reused transaction ID is reported as a warning in `Status`; moving a member whose payment is
  already verified is refused (409).

## Payments and QR passes

- Decisions are per team (one form response) and apply to all its members.
- **Verify**: blocked if the same transaction ID is already verified for another team. Creates the
  person's QR token (one per person, shared across events) and queues exactly one QR email per
  member. Verifying again never queues another.
- **Reject**: needs a reason; emails the captain. A team can re-submit the form with a new
  transaction ID and goes back to Pending.
- **Undo verification**: allowed until any QR email has actually been sent.
- **Resend QR email**: manual, limited by `QR_MANUAL_RESEND_LIMIT` per participant per event.
- Every action is recorded in `RegistrationActivity` and shown as the team's history.

## Gate

The QR is a link to `/p/<token>`. Anonymous visitors see nothing personal. Signed-in staff see the
entry card; MARK ENTERED succeeds once per registration even if several volunteers tap at once, and
every repeat scan is logged as refused with the original time, volunteer and gate.

## Email (Resend)

All sender settings come from `.env` (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `MAIL_FROM`,
`MAIL_REPLY_TO`); switching to the official account is a config change only.

- Check credentials: `npm run email:test -- you@example.com` sends one sample QR-pass email.
- Every email goes through `EmailOutbox` with a unique idempotency key (also sent to Resend), so
  retries and repeated clicks never duplicate an email.
- Errors: invalid recipient = that email fails; rate limit / quota / bad key / unverified sender =
  the whole queue pauses and nothing is marked failed; 5xx = retried with backoff up to
  `EMAIL_MAX_ATTEMPTS`.
- `EMAIL_TEST_RECIPIENT` (development only) redirects every email to one inbox.
- Delivery webhook: in Resend -> Webhooks, add `<APP_BASE_URL>/webhooks/resend` with events
  email.delivered, email.delivery_delayed, email.bounced, email.complained, email.failed,
  email.suppressed, and put the signing secret in `RESEND_WEBHOOK_SECRET`. Locally this needs a
  public tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`). Bounces show on the team page.
- Only one running instance should have the worker on per database (`EMAIL_WORKER_ENABLED=false`
  elsewhere); otherwise whichever instance claims a row sends it with its own settings.
