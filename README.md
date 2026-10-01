# Infinito Registration System

Registration import, payment verification, QR entry passes and gate entry for **Infinito 2K26**.

## 1. Overview

Participants register through Google Forms, one form per sport/event. Each response is synced
into PostgreSQL, and from then on the database is the source of truth. Staff work in a small,
server-rendered web app:

| Who | Where | What |
|---|---|---|
| Coordinators / admins | `/admin/registrations` | Event-wise lists, search, verify/reject payments, QR email status and resends, history |
| Volunteers (and any staff) | `/scan` → `/p/<token>` | Scan a pass, check photo/name/college/team/event, MARK ENTERED |
| Admins | `/admin/staff` | Add staff, set roles, disable accounts |

Google Sheets is **only the import layer**. Payments are never verified in the sheet.

## 2. Architecture

```
Google Form ─► response Sheet ─► Apps Script (onFormSubmit / resync)
                                     │  POST /webhooks/forms/submit  (X-Webhook-Secret)
                                     ▼
                           NestJS app ──► PostgreSQL (Prisma)
                             │   ▲             │
     staff (magic link) ─────┘   │             ├─► EmailOutbox ─► worker ─► Resend ─► participant
                                 │             │                          ◄─ /webhooks/resend (delivery)
     participant QR ─► /p/<token> (gate)       └─► Google Drive (photos / IDs, via service account)
```

- **Stack:** Node.js 22+, NestJS 11, TypeScript, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL,
  Resend, `qrcode`, `jsqr`. There is no separate frontend: HTML is rendered on the server with
  escaped templates, and the only JavaScript is two small files in `public/`.
- **Modules:** `forms` (webhook + parser), `registrations` (ingest), `payments`, `emails`
  (outbox, worker, Resend, webhook), `auth` (magic links, sessions, roles, staff), `admin`
  (dashboard), `entry` (scan/gate), `drive` (photo proxy), `web` (HTML helpers).
- **Data model:**
  - `Person`: one per email, holds the QR token.
  - `Team`: one per form response; a solo entry is a team of one.
  - `TeamMember`
  - `Registration`: one per person per event, holds payment status and entry.
  - `RegistrationActivity`: the audit history.
  - `EmailOutbox`
  - `EntryLog`: every scan outcome.
  - `StaffUser` and `StaffSession`.

## 3. Prerequisites

- Node.js 22.12 or newer, and npm
- Docker (for local PostgreSQL), or any PostgreSQL 14+
- For real email: a Resend account with a verified sending domain
- For photos and IDs: a Google Cloud service account (optional)

## 4. Installation

```bash
npm install          # also runs `prisma generate`
cp .env.example .env
```

## 5. Environment variables

All configuration comes from environment variables. [.env.example](.env.example) documents every
one with its default. Key ones:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_BASE_URL` | yes | Public URL. Every QR and sign-in link is built from it. **https in production** |
| `APP_SECRET` | prod | Signs CSRF tokens (≥ 32 chars) |
| `FORMS_WEBHOOK_SECRET` | yes | Shared with the Apps Script (≥ 24 random chars in production) |
| `BOOTSTRAP_ADMIN_EMAILS` | first run | Comma-separated emails made active admins on every start |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO` | prod | Email sending (see §17) |
| `RESEND_WEBHOOK_SECRET` | optional | Delivery/bounce tracking |
| `EMAIL_TEST_RECIPIENT` | dev only | Redirect every email to one inbox; ignored in production |
| `EMAIL_WORKER_ENABLED` | | `false` on every instance except one per database |
| `DECISION_EMAIL_DELAY_SECONDS` | | Undo window before QR/rejection emails send (default 120) |
| `QR_MANUAL_RESEND_LIMIT` | | Manual QR resends per participant per event (default 3) |
| `QR_TOKEN_BYTES` | | QR token randomness (default 32, minimum 16) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | optional | Drive access for photos/IDs (see §23) |

