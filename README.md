# Infinito Registration System

Registration import, manual verification, QR entry passes, college-level email operations and gate
check-in/check-out for **Infinito 2K26**.

Participants fill a Google Form. Each response row is synced into PostgreSQL, which is the source of
truth from then on. Coordinators verify participants and send passes from a web dashboard, and
volunteers scan passes at the gate. The Google Sheet is only the import layer: nothing is decided in
it, and nothing is read back from it.

**Key concepts (never mixed):**

| Term | Meaning | Source |
|---|---|---|
| **Expected arrival date** | The participant's planned or approximate arrival | Form question "Check In Date" |
| **Expected departure date** | The participant's planned or approximate departure | Form question "Check Out Date" |
| **Actual check-in (IN)** | The moment the participant's QR was scanned in at the gate | Server clock at **MARK ENTERED / CHECK IN** |
| **Actual check-out (OUT)** | The moment the participant's QR was scanned out at the gate | Server clock at **CHECK OUT** |
| **Blocked** | The participant's QR is refused for every IN and OUT until unblocked | Coordinator/admin action |

---

## 1. Architecture

```
Google Form ─► Response Sheet ─► Apps Script (form-submit trigger / resync menu)
                                   │ POST /webhooks/forms/submit   (X-Webhook-Secret)
                                   ▼
                         NestJS app ──► PostgreSQL (Prisma)  ◄── source of truth
                           │   ▲            │
   staff (magic link) ─────┘   │            ├─► EmailOutbox ─► worker ─► Resend ─► participant
                               │            │                        ◄─ /webhooks/resend (delivery)
   participant QR ─► /p/<token> (gate)      └─► Google Drive (photos / ID / Aadhaar, via service account)
```

- **Stack:** Node.js 22+, NestJS 11, TypeScript, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL,
  Resend, `qrcode`, `jsqr`. Pages are rendered on the server with auto-escaping templates, and the
  only JavaScript is two small files in `public/`.
- **Modules:**
  - `forms`: webhook and parser
  - `registrations`: ingest, colleges, email change
  - `payments`: verify, reject, undo
  - `emails`: outbox, worker, Resend, college bulk sends
  - `entry`: gate check-in/out
  - `admin`: dashboard
  - `auth`: magic links, sessions, roles, staff
  - `drive`: file proxy
  - `web`: HTML helpers
- **Data model:**

| Table | Holds |
|---|---|
| `Person` | One per email: name, mobile, roll no., college, Aadhaar **last 4 digits** only, Drive file IDs, QR token, gate block (`blockedAt`, `blockedById`, `blockReason`) |
| `College` | Colleges grouped by a normalised name (case and spacing ignored) |
| `PersonEmailAlias` | Previous emails after a staff email change |
| `Team` + `TeamMember` | One per form response (individual forms = a team of one) |
| `Registration` | One per participant per event: verification status, planned dates (`expectedArrival/DepartureText` + parsed `…Date`), accommodation/remark, actual gate presence (`insideSince`, `lastCheckInAt`, `lastCheckOutAt`) |
| `RegistrationActivity` | Audit history |
| `EmailOutbox` | Every email, with status and delivery |
| `EmailBatch` | Audit record of each college bulk send |
| `EntryLog` | Every check-in/check-out attempt, successful or refused |
| `StaffUser` / `StaffSession` | Staff accounts and signed-in devices |

## 2. Prerequisites

- Node.js 22.12 or newer, and npm
- Docker (for local PostgreSQL), or PostgreSQL 14+
- A Resend account with a verified sending domain (for real email)
- A Google Cloud service account (optional; needed to show photos, IDs and Aadhaar images)

## 3. Installation

```bash
npm install          # also runs `prisma generate`
cp .env.example .env
```

## 4. `.env`

Every variable is documented in [.env.example](.env.example). The main ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `APP_BASE_URL` | Public URL. QR and sign-in links are built from it (https in production) |
| `APP_SECRET` | Signs CSRF tokens (≥ 32 characters in production) |
| `FORMS_WEBHOOK_SECRET` | Shared with the Apps Script (≥ 24 random characters in production) |
| `BOOTSTRAP_ADMIN_EMAILS` | Comma-separated; made active admins on every start |
| `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email provider: Resend (default) or SMTP, e.g. Gmail (§34) |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO`, `RESEND_WEBHOOK_SECRET` | Email (§34) |
| `EMAIL_TEST_RECIPIENT` | Development only: deliver every email to one inbox |
| `EMAIL_WORKER_ENABLED` | Set `false` on all but one instance per database |
| `DECISION_EMAIL_DELAY_SECONDS` | Undo window before QR/rejection emails send (default 120) |
| `QR_MANUAL_RESEND_LIMIT` | Manual QR sends per participant per event; **0 = unlimited (default)** |
| `QR_TOKEN_BYTES` | QR token randomness (default 32) |
| `EVENT_NAMES` | Optional display names per slug |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Drive access (§35) |
| `AADHAAR_ENCRYPTION_KEY` | Stores full Aadhaar numbers **encrypted** (AES-256-GCM) for admins; empty = last 4 digits only |
| `VOLUNTEERS_CAN_VERIFY` | `true` lets volunteers verify from the gate card (default `false`) |

