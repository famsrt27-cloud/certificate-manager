import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@certificate-platform/auth": fromRoot("./packages/auth/src/index.ts"),
      "@certificate-platform/config": fromRoot("./packages/config/src/index.ts"),
      "@certificate-platform/contracts": fromRoot("./packages/contracts/src/index.ts"),
      "@certificate-platform/database": fromRoot("./packages/database/src/index.ts"),
      "@certificate-platform/domain": fromRoot("./packages/domain/src/index.ts"),
      "@certificate-platform/queue": fromRoot("./packages/queue/src/index.ts"),
      "@certificate-platform/storage": fromRoot("./packages/storage/src/index.ts"),
      "@certificate-platform/template-engine": fromRoot("./packages/template-engine/src/index.ts")
    }
  },
  test: {
    environment: "node",
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tests/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true
  }
});
