# API reference

Base URL: `http://localhost:3001` locally (`npm run start`), or the `ApiUrl` stack output in AWS.
All bodies are JSON. Ids are path parameters.

## Envelope

```jsonc
// 2xx
{ "success": true, "data": { … }, "meta": { … } }   // meta only where noted
// 4xx / 5xx
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Invalid request body",
  "details": [{ "path": "status", "message": "Invalid option: …" }] } }
```

| Status | When                                                                                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 200    | Read / update succeeded                                                                                                     |
| 201    | Created (POST)                                                                                                              |
| 204    | Deleted / marked read (no body)                                                                                             |
| 400    | `VALIDATION_ERROR` (path, query or body failed Zod validation) · `BAD_REQUEST` (malformed JSON, bad cursor, missing upload) |
| 401    | `UNAUTHORIZED` — missing, invalid or expired token, disabled/deleted account, or wrong login                                |
| 403    | `FORBIDDEN` — a non-admin calling `/users`                                                                                  |
| 404    | `NOT_FOUND` (entity) · `ROUTE_NOT_FOUND`                                                                                    |
| 409    | `CONFLICT` (duplicate id / document already confirmed)                                                                      |
| 500    | `INTERNAL_ERROR` — details are logged to CloudWatch, never returned                                                         |

**Updates are partial.** `PUT /x/{id}` accepts any subset of the create fields. Sending
`null` for an optional field removes it (e.g. `{ "nextFollowUp": null }`); `null` for a
required field is a validation error. Unknown fields are rejected.

**Time zones.** Endpoints that reason about "today" accept `?tzOffset=<minutes>` — the
value of `new Date().getTimezoneOffset()` in the browser (IST = `-330`).

## Authentication

Every route except `POST /auth/login` requires `Authorization: Bearer <token>`.

```
POST /auth/login     { email, password }  → 200 { token, expiresIn: 31536000, user }
POST /auth/refresh   (signed in)          → 200 { token, expiresIn: 31536000, user }
```

- Tokens are HS256-signed with `AUTH_SECRET` and expire after 365 days. They carry only the
  user id; the account is re-read on every request, so a disabled or deleted user (or a role
  change) takes effect immediately.
- Sessions roll: the web app and the browser extension swap their token for a fresh one via
  `/auth/refresh` at most once a day, so users stay signed in until they sign out. Only a
  session left unused for a year expires. To end every session at once, rotate `AUTH_SECRET`.
- Passwords are hashed with scrypt. Wrong email and wrong password return the same 401.
- All data is scoped to the signed-in user — each user has their own applications, documents,
  settings and so on.

| Route                |                                                          |
| -------------------- | -------------------------------------------------------- |
| `GET /auth/me`       | The signed-in user                                       |
| `PUT /auth/password` | `{ currentPassword, newPassword }` → 204 (8+ characters) |

### Users (admins only, otherwise 403)

| Route                |                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `GET /users`         | All accounts (never includes password hashes)                                             |
| `POST /users`        | `{ email, name, password, role: "admin" \| "user" }` → 201. Also creates an empty profile |
| `GET /users/{id}`    | One account                                                                               |
| `PUT /users/{id}`    | Any of `{ name, role, disabled, password }` — `password` resets it                        |
| `DELETE /users/{id}` | 204. Deletes the account, all of the user's data and their S3 files                       |

Safety rules: an admin can't delete, disable or demote themselves, and the last active admin
can't be removed (409). Email is the login id and can't be changed.

## Resources

The standard five routes exist for every resource below:
`GET /x` · `POST /x` · `GET /x/{id}` · `PUT /x/{id}` · `DELETE /x/{id}`.

| Resource       | Path              | List filters                                     | Extra routes                                                                                                            |
| -------------- | ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Applications   | `/applications`   | `status`, `priority`, `companyId`                | `PUT /applications/{id}/status` `{ status }` · `POST /applications/{id}/timeline` `{ date, title, type, description? }` |
| Companies      | `/companies`      | `status`                                         |                                                                                                                         |
| Contacts       | `/contacts`       | `companyId`, `relationship`                      |                                                                                                                         |
| Referrals      | `/referrals`      | `companyId`, `contactId`, `status`               |                                                                                                                         |
| Interviews     | `/interviews`     | `applicationId`, `status`                        |                                                                                                                         |
| Resumes        | `/resumes`        |                                                  | `POST /resumes/{id}/duplicate` · `PUT /resumes/{id}/default` (returns all resumes)                                      |
| Projects       | `/projects`       | `status`                                         |                                                                                                                         |
| Tasks          | `/tasks`          | `status`, `priority`, `relatedType`, `relatedId` | `POST /tasks/{id}/toggle`                                                                                               |
| Notes          | `/notes`          | `category`, `favorite=true\|false`               |                                                                                                                         |
| Skills         | `/skills`         |                                                  |                                                                                                                         |
| Certifications | `/certifications` |                                                  |                                                                                                                         |
| Links          | `/links`          | `category`                                       |                                                                                                                         |