## 5. PostgreSQL

```bash
docker compose up -d      # postgres:16 on localhost:5433, database infinito_dev
```

## 6. Prisma

The schema is in `prisma/schema.prisma`, and the CLI reads `DATABASE_URL` through
`prisma.config.ts`.

```bash
npx prisma migrate deploy   # apply migrations (local, CI and production)
npx prisma migrate status
npx prisma validate
npx prisma migrate dev --name <change>   # only when you change the schema
```

Five migrations apply cleanly to an empty database. The last two preserve existing data:
- **`20261003090000_college_inout_email_ops`:** creates colleges from existing participants and
  marks anyone who had already entered as inside.
- **`20261004090000_expected_dates_and_block`:**
  - It *renames* the form date columns to `expectedArrivalText` and `expectedDepartureText`; no
    data is lost.
  - It adds parsed `expectedArrivalDate` and `expectedDepartureDate`, backfilled from the existing
    text. Unreadable values are left for the next resync.
  - It adds the participant block fields.

## 7. Seed / bootstrap admin

Set `BOOTSTRAP_ADMIN_EMAILS=you@example.com` and start the app. You can also run
`npx prisma db seed`. Either way it is idempotent and never deletes or downgrades anyone.

## 8. Local run

```bash
npm run start:dev       # http://localhost:3000   (health: GET /health)
```

Without `RESEND_API_KEY`, emails are printed to the server log instead of sent, which is useful for
sign-in links during development.

## 9. Google Form setup

Every form must have a **Sports** question: it is the **only** source of the event (§15). One
form can serve one sport or many. The current form has these fields:
Email, College Name, Sports, Name, Mobile No., College Roll No., College ID Card Photo, Aadhaar No.,
Aadhaar Card Photo, Check In Date, Check Out Date, Accommodation, Accommodation Period and Remark.
No payment question is needed.

Uploads must be Google Forms file-upload questions.

**Aadhaar:**
- The **last 4 digits** are always stored.
- The **full number** is stored only if `AADHAAR_ENCRYPTION_KEY` is set, and then only encrypted
  (AES-256-GCM).
- The full number is decrypted solely to render an **admin's** page.
- Coordinators and volunteers only ever receive `XXXX XXXX 1234` from the server.
- The Aadhaar card image is **admin-only**: `/staff/files/<id>/aadhaar` returns 403 for anyone
  else, even with a copied link.
- Participants imported before the key was set get their full number on the next resync, because
  the Sheet still holds it.
- Losing the key makes the stored numbers unreadable.

## 10. Google Sheet setup

Link the form to a response spreadsheet (Responses → Link to Sheets). Don't sort the sheet or delete
rows, and don't edit the `Response ID` column; protecting that column is recommended. The Sheet is
**import-only**: verification, email changes, QR passes, resends and IN/OUT live in the database and
are never written back to the Sheet.

## 11. Apps Script

In the response spreadsheet, open Extensions → Apps Script, paste
[apps-script/registration-form.gs](apps-script/registration-form.gs), set the Script Properties
(§12), then run `setup` once and approve the permissions. `setup`:
- adds the helper columns **Status** and **Response ID** to the right of the form columns
- installs the form-submit trigger, so new rows sync automatically
- adds an **Infinito** menu with *Resync unsent rows* and *Resync selected rows*

## 12. Script Properties

| Property | Value |
|---|---|
| `WEBHOOK_URL` | see §13 |
| `WEBHOOK_SECRET` | see §14 |

There is **no `EVENT_SLUG`** any more. An old `EVENT_SLUG` property is simply ignored, and you can
delete it.

## 13. WEBHOOK_URL

`https://<your-server>/webhooks/forms/submit`. The base URL alone also works; the script adds the
path. If it's wrong, rows show `⚠ Not synced (HTTP 404: check the WEBHOOK_URL …)`.

## 14. WEBHOOK_SECRET

Exactly the server's `FORMS_WEBHOOK_SECRET`. A mismatch shows `❌ Webhook secret mismatch`.

## 15. Event = the Sports answer

The event of each row comes **only** from its **Sports** answer, slugified:

