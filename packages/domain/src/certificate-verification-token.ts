import { createHmac, timingSafeEqual } from "node:crypto";

export const CERTIFICATE_VERIFICATION_TOKEN_MAX_BYTES = 2_048;

const PUBLIC_IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000;
const UNKNOWN_KEY = new Uint8Array(32);

const base64Url = (value: Uint8Array | string): string => Buffer.from(value).toString("base64url");

export interface CertificateVerificationTokenInput {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly publicIdentifier: string;
  readonly issuedAt: Date;
}

export interface VerifiedCertificateVerificationToken {
  readonly publicIdentifier: string;
  readonly issuedAtSeconds: number;
}

export class InvalidCertificateVerificationTokenError extends Error {
  constructor() {
    super("Certificate verification token is invalid");
    this.name = "InvalidCertificateVerificationTokenError";
  }
}

const invalidToken = (): never => {
  throw new InvalidCertificateVerificationTokenError();
};

const decodeSegment = (segment: string): string => {
  if (!BASE64URL_PATTERN.test(segment)) return invalidToken();
  const decoded = Buffer.from(segment, "base64url");
  if (decoded.toString("base64url") !== segment) return invalidToken();
  return decoded.toString("utf8");
};

const parseStrictObject = (segment: string, fields: readonly string[]): Record<string, unknown> => {
  let parsed: unknown;
  const json = decodeSegment(segment);
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalidToken();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return invalidToken();
  const object = parsed as Record<string, unknown>;
  const keys = Object.keys(object);
  const propertyCount = json.match(/"(?:\\.|[^"\\])*"\s*:/g)?.length ?? 0;
  if (propertyCount !== keys.length || keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
    return invalidToken();
  }
  return object;
};

export const verifyCertificateVerificationToken = (
  token: string,
  verificationKeys: ReadonlyMap<string, Uint8Array>,
  maximumBytes = CERTIFICATE_VERIFICATION_TOKEN_MAX_BYTES
): VerifiedCertificateVerificationToken => {
  if (maximumBytes < 1 || Buffer.byteLength(token, "utf8") > maximumBytes) return invalidToken();
  const segments = token.split(".");
  if (segments.length !== 3) return invalidToken();
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) return invalidToken();

  const header = parseStrictObject(headerSegment, ["alg", "kid", "typ"]);
  if (header.alg !== "HS256" || header.typ !== "CVT" || typeof header.kid !== "string" || !KEY_ID_PATTERN.test(header.kid)) {
    return invalidToken();
  }
  const payload = parseStrictObject(payloadSegment, ["v", "typ", "pcid", "iat"]);
  if (payload.v !== 1 || payload.typ !== "certificate-verification" || typeof payload.pcid !== "string"
    || payload.pcid.length > 128 || !Number.isSafeInteger(payload.iat) || (payload.iat as number) < 0
    || (payload.iat as number) > MAX_TIMESTAMP_SECONDS) {
    return invalidToken();
  }

  const key = verificationKeys.get(header.kid);
  const signed = `${headerSegment}.${payloadSegment}`;
  const expectedSignature = createHmac("sha256", key ?? UNKNOWN_KEY).update(signed).digest();
  let providedSignature: Buffer;
  try {
    if (!BASE64URL_PATTERN.test(signatureSegment)) return invalidToken();
    providedSignature = Buffer.from(signatureSegment, "base64url");
    if (providedSignature.toString("base64url") !== signatureSegment) return invalidToken();
  } catch {
    return invalidToken();
  }
  const signatureMatches = providedSignature.byteLength === expectedSignature.byteLength
    && timingSafeEqual(providedSignature, expectedSignature);
  if (key === undefined || !signatureMatches || !PUBLIC_IDENTIFIER_PATTERN.test(payload.pcid)) return invalidToken();
  return { publicIdentifier: payload.pcid, issuedAtSeconds: payload.iat as number };
};

export const createCertificateVerificationToken = (input: CertificateVerificationTokenInput): string => {
  if (!PUBLIC_IDENTIFIER_PATTERN.test(input.publicIdentifier)) throw new Error("certificate public identifier is invalid");
  if (!KEY_ID_PATTERN.test(input.keyId) || input.key.byteLength < 32) throw new Error("verification key is invalid");
  const iat = Math.floor(input.issuedAt.getTime() / 1_000);
  if (!Number.isSafeInteger(iat)) throw new Error("certificate issue time is invalid");
  const header = base64Url(JSON.stringify({ alg: "HS256", kid: input.keyId, typ: "CVT" }));
  const payload = base64Url(JSON.stringify({ v: 1, typ: "certificate-verification", pcid: input.publicIdentifier, iat }));
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac("sha256", input.key).update(signed).digest("base64url")}`;
};

export const createCertificateVerificationUrl = (baseUrl: string, token: string): string => {
  const parsed = new URL(baseUrl);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.search || parsed.hash) {
    throw new Error("verification base URL is invalid");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/verify`;
  parsed.hash = `token=${token}`;
  return parsed.toString();
};
