# AGENTS.md

## Project
Certificate Management & Public Verification Platform.

## Core principles
- Security first.
- Privacy by design and data minimization.
- Public certificate download must not require recipient login.
- Never expose unnecessary personal data.
- Never use sequential IDs or Student IDs as public secrets.
- Never disable security controls merely to make tests pass.
- Do not add PII unless explicitly required and documented.

## Architecture rules
- Read relevant files under `docs/` before implementing a feature.
- Treat `docs/03-technology-stack.md` and `docs/04-repository-layout-and-naming.md` as the canonical implementation baseline.
- Use pnpm workspaces and the approved TypeScript stack; do not introduce a replacement or parallel framework, query builder, migration tool, queue, validation library, PDF engine, test runner, session model, or deployment orchestrator without an approved ADR.
- Do not change architecture, database schema, API contracts, or security model without documenting the change.
- Prefer small, reviewable changes.
- Keep certificate rendering deterministic and versioned.
- Certificate PDFs must remain tied to the template version used to issue them.
- Certificate issuance identity and the issuance-time binding snapshot are immutable.
- Renderers must consume immutable/versioned certificate inputs, never mutable live participant/project/training rows.
- A revoked certificate is terminal and must never become available again.
- Stale generation revisions must never overwrite the current certificate revision or PDF identity.
- Certificate generation idempotency is bound to the exact first-resolved participant set; workers must never re-resolve a later population.
- Initial generation must not silently reissue a participant with certificate history; reissue requires an explicit reviewed operation after revocation.
- The planned issuance timestamp and renderer revision are durable immutable generation inputs.

## Security rules
- Use cryptographically secure randomness for public tokens.
- Public verification endpoints must be rate-limited.
- Do not reveal whether another secret or Student ID exists through error messages.
- Admin APIs require authentication and server-side authorization.
- Never put secrets in source control.
- Do not log passwords, tokens, session secrets, or unnecessary PII.
- Validate and sanitize uploaded assets.
- Treat PDF/HTML rendering as an untrusted execution boundary.
- The certificate renderer receives only strict validated render data and validated asset bytes; it must not import database, storage, queue, auth, network, filesystem or signing-key capabilities.
- The renderer never signs verification tokens. A trusted application/worker boundary prepares the final verification URL and passes only that string to rendering.
- Public certificate pages should be non-indexable.

## Testing
Every feature must include appropriate unit/integration/E2E tests.
Security-sensitive features must include abuse-case tests.

## Change workflow
1. Read relevant documentation.
2. State assumptions.
3. Implement the smallest safe change.
4. Run tests and static checks.
5. Update documentation when behavior or contracts change.
