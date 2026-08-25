import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const CERTIFICATE_DOWNLOAD_TOKEN_MAX_BYTES = 2_048;
export const CERTIFICATE_DOWNLOAD_TOKEN_MAX_TTL_SECONDS = 60;

const PUBLIC_IDENTIFIER_PATTERN = /^[a-f0-9]{32}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_TIMESTAMP_SECONDS = 8_640_000_000_000;
const UNKNOWN_KEY = new Uint8Array(32);

const base64Url = (value: Uint8Array | string): string => Buffer.from(value).toString("base64url");

export interface CertificateDownloadTokenInput {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly publicIdentifier: string;
  readonly issuedAt: Date;
  readonly ttlSeconds: number;
  readonly tokenId?: string;
}

export interface VerifiedCertificateDownloadToken {
  readonly publicIdentifier: string;
  readonly issuedAtSeconds: number;
  readonly expiresAtSeconds: number;
  readonly tokenId: string;
}

export class InvalidCertificateDownloadTokenError extends Error {
  constructor() {
    super("Certificate download token is invalid");
    this.name = "InvalidCertificateDownloadTokenError";
  }
}

const invalidToken = (): never => {
  throw new InvalidCertificateDownloadTokenError();
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

export const createCertificateDownloadToken = (input: CertificateDownloadTokenInput): string => {
  if (!PUBLIC_IDENTIFIER_PATTERN.test(input.publicIdentifier)) throw new Error("certificate public identifier is invalid");
  if (!KEY_ID_PATTERN.test(input.keyId) || input.key.byteLength < 32 || input.key.byteLength > 128) {
    throw new Error("download signing key is invalid");
  }
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1
    || input.ttlSeconds > CERTIFICATE_DOWNLOAD_TOKEN_MAX_TTL_SECONDS) throw new Error("download token TTL is invalid");
  const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1_000);
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 0 || issuedAtSeconds > MAX_TIMESTAMP_SECONDS) {
    throw new Error("download token issue time is invalid");
  }
  const expiresAtSeconds = issuedAtSeconds + input.ttlSeconds;
  if (!Number.isSafeInteger(expiresAtSeconds) || expiresAtSeconds > MAX_TIMESTAMP_SECONDS) {
    throw new Error("download token expiry is invalid");
  }
  const tokenId = input.tokenId ?? randomBytes(16).toString("base64url");
  const tokenIdBytes = Buffer.from(tokenId, "base64url");
  if (!TOKEN_ID_PATTERN.test(tokenId) || tokenIdBytes.byteLength !== 16
    || tokenIdBytes.toString("base64url") !== tokenId) throw new Error("download token ID is invalid");
  const header = base64Url(JSON.stringify({ alg: "HS256", kid: input.keyId, typ: "CDT" }));
  const payload = base64Url(JSON.stringify({ v: 1, typ: "certificate-download", aud: "public-certificate-download",
    pcid: input.publicIdentifier, iat: issuedAtSeconds, exp: expiresAtSeconds, jti: tokenId }));
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac("sha256", input.key).update(signed).digest("base64url")}`;
};

export const verifyCertificateDownloadToken = (
  token: string,
  verificationKeys: ReadonlyMap<string, Uint8Array>,
  maximumBytes = CERTIFICATE_DOWNLOAD_TOKEN_MAX_BYTES
): VerifiedCertificateDownloadToken => {
  if (maximumBytes < 1 || Buffer.byteLength(token, "utf8") > maximumBytes) return invalidToken();
  const segments = token.split(".");
  if (segments.length !== 3) return invalidToken();
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (headerSegment === undefined || payloadSegment === undefined || signatureSegment === undefined) return invalidToken();
  const header = parseStrictObject(headerSegment, ["alg", "kid", "typ"]);
  if (header.alg !== "HS256" || header.typ !== "CDT" || typeof header.kid !== "string"
    || !KEY_ID_PATTERN.test(header.kid)) return invalidToken();
  const payload = parseStrictObject(payloadSegment, ["v", "typ", "aud", "pcid", "iat", "exp", "jti"]);
  if (payload.v !== 1 || payload.typ !== "certificate-download" || payload.aud !== "public-certificate-download"
    || typeof payload.pcid !== "string" || payload.pcid.length > 128 || typeof payload.jti !== "string"
    || !TOKEN_ID_PATTERN.test(payload.jti) || Buffer.from(payload.jti, "base64url").toString("base64url") !== payload.jti
    || Buffer.from(payload.jti, "base64url").byteLength !== 16 || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)) {
    return invalidToken();
  }
  const issuedAtSeconds = payload.iat as number;
  const expiresAtSeconds = payload.exp as number;
  if (issuedAtSeconds < 0 || issuedAtSeconds > MAX_TIMESTAMP_SECONDS || expiresAtSeconds <= issuedAtSeconds
    || expiresAtSeconds > MAX_TIMESTAMP_SECONDS
    || expiresAtSeconds - issuedAtSeconds > CERTIFICATE_DOWNLOAD_TOKEN_MAX_TTL_SECONDS) return invalidToken();
  const key = verificationKeys.get(header.kid);
  const signed = `${headerSegment}.${payloadSegment}`;
  const expectedSignature = createHmac("sha256", key ?? UNKNOWN_KEY).update(signed).digest();
  if (!BASE64URL_PATTERN.test(signatureSegment)) return invalidToken();
  const providedSignature = Buffer.from(signatureSegment, "base64url");
  const signatureMatches = providedSignature.toString("base64url") === signatureSegment
    && providedSignature.byteLength === expectedSignature.byteLength
    && timingSafeEqual(providedSignature, expectedSignature);
  if (key === undefined || !signatureMatches || !PUBLIC_IDENTIFIER_PATTERN.test(payload.pcid)) return invalidToken();
  return { publicIdentifier: payload.pcid, issuedAtSeconds, expiresAtSeconds, tokenId: payload.jti };
};
