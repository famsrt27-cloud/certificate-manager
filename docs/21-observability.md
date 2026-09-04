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

### Phase 8.4 backup signals

The operator backup boundary writes protected, low-cardinality status evidence for
database backup result/timestamp/safe byte size, durable-object backup result/count,
and restore-drill result/timestamp. Alerting must evaluate freshness from the last
successful timestamp and provider-exposed bucket versioning/lifecycle/replication
status. Do not emit backup filenames, object keys, tenant identifiers, credentials or
participant data as metrics or log fields.

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

## Phase 8.5 alert ownership gate

The repository supplies signals and safe first diagnostics; it does not supply an
alert destination or on-call roster. Before launch, the service owner must assign the
following matrix in the approved incident system. No numerical threshold is invented
here: use the approved trigger policy, or treat its absence as a launch blocker.

| Signal | First diagnostic and safe recovery | Required owner |
| --- | --- | --- |
| Elevated 5xx | Correlate redacted edge/API request IDs; check readiness before rollback. | Application on-call |
| Database failure | Check private readiness and provider health; do not run migrations during an outage. | Database + application on-call |
| Redis/session failure | Check authenticated TLS Redis health; expect logout/re-login after loss. | Cache + application on-call |
| Queue backlog/stalled/retried/failed | Compare private worker metrics with PostgreSQL job/outbox state; reconcile, never blindly replay terminal work. | Worker on-call |
| Renderer/generation failure | Inspect stable error code and immutable generation state; retry only the approved non-terminal path. | Worker on-call |
| Object-storage failure | Verify private bucket/provider health; do not create a public fallback or falsify PDF metadata. | Storage + application on-call |
| Auth/rate-limit or token-tamper anomaly | Preserve redacted evidence, assess abuse, and adjust only approved controls. | Security on-call |
| Backup/restore-test freshness | Review sanitized backup/restore status and provider evidence. | Backup owner |
| TLS expiry | Validate deployed certificate chain and renewal path without exposing private keys. | Platform/edge owner |

`alert_ownership` is an external/operator launch control. The repository contract is
complete when this matrix, signals, safe diagnostics, escalation expectations, and the
fail-closed launch classification exist; the repository cannot assign a real person or
destination. Until a real alert route and named owner accept these responsibilities,
production launch remains `BLOCKED` / `OPERATOR-REQUIRED` even when the repository
Phase 8 completion gate passes.
