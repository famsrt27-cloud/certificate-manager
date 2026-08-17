# 02 — Security and Privacy

## Security objectives

- Preserve certificate integrity and revocation state.
- Prevent cross-tenant access, IDOR, enumeration and privilege escalation.
- Keep signing keys, session secrets, verification tokens and storage credentials confidential.
- Minimize public and operational disclosure of recipient data.
- Treat uploads, template data and PDF rendering as untrusted inputs.

## Authentication and authorization

- Admin passwords are hashed and verified with bcrypt. Password inputs are validated by UTF-8 byte length and cannot exceed bcrypt's 72-byte boundary.
- Admin APIs require a valid Redis-backed server-side session.
- The browser cookie contains only a cryptographically random opaque session identifier and uses the `__Host-admin_session` name, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain` attribute.
- Redis session records have idle and absolute expiry and carry an authorization/session version used to invalidate stale membership or role state.
- Rotate the session identifier after login and relevant privilege changes; invalidate it on logout, user disablement and applicable membership/role revocation.
- State-changing admin requests require a session-bound CSRF token in `X-CSRF-Token`. Validate the token before domain work and use constant-time comparison where applicable.
- Login throttling, password policy, session TTLs, bcrypt cost calibration, Redis failure behavior and MFA policy must be documented and tested before Phase 2 is complete.
- Authorization is permission-based and organization-scoped on the backend.
- Resource IDs never replace permission and tenant checks.
- `SUPER_ADMIN` is a separately assigned system role; other roles are organization membership roles.

### Phase 2 authentication operating policy

- New password hashes require at least 12 Unicode characters and no more than 72 UTF-8 bytes. Passwords are never normalized or silently truncated. Login still performs a dummy bcrypt comparison for an unknown or inactive account so the response does not disclose account existence.
- Bcrypt cost is configurable from 12 through 15 and defaults to 12. Deployments benchmark the selected cost against their login-latency budget; configuration cannot select a value below 12.
- Sessions use 256-bit random identifiers and CSRF tokens. Redis keys contain an HMAC-SHA-256 digest of the browser session identifier, not the identifier itself.
- Idle expiry defaults to 30 minutes and absolute expiry to 8 hours. Both are configurable only within validated bounds. A successful login always replaces a supplied prior session, logout deletes the Redis record, and a changed server-resolved authorization version revokes the stale session on its next use.
- Login limiting uses keyed, non-PII Redis keys with a 15-minute window: five attempts per normalized account and 20 attempts per network source by default. Redis authentication-state failure fails closed with a safe `503` response.
- Login and every state-changing authenticated operation require an exact allowed `Origin`. CSRF comparison is constant-time, and a token from a rotated/revoked session is invalid.
- Audit events for login success/failure, logout, stale-session revocation and permission denial use fixed action-specific metadata. They never store email, password, session ID, CSRF token or raw network address.
- The accepted API/database contract does not yet define an MFA factor. Phase 2 therefore permits `ADMIN_MFA_POLICY=DEFERRED_NON_PRODUCTION` only and configuration validation rejects API startup with `NODE_ENV=production`. Production enablement requires an approved schema/API/ADR change and tested MFA implementation; an upstream claim must not silently bypass this gate.

## Public verification

- Verification requires no recipient login.
- Accept verification tokens in request bodies. A QR link may place the token in the URL fragment so the browser can submit it by POST; tokens must not be placed in query strings or paths.
- Apply distributed rate limits before expensive signature or database work where practical.
- Invalid, malformed, tampered and unknown tokens return the same generic error shape.
- Do not expose internal UUIDs, student IDs, external references, email, phone, address, storage keys, secrets or signing details.
- Successful responses contain only status, recipient display name, program/training, certificate number and issue date as permitted by status.
- Public pages set `noindex`, `nofollow`, `noarchive`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer` and do not load third-party analytics or resources that could receive token-bearing page state.

## Tokens and keys

- Verification tokens are signed stateless tokens; the complete token is never stored in plaintext.
- Tokens carry only the separate opaque public certificate identifier and non-PII protocol claims.
- Internal certificate UUIDs are never encoded into public tokens.
- Enforce an explicit algorithm allowlist and reject algorithm/header confusion.
- Use `kid` for rotation, store keys outside source control and retain only approved verification keys.
- Never log a verification token, download token, signing key or session secret.

## Secure download

- Download authorization is short-lived, audience-scoped and bound to one public certificate identifier.
- The application checks the signed verification token and current `AVAILABLE` state before issuing download authorization.
- The application checks authorization, expiry, audience and current certificate state again at redemption.
- Revoked or archived certificates cannot be downloaded even if a previously issued authorization has not expired.
- The public API streams the PDF or uses an equivalently protected application-controlled exchange; it never returns storage keys or permanent public URLs.

## Upload and rendering security

- Enforce file-size, declared MIME, detected signature and allowed-format rules.
- Validate HTTP payloads, upload metadata, queue payloads and custom template definitions with their canonical Zod schemas.
- Normalize file names and never use user-supplied paths as storage paths.
- Store uploads privately and quarantine them until validation completes.
- Parse CSV/XLSX and image/font metadata with resource limits.
- Custom JSON template schemas allow only documented element types, bindings and properties; the data binder resolves only allowlisted fields.
- Arbitrary JavaScript, local file access, path traversal and unrestricted remote resource loading are forbidden.
- Renderer workers use bounded concurrency and isolated temporary directories that are cleaned after every attempt.

## Privacy and data minimization

Required participant data is limited to display name and certificate/training relationships. An external reference is optional and private.

Prohibited by default:

- date of birth
- address or precise location
- health or family information
- unrelated contact data
- unnecessary phone or email data

`network_fingerprint` is optional security telemetry, not a raw IP address. If enabled, it must use a keyed, rotating pseudonymous derivation, have a documented short retention period and never be usable as public identity data.

## Logging and audit

- Use structured logs with request IDs and explicit redaction.
- Audit metadata must use action-specific allowlists; arbitrary request bodies are forbidden.
- Audit records are append-only at the application and database boundaries.
- Verification and download events follow approved retention and aggregation policies.
- Errors returned publicly must not reveal existence, tenant, status beyond the allowed response, or internal failure details.

## Required abuse-case tests

- cross-tenant and IDOR attempts
- privilege escalation and role confusion
- token tampering, wrong algorithm, wrong `kid` and unknown public identifier
- verification/download brute force and rate-limit bypass
- revoke between authorization and download redemption
- malicious CSV/XLSX/image/font uploads
- template injection, XSS, SSRF and path traversal
- renderer resource exhaustion
- bcrypt 72-byte boundary, session fixation/rotation and CSRF replay
- secret/PII log leakage