| Sports answer | Event |
|---|---|
| Football | `football` |
| Table Tennis | `table-tennis` |
| Badminton | `badminton` |
| Football, Table Tennis | `football` **and** `table-tennis` (one registration each) |

- **How the script finds the column.** It locates the sport column by its header: **Sports**,
  **Sport**, **Event** or **Game**, ignoring case, spaces, invisible characters and a trailing
  `*`/`:`. Failing that, it uses a header starting with "Sport", e.g. "Sports (TT, Hockey)".
- **What it sends.** The value always goes to the server as `answers.Sports`; e.g. `TT` → `tt`,
  `hoki` → `hoki`. Each sync logs `Infinito sync row N: Sports column "…", answers.Sports = "…"`
  (Apps Script → Executions). The server temporarily logs the received `answers.Sports` and column
  titles.
- **No Sports answer, no import.** A row without a Sports answer is **rejected**, with
  `❌ Sports is missing: the sport/event must be chosen in the form` in Status. There is no
  fallback event.
- **One person, many sports.** The same email is always the same Person with the same QR. Each
  sport gets its own registration, whether chosen in one row or in separate submissions.
- **Display names** come from the slug (`table-tennis` → "Table Tennis") unless `EVENT_NAMES`
  overrides them.
- **Keep the options stable.** Renaming a Sports option after syncing creates registrations under
  the new name; use a dropdown or multiple-choice question.
- **Per-event field overrides** (`EVENT_FORM_FIELD_OVERRIDES`) are keyed by this slug.

## 16. Resync

- **Not yet synced:** rows submitted before `setup`, or marked `⚠ Not synced` (server down, wrong
  URL), are picked up by **Infinito → Resync unsent rows**.
- **Bad data:** rows marked `❌` need fixing first. Correct the cells, select the rows, then use
  **Resync selected rows**.
- **Idempotent:** each row's Response ID maps to the same records, so resyncing never duplicates a
  participant or a registration.

On resync, only form data is refreshed: name, mobile, roll number, college, files, accommodation and
remark. The following are never overwritten:
- verification status and reviewer
- the QR token
- an email changed by staff (§25)
- email history
- check-in/check-out
- audit history

If an edited response drops a sport, that sport's unverified registration is removed. A verified or
entered one is kept, with a warning in Status.

## 17. Form field mapping

Titles are matched ignoring letter case, extra spaces, and a trailing `*`, `:`, `.` or `?`. So
`Email`, `Email ID`, `Email Address`, `Email Address *` and `Email Address:` all work. Aliases live
in [src/forms/form-field-map.ts](src/forms/form-field-map.ts):

