import { z } from "zod";

const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
const NodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const PortSchema = z.coerce.number().int().min(1).max(65_535);

const PostgresUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
      context.addIssue({ code: "custom", message: "must use the postgres or postgresql protocol" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid PostgreSQL URL" });
  }
});

const RedisUrlSchema = z.string().superRefine((value, context) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      context.addIssue({ code: "custom", message: "must use the redis or rediss protocol" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be a valid Redis URL" });
  }
});

const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, { message: "must use the http or https protocol" });

const EnvironmentBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const VerificationSigningKeysSchema = z.string().transform((value, context): Readonly<Record<string, Uint8Array>> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be a JSON object of verification signing keys" });
    return z.NEVER;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    context.addIssue({ code: "custom", message: "must be a JSON object of verification signing keys" });
    return z.NEVER;
  }
  const keys: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId) || typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      context.addIssue({ code: "custom", message: "contains an invalid verification signing key" });
      return z.NEVER;
    }
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.byteLength < 32 || bytes.byteLength > 128 || bytes.toString("base64url") !== encoded) {
      context.addIssue({ code: "custom", message: "contains an invalid verification signing key" });
      return z.NEVER;
    }
    keys[keyId] = new Uint8Array(bytes);
  }
  if (Object.keys(keys).length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one verification signing key" });
    return z.NEVER;
  }
  return Object.freeze(keys);
});

const ObjectStorageEnvironmentSchema = z.object({
  OBJECT_STORAGE_ENDPOINT: HttpUrlSchema,
  OBJECT_STORAGE_REGION: z.string().min(1).default("us-east-1"),
  OBJECT_STORAGE_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(3),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(8),
  OBJECT_STORAGE_FORCE_PATH_STYLE: EnvironmentBooleanSchema.default(true),
  OBJECT_STORAGE_CREATE_BUCKET: EnvironmentBooleanSchema.default(false),
  PARTICIPANT_IMPORT_MAX_BYTES: z.coerce.number().int().min(1_024).max(20 * 1_024 * 1_024).default(5 * 1_024 * 1_024),
  PARTICIPANT_IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(50_000).default(10_000),
  PARTICIPANT_IMPORT_MAX_UNCOMPRESSED_BYTES: z.coerce.number().int().min(1_024).max(100 * 1_024 * 1_024).default(25 * 1_024 * 1_024),
  PARTICIPANT_IMPORT_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  BULLMQ_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]+$/).default("certificate-platform")
});

const InfrastructureEnvironmentSchema = z.object({
  NODE_ENV: NodeEnvironmentSchema.default("development"),
  LOG_LEVEL: LogLevelSchema.default("info"),
  DATABASE_URL: PostgresUrlSchema,
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: RedisUrlSchema,
  READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000)
});

const AllowedOriginsSchema = z.string().min(1).default("http://localhost:3000").transform((value, context) => {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) {
    context.addIssue({ code: "custom", message: "must contain at least one origin" });
    return z.NEVER;
  }
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
        context.addIssue({ code: "custom", message: "must contain absolute HTTP origins without paths" });
        return z.NEVER;
      }
    } catch {
      context.addIssue({ code: "custom", message: "must contain valid origins" });
      return z.NEVER;
    }
  }
  return origins;
});

export const ApiEnvironmentSchema = InfrastructureEnvironmentSchema.extend({
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: PortSchema.default(3_001),
  ADMIN_ALLOWED_ORIGINS: AllowedOriginsSchema,
  SESSION_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
    message: "must contain at least 32 UTF-8 bytes"
  }),
  SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().min(300).max(3_600).default(1_800),
  SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(1_800).max(86_400).default(28_800),
  BCRYPT_COST: z.coerce.number().int().min(12).max(15).default(12),
  LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  LOGIN_RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().min(1).max(20).default(5),
  LOGIN_RATE_LIMIT_NETWORK_MAX: z.coerce.number().int().min(1).max(100).default(20),
  TEMPLATE_ASSET_MAX_BYTES: z.coerce.number().int().min(1_024).max(10 * 1_024 * 1_024).default(5 * 1_024 * 1_024),
  VERIFICATION_ACTIVE_KID: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).default("development-key"),
  ADMIN_MFA_POLICY: z.literal("DEFERRED_NON_PRODUCTION").default("DEFERRED_NON_PRODUCTION"),
  ...ObjectStorageEnvironmentSchema.shape
}).superRefine((environment, context) => {
  if (environment.SESSION_ABSOLUTE_TTL_SECONDS < environment.SESSION_IDLE_TTL_SECONDS) {
    context.addIssue({
      code: "custom",
      path: ["SESSION_ABSOLUTE_TTL_SECONDS"],
      message: "must be greater than or equal to the idle TTL"
    });
  }
  if (environment.NODE_ENV === "production") {
    for (const origin of environment.ADMIN_ALLOWED_ORIGINS) {
      if (!origin.startsWith("https://")) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_ALLOWED_ORIGINS"],
          message: "must use HTTPS in production"
        });
      }
    }
    context.addIssue({
      code: "custom",
      path: ["ADMIN_MFA_POLICY"],
      message: "production admin authentication requires an approved MFA contract and implementation"
    });
  }
});

export const WorkerEnvironmentSchema = InfrastructureEnvironmentSchema.extend({
  WORKER_HOST: z.string().min(1).default("0.0.0.0"),
  WORKER_HEALTH_PORT: PortSchema.default(3_002),
  PARTICIPANT_IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  CERTIFICATE_GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(2),
  CERTIFICATE_RENDER_MAX_ASSET_BYTES: z.coerce.number().int().min(1_024).max(50 * 1_024 * 1_024).default(10 * 1_024 * 1_024),
  CERTIFICATE_PDF_MAX_BYTES: z.coerce.number().int().min(1_024).max(50 * 1_024 * 1_024).default(10 * 1_024 * 1_024),
  VERIFICATION_PUBLIC_BASE_URL: HttpUrlSchema,
  VERIFICATION_SIGNING_KEYS_JSON: VerificationSigningKeysSchema,
  ...ObjectStorageEnvironmentSchema.shape
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.VERIFICATION_PUBLIC_BASE_URL.startsWith("https://")) {
    context.addIssue({ code: "custom", path: ["VERIFICATION_PUBLIC_BASE_URL"], message: "must use HTTPS in production" });
  }
});

export const WebPublicEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_BASE_PATH: z.string().min(1).default("/api")
});

export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>;
export type WorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema>;
export type WebPublicEnvironment = z.infer<typeof WebPublicEnvironmentSchema>;

export interface SafeEnvironmentIssue {
  readonly path: string;
  readonly message: string;
}

export class EnvironmentValidationError extends Error {
  readonly issues: readonly SafeEnvironmentIssue[];

  constructor(issues: readonly SafeEnvironmentIssue[]) {
    super("Environment validation failed");
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

const parseEnvironment = <Schema extends z.ZodType>(
  schema: Schema,
  input: NodeJS.ProcessEnv
): z.infer<Schema> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    );
  }

  return result.data;
};

export const loadApiEnvironment = (input: NodeJS.ProcessEnv = process.env): ApiEnvironment =>
  parseEnvironment(ApiEnvironmentSchema, input);

export const loadWorkerEnvironment = (
  input: NodeJS.ProcessEnv = process.env
): WorkerEnvironment => parseEnvironment(WorkerEnvironmentSchema, input);

export const loadWebPublicEnvironment = (
  input: NodeJS.ProcessEnv = process.env
): WebPublicEnvironment => parseEnvironment(WebPublicEnvironmentSchema, input);
