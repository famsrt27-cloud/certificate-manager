import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const rendererRoot = join(process.cwd(), "packages", "certificate-renderer");
const srcRoot = join(rendererRoot, "src");

const collectSource = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return collectSource(path);
  if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
  return [readFileSync(path, "utf8")];
});

describe("certificate renderer dependency boundary", () => {
  it("does not import infrastructure or use ambient network/secret capabilities", () => {
    const source = collectSource(srcRoot).join("\n");
    const forbidden = [
      /@certificate-platform\/(?:database|storage|queue|auth|config)/,
      /@aws-sdk\//,
      /\bioredis\b/,
      /\bbullmq\b/,
      /(?:from\s+|import\()\s*["'](?:node:)?(?:fs(?:\/promises)?|http|https|net|tls|dns|child_process)["']/,
      /\b(?:fetch|WebSocket|EventSource)\s*\(/,
      /\bprocess\.env\b/
    ];

    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });

  it("declares only the reviewed pre-Phase-5 runtime dependencies", () => {
    const packageJson = JSON.parse(readFileSync(join(rendererRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "@certificate-platform/template-engine",
      "zod"
    ]);
  });

  it("keeps monorepo source aliases for typecheck but disables them for package emission", () => {
    const baseTsconfig = JSON.parse(readFileSync(join(process.cwd(), "tsconfig.base.json"), "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const buildTsconfig = JSON.parse(readFileSync(join(rendererRoot, "tsconfig.build.json"), "utf8")) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };

    expect(baseTsconfig.compilerOptions?.paths?.["@certificate-platform/certificate-renderer"])
      .toEqual(["packages/certificate-renderer/src/index.ts"]);
    expect(buildTsconfig.compilerOptions?.paths).toEqual({});
  });
});

