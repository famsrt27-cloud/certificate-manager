# 07 — Testing Strategy

## Locked tools

- Vitest: unit and integration test runner
- Supertest: Fastify HTTP integration testing
- Playwright: browser and end-to-end testing
- Docker Compose services: PostgreSQL 16, Redis and MinIO for integration/E2E environments

No second test runner or browser automation framework is part of the baseline.

## Test layers

### Unit

Use Vitest for pure policies and deterministic components:

- Zod validation and wire mapping
- tenant/permission policies
- token claim and key-selection validation
- custom template data binder
- template coordinate/asset validation
- job idempotency decisions
- certificate lifecycle transitions
- deterministic PDF rendering inputs
- strict renderer-boundary validation, asset-set/hash checks and forbidden capability/dependency drift

Unit tests may use small fakes at explicit infrastructure ports. They must not mock away the security policy under test.

### Integration

Use Vitest and Supertest against a real Fastify application instance plus isolated Docker Compose infrastructure where the behavior depends on PostgreSQL, Redis or MinIO.

Cover:

- migrations up/down in disposable databases according to migration policy
- composite tenant foreign keys and database triggers
- Kysely queries and transactions
- Redis session creation, rotation, expiry and revocation
- CSRF enforcement
- BullMQ enqueue/retry/idempotency behavior
- S3-compatible private-object access and metadata
- API envelopes, status codes, validation and authorization

Do not substitute an in-memory database for PostgreSQL integrity tests.

### End-to-end

Use Playwright against the composed web/API/worker system for critical flows:

- admin login/logout and session expiry
- project/training/participant import
- template draft/preview/publish
- certificate generation progress
- public QR/fragment verification
- secure download authorization and redemption
- revocation blocking both verification download state and existing download authorization

### Security abuse cases

Required suites include:

- cross-tenant UUID/IDOR attempts
- role and membership revocation
- CSRF missing/invalid/replayed token
- session fixation and stale-session behavior
- bcrypt byte-length boundary behavior
- verification/download token tampering, algorithm confusion and wrong `kid`
- public rate-limit and generic-error behavior
- malicious CSV/XLSX and template asset uploads
- template binder injection and forbidden binding paths
- PDF resource exhaustion and remote-resource attempts
- renderer secret/infrastructure-field rejection and dependency-capability boundary tests
- storage-key and permanent-URL disclosure checks
- secret/PII leakage in logs and error responses

## Determinism and isolation

- Tests use fixed clocks/randomness only through explicit test seams; production randomness remains cryptographically secure.
- Each integration worker receives an isolated database/schema, Redis prefix and MinIO bucket/prefix.
- Tests clean only resources created within their isolated namespace.
- PDF tests compare stable semantic/content hashes where deterministic bytes are guaranteed; otherwise compare validated structure and approved visual fixtures without weakening assertions.
- Test retries must not hide deterministic failures.

## Fixtures and privacy

- Use synthetic recipient names, emails and external references.
- Never import production exports into automated tests.
- Tokens and credentials used by tests are ephemeral and must still be redacted from logs.
- Upload fixtures are minimal and purpose-specific, including explicit malicious fixtures for security tests.

## Phase gates

- Phase 1: configuration, migration, health-check and infrastructure integration tests
- Phase 2: authentication, Redis session, CSRF, RBAC and cross-tenant tests
- Phase 3: project/training/participant/import tests
- Phase 4: template validation, asset and immutable-publish tests
- Phase 5: BullMQ, PDFKit, qrcode, storage and idempotency tests
- Phase 6: public verification, rate limit and secure-download tests
- Phase 7: complete threat-model abuse suite
- Phase 8: deployment smoke, backup and restore tests

A phase is not complete while its critical security or data-integrity tests are failing.

The Phase 6 completion gate provisions PostgreSQL, Redis and local S3-compatible private storage in CI. Its canonical secure-download integration path is not optional in CI and proves verification, download authorization, private-object redemption, revocation blocking and corrupt-object rejection.
