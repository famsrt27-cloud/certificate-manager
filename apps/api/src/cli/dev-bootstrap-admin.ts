import { createInterface } from "node:readline/promises";

import { hashPassword } from "@certificate-platform/auth";
import { LoginRequestSchema } from "@certificate-platform/contracts";
import {
  bootstrapDevelopmentAdmin,
  closeDatabase,
  createDatabase,
  type DevelopmentAdminBootstrapResult
} from "@certificate-platform/database";

import { loadDevelopmentAdminEnvironment } from "./development-admin-environment.js";

const EMAIL_ENVIRONMENT_KEY = "DEV_BOOTSTRAP_ADMIN_EMAIL";
const PASSWORD_ENVIRONMENT_KEY = "DEV_BOOTSTRAP_ADMIN_PASSWORD";
const ORGANIZATION_ENVIRONMENT_KEY = "DEV_BOOTSTRAP_ORGANIZATION_NAME";

const usage = `Local development administrator bootstrap

Usage:
  pnpm dev:bootstrap-admin [--reset-password]

The command prompts for missing values. Non-interactive invocation may set:
  ${EMAIL_ENVIRONMENT_KEY}
  ${PASSWORD_ENVIRONMENT_KEY}
  ${ORGANIZATION_ENVIRONMENT_KEY}

--reset-password explicitly replaces the bcrypt hash of an existing local user.`;

const readLine = async (label: string): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Interactive input is unavailable; provide ${EMAIL_ENVIRONMENT_KEY}, ${PASSWORD_ENVIRONMENT_KEY}, and ${ORGANIZATION_ENVIRONMENT_KEY}`);
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await input.question(label);
  } finally {
    input.close();
  }
};

const readHiddenPassword = async (): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error(`Interactive password input is unavailable; provide ${PASSWORD_ENVIRONMENT_KEY} for this invocation`);
  }

  return new Promise<string>((resolve, reject) => {
    let password = "";
    const wasRaw = process.stdin.isRaw;
    process.stdout.write("Admin password: ");
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error === undefined) resolve(password);
      else reject(error);
    };

    const onData = (chunk: string | Buffer): void => {
      const input = String(chunk);
      for (const character of input) {
        if (character === "\u0003") {
          finish(new Error("Bootstrap cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = [...password];
          if (characters.length > 0) {
            characters.pop();
            password = characters.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          password += character;
          process.stdout.write("•");
        }
      }
    };

    process.stdin.on("data", onData);
  });
};

const resultMessage = (result: DevelopmentAdminBootstrapResult): readonly string[] => [
  result.organization === "CREATED" ? "Organization created" : "Organization already exists",
  result.user === "CREATED" ? "Admin user created" : "Admin user already exists",
  result.password === "UPDATED"
    ? "Existing admin password updated by explicit request"
    : result.password === "UNCHANGED"
      ? "Existing admin password left unchanged"
      : "Admin password stored as a bcrypt hash",
  result.membership === "CREATED" ? "Organization membership created" : "Organization membership already exists",
  result.organizationAdminRole === "ASSIGNED" ? "ORG_ADMIN membership role assigned" : "ORG_ADMIN membership role already assigned"
];

const run = async (): Promise<void> => {
  const argumentsSet = new Set(process.argv.slice(2));
  if (argumentsSet.has("--help")) {
    console.log(usage);
    return;
  }
  const unknownArguments = [...argumentsSet].filter((argument) => argument !== "--reset-password");
  if (unknownArguments.length > 0) throw new Error(`Unknown option: ${unknownArguments.join(", ")}`);

  const environment = loadDevelopmentAdminEnvironment(process.env);
  const rawEmail = process.env[EMAIL_ENVIRONMENT_KEY] ?? await readLine("Admin email: ");
  const password = process.env[PASSWORD_ENVIRONMENT_KEY] ?? await readHiddenPassword();
  const rawOrganizationName = process.env[ORGANIZATION_ENVIRONMENT_KEY] ?? await readLine("Organization name: ");
  const loginInput = LoginRequestSchema.safeParse({ email: rawEmail, password });
  if (!loginInput.success) {
    throw new Error("Admin email or password does not satisfy the authentication input policy");
  }
  const organizationName = rawOrganizationName.trim();
  if (organizationName.length < 1 || organizationName.length > 200) {
    throw new Error("Organization name must contain between 1 and 200 characters");
  }

  const passwordHash = await hashPassword(loginInput.data.password, environment.bcryptCost);
  const database = createDatabase({ connectionString: environment.databaseUrl, maxConnections: 2 });
  try {
    const result = await bootstrapDevelopmentAdmin(database, {
      email: loginInput.data.email,
      organizationName,
      passwordHash,
      replaceExistingPassword: argumentsSet.has("--reset-password")
    });
    for (const message of resultMessage(result)) console.log(message);
    if (
      result.organization === "EXISTING"
      && result.user === "EXISTING"
      && result.membership === "EXISTING"
      && result.organizationAdminRole === "EXISTING"
      && result.password === "UNCHANGED"
    ) {
      console.log("Existing admin account detected; no destructive change performed");
    }
  } finally {
    await closeDatabase(database);
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Local admin bootstrap failed");
  process.exitCode = 1;
});