Field-level shapes are the frontend types in `iamcandidate-ui/src/lib/types` (mirrored in
`src/models`) and are enforced by the Zod schemas in `src/schemas`. Server-managed fields
(`id`, `createdAt`, `updatedAt`, `timeline`, `completedAt`, …) are never accepted from clients.

Server-side rules worth knowing:

- Creating an application adds timeline events and sets `appliedDate` unless the status is
  `wishlist`. Changing status appends a timeline event and an activity.
- `POST /applications/extract` `{ url }` reads a job posting from a link and returns
  `{ url, kind: "job" | "unknown", site, via: "api" | "page", job: { role, company, location,
  workMode, salary, jobId, jobUrl, source, description } }` (blank = not found). Nothing is
  saved — the web app's Job chat shows it for review, then calls `POST /applications`.
  Greenhouse, Lever, Ashby and Workday links are read through their public job APIs; LinkedIn
  through its logged-out job page; anything else from the page's HTML (the extension's site
  rules, then `JobPosting` JSON-LD, then meta tags). Only public http(s) hosts are fetched —
  private, loopback and link-local addresses are refused on every redirect — with a 3 MB /
  8 s cap per page. Sites that block the request (403/429, LinkedIn's 999) return a 502 that
  says so.
- `GET /jobs/search?q=&location=&remote=&page=&boards=` finds open jobs and returns
  `{ jobs: [{ id, role, company, location, workMode, salary, description, url, source, postedAt }],
  sources: [{ name, status: "ok" | "off" | "error", message? }], hasMore }`. Nothing is saved.
  `boards` is a comma-separated list of up to 10 `greenhouse|lever|ashby:slug` company boards,
  filtered by role and location and returned with the first page only. Jooble is `off` until
  `JOOBLE_API_KEY` is set. A source that fails doesn't fail the search, and results are cached per
  Lambda instance for 10 minutes.
- Creating an interview appends an "interview scheduled" event to its application.
- Updating a resume bumps its version (`v3.2` → `v3.3`) unless `version` is sent.
- Setting a task to `done` sets `completedAt`; any other status clears it.

## Documents (S3)

Files go straight from the browser to S3 with a presigned URL; Lambda only handles metadata.

```
1. POST /documents/upload-url   { fileName, contentType, sizeBytes }        → 201
   ← { documentId, uploadKey, uploadUrl, method: "PUT", headers, expiresIn: 300 }
2. PUT  <uploadUrl>  (body = file, headers = the returned headers)           → S3
3. POST /documents   { uploadKey, name, category, kind, sizeBytes, description? } → 201 DocumentFile
```

Step 3 checks that `uploadKey` is inside the caller's prefix and that the object exists
(`HeadObject`); the stored `sizeBytes` and `mimeType` come from S3, not the client. Max size
25 MB; allowed types are PDF, Word, Excel/CSV, text/Markdown, ZIP and common images.

| Route                               |                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /documents?category=&starred=` | List                                                                                                                             |
| `GET /documents/{id}`               | One                                                                                                                              |
| `GET /documents/{id}/download-url`  | `{ url, expiresIn }` — presigned GET with `Content-Disposition: attachment`. 404 for documents without a stored file (seed data) |
| `PUT /documents/{id}`               | `{ name?, category?, starred?, description? }`                                                                                   |
| `POST /documents/{id}/toggle-star`  | Flip `starred`                                                                                                                   |
| `DELETE /documents/{id}`            | Deletes metadata and the S3 object                                                                                               |

## Email (each user's own SMTP account)

Users send from their own mailbox. SMTP settings are stored per user; the password is
encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`) and never returned.

