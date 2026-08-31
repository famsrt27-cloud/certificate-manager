# 10 — API Contract

## Authority

This file is the canonical API source of truth. Fastify implements the routes, and Zod schemas validate/map their wire contracts. OpenAPI and implementation-specific route definitions must conform to this file and must not introduce conflicting envelopes, public fields or security behavior.

## Conventions

Base path: `/api`

JSON content type: `application/json`

Every request has a server-issued UUID `request_id`. A valid client-supplied `X-Request-ID` may be correlated, but the server must not trust it as identity or authorization. JSON responses use the following envelopes.

Success:

```json
{
  "data": {},
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Error:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request could not be processed."
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Binary responses return the request ID in `X-Request-ID` because they do not use a JSON envelope.

Large admin collections use cursor pagination:

```json
{
  "data": [],
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633",
    "next_cursor": "opaque-cursor-or-null"
  }
}
```

The template collection includes a bounded `preview` summary for each item so the library can render the canonical composition without per-template version requests. The selected preview is the highest version in `PUBLISHED`, otherwise the highest `DRAFT`, otherwise the highest remaining lifecycle state; templates without a version return `preview: null`. The summary contains only `version`, `status`, and the validated canonical `definition`. Private image bytes remain available only through the tenant-authorized asset-content endpoint.

## Foundation health endpoints

Operational health endpoints are outside the `/api` business namespace and do not implement domain behavior:

- `GET /health/live` reports process liveness and does not query dependencies.
- `GET /health/ready` reports readiness only after PostgreSQL and Redis checks succeed within the configured timeout.

Both API endpoints use the canonical JSON envelope and a server-issued UUID `request_id`, also returned in `X-Request-ID`. The worker exposes the same paths on its internal health port with `service: "worker"`. A failed readiness check returns HTTP `503`, error code `SERVICE_UNAVAILABLE` and the safe message `The service is not ready.` Dependency errors and credentials are never included in the response.

## Identifier rules

- Authenticated admin APIs may use internal UUIDs, but every lookup is permission-checked and organization-scoped on the backend.
- Public APIs never expose internal database UUIDs.
- A signed verification token contains the separate opaque certificate `public_identifier` defined in `docs/11-token-spec.md`.
- Public APIs accept the complete signed token, never a raw internal or public identifier as proof of authorization.
- Certificate numbers are display metadata and are not secrets or lookup credentials.

## Admin security

- `/api/admin/auth/login` and `/api/admin/auth/mfa` are the only pre-session admin routes. Both are exact-origin checked, no-store, and use generic authentication failures; login retains distributed account/network throttling and the MFA challenge permits at most five attempts in five minutes. Every other `/api/admin/*` route requires authenticated server-side identity and authorization.
- The active organization must be derived from an authorized organization membership. A client-supplied organization value cannot grant scope.
- Each endpoint enforces the permissions in `docs/18-roles-permissions.md`.
- Authentication uses the `__Host-admin_session` Secure/HttpOnly/SameSite=Lax cookie containing only an opaque Redis session ID.
- Every state-changing authenticated admin request requires the session-bound token in `X-CSRF-Token`.
- Import, generation and other safely retryable creation requests require an `Idempotency-Key` header. Keys are scoped by organization and operation.
- Sensitive actions create allowlisted, redacted audit events.

All Phase 3 tenant routes require `X-Organization-ID` as an admin tenant selector. It is not authorization evidence: the backend resolves the current session identity, verifies an active membership and required permission for that organization, then scopes every resource query by the verified `organization_id`. Missing/malformed selectors fail validation; selectors for another tenant fail authorization without attempting a UUID-only resource lookup.

## Admin authentication

Passwords are verified with bcrypt after Zod shape validation and UTF-8 byte-length enforcement. Redis is the authoritative session store. Passwords, cookie/session values and CSRF tokens must never appear in logs or audit metadata.

### Login

`POST /api/admin/auth/login`

Unauthenticated. Enforce allowed `Origin`, rate limiting and generic credential failure behavior.

```json
{
  "email": "admin@example.invalid",
  "password": "example-only-not-a-real-password"
}
```

With `ADMIN_MFA_POLICY=DEFERRED_NON_PRODUCTION`, response `200` rotates/creates the Redis session, sets the `__Host-admin_session` cookie and returns:

```json
{
  "data": {
    "user": {
      "id": "admin-visible-internal-uuid",
      "email": "admin@example.invalid"
    },
    "memberships": [],
    "csrf_token": "session-bound-csrf-token"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

The response uses `Cache-Control: no-store`. Generic invalid-credential responses do not reveal account existence or status.

With `ADMIN_MFA_POLICY=REQUIRED`, password success does not create a session. It sets a five-minute `__Host-admin_mfa` Secure/HttpOnly/SameSite=Lax cookie and returns either `{ "status": "MFA_REQUIRED" }` or `{ "status": "MFA_ENROLLMENT_REQUIRED", "provisioning_uri": "otpauth://..." }`. The provisioning URI is disclosed only for first enrollment and responses remain `no-store`.

### Complete MFA

`POST /api/admin/auth/mfa`

Pre-session route requiring the exact allowed `Origin` and MFA challenge cookie. The strict request is `{ "code": "123456" }` for TOTP or a 24-character recovery code. Successful verification deletes the challenge, creates the full admin session, expires the challenge cookie and returns the normal authentication response. First enrollment additionally returns ten `recovery_codes` exactly once. Invalid, expired, replayed, already-consumed and unknown factors share the generic authentication failure. Password, OTP, recovery codes, encryption keys, decrypted secrets and challenge identifiers are never logged or placed in audit metadata.

Each active membership is serialized as:

```json
{
  "id": "membership-internal-uuid",
  "organization": {
    "id": "organization-internal-uuid",
    "name": "Example Organization"
  },
  "roles": ["ORG_ADMIN"],
  "permissions": ["organization:read"]
}
```

Only active memberships in active organizations are returned. Roles and permissions are resolved from PostgreSQL; client-supplied role, permission or organization claims are ignored. Authentication errors use safe allowlisted messages. Rate limiting returns HTTP `429` with `Retry-After`; unavailable Redis authentication state returns safe HTTP `503` and does not fall back to a browser token.

### Inspect session

`GET /api/admin/auth/session`

Requires a valid session. Returns the current user, active memberships, effective role/permission view and the current session-bound CSRF token. It returns no password hash, Redis key, raw session ID or secret.

### Logout

`POST /api/admin/auth/logout`

Requires a valid session and `X-CSRF-Token`. The server deletes the Redis session and expires the cookie. Repeated logout receives a safe idempotent response without disclosing prior session state.

## Admin endpoints

### Organization dashboard summary

`GET /api/admin/dashboard`

- Requires an authenticated active membership, `X-Organization-ID`, and `organization:read`.
- Returns `Cache-Control: no-store` and a bounded aggregate summary for the selected organization.
- Metric groups are omitted unless the server-resolved membership has the corresponding existing read permission: `project:read`, `training:read`, `participant:read`, `template:read`, `certificate:read`, or `job:read`.
- Project and training `active` counts include only `ACTIVE` rows; `total` includes all lifecycle states.
- Published template-version readiness counts only `PUBLISHED` versions belonging to active templates.
- Certificate `in_progress` counts `DRAFT` and `GENERATING` certificates. Job attention counts expose only lifecycle totals, never job payloads or error details.
- All aggregates are explicitly filtered by `organization_id`; no resource identifiers, recipient data, storage keys, token material, or session data are returned.

The examples below show core contracts. CRUD list/read/update/archive endpoints follow the same envelope, organization-scope and permission rules and must be added to OpenAPI before implementation.

### Create project

`POST /api/admin/projects`

Permission: `project:create`

```json
{
  "name": "Digital Literacy 2026",
  "slug": "digital-literacy-2026"
}
```

### Project CRUD

- `GET /api/admin/projects` — `project:read`; cursor-paginated, optional `status` filter.
- `GET /api/admin/projects/{projectId}` — `project:read`.
- `PATCH /api/admin/projects/{projectId}` — `project:update`; accepts one or both of `name` and `slug`.
- `POST /api/admin/projects/{projectId}/archive` — `project:archive`; sets `status` to `ARCHIVED` and is safe to repeat.

Project names are trimmed non-empty strings up to 200 characters. Slugs are lowercase kebab-case up to 100 characters and unique within the active organization. Archived projects cannot be updated or used for new trainings.

Response `201`:

```json
{
  "data": {
    "id": "admin-visible-internal-uuid",
    "name": "Digital Literacy 2026",
    "slug": "digital-literacy-2026",
    "status": "ACTIVE"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

### Create training

`POST /api/admin/trainings`

Permission: `training:create`

```json
{
  "project_id": "admin-visible-internal-uuid",
  "name": "รุ่นที่ 1",
  "code": "DL2026-01",
  "start_date": "2026-08-17",
  "end_date": "2026-08-17"
}
```

The backend resolves `project_id` only inside the active organization.

### Training CRUD

- `GET /api/admin/trainings` — `training:read`; cursor-paginated, with optional `project_id` and `status` filters.
- `GET /api/admin/trainings/{trainingId}` — `training:read`.
- `PATCH /api/admin/trainings/{trainingId}` — `training:update`; accepts at least one mutable training field.
- `POST /api/admin/trainings/{trainingId}/archive` — `training:archive`; sets `status` to `ARCHIVED` and is safe to repeat.

Names are trimmed non-empty strings up to 200 characters. Codes are 1–100 approved ASCII identifier characters and remain unique per organization/project. Dates use `YYYY-MM-DD`; when both are present, `end_date` cannot precede `start_date`.

### Participant management

- `GET /api/admin/participants` — `participant:read`; cursor-paginated, optionally filtered by an active `training_id` relationship.
- `GET /api/admin/participants/{participantId}` — `participant:read`.
- `PATCH /api/admin/participants/{participantId}` — `participant:update`; accepts `display_name` and/or nullable `external_reference`.

The authenticated admin contract may return participant display name and private external reference. It never returns these fields from job summaries or public endpoints. Participants are created only through confirmed imports in Phase 3; there is no direct create endpoint or participant archive permission in the canonical catalog.

### Template management

All template operations require the canonical admin session and `X-Organization-ID`; state-changing operations also require Origin and CSRF validation. Resource queries are scoped by both `organization_id` and the resource identifier.

- `POST /api/admin/templates` — `template:create`; creates an active template shell.
- `GET /api/admin/templates` — `template:read`; cursor-paginated.
- `GET /api/admin/templates/{templateId}` — `template:read`.
- `PATCH /api/admin/templates/{templateId}` — `template:update`; renames a non-archived template.
- `POST /api/admin/templates/{templateId}/archive` — `template:update`; archives the template shell without deleting historical versions or assets.
- `GET /api/admin/templates/{templateId}/versions` — `template:read`; cursor-paginated with `limit` 1-100 (default 50).
- `GET /api/admin/templates/{templateId}/versions/{versionId}` — `template:read`.
- `PATCH /api/admin/templates/{templateId}/versions/{versionId}` — `template:update`; replaces only a `DRAFT` definition and its derived asset links.
- `DELETE /api/admin/templates/{templateId}/versions/{versionId}` — `template:update`; deletes only a `DRAFT` version.
- `POST /api/admin/templates/{templateId}/versions/{versionId}/preview` — `template:read`; validates the stored definition and active asset set, then returns a synthetic allowlist-bound data preview. It does not render or return a PDF and does not accept recipient data.
- `POST /api/admin/templates/{templateId}/versions/{versionId}/archive` — `template:publish`; changes only `PUBLISHED` to `ARCHIVED`.
- `POST /api/admin/templates/{templateId}/assets` — `template:asset:create`; accepts one private multipart PNG, JPEG, TTF or OTF asset.
- `GET /api/admin/templates/{templateId}/assets` — `template:read`; cursor-paginated with `limit` 1-100 (default 50) and returns validated metadata without a storage key or URL.
- `GET /api/admin/templates/{templateId}/assets/{assetId}` — `template:read`.
- `POST /api/admin/templates/{templateId}/assets/{assetId}/archive` — `template:asset:create`; blocked when a published/archived version depends on the asset.

Template archive, asset archive and version delete are the canonical recoverable lifecycle operations; published rendering inputs are never deleted or overwritten.

### Create template version

`POST /api/admin/templates/{templateId}/versions`

Permission: `template:create`

Creates a new `DRAFT` version. Definition and asset IDs must pass schema, ownership and upload validation.

### Publish template version

`POST /api/admin/templates/{templateId}/versions/{versionId}/publish`

Permission: `template:publish`

The backend verifies that the template/version/asset set belongs to the active organization, all assets are `ACTIVE`, preview validation succeeded and the version is still `DRAFT`. Publishing is atomic and makes definition and asset links immutable.

### Upload and validate participant import

`POST /api/admin/trainings/{trainingId}/participants/import`

Permission: `participant:import`

Content type: `multipart/form-data`

Headers: `Idempotency-Key` required

Accept only approved CSV/XLSX formats and size limits. Store the source privately, create a `PARTICIPANT_IMPORT` job and parse/validate asynchronously.

The Phase 3 defaults are 5 MiB, 10,000 data rows and 25 MiB total XLSX uncompressed content. The multipart body contains exactly one `file` part. CSV must be UTF-8; XLSX must be a bounded, non-encrypted OOXML workbook with one worksheet and no external/embedded/formula content. Headers are exactly `display_name` plus optional `external_reference`. Only those normalized fields and allowlisted validation codes are staged or returned.

Response `202`:

```json
{
  "data": {
    "job_id": "admin-visible-internal-uuid",
    "status": "QUEUED"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

After validation, the job enters `AWAITING_CONFIRMATION` and exposes only normalized allowed fields and row-level validation errors to authorized admins.

### Inspect participant import

`GET /api/admin/participant-imports/{jobId}`

Permission: `participant:import`

Returns job progress, valid/invalid counts and a cursor-paginated validation preview. It never returns the private source storage key.

### Confirm participant import

`POST /api/admin/participant-imports/{jobId}/confirm`

Permission: `participant:import`

Headers: `Idempotency-Key` required

Only a job in `AWAITING_CONFIRMATION` may be confirmed. Confirmation resumes asynchronous processing and creates tenant-safe participant/training relationships. Certificate generation cannot begin before the import succeeds.

Confirmation is PostgreSQL-state-idempotent for the organization/job/operation. A repeated request with the required `Idempotency-Key` returns the current safe job status and cannot create duplicate participants or training relationships. A non-empty `external_reference` is matched exactly within the organization under a transaction lock; missing references create distinct participants and display names are never deduplication keys.

### List admin certificates

`GET /api/admin/certificates`

Permission: `certificate:read`

Cursor-paginated with `limit` 1-100 (default 50). Optional bounded filters are `training_id` and canonical certificate `status`. The query is explicitly organization-scoped and reads recipient, project, training and issue-time display fields from the immutable issuance snapshot. It returns the internal certificate ID only for authorized admin actions, certificate number, lifecycle status, snapshot display fields, training ID, issue/revocation timestamps and the private bounded revocation reason. It never returns a public identifier, participant external reference, verification token/key material, PDF storage key/URL/hash, or job payload.

### View or download an admin certificate PDF

`GET /api/admin/certificates/{certificateId}/pdf`

Permission: `certificate:download`

Requires an authenticated admin session and `X-Organization-ID`. The certificate lookup is explicitly scoped to the selected organization and only an `AVAILABLE` certificate with complete, valid PDF publication metadata may be returned. `certificate:read` does not grant PDF access.

Optional query parameter `disposition` is `inline` by default and may be `attachment`. Both modes read the same private object through the application, enforce the configured PDF size bound, expected byte length, `%PDF-` signature and SHA-256 digest, then re-read persisted state and publication identity after storage access. A concurrent revocation or publication change fails closed.

Response `200`:

- `Content-Type: application/pdf`
- `Content-Disposition: inline|attachment; filename="certificate-<sanitized-certificate-number>.pdf"`
- `Cache-Control: private, no-store`
- `X-Content-Type-Options: nosniff`
- `X-Request-ID: <uuid>`

No storage key, storage URL, public identifier or verification/download token is exposed.

### Generate certificates

`POST /api/admin/trainings/{trainingId}/certificates/generate`

Permission: `certificate:generate`

Headers: `Idempotency-Key` required

```json
{
  "template_version_id": "admin-visible-internal-uuid",
  "participant_ids": ["admin-visible-internal-uuid"]
}
```

An omitted `participant_ids` field means all currently eligible active training participants. An empty array is invalid. Both explicit and all-eligible resolution are capped at 1,000 participants per generation operation; a larger selection is rejected before issuance rows are materialized. The referenced template version must belong to the active organization and be `PUBLISHED`.

For initial generation, "eligible" means an active `training_participants` relationship with no certificate history for that organization/training/participant. An explicit participant list must contain unique participants and every requested participant must be eligible; otherwise the whole request conflicts rather than partially issuing. The omitted form filters to the eligible set; if no eligible target remains, the request returns a conflict/no-work result. A revoked historical certificate is not silently treated as initial-generation eligibility: a future explicit reissue operation must create a brand-new certificate identity.

At first successful job creation the API transaction locks/validates the training and published template, resolves the exact participant set, computes the versioned request fingerprint, chooses the current server-side renderer revision, creates the job/detail rows, creates one immutable certificate + issuance snapshot + generation item per target, writes the durable queue intent, and writes one actor/organization/request-correlated `CERTIFICATE_GENERATION_REQUESTED` audit event before commit. Idempotent replay does not duplicate this audit event. The worker consumes those rows and must never re-resolve a later participant population.

Idempotency behavior is request-bound:

- the stored generation detail records `selection_mode`, a SHA-256 request fingerprint and `renderer_revision`
- the fingerprint binds organization, operation version, training, template version, selection mode and the exact first-resolved participant IDs in canonical sorted order
- `renderer_revision` is a server-selected durable execution input, not a client field and not part of the client request fingerprint
- an existing idempotency key with different training/template/selection semantics returns HTTP `409`
- an `EXPLICIT` retry compares the normalized explicit set to the stored fingerprint
- an `ALL_ELIGIBLE` retry for an already-created job returns that original job without re-resolving the now-current eligible population

The issuance snapshot also stores the planned issue timestamp. The renderer binds that durable value, and initial publication must persist the same timestamp into `certificates.issued_at`.

Response `202`:

```json
{
  "data": {
    "job_id": "admin-visible-internal-uuid",
    "status": "QUEUED"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

### Inspect a job

`GET /api/admin/jobs/{jobId}`

Permission: the permission for the underlying job type

```json
{
  "data": {
    "job_id": "admin-visible-internal-uuid",
    "type": "CERTIFICATE_GENERATION",
    "status": "RUNNING",
    "progress": {
      "completed": 48,
      "total": 100
    },
    "attempt_count": 1
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Do not expose raw worker exceptions, storage keys or participant PII in job errors.

### Revoke certificate

`POST /api/admin/certificates/{certificateId}/revoke`

Permission: `certificate:revoke`

```json
{
  "reason": "Issued in error"
}
```

Revocation is atomic, idempotent for the same effective state and audited. The reason is private admin data.
Only an `AVAILABLE` certificate may transition to `REVOKED`; a repeated request for an already-revoked certificate returns its current immutable admin representation without changing its original reason or creating a second audit event. Other lifecycle states conflict. Tenant scope is applied to both the lock and update, and revocation does not delete the stored PDF. Public verification and download authorization consult current persisted state and therefore reflect revocation immediately.

## Public security policy

All `/api/public/*` endpoints:

- require no recipient login
- accept secrets only in POST bodies, never paths or query strings
- apply distributed rate limiting and abuse monitoring
- set `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow, noarchive`
- use generic errors for malformed, tampered, unknown and otherwise unverifiable tokens
- never return internal UUIDs, external/student references, email, phone, address, revocation reason, storage key or signing details

The public web page must also use `Referrer-Policy: no-referrer`. QR links use a URL fragment for client-side POST submission; fragments are not sent to the server in the initial request.

## Public verification

### Verify

`POST /api/public/verify`

```json
{
  "token": "signed-verification-token"
}
```

Response `200` for an available certificate:

```json
{
  "data": {
    "status": "valid",
    "certificate_number": "CERT-2026-001234",
    "recipient_name": "Somchai Example",
    "program_name": "Digital Literacy 2026",
    "issued_at": "2026-08-17"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Response `200` for a revoked certificate:

```json
{
  "data": {
    "status": "revoked",
    "certificate_number": "CERT-2026-001234"
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Do not expose the revocation reason. Certificates in non-public lifecycle states return the generic verification failure.

### Issue download authorization

`POST /api/public/certificates/download-authorize`

```json
{
  "token": "signed-verification-token"
}
```

The server verifies the signature, resolves `pcid`, and requires the current certificate state to be `AVAILABLE` with complete PDF integrity metadata.

Response `200`:

```json
{
  "data": {
    "download_token": "short-lived-signed-download-token",
    "expires_in": 60
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

The download token uses a distinct audience/type, is scoped to the same public certificate identifier, expires in no more than 60 seconds and is never logged.

### Redeem download authorization

`POST /api/public/certificates/download`

```json
{
  "download_token": "short-lived-signed-download-token"
}
```

Before streaming, the server revalidates signature, type/audience, expiry and current `AVAILABLE` status. It then validates stored PDF metadata and streams `application/pdf` through the application.

Response `200`:

- `Content-Type: application/pdf`
- `Content-Disposition: attachment; filename="certificate.pdf"`
- `Cache-Control: private, no-store`
- `X-Content-Type-Options: nosniff`
- `X-Request-ID: <uuid>`

No storage key or permanent object URL is returned. A certificate revoked between authorization and redemption is rejected.

## Public errors

Malformed, invalid-signature, unknown-identifier, unavailable and invalid download authorization failures use the same external shape:

```json
{
  "error": {
    "code": "PUBLIC_REQUEST_FAILED",
    "message": "The request could not be completed."
  },
  "meta": {
    "request_id": "7f7dc332-d45f-4cee-bf5c-16e7266a8633"
  }
}
```

Use a consistent status policy and avoid material timing differences. Rate limiting returns `429` with the same non-disclosing body and an appropriate `Retry-After` header.

### Bounded public certificate search

`POST /api/public/certificates/project-suggestions` accepts exactly `{ "query": "..." }`. `POST /api/public/certificates/training-suggestions` accepts `{ "query": "..." }` with optional `project_name`; when supplied, the selected exact project is an additional server-side filter. Query text requires at least two normalized characters. Both operations use separate distributed 30-request/60-second network rate-limit buckets, read only opted-in `AVAILABLE` issuance snapshots, return at most ten `{ "label": "..." }` items, and expose no IDs, people, certificate references, totals or pagination. The certificate discovery operation retains its stricter separate 5-request/60-second network bucket. Empty and too-short requests use the generic public error.

`POST /api/public/certificates/search` is distinct from signed QR verification. Its strict body accepts exactly: `certificate_number` alone; `recipient_name` plus `project_name`; `recipient_name` plus `training_name`; or the recipient plus both contexts. Values are NFKC-normalized, trimmed and whitespace-collapsed. Recipient matching is exact after that normalization and after removing at most one recognized leading Thai title: `นาย`, `นาง`, `นางสาว`, `เด็กชาย`, `เด็กหญิง`, `ด.ช.` or `ด.ญ.`. The dotted abbreviations tolerate NFKC-equivalent dots and canonical whitespace around their dots; no other punctuation or leading word is removed. Recipient requires at least four characters; contexts and certificate number require at least three. Character and UTF-8 byte ceilings apply. Empty, name-only, internal-ID, external-reference and unknown-field input receives the generic public error. First-name, surname and other partial-name input is never sufficient.

Matching is exact after explicit trim/case normalization, with no fuzzy or wildcard semantics. Only organization-opted-in `AVAILABLE` issuance snapshots are returned. The response has at most ten rows, no total and no cursor. An eleventh match yields `results: []` and `too_broad: true`. Each row contains only `certificate_number`, `recipient_name`, `project_name`, the separately approved search-only `training_name`, `issued_at`, literal `available` status and a non-display `search_result_token`. This does not broaden the QR verification contract.

`POST /api/public/certificates/search-download-authorize` accepts only `{ "search_result_token": "..." }`. It verifies the distinct search-result type/audience/signature/expiry before lookup, re-reads current persisted state and complete publication metadata, and issues the existing typed download token only for current `AVAILABLE` PDFs. QR and download tokens are rejected. Final redemption remains `POST /api/public/certificates/download` with its own state and integrity recheck.

`PATCH /api/admin/organizations/current` accepts exactly `{ "public_certificate_search_enabled": boolean }`, requires the selected `X-Organization-ID`, authenticated membership, CSRF validation and `organization:update`, and returns the resulting boolean. The setting remains `FALSE` by default and is never enabled by bootstrap or migration.