**Development vs production.** With `NODE_ENV=production` the app **refuses to start** if any of
these is true:
- `APP_SECRET` is shorter than 32 characters.
- `FORMS_WEBHOOK_SECRET` is shorter than 24 characters, or is still `change-this-secret`.
- `APP_BASE_URL` is not `https://`.
- `RESEND_API_KEY` is missing.

Production also ignores `EMAIL_TEST_RECIPIENT`. In development, a missing Resend key means emails
are printed to the server log instead of sent.

## 6. PostgreSQL (Docker)

```bash
docker compose up -d      # postgres:16 on localhost:5433, db infinito_dev
```

## 7. Prisma setup

The Prisma CLI reads `DATABASE_URL` through [prisma.config.ts](prisma.config.ts). `npm install`
already generates the client; run `npx prisma generate` after changing `prisma/schema.prisma`.

## 8. Migrations

```bash
npx prisma migrate deploy     # apply all migrations (local, CI, production)
npx prisma migrate status
npx prisma migrate dev --name <change>   # only when you change the schema
```

The three migrations in `prisma/migrations` apply cleanly to an empty database.

## 9. Seed / bootstrap admin

Set `BOOTSTRAP_ADMIN_EMAILS=you@example.com`. The app makes those addresses active admins on every
start. To do it without starting the app, run:

```bash
npx prisma db seed            # idempotent; never deletes or downgrades anyone
```

## 10. Running locally

```bash
npm run start:dev                         # http://localhost:3000, health: GET /health
```

Open `/login`, enter your bootstrap admin email, and click the link. Without a Resend key, copy the
link from the server log.

| Command | What |
|---|---|
| `npm test` | Unit tests |
| `npm run test:e2e` | End-to-end tests (real app + PostgreSQL). Needs `E2E_DATABASE_URL`, see §10a |
| `npm run check-types` / `npm run lint` | TypeScript / ESLint |
| `npm run build` then `npm run start:prod` | Production build and start (`node dist/src/main`) |
| `npm run email:test -- you@example.com` | Send one real sample QR email with the current `.env` |

**10a. E2E database.** The e2e suite truncates every table, so it only runs against a database
whose name contains `e2e` or `test`. Migrations are applied to it automatically.

```bash
docker exec infinito_registration_postgres psql -U postgres -c "create database infinito_e2e"
E2E_DATABASE_URL="postgresql://postgres:infinito_dev_pwd@localhost:5433/infinito_e2e" npm run test:e2e
```

When `NODE_ENV=test`, the app ignores `.env`, so tests never pick up real credentials.

## 11. Google Form setup

Use the agreed question titles. Matching ignores letter case, extra spaces, a trailing `*` and a
trailing `:`. The aliases live in [src/forms/form-field-map.ts](src/forms/form-field-map.ts):

