import { z } from "zod";

import { RequestMetaSchema } from "./foundation.js";

export const PublicVerificationRequestSchema = z.object({
  token: z.string().min(1).max(2_048)
}).strict();

export const PublicVerificationValidDataSchema = z.object({
  status: z.literal("valid"),
  certificate_number: z.string().min(1).max(200),
  recipient_name: z.string().min(1).max(300),
  program_name: z.string().min(1).max(200),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).strict();

export const PublicVerificationRevokedDataSchema = z.object({
  status: z.literal("revoked"),
  certificate_number: z.string().min(1).max(200)
}).strict();

export const PublicVerificationDataSchema = z.discriminatedUnion("status", [
  PublicVerificationValidDataSchema,
  PublicVerificationRevokedDataSchema
]);

export const PublicVerificationResponseSchema = z.object({
  data: PublicVerificationDataSchema,
  meta: RequestMetaSchema
}).strict();

export const PublicDownloadAuthorizationRequestSchema = z.object({
  token: z.string().min(1).max(2_048)
}).strict();

export const PublicDownloadAuthorizationDataSchema = z.object({
  download_token: z.string().min(1).max(2_048),
  expires_in: z.number().int().min(1).max(60)
}).strict();

export const PublicDownloadAuthorizationResponseSchema = z.object({
  data: PublicDownloadAuthorizationDataSchema,
  meta: RequestMetaSchema
}).strict();

export type PublicVerificationData = z.infer<typeof PublicVerificationDataSchema>;
export type PublicVerificationRequest = z.infer<typeof PublicVerificationRequestSchema>;
export type PublicVerificationResponse = z.infer<typeof PublicVerificationResponseSchema>;
export type PublicDownloadAuthorizationData = z.infer<typeof PublicDownloadAuthorizationDataSchema>;
export type PublicDownloadAuthorizationRequest = z.infer<typeof PublicDownloadAuthorizationRequestSchema>;
export type PublicDownloadAuthorizationResponse = z.infer<typeof PublicDownloadAuthorizationResponseSchema>;
