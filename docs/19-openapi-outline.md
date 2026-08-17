# 19 — OpenAPI 3.1 Outline

## Authority

The Fastify implementation must produce an OpenAPI 3.1 document that mirrors `docs/10-api-contract.md`. Canonical wire validation uses shared Zod schemas. This outline does not redefine the API. If any path, field, response envelope or security behavior differs, `docs/10-api-contract.md` governs and both files must be reconciled before implementation.

## Required metadata

- OpenAPI version `3.1.x`
- API title and specification version from `MANIFEST.json`
- environment-specific server URLs with no embedded credentials
- reusable request ID, pagination, error and security components
- schemas aligned with `@certificate-platform/contracts` Zod wire definitions without maintaining conflicting handwritten field sets

## Tags

- Health
- Auth
- Organizations
- Users
- Projects
- Trainings
- Participants
- Participant Imports
- Templates
- Certificates
- Jobs
- Public Verification
- Public Download
- Audit
- Security

## Canonical JSON envelopes

Success schemas use:

```json
{
  "data": {},
  "meta": {
    "request_id": "uuid"
  }
}
```

Error schemas use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Safe public message"
  },
  "meta": {
    "request_id": "uuid"
  }
}
```

Binary PDF responses are the documented exception: they return `application/pdf` and carry `X-Request-ID` as a response header.

## Foundation health paths

The generated API description includes `GET /health/live` and `GET /health/ready` exactly as defined by `docs/10-api-contract.md`. Both responses declare `X-Request-ID`; readiness declares the canonical `503` error envelope with `SERVICE_UNAVAILABLE`. The worker health port is operational infrastructure and is not part of the public API document.

## Pagination

Large authenticated admin lists use opaque cursor pagination:

```json
{
  "data": [],
  "meta": {
    "request_id": "uuid",
    "next_cursor": "opaque-cursor-or-null"
  }
}
```

Cursors must not grant access, leak raw query state or bypass organization scoping.

## Security schemes

### Admin

OpenAPI defines `adminSession` as an API-key security scheme in the `__Host-admin_session` cookie and `csrfToken` as an API-key scheme in the `X-CSRF-Token` header.

`POST /api/admin/auth/login` declares no authenticated security scheme and documents origin/rate-limit behavior. Every other `/api/admin/*` operation requires `adminSession` and states its required permission. State-changing authenticated operations require both `adminSession` and `csrfToken`.

Organization scope is derived from an authorized membership; an identifier alone never grants access.

Phase 3 tenant operations declare the required `X-Organization-ID` header as a selector, not as a security scheme or authorization credential. State-changing operations also declare CSRF, and import commands declare `Idempotency-Key`.

Session and authentication responses use `Cache-Control: no-store`. Cookie/session IDs, passwords and CSRF tokens are marked sensitive and excluded from logs and real examples.

### Public

Public endpoints declare no account authentication. The signed verification/download token is an operation request-body field, marked sensitive and excluded from examples containing real values.

Tokens must not be modeled as path parameters, query parameters or reusable bearer authorization headers.

## Canonical core operations

OpenAPI paths must match these `docs/10-api-contract.md` operations exactly:

- `POST /api/admin/auth/login`
- `GET /api/admin/auth/session`
- `POST /api/admin/auth/logout`
- `POST /api/admin/projects`
- `GET /api/admin/projects`
- `GET /api/admin/projects/{projectId}`
- `PATCH /api/admin/projects/{projectId}`
- `POST /api/admin/projects/{projectId}/archive`
- `POST /api/admin/trainings`
- `GET /api/admin/trainings`
- `GET /api/admin/trainings/{trainingId}`
- `PATCH /api/admin/trainings/{trainingId}`
- `POST /api/admin/trainings/{trainingId}/archive`
- `GET /api/admin/participants`
- `GET /api/admin/participants/{participantId}`
- `PATCH /api/admin/participants/{participantId}`
- `POST /api/admin/templates/{templateId}/versions`
- `POST /api/admin/templates/{templateId}/versions/{versionId}/publish`
- `POST /api/admin/trainings/{trainingId}/participants/import`
- `GET /api/admin/participant-imports/{jobId}`
- `POST /api/admin/participant-imports/{jobId}/confirm`
- `POST /api/admin/trainings/{trainingId}/certificates/generate`
- `GET /api/admin/jobs/{jobId}`
- `POST /api/admin/certificates/{certificateId}/revoke`
- `POST /api/public/verify`
- `POST /api/public/certificates/download-authorize`
- `POST /api/public/certificates/download`

Additional CRUD operations may be specified before their implementation, but they must follow the same version, envelope, tenant, permission and identifier rules.

The Phase 3 Fastify application serves the generated implemented-operation document at `GET /openapi.json`. Its request/response JSON schemas are derived from the canonical Zod contracts, and it intentionally omits Phase 4+ paths until those phases are implemented.

## Idempotency

OpenAPI marks `Idempotency-Key` as required for:

- participant import upload
- participant import confirmation
- certificate generation
- any later safely retryable creation command identified by the API contract

The key is organization- and operation-scoped and is not returned in public logs or error detail.

## Public schemas

Public schemas contain no internal UUID, organization ID, student/external reference, contact data, storage key, revocation reason or signing details.

`PublicVerificationValid` contains only:

- `status: valid`
- `certificate_number`
- `recipient_name`
- `program_name`
- `issued_at`

`PublicVerificationRevoked` contains only:

- `status: revoked`
- `certificate_number`

All invalid, malformed, unknown and unavailable cases use the canonical `PUBLIC_REQUEST_FAILED` error schema. Rate limiting uses the same safe body with HTTP `429` and `Retry-After`.

## Download response

`POST /api/public/certificates/download` declares:

- request body containing only `download_token`
- `200` response with `application/pdf` binary schema
- `Content-Disposition`, `Cache-Control`, `X-Content-Type-Options` and `X-Request-ID` headers
- generic JSON public-error responses

It must not declare a storage URL, storage key, certificate UUID or certificate public identifier in the response.

## Logging annotation

Token-bearing request fields are sensitive. Generated documentation, tracing, analytics and request logging must not capture verification tokens, download tokens, passwords, session secrets or unnecessary PII.
