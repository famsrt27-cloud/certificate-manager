export interface StructuredLoggerOptions {
  level: string;
  base: null;
  redact: {
    paths: string[];
    censor: string;
  };
  serializers: {
    err: (error: unknown) => { type: string; message: string; stack: string };
  };
}

const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const serializeErrorForLogging = (error: unknown): { type: string; message: string; stack: string } => {
  if (!(error instanceof Error)) return { type: "UnknownError", message: "[REDACTED]", stack: "[REDACTED]" };
  const type = error.constructor.name;
  return { type: SAFE_ERROR_TYPE.test(type) ? type : "Error", message: "[REDACTED]", stack: "[REDACTED]" };
};

const SENSITIVE_LOG_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-csrf-token",
  "req.body.password",
  "req.body.csrf_token",
  "req.body.session_id",
  "req.body.token",
  "req.body.download_token",
  "req.body.jti",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.x-csrf-token",
  "request.body.password",
  "request.body.token",
  "request.body.download_token",
  "request.body.jti",
  "password",
  "password_hash",
  "token",
  "download_token",
  "downloadToken",
  "verificationToken",
  "verification_token",
  "jti",
  "rawJti",
  "signingKey",
  "signing_key",
  "verificationSigningKey",
  "verification_signing_key",
  "hmacKey",
  "hmac_key",
  "csrf_token",
  "session_id",
  "sessionId",
  "csrfToken",
  "storageKey",
  "storage_key"
];

export const createStructuredLoggerOptions = (level: string): StructuredLoggerOptions => ({
  level,
  base: null,
  redact: {
    paths: [...SENSITIVE_LOG_PATHS],
    censor: "[REDACTED]"
  },
  serializers: { err: serializeErrorForLogging }
});
