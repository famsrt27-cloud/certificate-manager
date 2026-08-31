# 23 — Threat Model

## Asset

- certificates
- recipient data
- template assets
- admin accounts
- signing keys
- PDF files
- audit logs
- database

## Threats

### T1 Token guessing
Mitigation:
- cryptographically signed token carrying a separate 128-bit opaque public certificate identifier
- rate limit
- abuse detection

### T2 Token tampering
Mitigation:
- cryptographic signature
- key rotation

### T3 Enumeration
Mitigation:
- no sequential public identifiers
- generic errors
- no name search

### T4 IDOR
Mitigation:
- backend authorization
- opaque identifiers
- scoped queries
- organization membership checks
- composite tenant foreign keys

### T5 Malicious upload
Mitigation:
- MIME/signature validation
- size limits
- safe storage
- scanning/sanitization

### T6 SSRF/PDF abuse
Mitigation:
- renderer sandbox
- network disabled by default
- allowlist if needed

### T7 Admin compromise
Mitigation:
- MFA
- RBAC
- audit
- session controls

### T8 Storage exposure
Mitigation:
- private bucket
- short-lived signed URLs
- no public listing

### T9 Log leakage
Mitigation:
- structured logging
- secret redaction
- PII minimization

### T10 Revocation bypass
Mitigation:
- verification checks current certificate status every time
- download status is checked at authorization and redemption

### T11 Cross-tenant association
Mitigation:
- every tenant-owned row carries organization ID
- composite foreign keys bind related resources to one organization
- admin queries require active membership and permission
- negative cross-tenant tests

### T12 Internal identifier disclosure
Mitigation:
- public tokens contain only the separate opaque public certificate identifier
- public responses omit both internal UUIDs and raw public identifiers
- signed token is required; public identifier alone is not a verification credential

### T13 Download token replay or race
Mitigation:
- distinct download token type and audience
- maximum 60-second expiry
- POST-body transport only
- status recheck at redemption
- no permanent object URL or storage key disclosure
- optional `jti` replay control where required by the approved implementation

### T14 Tenant or role confusion
Mitigation:
- system and organization role assignments use separate tables
- roles and effective permissions are resolved server-side
- membership and session revocation tests
- privileged bypass paths are explicit and audited

### T15 Session fixation, theft or stale authorization
Mitigation:
- opaque cryptographically random Redis session IDs
- `__Host-admin_session` Secure/HttpOnly/SameSite=Lax cookie
- rotation after login and relevant privilege changes
- idle and absolute expiry
- invalidation on logout/user disablement/applicable membership or role revocation
- no session IDs in browser storage, logs or URLs

### T16 CSRF
Mitigation:
- session-bound CSRF token in `X-CSRF-Token`
- allowed-Origin enforcement for login and state-changing browser requests
- SameSite cookie policy as defense in depth
- negative missing/invalid/replayed-token tests

### T17 Password boundary or offline cracking
Mitigation:
- bcrypt with environment-calibrated approved work factor
- enforce UTF-8 input byte limit before bcrypt's 72-byte boundary
- generic login failures and throttling
- never log plaintext passwords or hashes

### T18 Queue/cache confusion
Mitigation:
- BullMQ/Redis coordinates delivery but PostgreSQL is authoritative for job/item state
- versioned Zod-validated queue payloads
- durable idempotency constraints and safe redelivery
- separate Redis namespaces for sessions, rate limits and queue data

### T19 Production ingress or observability exposure
Mitigation:
- only the Nginx TLS edge publishes host ports in production Compose
- web, API, worker, migrations and private dependencies use least-privilege private
  networks; health and metrics are blocked at the public edge
- Nginx overwrites forwarded headers and Fastify trusts exactly one internal hop
- structured logs and metrics use generated request IDs, stable route patterns and
  aggregate fixed labels; tokens, raw IPs, search criteria, credentials and PII are
  excluded
- deployment-injected TLS and secret material is never baked into images
