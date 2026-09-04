import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type RenderedService = {
  readonly cap_drop?: readonly string[];
  readonly environment?: Record<string, string>;
  readonly networks?: readonly string[] | Record<string, null>;
  readonly ports?: readonly unknown[];
  readonly profiles?: readonly string[];
  readonly read_only?: boolean;
  readonly restart?: string;
  readonly security_opt?: readonly string[];
  readonly user?: string;
};

type RenderedCompose = {
  readonly networks: Record<string, { readonly internal?: boolean; readonly external?: boolean }>;
  readonly services: Record<string, RenderedService>;
};

const composeSource = readFileSync(join(process.cwd(), "compose.production.yaml"), "utf8");
const interpolationVariables = new Set(
  Array.from(composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g), (match) => match[1])
);
const nginxConfiguration = readFileSync(join(process.cwd(), "deploy", "nginx", "nginx.conf"), "utf8");

let temporaryDirectory: string;
let productionEnvironmentFile: string;

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "certificate-platform-production-compose-"));
  productionEnvironmentFile = join(temporaryDirectory, "production.env");
  const signingKey = Buffer.alloc(32, 9).toString("base64url");
  const mfaKey = Buffer.alloc(32, 7).toString("base64url");
  writeFileSync(productionEnvironmentFile, [
    "DATABASE_URL=postgresql://certificate_app:synthetic-postgres-password@postgres.production.invalid:5432/certificate_platform?sslmode=verify-full",
    "REDIS_URL=rediss://:synthetic-redis-password@redis.production.invalid:6379/0",
    "OBJECT_STORAGE_ENDPOINT=https://storage.production.invalid",
    "OBJECT_STORAGE_REGION=us-east-1",
    "OBJECT_STORAGE_BUCKET=certificate-platform-production",
    "OBJECT_STORAGE_ACCESS_KEY=synthetic-storage-access",
    "OBJECT_STORAGE_SECRET_KEY=synthetic-storage-secret",
    "BULLMQ_PREFIX=certificate-platform-production",
    "VERIFICATION_PUBLIC_BASE_URL=https://certificates.production.invalid",
    `VERIFICATION_SIGNING_KEYS_JSON={"production-key":"${signingKey}"}`,
    "VERIFICATION_ACTIVE_KID=production-key",
    "SESSION_SECRET=synthetic-production-session-secret-value",
    "ADMIN_ALLOWED_ORIGINS=https://admin.certificates.production.invalid",
    "ADMIN_MFA_POLICY=REQUIRED",
    `ADMIN_MFA_ENCRYPTION_KEY=${mfaKey}`,
    "PRODUCTION_DEPENDENCY_NETWORK=certificate-platform-production-dependencies",
    "TLS_CERTIFICATE_SECRET_NAME=certificate-platform-production-certificate",
    "TLS_PRIVATE_KEY_SECRET_NAME=certificate-platform-production-private-key"
  ].join("\n"), "utf8");
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function renderProductionCompose(): RenderedCompose {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (interpolationVariables.has(key.toUpperCase()) || key.toUpperCase().startsWith("COMPOSE_")) {
      delete environment[key];
    }
  }

  const command = process.platform === "win32" ? "docker.exe" : "docker";
  const result = spawnSync(command, [
    "compose",
    "--env-file",
    productionEnvironmentFile,
    "-f",
    "compose.production.yaml",
    "--profile",
    "tools",
    "config",
    "--format",
    "json"
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment
  });

  if (result.status !== 0) {
    throw new Error(`docker compose production config failed (${String(result.status)}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as RenderedCompose;
}

const networkNames = (service: RenderedService): readonly string[] =>
  Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {});

describe("production Compose deployment topology", () => {
  it("publishes only the TLS edge and isolates runtime services", () => {
    const rendered = renderProductionCompose();

    expect(rendered.services.proxy.ports).toHaveLength(2);
    for (const serviceName of ["web", "api", "worker", "migrate"]) {
      expect(rendered.services[serviceName]?.ports, serviceName).toBeUndefined();
      expect(rendered.services[serviceName]?.read_only, serviceName).toBe(true);
      expect(rendered.services[serviceName]?.cap_drop, serviceName).toEqual(["ALL"]);
      expect(rendered.services[serviceName]?.security_opt, serviceName).toContain("no-new-privileges:true");
      expect(rendered.services[serviceName]?.user, serviceName).toBe("10001:10001");
    }
    expect(networkNames(rendered.services.proxy)).toEqual(["application", "edge"]);
    expect(networkNames(rendered.services.web)).toEqual(["application"]);
    expect(networkNames(rendered.services.api)).toEqual(["application", "dependencies"]);
    expect(networkNames(rendered.services.worker)).toEqual(["dependencies"]);
    expect(rendered.networks.application.internal).toBe(true);
    expect(rendered.networks.dependencies.external).toBe(true);
  });

  it("requires production-safe configuration and keeps worker credentials minimal", () => {
    const rendered = renderProductionCompose();
    const apiEnvironment = rendered.services.api.environment;
    const workerEnvironment = rendered.services.worker.environment;

    expect(apiEnvironment).toMatchObject({
      NODE_ENV: "production",
      API_TRUST_PROXY_HOPS: "1",
      ADMIN_MFA_POLICY: "REQUIRED",
      OBJECT_STORAGE_CREATE_BUCKET: "false",
      BULLMQ_PREFIX: "certificate-platform-production"
    });
    expect(workerEnvironment).toMatchObject({
      NODE_ENV: "production",
      OBJECT_STORAGE_CREATE_BUCKET: "false",
      BULLMQ_PREFIX: "certificate-platform-production"
    });
    expect(workerEnvironment).not.toHaveProperty("SESSION_SECRET");
    expect(workerEnvironment).not.toHaveProperty("ADMIN_MFA_ENCRYPTION_KEY");
    expect(rendered.services.migrate.profiles).toEqual(["tools"]);
    expect(rendered.services.migrate.restart).toBe("no");
    expect(rendered.services.migrate.environment).toEqual({
      DATABASE_URL: "postgresql://certificate_app:synthetic-postgres-password@postgres.production.invalid:5432/certificate_platform?sslmode=verify-full",
      NODE_ENV: "production"
    });
  });

  it("keeps health and metrics private while forwarding a sanitized same-site request", () => {
    expect(nginxConfiguration).toContain("location ^~ /health/ { return 404; }");
    expect(nginxConfiguration).toContain("location = /metrics { return 404; }");
    expect(nginxConfiguration).toContain("location = /openapi.json { return 404; }");
    expect(nginxConfiguration).toContain("proxy_set_header X-Forwarded-Proto https;");
    expect(nginxConfiguration).toContain("proxy_set_header X-Request-ID \"\";");
    expect(nginxConfiguration).toContain("proxy_pass http://web_upstream;");
    expect(nginxConfiguration).toContain("return 308 https://$host$request_uri;");
    const productionLogFormat = nginxConfiguration.match(/log_format production_json[\s\S]*?;\r?\n/)?.[0];
    expect(productionLogFormat).toBeDefined();
    expect(productionLogFormat).not.toMatch(/\$(?:uri|request_uri|args|query_string)\b/);
  });
});
