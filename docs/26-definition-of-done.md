# 26 — Definition of Done

A feature is complete only when:

- [ ] Requirement implemented
- [ ] Locked stack and pnpm workspace boundaries followed
- [ ] Backend authorization implemented
- [ ] Validation implemented
- [ ] Error handling implemented
- [ ] Audit event added where needed
- [ ] Unit tests added
- [ ] Integration tests added where relevant
- [ ] E2E tests added for critical flows
- [ ] Vitest/Supertest/Playwright suites used according to `docs/07-testing-strategy.md`
- [ ] Security abuse cases tested
- [ ] Privacy impact considered
- [ ] Documentation updated
- [ ] Migration reviewed
- [ ] node-pg-migrate migration and Kysely types agree with PostgreSQL 16 schema where applicable
- [ ] API and OpenAPI paths/envelopes agree where applicable
- [ ] pnpm frozen-lockfile install passes
- [ ] Typecheck passes
- [ ] Lint passes
- [ ] Build passes
- [ ] No secrets committed
- [ ] No unnecessary PII introduced
- [ ] No unrelated refactor included
