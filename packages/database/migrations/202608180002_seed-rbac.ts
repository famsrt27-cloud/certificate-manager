import type { MigrationBuilder } from "node-pg-migrate";

const PERMISSIONS = [
  "organization:read", "organization:update",
  "user:read", "user:create", "user:update", "user:disable", "role:assign", "role:revoke",
  "project:create", "project:read", "project:update", "project:archive",
  "training:create", "training:read", "training:update", "training:archive",
  "participant:import", "participant:read", "participant:update",
  "template:create", "template:read", "template:update", "template:asset:create", "template:publish",
  "certificate:read", "certificate:generate", "certificate:revoke", "certificate:download",
  "job:read", "job:retry", "audit:read", "security:read"
] as const;

const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  SUPER_ADMIN: PERMISSIONS,
  ORG_ADMIN: PERMISSIONS,
  CERTIFICATE_MANAGER: [
    "organization:read",
    "project:create", "project:read", "project:update", "project:archive",
    "training:create", "training:read", "training:update", "training:archive",
    "participant:import", "participant:read", "participant:update",
    "template:read",
    "certificate:read", "certificate:generate", "certificate:revoke", "certificate:download",
    "job:read", "job:retry"
  ],
  TEMPLATE_MANAGER: [
    "organization:read", "project:read", "training:read",
    "template:create", "template:read", "template:update", "template:asset:create", "template:publish"
  ],
  VIEWER: [
    "organization:read", "user:read", "project:read", "training:read", "participant:read",
    "template:read", "certificate:read", "certificate:download", "job:read"
  ]
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    INSERT INTO roles (code, scope, description) VALUES
      ('SUPER_ADMIN', 'SYSTEM', 'System-scoped administration'),
      ('ORG_ADMIN', 'ORGANIZATION', 'Organization-scoped administration'),
      ('CERTIFICATE_MANAGER', 'ORGANIZATION', 'Certificate operations within an organization'),
      ('TEMPLATE_MANAGER', 'ORGANIZATION', 'Template operations within an organization'),
      ('VIEWER', 'ORGANIZATION', 'Read-only organization access');

    INSERT INTO permissions (code, description) VALUES
      ${PERMISSIONS.map((permission) => `(${sqlString(permission)}, ${sqlString(permission)})`).join(",\n      ")};

    INSERT INTO role_permissions (role, permission_code) VALUES
      ${Object.entries(ROLE_PERMISSIONS).flatMap(([role, permissions]) =>
        permissions.map((permission) => `(${sqlString(role)}, ${sqlString(permission)})`)
      ).join(",\n      ")};
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    DELETE FROM role_permissions WHERE role IN ('SUPER_ADMIN','ORG_ADMIN','CERTIFICATE_MANAGER','TEMPLATE_MANAGER','VIEWER');
    DELETE FROM permissions WHERE code IN (${PERMISSIONS.map(sqlString).join(",")});
    DELETE FROM roles WHERE code IN ('SUPER_ADMIN','ORG_ADMIN','CERTIFICATE_MANAGER','TEMPLATE_MANAGER','VIEWER');
  `);
};
