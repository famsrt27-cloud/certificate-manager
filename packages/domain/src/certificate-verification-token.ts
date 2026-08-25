import { createHmac } from "node:crypto";

const base64Url = (value: Uint8Array | string): string => Buffer.from(value).toString("base64url");

export interface CertificateVerificationTokenInput {
  readonly keyId: string;
  readonly key: Uint8Array;
  readonly publicIdentifier: string;
  readonly issuedAt: Date;
}

export const createCertificateVerificationToken = (input: CertificateVerificationTokenInput): string => {
  if (!/^[a-z0-9]{32}$/.test(input.publicIdentifier)) throw new Error("certificate public identifier is invalid");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.keyId) || input.key.byteLength < 32) throw new Error("verification key is invalid");
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
