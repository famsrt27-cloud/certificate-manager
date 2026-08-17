# 18 — Roles and Permissions

## Authorization model

Users are global identities. Tenant access is established through an active `organization_membership`; organization roles attach to that membership. The backend resolves effective permissions from reviewed role-permission mappings.

Frontend role names, hidden buttons, internal UUID possession and client-supplied organization identifiers are never authorization evidence.

## Role scope

### SUPER_ADMIN

System-scoped administration. Assigned only through `user_system_roles`. It cannot be assigned through an organization membership.

### ORG_ADMIN

Organization-scoped management of the organization, memberships, roles and resources.

### CERTIFICATE_MANAGER

Organization-scoped management of projects, trainings, participants, imports, certificate generation and revocation.

### TEMPLATE_MANAGER

Organization-scoped creation, editing, asset management and publishing of templates.

### VIEWER

Organization-scoped read-only access to permitted administrative data. Public verification does not use this role.

## Permission catalog

```text
organization:read
organization:update

user:read
user:create
user:update
user:disable
role:assign
role:revoke

project:create
project:read
project:update
project:archive

training:create
training:read
training:update
training:archive

participant:import
participant:read
participant:update

template:create
template:read
template:update
template:asset:create
template:publish

certificate:read
certificate:generate
certificate:revoke
certificate:download

job:read
job:retry

audit:read
security:read
```

## Database representation

- `roles` defines reviewed role codes and scope.
- `permissions` defines permission codes.
- `role_permissions` maps roles to permissions.
- `organization_memberships` connects users to organizations.
- `membership_roles` grants non-system roles within the same organization.
- `user_system_roles` grants `SUPER_ADMIN` directly to a user.

Role and permission seeds must be reviewed, deterministic and changed through a migration plus audit-capable administrative workflow where applicable.

## Seeded permission matrix

| Role | Effective organization permissions |
|---|---|
| `SUPER_ADMIN` | Full catalog, assigned only in `user_system_roles`; use still requires an explicit audited backend bypass |
| `ORG_ADMIN` | Full catalog within its organization |
| `CERTIFICATE_MANAGER` | Organization read; project/training/participant management; template read; certificate management/download; job read/retry |
| `TEMPLATE_MANAGER` | Organization/project/training read and all template permissions |
| `VIEWER` | Organization/user/project/training/participant/template/certificate/job read plus certificate download |

The exact rows are seeded by the append-only RBAC seed migration. `SUPER_ADMIN` is rejected by the membership table constraint, and tenant membership roles are resolved with their stored `organization_id` rather than from request claims.

## Backend authorization sequence

For each admin request:

1. Resolve the opaque cookie value against Redis and validate session idle/absolute expiry and authorization version.
2. For state-changing requests, validate the session-bound `X-CSRF-Token` before domain work.
3. Authenticate the active user and validate current user state; do not trust cached frontend claims.
4. Resolve the requested operation and required permission.
5. For normal tenant operations, resolve an active membership in the active organization.
6. Resolve effective membership roles and permissions server-side. A session cache may optimize this only when revocation/version checks keep it current.
7. Scope the Kysely resource query by `organization_id`; a UUID-only query is forbidden.
8. Verify referenced child resources belong to the same organization.
9. Execute the action and create a sanitized audit event when required.

`SUPER_ADMIN` bypass, where explicitly allowed, must be a reviewed backend policy branch and must still be audited. It must not be inferred from an organization role or frontend claim.

## Required negative tests

- user without a membership
- inactive user or membership
- role from organization A used against organization B
- internal UUID from another organization
- `VIEWER` attempting a state change
- `CERTIFICATE_MANAGER` attempting template publication unless separately permitted
- organization role attempting system administration
- forged frontend role/permission claims
- stale session after membership or role revocation
