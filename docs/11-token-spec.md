# 11 — Stateless Token Specification

## Decision

Public verification uses a signed stateless verification token. The complete token is never stored in the database. Current certificate status remains stateful and is checked on every verification and download operation.

## Certificate identifiers

Each certificate has two distinct identifiers:

- `certificates.id`: internal UUID, allowed only inside trusted application/admin boundaries
- `certificates.public_identifier`: globally unique 32-character lowercase hexadecimal value generated from 16 cryptographically random bytes

Only `public_identifier` may be used as a public token subject. It is opaque, non-sequential, immutable and not sufficient for verification without a valid signature. Internal UUIDs must never be encoded into verification or download tokens.

## Verification token

Use a versioned, compact signed token with an explicit protected header and payload. Conceptual protected header:

```json
{
  "alg": "HS256",
  "kid": "key-2026-01",
  "typ": "CVT"
}
```

Conceptual payload:

```json
{
  "v": 1,
  "typ": "certificate-verification",
  "pcid": "8e0f8e23ef3b9ce8a7cb5f451c71d8f4",
  "iat": 1786963200
}
```

The verification token must not contain:

- internal database UUIDs
- organization, user, participant or student IDs
- display name or certificate metadata
- email, phone, address, date of birth or other PII
- storage keys
- permissions, certificate status or revocation state

Signed tokens provide integrity, not confidentiality. All claims must therefore be safe to decode publicly.

## Verification algorithm

1. Enforce token byte-length and structural limits before decoding.
2. Parse only the supported compact format.
3. Require the expected `typ`, version and an explicitly allowlisted algorithm.
4. Resolve `kid` only from the configured verification-key set; never accept an embedded key or key URL.
5. Verify the signature before using `pcid` in a database query.
6. Validate `pcid` against the exact lowercase 32-hex format.
7. Resolve the certificate by `public_identifier` using a parameterized query.
8. Load current certificate, training, organization and template state as required.
9. Return only the status-dependent fields allowed by `docs/10-api-contract.md`.

Malformed, invalid-signature and unknown-identifier cases produce the same public error behavior. The implementation must avoid material timing differences where practical.

## Lifetime and replay model

The certificate verification token is stable for the certificate and does not use expiry as a substitute for revocation. It is a bearer capability: anyone possessing it can view the minimal public verification result. Current database state remains authoritative.

For deterministic certificate rendering, verification-token time/key inputs cannot depend on the current render attempt. The verification-token `iat` for an issued certificate is derived from the immutable planned issuance timestamp, not `Date.now()` during PDF generation. Key selection for an existing certificate must also remain stable across ordinary regeneration (for example by retaining a non-secret `kid` association or another reviewed immutable rule). The renderer is not allowed to make this choice: trusted application/token code produces the complete verification URL and passes only that string into rendering.

A stable token cannot authorize direct storage access. PDF access always requires a separate short-lived download token and a fresh state check.

## Download token

Download authorization uses a separately typed signed token. Conceptual payload:

```json
{
  "v": 1,
  "typ": "certificate-download",
  "aud": "public-certificate-download",
  "pcid": "8e0f8e23ef3b9ce8a7cb5f451c71d8f4",
  "iat": 1786963200,
  "exp": 1786963260,
  "jti": "cryptographically-random-token-id"
}
```

Rules:

- maximum lifetime is 60 seconds
- type and audience are mandatory
- `pcid` is the same separate public identifier, never the internal UUID
- authorization is valid for one certificate only
- certificate status is checked when the token is issued and again when redeemed
- the token is accepted only in the POST body
- token values are never logged, cached or returned in URLs
- revocation or archival blocks redemption immediately

The `jti` supports correlation-safe replay controls if the approved implementation requires single use; raw `jti` values must not be logged.

For the Phase 6 MVP, download tokens remain stateless and may be replayed only within their at-most-60-second validity window. Every redemption revalidates token time and current certificate/publication state. No raw `jti` is persisted or logged, and one-time-token persistence is not introduced without a later approved requirement.

## HMAC and asymmetric signing

The approved MVP decision permits HMAC-SHA-256 for one backend signing authority. The implementation must pin `HS256` rather than trusting the token header and must isolate the shared secret.

If signing and verification later move to different trust domains, adopt an approved asymmetric algorithm through a new ADR and token version. Do not silently accept multiple algorithm families.

## Key rotation

- `kid` is required in the protected header.
- Maintain one active signing key and an explicitly approved set of previous verification keys.
- Newly issued certificate tokens use the active key selected at first issuance. Ordinary regeneration of an existing certificate retains its approved certificate key selection so the stable verification token does not change merely because a deployment rotated the current signing key.
- Removed/compromised keys fail closed.
- Keys come from the approved secret-management mechanism and are never stored in source or the application database.
- Rotation, compromise and retirement procedures must be tested before production.

## QR transport

The QR code may encode the public verification page with the token in the URL fragment, for example conceptually:

```text
https://verify.example/verify#token=<signed-token>
```

The browser reads the fragment and submits the token by `POST /api/public/verify`. The fragment is not included in the initial HTTP request. The page must use `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, no third-party resources and no token-bearing analytics.

Tokens must not appear in URL paths or query strings.

## Database storage rule

The database stores:

- internal certificate UUID
- non-secret opaque `public_identifier`
- current certificate status and rendering metadata

The database does not store the complete verification token or download token in plaintext.

## Certificate search result capability

Successful bounded discovery may mint a compact HS256 capability with header `typ: CSRT` and strict claims `v: 1`, `typ: certificate-search-result`, `aud: public-certificate-search-result`, opaque `pcid`, `iat`, `exp` and random 128-bit `jti`. Its lifetime is configurable from 60 to 300 seconds and defaults to 180 seconds. It binds one certificate public identity without returning that identity separately.

Only `POST /api/public/certificates/search-download-authorize` accepts this token. Verification authenticates type, audience, key, signature, canonical claims, time and expiry before database access. It is mutually exclusive with QR verification (`CVT`) and PDF download (`CDT`) tokens. The browser keeps it only in component memory. Successful exchange rechecks current publication state and mints a normal `CDT`; final redemption is unchanged.
