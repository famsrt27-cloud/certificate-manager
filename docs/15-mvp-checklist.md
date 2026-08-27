# 15 — MVP Checklist

## Foundation
- [ ] pnpm workspace repository structure
- [ ] Strict TypeScript configuration
- [ ] Next.js/Tailwind web boundary
- [ ] Fastify API boundary
- [ ] BullMQ worker boundary
- [ ] AGENTS.md
- [ ] Environment configuration
- [ ] Zod environment validation
- [ ] PostgreSQL 16
- [ ] Kysely database layer
- [ ] node-pg-migrate migrations
- [ ] Redis for sessions, rate limits and BullMQ
- [ ] MinIO/S3-compatible storage adapter
- [ ] Docker Compose services
- [ ] Composite tenant-integrity constraints
- [ ] Health checks

## Admin
- [x] bcrypt authentication
- [x] Redis opaque sessions
- [x] Session-bound CSRF
- [x] RBAC
- [x] Organization memberships and scoped roles
- [x] Projects
- [x] Trainings
- [x] Participants
- [ ] Templates
- [ ] Template versions
- [ ] Certificates
- [ ] Revoke

## Certificate
- [x] CSV/XLSX import
- [x] Validation/preview
- [x] Import jobs and staged rows
- [x] Queue (participant import only)
- [x] Worker (participant import only)
- [ ] PDF generation
- [ ] PDFKit renderer
- [ ] qrcode generation
- [ ] Private object storage
- [ ] QR

## Public
- [ ] Verification page
- [ ] Stateless signed token
- [ ] Separate opaque public certificate identifier
- [ ] Rate limiting
- [ ] Minimal metadata
- [ ] Secure download
- [ ] Recheck revocation on download redemption
- [ ] noindex

## Security
- [x] Audit log foundation for authentication and authorization
- [ ] Security headers
- [ ] CSRF strategy
- [ ] IDOR tests
- [ ] XSS tests
- [ ] SSRF tests
- [ ] upload security
- [ ] secret management
- [ ] backup strategy
- [ ] Vitest unit/integration suites
- [ ] Supertest API integration suites
- [ ] Playwright E2E suites

## Phase 7 security completion
- [x] Milestone 1 — threat model and security-boundary abuse suite
- [x] Milestone 2 — malicious input, template, renderer and PDF hardening
- [x] Milestone 3 — final repository sweep, leakage/privacy audit and resource completion gate
- [ ] Phase 8 deployment, secret operations, monitoring, backup and restore evidence
