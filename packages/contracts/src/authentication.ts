import { z } from "zod";

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
};

export const OrganizationRoleCodeSchema = z.enum([
  "ORG_ADMIN",
  "CERTIFICATE_MANAGER",
  "TEMPLATE_MANAGER",
  "VIEWER"
]);

export const LoginRequestSchema = z.object({
  email: z.email().max(320).transform((value) => value.trim().toLowerCase()),
  password: z.string().min(1).refine((value) => utf8ByteLength(value) <= 72)
}).strict();

export const MfaCodeRequestSchema = z.object({
  code: z.string().trim().refine((value) => /^\d{6}$/.test(value) || /^[A-Za-z0-9_-]{24}$/.test(value))
}).strict();

export const AuthenticatedUserSchema = z.object({
  id: z.uuid(),
  email: z.email()
});

export const AuthenticatedMembershipSchema = z.object({
  id: z.uuid(),
  organization: z.object({
    id: z.uuid(),
    name: z.string().min(1)
  }),
  roles: z.array(OrganizationRoleCodeSchema),
  permissions: z.array(z.string().regex(/^[a-z]+(?::[a-z]+)+$/))
});

export const AuthenticationDataSchema = z.object({
  user: AuthenticatedUserSchema,
  memberships: z.array(AuthenticatedMembershipSchema),
  csrf_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});

export const AuthenticationResponseSchema = z.object({
  data: AuthenticationDataSchema,
  meta: z.object({ request_id: z.uuid() })
});

export const MfaPendingDataSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("MFA_REQUIRED") }),
  z.object({ status: z.literal("MFA_ENROLLMENT_REQUIRED"), provisioning_uri: z.string().startsWith("otpauth://totp/") })
]);

export const LoginResponseSchema = z.object({
  data: z.union([AuthenticationDataSchema, MfaPendingDataSchema]),
  meta: z.object({ request_id: z.uuid() })
});

export const MfaCompletionResponseSchema = z.object({
  data: AuthenticationDataSchema.extend({ recovery_codes: z.array(z.string().regex(/^[A-Za-z0-9_-]{24}$/)).length(10).optional() }),
  meta: z.object({ request_id: z.uuid() })
});

export const LogoutResponseSchema = z.object({
  data: z.object({ logged_out: z.literal(true) }),
  meta: z.object({ request_id: z.uuid() })
});

export type AuthenticationData = z.infer<typeof AuthenticationDataSchema>;
export type AuthenticationResponse = z.infer<typeof AuthenticationResponseSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type MfaCodeRequest = z.infer<typeof MfaCodeRequestSchema>;
export type MfaCompletionResponse = z.infer<typeof MfaCompletionResponseSchema>;
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;