| Field | Accepted titles (examples) |
|---|---|
| Team name | `Team Name` (optional; defaults to the captain's name) |
| Transaction ID | `Transaction ID`, `UPI Transaction ID`, `UTR Number`, `UTR` |
| Member *n* | `Member {n} Name`, `Member {n} Email`, `Member {n} Phone`, `Member {n} College`, `Member {n} Photo`, `Member {n} ID` |
| Member 1 fallbacks | `Captain Name`, `Name`, `Email`, `Phone`, `College ID`… plus the form's collected email |
| College (whole team) | `College`, `College Name`, `Institute` |

Per-event differences, such as team size or a free event with no transaction ID, go in
`EVENT_FORM_FIELD_OVERRIDES` in the same file. Uploads (photo/ID) must be Google Forms
file-upload questions.

Normalisation:
- Emails are lowercased.
- Indian phone numbers are reduced to 10 digits.
- Transaction IDs are uppercased with spaces removed (`utr 111` = `UTR111`).
- Drive links are reduced to file IDs.

Invalid rows are rejected, and every problem is listed in the sheet.

## 12. Google Sheet setup

Link each form to its own response spreadsheet (Responses → Link to Sheets). Don't sort the sheet
or delete rows, and don't edit the `Response ID` column. Protecting that column is a good idea.

## 13. Apps Script setup

In the response spreadsheet, open Extensions → Apps Script, paste
[apps-script/registration-form.gs](apps-script/registration-form.gs), set the Script Properties
(§14), then run `setup` once and approve the permissions. `setup`:
- adds the helper columns **Status** and **Response ID** to the right of the form columns
- installs the form-submit trigger, so new submissions sync automatically
- adds an **Infinito** menu with *Resync unsent rows* and *Resync selected rows*

## 14. Script Properties

| Property | Value |
|---|---|
| `WEBHOOK_URL` | `https://<your-server>/webhooks/forms/submit` (the base URL alone also works) |
| `WEBHOOK_SECRET` | exactly the server's `FORMS_WEBHOOK_SECRET` |
| `EVENT_SLUG` | the event's slug, e.g. `table-tennis` |

## 15. EVENT_SLUG

The slug decides which event a sheet's registrations belong to, and the dashboard groups by it.
It is lowercased; allowed characters are `a-z`, `0-9` and single hyphens. The display name comes
from the slug (`table-tennis` → "Table Tennis") unless `EVENT_NAMES` overrides it. **Choose the
slug before syncing and don't change it afterwards**: rows resynced under a new slug become new
registrations for a different event.

## 16. Existing-row resync

Rows submitted before `setup`, or rows that failed with `⚠ Not synced` (server down, wrong URL),
are picked up by **Infinito → Resync unsent rows**. Rows marked `❌` have bad data: fix the cells,
select the rows, then use **Resync selected rows**.

Resync is idempotent. Each row's **Response ID** (stamped on first sync) maps to one team, so
resending a row, or a respondent editing their response, updates it instead of duplicating it.

What the **Status** column shows:
- `✅ Received · N member(s)`, plus warnings such as a reused transaction ID
- `❌ <reasons>` for validation problems or conflicts
- `⚠ Not synced (...)` for transient or configuration problems

## 17. Resend setup

1. Verify your sending domain in Resend and create an API key.
2. Set the following:
   - `RESEND_API_KEY`
   - `MAIL_FROM="Infinito 2K26 <no-reply@your-domain>"`
   - `MAIL_REPLY_TO` (a monitored inbox)
3. Check the setup with `npm run email:test -- you@example.com`.
4. Optional delivery tracking:
   - In Resend → Webhooks, add `<APP_BASE_URL>/webhooks/resend` with the events `email.delivered`,
     `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and
     `email.suppressed`.
   - Set `RESEND_WEBHOOK_SECRET` to the `whsec_…` signing secret.
   - Bounces and spam complaints then show on the team page.

For development without a domain, use `MAIL_FROM="Infinito Dev <onboarding@resend.dev>"` with
`EMAIL_TEST_RECIPIENT=<your Resend account email>`. Switching to the official account later only
changes these variables.

**How the worker behaves:**
- **One queue.** Every email goes through `EmailOutbox` with a unique idempotency key, which is
  also sent to Resend, so retries, double clicks and crashes never duplicate an email.
- **Concurrency.** The worker claims rows atomically, so two running instances can't send the
  same row. Still, run only one sender per database (`EMAIL_WORKER_ENABLED=false` elsewhere).
- **Errors:**
  - An invalid recipient fails only that email.
  - Rate limits, used-up quota, a bad key or an unverified sender pause the whole queue without
    using up attempts.
  - 5xx errors retry with exponential backoff, up to `EMAIL_MAX_ATTEMPTS`.
  - `EMAIL_DAILY_CAP` throttles sending while a new domain warms up.

## 18. QR email flow

1. A coordinator clicks **Verify payment** on a team.
2. In one transaction, the app:
   - checks the transaction ID isn't verified for another team;
   - marks every member VERIFIED;
   - creates each member's QR token if they don't have one: 32 random bytes, one per person,
     reused across events;
   - queues **exactly one** QR email per member.
3. The emails wait `DECISION_EMAIL_DELAY_SECONDS` (the undo window) and then send. Each member
   gets their own pass. The QR encodes `<APP_BASE_URL>/p/<token>`; it is inline in the email and
   also attached as a PNG.
4. Clicking Verify again (or 5 times at once) never queues another email. Undo → Verify re-arms the
   same email instead of creating a new one.

## 19. Manual QR resend

On the team page each verified member has a **Resend QR email** button with
"Sent N× · last … · Manual resends used/limit".

- The resend reuses the **same QR token**. Earlier emails stay valid, and no new token or
  registration is ever created.
- It goes to the participant's registered email.
- It is only allowed while the registration is VERIFIED. Unverified or rejected registrations are
  refused.
- The limit is `QR_MANUAL_RESEND_LIMIT` (default **3**) manual sends per participant per event.
  The automatic first email doesn't count.
- A resend is refused while another QR email for that participant is still queued. Simultaneous
  clicks are serialised by a database lock, so they can't exceed the limit.
- If an email failed, for example after a bounce, use Resend to try again; it counts toward the
  same limit.
- Each resend is recorded in the history with who clicked it.

## 20. Staff roles

| Role | Can |
|---|---|
| `ADMIN` | Everything coordinators can, plus `/admin/staff` (add staff, change roles, disable) |
| `COORDINATOR` | Registrations, search, verify/reject/undo payments, QR resends, entries, history |
| `VOLUNTEER` | `/scan` and pass pages only: photo, name, college, team, event, ID, MARK ENTERED |

Roles are enforced on the server for every route, including direct URLs and POSTs. Volunteers never
see email, phone or transaction IDs.

How sign-in works:
- Staff sign in with a single-use link that expires after 15 minutes. It's sent at most once per
  minute per account, and the login form is also limited per IP.
- Sessions are `HttpOnly` and `SameSite=Lax` cookies, `Secure` over https, and are stored hashed.
- Disabling an account signs it out everywhere.

## 21. Admin dashboard

- **`/admin/registrations`:**
  - an event sidebar with team counts and pending counts
  - search by participant name, email, team name, transaction ID, or registration/team ID
  - payment-status chips and a duplicate-transaction badge
- **`/admin/teams/<id>`:**
  - members, contact details, photo and ID links
  - payment details, Verify, Reject (a reason is required and is emailed to the captain), and Undo
    (until the QR emails have actually been sent)
  - QR email status and Resend, entry state per member
  - all emails with their delivery status, and the full activity history
- **`/admin/entries`:** every scan, including refused repeats, by event.

Payment rules:
- Decisions apply to the whole team, meaning the whole form response.
- Rejecting before entry revokes the passes. The pass page then shows *DO NOT ADMIT*, and any QR
  email not yet sent is cancelled.
- Once any member has entered, the team can no longer be rejected.
- After a rejection, the team can submit the form again with a new transaction ID and goes back to
  Pending.

## 22. Volunteer scan flow

1. Open `/scan` (it asks for the camera), or scan with the phone's normal camera app. The QR is a
   URL that opens the pass page in the browser where the volunteer is signed in.
2. The pass page shows:
   - photo, name, college, and an ID link
   - for each event: team, team entry progress, and the verdict
3. The verdict is a big **MARK ENTERED** button if the payment is verified.
4. Tapping it records the entry once. Ten simultaneous taps still produce one entry, and every
   repeat is logged as refused.
5. A repeat scan shows **ALREADY ENTERED** with the time, the volunteer and the gate.
6. Anonymous visitors see only "Show this QR to a volunteer". Unknown tokens show *NOT A VALID
   PASS*.

## 23. Google Drive setup (photos and IDs)

1. Create a Google Cloud service account (no roles needed) and download a JSON key.
2. Share each form's upload folder in Drive with the service account's email as **Viewer**.
3. Put the JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`, either raw or base64-encoded.

Files are fetched on demand and served only to signed-in staff at `/staff/files/<personId>/photo|id`.
- Allowed types: images and PDFs, up to 10 MB.
- Responses are private and briefly cached.
- Drive URLs and the key are never sent to browsers.
- Missing or inaccessible files show "No photo"; they never cause an error page.

## 24. Production deployment checklist

- [ ] PostgreSQL provisioned; `DATABASE_URL` set; run `npx prisma migrate deploy` on each release.
- [ ] `NODE_ENV=production`, `APP_BASE_URL=https://<domain>`, served over HTTPS.
- [ ] `APP_SECRET` (`openssl rand -hex 32`) and `FORMS_WEBHOOK_SECRET` (`openssl rand -hex 24`) set.
- [ ] `RESEND_API_KEY`, `MAIL_FROM` on a verified domain (SPF/DKIM/DMARC), `MAIL_REPLY_TO` set;
      `EMAIL_TEST_RECIPIENT` unset; `npm run email:test` succeeds.
- [ ] Resend webhook → `https://<domain>/webhooks/resend`, `RESEND_WEBHOOK_SECRET` set.
- [ ] `BOOTSTRAP_ADMIN_EMAILS` set for the first admin; other staff added in `/admin/staff`.
- [ ] Exactly one instance with `EMAIL_WORKER_ENABLED=true`.
- [ ] Host does not sleep (cold starts at the gate are not acceptable).
- [ ] Apps Script `WEBHOOK_URL` → `https://<domain>/webhooks/forms/submit`, `WEBHOOK_SECRET` updated,
      **Resync unsent rows** run once.
- [ ] Drive service account set up if photos/IDs are needed.
- [ ] Gate dry run on real phones; printed per-event name lists as the offline fallback.

Build and start: `npm ci && npm run build && npx prisma migrate deploy && npm run start:prod`.
The Prisma CLI is a regular dependency, so migrations also work in a production-only install.
A Cloudflare tunnel is only a local testing aid; the app doesn't depend on one.

## 25. Security considerations

- **Webhooks.**
  - Forms: a shared secret, compared in constant time.
  - Resend: a signed payload (Standard Webhooks), checked against the raw request body.
- **Auth.**
  - Magic links: single use, short-lived, stored hashed, consumed only on POST so email link
    scanners can't burn them.
  - Sessions: stored hashed, revocable.
  - Staff roles: checked on the server for every route.
- **CSRF and cross-site requests.**
  - Every staff form carries a per-session HMAC token.
  - All non-webhook POSTs from another origin are rejected.
  - Cookies are `SameSite=Lax`.
- **XSS.**
  - All HTML is built with an auto-escaping template helper.
  - Helmet's default CSP (`script-src 'self'`) blocks inline scripts.
  - Participant files are served with `nosniff`, and images are sandboxed.
- **Data exposure.**
  - QR tokens are random, unrelated to database IDs, and unguessable.
  - Pass pages reveal nothing to anonymous visitors, and volunteers see no email, phone or
    transaction ID.
  - Signed-in pages are `Cache-Control: no-store`.
- **Concurrency.**
  - Verify and reject take per-team and per-transaction database locks.
  - Entry is a conditional update, so only one tap can succeed.
  - QR resends take a per-registration lock.
  - Email enqueueing is protected by unique idempotency keys.
- **Abuse.**
  - The login form is limited per IP, and sign-in emails are limited per account.
  - Resends are capped.
  - Inputs are validated with zod or explicit parsing.
  - SQL goes only through Prisma or parameterised tagged templates.
- **Secrets.** Secrets live only in the environment; nothing is hardcoded, and `.env*` is
  git-ignored except `.env.example`.