| Route                                             |                                                                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /settings/smtp`                              | Settings with `password: ""` and `hasPassword`                                                                                               |
| `PUT /settings/smtp`                              | `{ host, port, username, password, encryption: "tls" \| "ssl" \| "none", senderName, senderEmail }`. An empty `password` keeps the saved one |
| `POST /settings/smtp/test`                        | Connects and logs in without sending → `{ ok, latencyMs }`                                                                                   |
| `DELETE /settings/smtp`                           | Forget the account                                                                                                                           |
| `POST /emails/send`                               | `{ to[], cc[], subject, body, applicationId?, contactId?, templateId? }` → 201 Email (folder `sent`, with the server's `messageId`)          |
| `POST /emails/drafts` · `PUT /emails/drafts/{id}` | Save a draft (recipients optional)                                                                                                           |
| `GET /emails?folder=&applicationId=&contactId=`   | Sent mail and drafts, newest first                                                                                                           |
| `PUT /emails/{id}`                                | `{ read?, starred? }`                                                                                                                        |
| `DELETE /emails/{id}`                             | 204                                                                                                                                          |
| `/templates`                                      | Standard CRUD, plus `POST /templates/{id}/duplicate` and `POST /templates/defaults` (re-add deleted defaults → `{ added, templates }`)       |

Templates have a `channel`: `email` (sent from IamCandidate) or `linkedin` (filled in, copied and pasted
into LinkedIn; `subject` is empty). Templates created without a channel, and ones from before
channels existed, are `email`.

Every account starts with default templates, defined in `src/lib/default-templates.ts`:

- **Email (10):** referral request, follow-up and thank-you, recruiter and hiring-manager
  outreach, application follow-up, interview availability and thank-you, feedback request,
  withdrawal.
- **LinkedIn (7):** referral and recruiter connection notes (under LinkedIn's 300-character limit
  when filled), referral requests (cold and to someone you know), referral follow-up and
  thank-you, recruiter message.

New accounts get them on creation; existing ones on their first `GET /templates`. Each default
has a `since` version: to add templates, append them with a new `DEFAULT_TEMPLATES_VERSION`, and
existing accounts receive only those. A deleted default stays deleted unless restored.

Sending is tracked: the email is stored in **Sent**, the linked application gets an
`email` timeline event, the matching contact's `lastContacted` is updated, the template's
`usageCount` goes up and an `email_sent` activity is recorded.

SMTP failures return **502 `SMTP_ERROR`** with an actionable message (wrong login / app
password, can't connect to host:port, rejected recipient) and nothing is stored. SMTP hosts
must resolve to public addresses (`ALLOW_PRIVATE_SMTP_HOSTS=true` allows localhost catchers
in local development). Lambda blocks outbound port 25 — use 587 (STARTTLS) or 465 (SSL/TLS).

Common settings: Gmail `smtp.gmail.com:587` STARTTLS with an
[app password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification);
Outlook/Microsoft 365 `smtp.office365.com:587` STARTTLS; Zoho `smtp.zoho.in:465` SSL/TLS.
Receiving mail (the Inbox) is not implemented.

## LaTeX

| Route                 |                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /latex/compile` | `{ source }` (≤ 200 000 chars) → `{ pdfBase64, sizeBytes, log }`. **400 `COMPILE_ERROR`** with `details: { line?, log }`; **503** if Tectonic isn't installed |

LaTeX resumes are normal resumes with `format: "latex"` and `latexSource`. See [latex.md](latex.md).

## Google Drive

Read-only access to the user's own Drive; see [google-drive.md](google-drive.md) for setup.

