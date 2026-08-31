export interface StructuredLoggerOptions {
  level: string;
  base: { service: string };
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
  "req.headers.x-forwarded-for",
  "req.headers.x-forwarded-host",
  "req.headers.x-forwarded-proto",
  "req.headers.x-real-ip",
  "req.headers.forwarded",
  "req.remoteAddress",
  "req.remotePort",
  "req.body.password",
  "req.body.csrf_token",
  "req.body.session_id",
  "req.body.token",
  "req.body.download_token",
  "req.body.search_result_token",
  "req.body.jti",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.x-csrf-token",
  "request.headers.x-forwarded-for",
  "request.headers.x-forwarded-host",
  "request.headers.x-forwarded-proto",
  "request.headers.x-real-ip",
  "request.headers.forwarded",
  "request.remoteAddress",
  "request.remotePort",
  "request.ip",
  "request.body.password",
  "request.body.token",
  "request.body.download_token",
  "request.body.search_result_token",
  "request.body.jti",
  "password",
  "password_hash",
  "token",
  "download_token",
  "downloadToken",
  "search_result_token",
  "searchResultToken",
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
  "storage_key",
  "networkAddress",
  "network_address"
];

export const createStructuredLoggerOptions = (level: string, service = "unknown"): StructuredLoggerOptions => ({
  level,
  base: { service },
  redact: {
    paths: [...SENSITIVE_LOG_PATHS],
    censor: "[REDACTED]"
  },
  serializers: { err: serializeErrorForLogging }
});
