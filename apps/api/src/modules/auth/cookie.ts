export const ADMIN_SESSION_COOKIE_NAME = "__Host-admin_session";
export const ADMIN_MFA_COOKIE_NAME = "__Host-admin_mfa";

const readOpaqueCookie = (cookieHeader: string | undefined, cookieName: string): string | undefined => {
  if (cookieHeader === undefined) return undefined;
  const values = cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) return [];
    try {
      return [decodeURIComponent(part.slice(separator + 1).trim())];
    } catch {
      return [];
    }
  });
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0] ?? "") ? values[0] : undefined;
};

export const readAdminSessionCookie = (cookieHeader: string | undefined): string | undefined =>
  readOpaqueCookie(cookieHeader, ADMIN_SESSION_COOKIE_NAME);

export const readAdminMfaCookie = (cookieHeader: string | undefined): string | undefined =>
  readOpaqueCookie(cookieHeader, ADMIN_MFA_COOKIE_NAME);

export const createAdminSessionCookie = (sessionId: string, maxAgeSeconds: number): string =>
  `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;

export const expireAdminSessionCookie = (): string =>
  `${ADMIN_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

export const createAdminMfaCookie = (challengeId: string): string =>
  `${ADMIN_MFA_COOKIE_NAME}=${encodeURIComponent(challengeId)}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`;

export const expireAdminMfaCookie = (): string =>
  `${ADMIN_MFA_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