| Field | Accepted titles (examples) |
|---|---|
| Email | Email, Email ID, Email Address, E-mail (plus the form's own collected email) |
| Name | Name, Full Name, Participant Name |
| College | College Name, College, Institute |
| Sports (**required**: the event) | Sports, Sport, Event, Game |
| Mobile | Mobile No., Mobile Number, Mobile, Phone, Phone Number, Contact Number |
| Roll no. | College Roll No., College Roll Number, Roll No., Roll Number |
| College ID image | College ID Card Photo, College ID Card, College ID, ID Card Photo |
| Aadhaar | Aadhaar No. / Number (last 4 kept); Aadhaar Card Photo |
| Expected arrival | Check In Date, Check-in Date, Arrival Date, Expected Arrival Date |
| Expected departure | Check Out Date, Check-out Date, Departure Date, Expected Departure Date |
| Accommodation | Accommodation, Accommodation Period |
| Remark | Remark, Remarks, Comments |
| Team forms | Team Name, Member {n} Name / Email / … (still supported) |

Per-event differences go in `EVENT_FORM_FIELD_OVERRIDES`, keyed by the Sports slug. For example,
`requireTransactionId: true` for a form that collects one; it is not required by default. Sports is
always required.

Normalisation:
- Emails are lowercased.
- Indian mobile numbers are reduced to 10 digits.
- Drive links are reduced to file IDs.

Invalid rows are rejected and every reason is listed in the Status column.

> **"Check In Date" and "Check Out Date" are PLANNED dates** (expected arrival and expected
> departure). They never become gate times; actual IN/OUT comes only from QR scans (§29–30).
>
> **Accepted formats:** `2026-10-05`, `05/10/2026` (day first, as used in India), `5-10-2026`,
> `5.10.26`, `5 October 2026`, `05 Oct 2026` and `October 5, 2026`. The Apps Script sends Sheets
> date cells as `yyyy-MM-dd` in the sheet's timezone.
>
> **Missing or unreadable dates** never reject a registration. They are kept as text, with a
> warning in Status.

## 18. Admin login

Open `/login`, enter your email, and click the link that arrives by email:
- It works once and expires after 15 minutes.
- It is sent at most once per minute per account.
- Admins land on `/admin/registrations`.

## 19. Coordinator login

Coordinators are added by an admin at `/admin/staff` with the role *coordinator*, and sign in the
same way.

## 20. Volunteer login

Volunteers are added with the role *volunteer*, sign in the same way, and land on `/scan`.

## 21. Manual verification

Every imported registration starts as **PENDING**. On the participant page, a coordinator clicks
**Verify**. In one transaction this:
- marks the registration VERIFIED;
- creates the participant's QR token if they don't have one yet;
- queues exactly **one** automatic QR email;
- records who did it and when.

Simultaneous clicks can't create a second token or email. **Reject** needs a reason, which is
emailed to the participant. Rejecting before entry revokes the pass; after any check-in, the
registration can no longer be rejected. **Undo verification** works until the QR email has actually
been sent. For a multi-member team form, these actions apply to the whole response.

## 22. QR generation

A QR token is 32 random bytes (`QR_TOKEN_BYTES`), created once per participant on their first
verification. It is unrelated to any database ID. The QR encodes `<APP_BASE_URL>/p/<token>`.

The token never changes: not on resend, bulk send, email change or re-verification. One participant
has one token across all their events.

## 23. Individual QR email

After verification, the participant receives **their own** pass at **their current email**. The
email shows their name, event and college, includes the QR inline, and attaches it as a PNG. The
participant page shows how many times it was sent, the last send time, the delivery status and any
failure.

## 24. Repeated QR resend

**Send QR email / Resend QR email** on the participant page can be used as many times as needed.
`QR_MANUAL_RESEND_LIMIT=0` is the default and means unlimited.
- **Same pass:** it always reuses the same token and goes to the participant's current email.
- **Verified only:** unverified and rejected participants are refused.
- **One at a time:** only one QR email per participant can be waiting at once, which stops double
  clicks. The next send is allowed as soon as the previous one has gone out or failed.
- **Retry after failure:** a failed email can be sent again.
- **Audited:** every send records the staff member, recipient and time.

## 25. Change email

On the participant page, use **Change email**.
- **Validated and normalised**, like form emails.
- **Same participant:** the person keeps the same registrations, QR token, verification status and
  entry history.
- **History:** the old and new address are recorded with the staff member and time.
- **Queued emails:** any still waiting are redirected to the new address.
- **No automatic email:** use *Send QR email* afterwards if needed.
- **Conflicts:** an address already used by another participant is refused, and records are never
  merged.
- **Resync-safe:** the old address is kept as an alias, so resyncing the old sheet row maps to the
  same person and does not revert the change.

## 26. College dashboard

`/admin/colleges` lists every college with **Total / Verified / Pending / Inside / Outside**. The
list can be filtered by event and searched by college name. A college's page shows:
- event chips and the counters
- all its participants, with status, gate state and QR email status
- the two bulk actions
- a history of college email runs with live sent, failed and waiting counts

## 27. Send QR to all college students

**Send QR to all verified students** sends every VERIFIED student of that college (in the selected
event, or all events) **their own QR at their own email**:
- Unverified and rejected students are excluded.
- Existing tokens are reused.
- One email is queued per registration through the outbox. A failed recipient doesn't affect the
  others.
- Clicking twice while emails are still waiting doesn't queue duplicates.
- Each run is recorded as an `EmailBatch`: who, college, event, eligible and queued counts. Every
  student's history also gets an entry.

## 28. Send all college QR passes to one selected student

**Send all college QR passes to one student** sends **one consolidated email** to the selected
student's current address. It contains every verified student of that college (and event):
- one entry per student, with their name, college and event(s)
- the student's own QR inline, plus a PNG attachment named after them

Each QR is still that student's own pass: no token is replaced or created. The email says clearly
that each QR admits only its owner.

Rules:
- **Recipient:** must be a verified participant of the same college; anyone else is refused.
- **Scope:** unverified and rejected students, and other colleges, are never included.
- **Size:** more than 40 passes are split into numbered emails.
- **Audit:** the run is recorded with the staff member, college, recipient, recipient email, pass
  count and time.
- **Who can do it:** coordinators and admins only.

## 29. Check-in (actual IN)

Every scan runs these checks in order, on the server:
1. **Valid QR?** If not: *INVALID QR*.
2. **Registration belongs to this pass?** A registration ID from a different pass is refused as
   *INVALID QR*.
3. **Verified?** If not: *NOT VERIFIED*.
4. **Participant blocked?** If so: *ACCESS BLOCKED* (§30a).
5. **Current state.** If *outside*, show **MARK ENTERED (CHECK IN)**. If *inside*, show
   **CHECK OUT (OUT)**.

Check-in rules:
- **Atomic.** Check-in is one conditional database update that also requires "verified and not
  blocked". Ten simultaneous taps give exactly one IN, and a block that lands mid-scan always wins.
- **Already inside.** A second check-in is refused with *ALREADY ENTERED: inside since …*.
- **Confirmation** shows the name, college, event and the exact server timestamp, e.g.
  `✅ ENTERED (CHECK IN): Priya · NIT Patna · Football · 05 Oct 2026, 14:05:09`.
- **Where:** at the gate (`/scan` → pass page), or with **Check in** on the participant page
  (coordinators and admins).
- **History.** Every attempt, successful or refused, is kept in the gate log, and the first-ever
  entry time is preserved.

### Manual CHECK IN / CHECK OUT (no QR)

Staff can record IN and OUT without scanning a QR. Either way uses **exactly the same server-side
logic** as a scan:
- the same checks (verified, not blocked, current IN/OUT state)
- the same atomic update of `insideSince`, `lastCheckInAt` and `lastCheckOutAt`
- the same gate log (`EntryLog`) and history

A manual action is labelled *manual (no QR scan)*, with the staff member, IN or OUT, the
participant and the exact server time. Simultaneous manual and QR actions still produce exactly one
state change.

| Where | Who |
|---|---|
| Participant page → **CHECK IN** (when outside) / **CHECK OUT** (when inside) | Coordinators, admins |
| `/scan` → *No QR? Find the participant* → gate card (`/gate/<registrationId>`) | Every gate role: volunteers, coordinators, admins |

The volunteer search finds people by name or college only and shows only what the gate needs; no
email, mobile or IDs. Blocked participants are refused there too. Only the admin override (§30a)
can record a blocked participant's exit.

## 30. Check-out (actual OUT)

**CHECK OUT** appears on the pass page while the participant is inside, and on the participant page.
- **Not inside.** Checking out someone who has never checked in, or who is already outside, is
  refused and logged.
- **Concurrent.** Ten simultaneous OUT taps give exactly one OUT.
- **Re-entry.** After a check-out, the next scan offers CHECK IN again.

## 30a. Block / unblock

Coordinators and admins can **Block participant** on the participant page, with an optional reason.
Blocking:
- applies to the **whole participant**, because the QR is per participant, so every event is
  blocked;
- refuses every gate **IN and OUT**: through the pass page, `/p/<token>/enter|exit` called directly,
  or the participant page's check-in;
- shows the gate a neutral **ACCESS BLOCKED, please contact the coordinator/admin**, never the
  reason;
- **keeps everything else**: verification, the QR token, and all past IN/OUT records;
- is recorded in the history with the staff member, time, reason, and whether they were inside;
- adds them to the **Blocked** counter, also available as a filter chip.

**Blocked while inside:** the participant stays recorded as *inside*, and their earlier IN record is
untouched. The gate refuses both IN and OUT. To record that a blocked participant has left, an
**admin** (not a coordinator or volunteer) can use **Admin override: record check-out**. It is
logged as an override.

**Unblock** restores normal scanning according to the current IN/OUT state. The QR token and
verification are unchanged, and the earlier block stays in the history.

Volunteers can't block or unblock; the server returns 403.

## 31. Dashboard counters

Counters are over **registrations** (one per participant per event), filtered by the current event
and/or college:

| Counter | Definition |
|---|---|
| **Total** | All registrations |
| **Verified** | Manually verified by a coordinator/admin |
| **Pending** | Not yet verified |
| **Rejected** | Rejected during verification |
| **Blocked** | Participant is blocked at the gate. Independent of the other counters; a blocked participant can still be counted as inside |
| **Inside** | Checked in and not checked out (actual QR IN/OUT) |
| **Outside** | Total − Inside: never entered, checked out, or not verified |

Registering or verifying never counts as entry.

## 32. Search / filter

`/admin/registrations` lists **one row per registration**, i.e. per participant and event. Clicking
a row opens that participant's page. It has:
- **Status and gate views.** Every counter tile, and its matching chip, is a filter: **All ·
  Pending · Verified · Rejected · Blocked · Inside · Outside** (`?status=inside` etc.). The active
  one is highlighted.
  - The counts always describe the current event, college, search and date filters, so each
    view's rows add up to its tile.
  - An empty view explains itself, e.g. *No registrations are inside under these filters. 5 match
    otherwise*, instead of "No registrations match".
- **Event filter** in the sidebar
- **College filter** (`?college=`, linked from college pages)
- **Expected arrival / expected departure** date pickers
- **Search** by name, email, mobile (any formatting), college roll number, college name, team name,
  transaction ID, or registration/team ID

### Expected arrivals / departures

`/admin/arrivals` and `/admin/departures` (nav: *Arrivals / departures*) show everyone whose
**planned** date is the chosen day. Use **Today**, **Tomorrow**, or pick a date, and optionally an
event and a college.

| Page | Summary | Per row |
|---|---|---|
| Arrivals | Expected arrivals · Already arrived (QR IN at least once) · Not arrived yet · Blocked | Name, college, event, mobile, expected arrival, actual IN time, inside/outside, verification, blocked |
| Departures | Expected departures · Checked out (QR OUT, not inside) · Still inside · Never arrived · Blocked | Name, college, event, expected departure, actual OUT time, inside/outside, verification, blocked |

**By college** breaks the same numbers down per college, and every college page links to its own
arrivals and departures. The **expected** counts come from the form dates. The **arrived,
checked-out and inside** counts come only from QR gate scans.

## 33. Staff roles

Every rule below is enforced **on the server**, for page routes, POST actions and document URLs.
Navigation only mirrors it; an unauthorised direct request gets **403**.

| | Admin | Coordinator | Volunteer |
|---|---|---|---|
| Navigation | Dashboard, Inside, Outside, Blocked, Arrivals, Gate log, Colleges, Scan, Staff | same, without Staff | Scan, Find participant |
| Participant page `/admin/registrations/<id>` | ✅ full | ✅ | ❌ (uses the gate card `/gate/<id>`) |
| Aadhaar number | **full** (decrypted) | last 4 only | last 4 only |
| Aadhaar image `/staff/files/<id>/aadhaar` | ✅ | ❌ 403 | ❌ 403 |
| College ID image | ✅ | ✅ | ✅ (gate check) |
| Email | ✅ | ✅ | masked (`p•••@example.com`) |
| Mobile, roll no., accommodation, remark | ✅ | ✅ | ❌ |
| Verify / reject / undo | ✅ | ✅ | only if `VOLUNTEERS_CAN_VERIFY=true` (verify from the gate card) |
| Send / resend individual QR email | ✅ | ✅ | ✅ from the gate card (address shown masked) |
| College bulk emails | ✅ | ✅ | ❌ 403 |
| Change email | ✅ | ✅ | ✅ from the gate card only (same logic and audit); the dashboard route stays ❌ 403 |
| Block / unblock | ✅ | ✅ | ❌ 403 |
| Check IN/OUT: QR scan and manual gate card | ✅ | ✅ | ✅ |
| Check IN/OUT from the participant page | ✅ | ✅ | ❌ |
| Blocked-participant check-out override | ✅ | ❌ | ❌ |
| Expected arrivals/departures, gate log, colleges | ✅ | ✅ | ❌ 403 |
| Staff management | ✅ | ❌ 403 | ❌ 403 |

**Find participant** (`/scan/find`) is a directory of **every** participant registration:
- Search by name, college or event.
- 50 per page.
- Only name, college, event and status are shown, and only those columns are queried.

Opening one shows the volunteer **gate card** (`/gate/<registrationId>`), their participant
profile. It shows photo, name, college, event, Aadhaar last 4, the College ID link, a masked
email, and verification and gate state. Its only actions are:
- IN/OUT
- **Send QR email** (this participant only)
- **Change email**
- **Verify**, only with `VOLUNTEERS_CAN_VERIFY=true`; otherwise the button is absent and the
  server returns 403.

### Mobile

Every page works on phones; it was checked at 360, 390, 412 and 1280px in a real browser, with no
horizontal page overflow.
- **Navigation** collapses into a **☰ Menu** (CSS only).
- **Tables** turn into stacked cards with labels.
- **Profiles and forms** go single-column, and long emails and college names wrap.
- **Touch targets:** buttons and links are at least 44px tall.
- **Inputs** use 16px text, so iOS doesn't zoom in.
- **Nothing depends on hover.**

## 34. Email worker (Resend or SMTP)

All emails go through `EmailOutbox`:
- registration received
- QR pass
- rejection
- college bulk emails
- sign-in links

A background worker sends them through the provider chosen by `EMAIL_PROVIDER`:

- **Resend** (default): `RESEND_API_KEY`, `MAIL_FROM` on a verified domain, `MAIL_REPLY_TO`, and
  optionally `RESEND_WEBHOOK_SECRET` for delivery tracking. Free plan: 100 emails/day.
- **SMTP** (`EMAIL_PROVIDER=smtp`), e.g. Gmail / Google Workspace: `SMTP_HOST=smtp.gmail.com`,
  `SMTP_PORT=465`, `SMTP_USER` = the Gmail address, `SMTP_PASS` = a Google app password (needs
  2-Step Verification; spaces are ignored). `MAIL_FROM` defaults to that address. Gmail allows about
  500 emails/day (free) or 2,000/day (paid Workspace): set `EMAIL_DAILY_CAP` a little below that and
  `EMAIL_SEND_INTERVAL_MS=2000`. The login is checked at start-up ("Email provider login OK/failed"
  in the log). There is no delivery webhook and no provider-side idempotency key with SMTP.

Switching provider is only a change of these values (then restart). To check the setup, run
`npm run email:test -- you@example.com`.

How the worker behaves:
- **No duplicates.** Each email has a unique idempotency key, which is also sent to Resend.
  Retries and double clicks never duplicate an email. (With SMTP, a crash in the instant between
  handing an email over and recording it could, rarely, send that one email twice.)
- **Concurrency.** Rows are claimed atomically, so two instances never send the same row. Still, run
  only one sender per database (`EMAIL_WORKER_ENABLED=false` elsewhere).
- **Errors:**
  - An invalid recipient fails only that email.
  - Rate limits, used-up quota (incl. Gmail's daily limit), a bad key / app password or an
    unverified sender pause the whole queue without using up attempts.
  - 5xx errors retry with backoff, up to `EMAIL_MAX_ATTEMPTS`.
- **Delivery tracking.** With the Resend webhook set to `<APP_BASE_URL>/webhooks/resend` (events
  `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`,
  `email.suppressed`), delivery and bounce status appear in the dashboard.
- **Test mode.** `EMAIL_TEST_RECIPIENT` redirects every email to one inbox in development; it is
  ignored in production.

## 35. Google Drive

1. Create a Google Cloud service account and a JSON key.
2. Share each form's upload folder in Drive with the service account's email as **Viewer**.
3. Put the JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`, either raw or base64-encoded.

Files are proxied at `/staff/files/<personId>/photo|id|aadhaar`:
- **Who can open them:** signed-in staff only, and Aadhaar for coordinators and admins only.
- **Allowed files:** images and PDFs, up to 10 MB.
- **Privacy:** responses are private and briefly cached, and the key and Drive URLs never reach the
  browser.
- **Missing files** show as "not uploaded"; they never cause an error page.

## 36. Production environment

With `NODE_ENV=production` the app **refuses to start** if any of these is true:
- `APP_SECRET` is shorter than 32 characters.
- `FORMS_WEBHOOK_SECRET` is shorter than 24 characters, or is still the placeholder.
- `APP_BASE_URL` is not `https://`.
- `RESEND_API_KEY` is missing (`EMAIL_PROVIDER=resend`, the default), or `SMTP_HOST`,
  `SMTP_USER` or `SMTP_PASS` is missing (`EMAIL_PROVIDER=smtp`).

Production also ignores `EMAIL_TEST_RECIPIENT`. Cookies are `Secure` over https.

## 37. Deployment

```bash
npm ci
npm run build
npx prisma migrate deploy
npm run start:prod        # node dist/src/main
```

Checklist:
- [ ] PostgreSQL provisioned; migrations applied on each release.
- [ ] HTTPS and a host that doesn't sleep (cold starts at the gate are not acceptable).
- [ ] All production variables set (§36); `MAIL_FROM` on a verified domain with SPF, DKIM and DMARC.
- [ ] Exactly one instance with `EMAIL_WORKER_ENABLED=true`.
- [ ] Resend webhook configured (optional).
- [ ] First admin via `BOOTSTRAP_ADMIN_EMAILS`; other staff added in `/admin/staff`.
- [ ] Apps Script `WEBHOOK_URL` and `WEBHOOK_SECRET` updated; *Resync unsent rows* run once.
- [ ] Drive service account set up if photos are needed.
- [ ] Gate dry run on real phones, plus printed per-college name lists as the offline fallback.

A Cloudflare tunnel is only a local testing aid; the app doesn't depend on one.

## 38. Security

- **Webhooks.**
  - Forms: a shared secret, compared in constant time.
  - Resend: a signed payload, checked against the raw request body.
- **Auth.**
  - Magic links: single use, short-lived, stored hashed, consumed only on POST.
  - Sessions: stored hashed, revocable; disabling a staff member signs them out everywhere.
- **Authorization.** Roles are checked on the server for every route. Every ID in a URL is
  resolved on the server:
  - a participant from another college can't be used as a bulk recipient;
  - a registration ID from another person's pass is refused at the gate;
  - unknown IDs return 404.
- **CSRF and cross-site requests.**
  - Every staff form carries a per-session HMAC token.
  - All non-webhook POSTs from another site are rejected (`Sec-Fetch-Site`, then `Origin`/`Referer`).
  - Cookies are `HttpOnly` and `SameSite=Lax`; `Referrer-Policy` is `same-origin`.
- **XSS.** All HTML is built with an escaping template helper, the default Content-Security-Policy
  blocks inline scripts, and file responses use `nosniff` (images are sandboxed).
- **Data minimisation.**
  - The full Aadhaar number is stored only encrypted (and only with `AADHAAR_ENCRYPTION_KEY`).
  - Pages are role-filtered on the server: non-admins never receive the full number, the
    encrypted value, or an Aadhaar link. The Aadhaar image route is admin-only.
  - Volunteers see no email, mobile or roll number; QR email confirmations mask the address.
  - Staff pages are `Cache-Control: no-store`.
  - QR tokens are random and unrelated to database IDs.
- **Concurrency.**
  - Verify, reject, resend, college bulk sends and email changes take database locks.
  - Check-in and check-out are conditional updates.
  - Email enqueueing is protected by unique keys.
- **Secrets.** Secrets come only from the environment, and `.env*` is git-ignored except
  `.env.example`.

## 39. Troubleshooting

| Symptom | Fix |
|---|---|
| Sheet shows `⚠ Not synced (HTTP 404 …)` | `WEBHOOK_URL` is wrong; fix it, then *Resync unsent rows* |
| `❌ Webhook secret mismatch` | Script `WEBHOOK_SECRET` ≠ server `FORMS_WEBHOOK_SECRET` |
| `❌ Member 1: … is not a valid email` | Fix the cell, select the row, *Resync selected rows* |
| Login says "Cross-site request blocked" | Hard-reload `/login` (an old cached page); make sure you use the same host as `APP_BASE_URL` |
| No sign-in email in development | Without the provider's credentials (`RESEND_API_KEY` or `SMTP_*`) the link is in the server log |
| Emails stay "queued" | Check the server log for "Email sending paused/disabled" or "Email provider login failed": key / app password, `MAIL_FROM` or daily quota |
| "No photo" everywhere | `GOOGLE_SERVICE_ACCOUNT_JSON` missing, or folders not shared with the service account |
| A participant appears twice under different events | The Sports answer changed spelling; fix the form option and resync |
| `❌ Sports is missing …` | The row has no Sports answer; fill it in the sheet and *Resync selected rows*. If Status adds "(no Sports/Sport/Event/Game column found …)", the script couldn't find the column: check the header and the execution log |
| Participant has no QR with them at the gate | `/scan` → *No QR? Find the participant* → check photo/ID → manual CHECK IN |
| Expected arrival shows "(not a date)" | The form answer isn't a recognised date (§17); fix the cell and *Resync selected rows* |
| Gate shows ACCESS BLOCKED | The participant is blocked; a coordinator/admin can see the reason and unblock on the participant page |
| App refuses to start in production | Read the "Refusing to start in production: …" message (§36) |

## 40. Testing

```bash
npm run check-types && npm run lint && npm run build
npm test                                        # unit tests
E2E_DATABASE_URL="postgresql://postgres:infinito_dev_pwd@localhost:5433/infinito_e2e" npm run test:e2e
npx prisma validate && npx prisma migrate status
```

The e2e suites boot the real app against PostgreSQL. They truncate every table, so they only run
against a database whose name contains `e2e` or `test`; migrations are applied automatically.
Create one once with:

```bash
docker exec infinito_registration_postgres psql -U postgres -c "create database infinito_e2e"
```

When `NODE_ENV=test`, the app ignores `.env`, and emails use the console transport or a test fake,
so tests never send real email.

The six suites:
- `test/app.e2e-spec.ts`: core flows, roles, CSRF and cross-site checks, concurrency.
- `test/roles.e2e-spec.ts`: covers the following:
  - admin, coordinator and volunteer access to every route, called directly (403s included)
  - full vs last-4 Aadhaar
  - the Aadhaar and College ID documents
  - navigation per role
- `test/apps-script.e2e-spec.ts`: runs the real `registration-form.gs` against fake Google
  services and checks the following:
  - the payload it builds (`"Sports": "TT"`) for `handleFormSubmit` and `resyncUnsent`
  - that payload arriving at the backend and creating `eventSlug = tt`
  - the Status cell written from the server's reply
- `test/gate-views.e2e-spec.ts`: covers the following:
  - Sports as the only event source
  - the Inside, Outside, Blocked and status views
  - clickable participant rows
  - manual IN/OUT sharing state with QR scans
  - email-change permissions
- `test/expected-block.e2e-spec.ts`: covers the following:
  - expected vs actual dates, and the arrivals/departures dashboards
  - the IN → OUT → IN cycle
  - blocking: refused scans, direct POSTs, the admin override, unblock, audit
  - concurrency of blocked and unblocked scans
- `test/workflow.e2e-spec.ts`: the individual-form workflow, including:
  - import, resync and duplicate submissions
  - verification, repeated QR sends, email change
  - both college bulk sends
  - IN/OUT, counters, privacy and search
