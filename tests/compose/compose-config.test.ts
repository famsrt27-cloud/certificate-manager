import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type RenderedService = {
  environment?: Record<string, string>;
};

type RenderedCompose = {
  services: Record<string, RenderedService>;
};

const composeSource = readFileSync(join(process.cwd(), "compose.yaml"), "utf8");
const interpolationVariables = new Set(
  Array.from(composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g), (match) => match[1])
);

let temporaryDirectory: string;
let emptyEnvironmentFile: string;

beforeAll(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "certificate-platform-compose-"));
  emptyEnvironmentFile = join(temporaryDirectory, "empty.env");
  writeFileSync(emptyEnvironmentFile, "", "utf8");
});

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function renderCompose(overrides: Readonly<Record<string, string>> = {}): RenderedCompose {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (interpolationVariables.has(key.toUpperCase()) || key.toUpperCase().startsWith("COMPOSE_")) {
      delete environment[key];
    }
  }
  Object.assign(environment, overrides);

  const command = process.platform === "win32" ? "docker.exe" : "docker";
  const result = spawnSync(command, [
    "compose",
    "--env-file",
    emptyEnvironmentFile,
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
    throw new Error(`docker compose config failed (${String(result.status)}): ${result.stderr}`);
  }

  return JSON.parse(result.stdout) as RenderedCompose;
}

function expectServerEnvironment(
  rendered: RenderedCompose,
  expected: Readonly<Record<string, string>>
): void {
  for (const serviceName of ["api", "worker", "migrate"]) {
    expect(rendered.services[serviceName]?.environment, serviceName).toMatchObject(expected);
  }
}

describe("Compose deployment environment interpolation", () => {
  it("preserves development defaults with isolated host inputs", () => {
    const rendered = renderCompose();

    expectServerEnvironment(rendered, {
      NODE_ENV: "development",
      OBJECT_STORAGE_CREATE_BUCKET: "true"
    });
  });

  it("propagates the production NODE_ENV override", () => {
    const rendered = renderCompose({ NODE_ENV: "production" });

    expectServerEnvironment(rendered, { NODE_ENV: "production" });
  });

  it("preserves an externally disabled bucket-creation setting", () => {
    const rendered = renderCompose({ OBJECT_STORAGE_CREATE_BUCKET: "false" });

    expectServerEnvironment(rendered, { OBJECT_STORAGE_CREATE_BUCKET: "false" });
  });

  it("propagates the combined production and bucket-creation overrides", () => {
    const rendered = renderCompose({
      NODE_ENV: "production",
      OBJECT_STORAGE_CREATE_BUCKET: "false"
    });

    expectServerEnvironment(rendered, {
      NODE_ENV: "production",
      OBJECT_STORAGE_CREATE_BUCKET: "false"
    });
  });
});