| Route                                            |                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /integrations/google-drive`                 | `{ available, connected, account?, connectedAt? }` (`available` = server has Google credentials)                               |
| `GET /integrations/google-drive/auth-url`        | `{ url }` — Google consent URL with a signed, 10-minute `state` bound to the user                                              |
| `POST /integrations/google-drive/connect`        | `{ code, state }` from the redirect → status. Tokens are stored encrypted                                                      |
| `DELETE /integrations/google-drive`              | Revokes the grant at Google and forgets it                                                                                     |
| `GET /integrations/google-drive/files?parentId=` | One folder (default My Drive): `DriveItem[]` with `type`, `kind`, `sizeBytes`, `mimeType`                                      |
| `POST /integrations/google-drive/import`         | `{ fileId, category? }` → 201 Document (`source: "drive"`, `driveFileId`). Google formats are exported (PDF / xlsx); max 25 MB |

Errors: **409** when Drive isn't connected or Google revoked/expired the grant (the stored
connection is then removed — reconnect), **502 `INTEGRATION_ERROR`** when Google fails, **400**
when the server has no Google credentials.

`GET /integrations` returns every integration's status in one call:
`{ googleDrive, googleCalendar, github, linkedin, aws }`.

## Google Calendar

Puts upcoming interviews (timed, with the meeting link), follow-ups (application, contact and
open-referral dates, all-day) and open tasks' due dates on the user's primary calendar. Event
ids are derived from the IamCandidate item, so syncing again updates events instead of duplicating them.
Items that no longer qualify (cancelled, done, past, deleted) are removed on the next sync. At most
150 events per sync. Uses the Google OAuth client from [google-drive.md](google-drive.md).

| Route                                                |                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /integrations/google-calendar`                  | `{ available, connected, account?, connectedAt?, lastSyncedAt?, lastSync? }`         |
| `GET /integrations/google-calendar/auth-url`         | `{ url }`, consent for `calendar.events` with a signed `state` (`p: "calendar"`)     |
| `POST /integrations/google-calendar/connect`         | `{ code, state }` from the shared callback page → status                             |
| `POST /integrations/google-calendar/sync?tzOffset=`  | Sync now → status with `lastSync: { synced, removed, interviews, followUps, tasks }` |
| `DELETE /integrations/google-calendar?removeEvents=` | Revoke and forget; `removeEvents=true` first deletes the events IamCandidate created         |

## GitHub

Connected with the user's own fine-grained personal access token (read-only: Contents, Metadata,
Pull requests), stored AES-256-GCM encrypted. A rejected token removes the connection (409).

| Route                                        |                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /integrations/github`                   | `{ connected, account?, name?, avatarUrl?, connectedAt? }`                                                                |
| `PUT /integrations/github`                   | `{ token }`, checked against GitHub, then stored → status. 400 if GitHub rejects it                                       |
| `DELETE /integrations/github`                | Forget the token (revoke it on GitHub yourself)                                                                           |
| `GET /integrations/github/repos`             | Up to 100 repos, most recently pushed first, each with the linked `projectId` if any                                      |
| `GET /integrations/github/activity?repo=o/n` | `{ repo, commits (10, default branch), pullRequests (10, most recently updated) }`                                        |
| `POST /integrations/github/import`           | `{ repo }` → 201 Project (name, description, languages + topics, URL, homepage). Returns the linked project if one exists |

Projects link to a repository through their `repository` URL; any github.com URL counts.

## LinkedIn

LinkedIn's API doesn't let other apps read connections or saved jobs, so IamCandidate imports the CSV
files from LinkedIn's "Get a copy of your data" export. The file type is detected from its header.

| File                   | Becomes                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `Connections.csv`      | Contacts (relationship "professional") and their companies |
| `Saved Jobs.csv`       | Applications in Wishlist                                   |
| `Job Applications.csv` | Applications in Applied, with the application date         |

| Route                                |                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /integrations/linkedin`         | `{ lastImportAt?, imports: { connections?, saved_jobs?, job_applications? } }`                                          |
| `POST /integrations/linkedin/import` | `{ csv, dryRun }` (≤ 5 MB, ≤ 5000 rows) → `{ kind, rows, created, skipped, invalid, companiesCreated, sample, dryRun }` |

Rows already in IamCandidate are skipped: contacts by LinkedIn URL or exact name, applications by job URL
or company + role. Companies match by name, ignoring suffixes like "Inc" or "Pvt Ltd". The export
has no work mode, so imported applications are set to `onsite`.

## AWS S3 backup

Copies the user's data to their own bucket with an access key they provide (secret stored
encrypted). Each backup writes `<prefix>iamcandidate-backup/data/iamcandidate-<timestamp>.json`, a JSON export of
every record without credentials, and copies each document to
`<prefix>iamcandidate-backup/documents/<id>/<name>`, skipping files already there with the same size.

