# 21 — Observability

## Logs

Structured JSON logs.

Fields:
- timestamp
- level
- service
- request_id
- route
- status
- duration_ms
- error_code

Never log secrets or unnecessary PII.

Request bodies for login, public verification, download authorization and download redemption must not be logged. Verification tokens, download tokens, session values, signing details, storage keys and participant import rows are redacted before logs, traces or error reports are emitted.

Fastify request logging, BullMQ job logging and worker error handling use the same redaction policy. Never serialize complete Zod input errors if they can contain passwords, tokens, import rows or template-bound recipient values.

The Phase 1 API and worker health boundaries emit structured JSON logs, generate a fresh UUID request ID instead of trusting `X-Request-ID`, return that ID in JSON metadata and the response header, and redact the reserved credential/token fields in the shared logger configuration. Domain-specific job logging remains deferred to its roadmap phase.

Phase 2 adds append-only allowlisted audit actions `AUTH_LOGIN_FAILED`, `AUTH_LOGIN_SUCCEEDED`, `AUTH_LOGOUT`, `AUTH_SESSION_REVOKED` and `AUTHORIZATION_DENIED`. Failed-login metadata contains only a fixed result category. Authorization-denial metadata contains only the required permission and a fixed reason; raw request data, email, network address, cookie/session IDs and CSRF tokens are excluded.

## Metrics

Track:
- request count
- latency
- error rate
- verification success/failure
- download success/failure
- generation queue depth
- generation duration
- failed jobs
- PDF renderer failures
- rate-limit events
- Redis session failures and session invalidations
- BullMQ stalled/retried/dead-letter jobs reconciled with PostgreSQL job state
- S3-compatible/MinIO request failures without object keys as metric labels

Public metrics use aggregate result categories. Do not attach token values, certificate identifiers, recipient names, raw IP addresses or other high-cardinality PII as labels.

## Alerts

Alert on:
- elevated 5xx
- queue backlog
- repeated token tampering
- brute-force spikes
- storage failures
- database connection failures
- certificate generation failure rate

## Tracing

Use request_id and, where supported, distributed tracing.

Tracing baggage and span attributes must follow the same secret/PII redaction rules as logs.
