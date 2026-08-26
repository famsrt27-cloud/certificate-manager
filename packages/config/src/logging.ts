export interface StructuredLoggerOptions {
  level: string;
  base: null;
  redact: {
    paths: string[];
    censor: string;
  };
}

const SENSITIVE_LOG_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-csrf-token",
  "req.body.password",
  "req.body.csrf_token",
  "req.body.session_id",
  "req.body.token",
  "req.body.download_token",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.x-csrf-token",
  "password",
  "password_hash",
  "token",
  "download_token",
  "downloadToken",
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
  }
});