| Route                              |                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /integrations/aws-s3`         | `{ connected, bucket?, region?, prefix?, accessKeyId? (masked), connectedAt?, lastBackup? }`                              |
| `PUT /integrations/aws-s3`         | `{ bucket, region, prefix, accessKeyId, secretAccessKey }`. Writes a test file first. An empty secret keeps the saved one |
| `DELETE /integrations/aws-s3`      | Forget the key; existing backups stay in the bucket                                                                       |
| `POST /integrations/aws-s3/backup` | `{ cursor? }` → `{ done, cursor?, copied, total, bytes, failed, dataKey, summary? }`                                      |

API Gateway allows 30 seconds per request, so a backup runs in steps of about 20 seconds: call
again with `cursor` until `done`. The key needs `s3:PutObject` and `s3:GetObject` on
`arn:aws:s3:::<bucket>/<prefix>iamcandidate-backup/*`.

## System

| Route                                   |                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /board`                           | The user's sync pad: `{ content, updatedAt }` (`updatedAt` is `null` before the first save)                                            |
| `PUT /board` `{ content }`              | Replaces the pad (up to 50,000 characters); stored AES-256-GCM encrypted                                                                   |
| `GET /dashboard?tzOffset=`              | Aggregates for the dashboard (counts, 10-week series, status breakdown, funnel, next interview, task/document counts, 7 latest activities) |
| `GET /activities?limit=1..200&cursor=`  | Newest first. `meta.nextCursor` is `null` on the last page                                                                                 |
| `GET /notifications?tzOffset=`          | Reminders derived from interviews (next 3 days), overdue/today follow-ups and tasks, honoring notification preferences                     |
| `PUT /notifications/{id}/read`          | 204                                                                                                                                        |
| `PUT /notifications/read-all?tzOffset=` | Marks every current reminder read; returns the list                                                                                        |
| `GET` / `PUT /settings/profile`         | `{ name, email, role, bio, location, avatarUrl? }`                                                                                         |
| `GET` / `PUT /settings/autofill`        | What the browser extension types into application forms: contact, address, links, work, `workAuthorization` / `needsSponsorship` / `willingToRelocate` (`"yes"`, `"no"` or `""`), education, voluntary self-identification, `summary`, `coverLetter`, and `answers: [{ id?, question, answer }]`. Before the first save, `GET` starts from the profile. |
| `POST /settings/autofill/learn`         | `{ details?, answers? }` from a form you filled: each detail fills only an empty field; each answer replaces the saved answer to the same question (matched without case, punctuation or "required"). Returns the profile. |
| `GET` / `PUT /settings/notifications`   | `{ emailNotifications, interviewReminders, taskReminders, followUpReminders, weeklyDigest }`                                               |

Notifications are data only — nothing is emailed or pushed.

## curl examples

```bash
API=http://localhost:3001

# Sign in (seeded admin) and send the token on every request
TOKEN=$(curl -s -X POST $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"demo123"}' | jq -r .data.token)
alias curl="curl -H 'authorization: Bearer $TOKEN'"

# Admin: add a user
curl -s -X POST $API/users -H 'content-type: application/json' \
  -d '{"email":"new@example.com","name":"New User","password":"change-me-123","role":"user"}'

# Create a company and an application
curl -s -X POST $API/companies -H 'content-type: application/json' -d '{
  "name":"Acme","industry":"SaaS","website":"https://acme.example","location":"Remote",
  "size":"50-200","status":"target","description":"","notes":""}'

curl -s -X POST $API/applications -H 'content-type: application/json' -d '{
  "companyId":"cmp_xxx","role":"Frontend Engineer","location":"Remote","workMode":"remote",
  "status":"applied","priority":"high","notes":""}'

# List, filter, update, move, delete
curl -s "$API/applications?status=applied"
curl -s -X PUT $API/applications/app_xxx -H 'content-type: application/json' -d '{"salary":null,"notes":"Called back"}'
curl -s -X PUT $API/applications/app_xxx/status -H 'content-type: application/json' -d '{"status":"recruiter"}'
curl -s -X DELETE -i $API/applications/app_xxx

# Validation error
curl -s -X POST $API/applications -H 'content-type: application/json' -d '{"role":"x"}'

# Upload a document
TICKET=$(curl -s -X POST $API/documents/upload-url -H 'content-type: application/json' \
  -d '{"fileName":"resume.pdf","contentType":"application/pdf","sizeBytes":12345}')
URL=$(echo "$TICKET" | jq -r .data.uploadUrl); KEY=$(echo "$TICKET" | jq -r .data.uploadKey)
curl -s -X PUT "$URL" -H 'Content-Type: application/pdf' --data-binary @resume.pdf
curl -s -X POST $API/documents -H 'content-type: application/json' \
  -d "{\"uploadKey\":\"$KEY\",\"name\":\"resume.pdf\",\"category\":\"resume\",\"kind\":\"pdf\",\"sizeBytes\":12345}"

# Dashboard and activity
curl -s "$API/dashboard?tzOffset=-330"
curl -s "$API/activities?limit=20"
```
