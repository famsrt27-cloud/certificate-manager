# 04 — Repository Layout and Naming Conventions

## Status

The Phase 2 implementation adds `auth` and `domain` to the Phase 1 `config`, `contracts`, `database` and `queue` packages. Storage, template, rendering and shared test-fixture packages remain deferred to their roadmap phases.

## Package manager and workspace

- Use one pnpm workspace rooted at the repository root.
- Use one root `package.json`, one `pnpm-workspace.yaml` and one committed `pnpm-lock.yaml`.
- Run dependency installation and cross-workspace scripts from the root.
- CI uses frozen-lockfile installation.
- Internal packages use the `@certificate-platform/*` scope and workspace protocol.
- Runtime applications do not import source files across package boundaries; they import declared package exports.

## Canonical planned layout

```text
/
├─ apps/
│  ├─ web/                       # Next.js + Tailwind CSS
│  │  ├─ src/app/               # App Router routes/layouts
│  │  ├─ src/components/
│  │  ├─ src/features/
│  │  └─ tests/
│  ├─ api/                       # Fastify HTTP boundary
│  │  ├─ src/routes/
│  │  ├─ src/plugins/
│  │  ├─ src/modules/
│  │  └─ tests/
│  └─ worker/                    # BullMQ processors
│     ├─ src/processors/
│     └─ tests/
├─ packages/
│  ├─ auth/                      # bcrypt, Redis session and CSRF services
│  ├─ config/                    # typed environment validation
│  ├─ contracts/                 # browser-safe Zod wire schemas and DTO types
│  ├─ database/                  # Kysely, PostgreSQL types and node-pg-migrate files
│  │  ├─ src/
│  │  └─ migrations/
│  ├─ domain/                    # framework-independent use cases and policies
│  ├─ queue/                     # BullMQ names, versioned payload schemas and producers
│  ├─ storage/                   # S3-compatible adapter using @aws-sdk/client-s3
│  ├─ template-engine/           # custom JSON schema, Zod validation and binder
│  ├─ certificate-renderer/      # PDFKit and qrcode rendering
│  └─ test-utils/                # non-production fixtures/helpers
├─ tests/
│  ├─ e2e/                       # Playwright system flows
│  └─ security/                  # cross-service abuse cases
├─ docs/
├─ compose.yaml                  # Docker Compose baseline, created in Phase 1
├─ package.json                  # workspace scripts, created in Phase 1
├─ pnpm-workspace.yaml           # created in Phase 1
├─ pnpm-lock.yaml                # created by approved install in Phase 1
└─ tsconfig.base.json            # strict shared TypeScript config
```

## Dependency direction

```text
apps/web ───────────────→ packages/contracts

apps/api ───────────────→ packages/auth
        ├───────────────→ packages/contracts
        ├───────────────→ packages/domain
        ├───────────────→ packages/database
        ├───────────────→ packages/queue
        └───────────────→ packages/storage

apps/worker ────────────→ packages/domain
           ├────────────→ packages/database
           ├────────────→ packages/queue
           ├────────────→ packages/template-engine
           ├────────────→ packages/certificate-renderer
           └────────────→ packages/storage
```

Shared packages never import from `apps/*`. `packages/contracts` must remain browser-safe and cannot import database, Redis, bcrypt, queue, storage or signing-key code. Circular workspace dependencies are forbidden.

## TypeScript conventions

- Enable strict TypeScript checks across every workspace.
- Use explicit package exports and avoid deep imports into another package's `src/` directory.
- Use `camelCase` for variables/functions and `PascalCase` for types, classes, React components and Zod schema constants such as `CreateProjectRequestSchema`.
- Use `UPPER_SNAKE_CASE` for environment-variable names and stable enum/error-code values.
- Avoid `any`; boundary data begins as `unknown` and is validated before use.
- Infer wire types from canonical Zod schemas instead of maintaining duplicate interfaces.

## File and directory naming

- Directories and ordinary TypeScript files use `kebab-case`.
- React component files use `kebab-case.tsx` and export `PascalCase` components.
- Next.js reserved files keep framework names such as `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx` and `not-found.tsx`.
- Tests use `*.test.ts`/`*.test.tsx`; Playwright tests use `*.spec.ts`.
- Avoid generic dumping grounds such as `utils.ts`, `helpers.ts` or `common/`; names describe the bounded purpose.
- Each workspace package name uses `@certificate-platform/<kebab-name>`.

## API naming

- Paths follow `docs/10-api-contract.md`; plural resources and existing canonical action suffixes must not drift.
- Path parameter names use `camelCase`, matching the canonical contract examples.
- JSON wire fields use `snake_case`.
- Internal TypeScript values use `camelCase`; explicit serializers map between internal and wire names.
- Error codes and lifecycle values use `UPPER_SNAKE_CASE`.
- Public response schemas and admin response schemas are separate; internal models are never serialized directly.

## Database naming

- PostgreSQL tables use plural `snake_case`.
- Columns use `snake_case`.
- Primary keys are `id`; foreign keys are `<singular_resource>_id`.
- Time columns end in `_at`; byte counts end in `_bytes`; SHA-256 columns end in `_sha256`.
- Constraint/index names use `<table>_<columns>_<kind>` where practical, with kinds such as `pk`, `fk`, `uq`, `idx` and `chk`.
- PostgreSQL enum values remain `UPPER_SNAKE_CASE`.
- node-pg-migrate filenames use `<timestamp>_<kebab-description>.ts` and are never edited after application to a shared environment.

## Fastify naming and boundaries

- Route registration files are named for the resource/operation, not a generic controller bucket.
- Fastify plugins encapsulate infrastructure wiring; they do not contain domain policy.
- Route handlers validate input, resolve authenticated context, call one application use case and map the result to the wire contract.
- Domain and persistence errors are translated to allowlisted API errors at the boundary.
- `app.ts` builds the Fastify instance for tests; `server.ts` owns process startup and signal handling.

## Queue naming

- Queue names use stable versioned kebab-case, for example `participant-import:v1` and `certificate-generation:v1`.
- Job names use stable kebab-case operation names.
- Payloads have Zod schemas and an explicit integer version.
- Payloads contain internal UUIDs and minimum operational data, never complete verification tokens, passwords, secrets or unnecessary PII.

## Environment naming

- Server-only variables use descriptive `UPPER_SNAKE_CASE` names.
- Only intentionally public, non-secret browser configuration may use Next.js `NEXT_PUBLIC_` variables.
- Secrets never receive a `NEXT_PUBLIC_` prefix.
- `.env.example` documents names and safe placeholders only; real values are never committed.
- Local, test, staging and production use separate PostgreSQL databases, Redis namespaces, buckets and signing/session secrets.

## Test naming and placement

- Unit tests are colocated with the module or placed in the owning workspace `tests/` directory.
- API/database integration tests live under the owning server workspace `tests/integration/`.
- Playwright E2E tests live in root `tests/e2e/`.
- Security abuse tests that cross application boundaries live in root `tests/security/`.
- Test fixtures use synthetic names and identifiers and never copy production PII.
