# 27 — Local Development Administrator Bootstrap

## Scope and safety

`pnpm dev:bootstrap-admin` is a local operator CLI. It is not an HTTP endpoint and is never exposed to a browser. It:

- requires `NODE_ENV=development` exactly;
- accepts only an explicit PostgreSQL URL whose host is `localhost`, `127.0.0.1`, or `::1`;
- uses the canonical email validation and bcrypt password policy, including the configured `BCRYPT_COST`;
- creates or reconciles one organization, user, active membership, and organization-scoped `ORG_ADMIN` assignment in one transaction;
- never creates `SUPER_ADMIN`, deletes other role assignments, or stores a plaintext password;
- leaves an existing user's password unchanged unless `--reset-password` is supplied explicitly.

Do not add bootstrap credentials to `.env`, migrations, source control, screenshots, tickets, or logs.

## First local run

From the repository root:

```powershell
docker compose up -d postgres redis minio
docker compose ps
pnpm db:migrate
pnpm dev:bootstrap-admin
pnpm dev
```

The bootstrap command prompts for:

1. Admin email
2. Admin password (input is masked and is never printed)
3. Organization name

The password must follow the existing provisioning policy: 12 or more characters and no more than 72 UTF-8 bytes. After startup, open `http://localhost:3000/admin/login` and sign in with the email/password supplied to the command.

If an existing local user intentionally needs a new password, run:

```powershell
pnpm dev:bootstrap-admin --reset-password
```

For a non-interactive one-time invocation, the command accepts `DEV_BOOTSTRAP_ADMIN_EMAIL`, `DEV_BOOTSTRAP_ADMIN_PASSWORD`, and `DEV_BOOTSTRAP_ORGANIZATION_NAME` from the current process environment. Remove those process variables immediately afterward. Do not save them to `.env`.

## Inspect the local PostgreSQL database

DBeaver or pgAdmin can connect using the Compose development defaults:

| Field | Local development default |
|---|---|
| Host | `localhost` |
| Port | `5432` |
| Database | `certificate_platform` |
| Username | `certificate_app` |
| Password | `local-postgres-change-me` |

These are **LOCAL DEVELOPMENT DEFAULTS only**. If `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, or `POSTGRES_PASSWORD` is overridden in `.env` or the current environment, use the overridden value. Do not reuse these defaults outside local development.

The existing PostgreSQL container also provides a CLI alternative without adding pgAdmin or Adminer to Compose:

```powershell
docker compose exec postgres psql -U certificate_app -d certificate_platform
```

Inside `psql`, `\dt` lists tables and `\q` exits. Avoid manual mutations; use the bootstrap command and migrations for repeatable setup.
