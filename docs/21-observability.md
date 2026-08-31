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

Phase 3 adds allowlisted project/training create, update and archive actions, participant update, and participant-import queued/confirmed actions. These events contain organization, actor membership, action, resource type/UUID and request ID only; file names, storage keys, import rows, display names and external references are excluded. Worker failures expose only stable error codes.

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

Public `search_result_token` values receive the same request-body, structured-log, trace and error-report redaction as verification and download tokens. Search criteria and returned recipient names are not added to metrics, tracing attributes or routine request logs.

## Phase 8.3 private metrics surface

API and worker each expose a small in-process Prometheus text endpoint at `/metrics`.
It is reachable only on private deployment networks; the production Nginx edge returns
404 for it. No monitoring vendor, public scrape endpoint, token-bearing label, or
high-cardinality route value is introduced by this implementation. The collector must
scrape the private API/worker endpoints with deployment-managed network controls.

Implemented metric families are:

- `certificate_platform_http_requests_total` and
  `certificate_platform_http_request_duration_seconds`, labelled only with fixed
  service, method, matched route pattern and status code;
- `certificate_platform_public_verification_total` and
  `certificate_platform_public_download_total`, labelled only by aggregate result;
- `certificate_platform_rate_limit_events_total`, labelled by fixed login/public
  verification/public download/public search scope;
- `certificate_platform_dependency_failures_total` and
  `certificate_platform_readiness_total`, labelled only by database/Redis and result;
- worker generation queue depth, duration, failed/retried/stalled events and renderer
  failure families;
- object-storage failure and Redis-backed session failure counters.

Route labels are derived from registered Fastify route patterns only; unmatched,
query-bearing, malformed, or overlong input is grouped as `unmatched`. Labels never
contain raw URLs, tokens, certificate identifiers, recipient/participant names, raw
IP addresses, credentials, search criteria, storage keys, signing material, or queue
payload contents. Counters reset on process restart; alerting and retention are a
private collector/operations responsibility.

API and worker disable framework default request logging and write a redacted JSON
completion record with service identity, generated request ID, matched route, status,
duration and stable HTTP error code where applicable. Nginx writes a separate JSON edge
access record containing only method, status, duration, upstream status and the
application-generated response request ID. Raw request paths and query strings,
forwarded/client address fields, request bodies and tokens are not edge-log dimensions.
Next.js is reached only through the edge; its canonical request outcome is therefore
represented by the edge record, while API work is represented by API JSON logs and
metrics.
