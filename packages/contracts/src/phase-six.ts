import { z } from "zod";

import { RequestMetaSchema } from "./foundation.js";

const normalizePublicSearchText = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
};
const boundedSearchText = (minimumCharacters: number, maximumCharacters: number, maximumBytes: number) => z.string()
  .transform(normalizePublicSearchText)
  .pipe(z.string().min(minimumCharacters).max(maximumCharacters))
  .refine((value) => utf8ByteLength(value) <= maximumBytes,
    { message: "value exceeds UTF-8 byte limit" });

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

export const PublicCertificateDownloadRequestSchema = z.object({
  download_token: z.string().min(1).max(2_048)
}).strict();

export const PUBLIC_CERTIFICATE_SEARCH_RESULT_LIMIT = 10;
export const PUBLIC_CERTIFICATE_SUGGESTION_LIMIT = 10;

export const PublicProjectSuggestionRequestSchema = z.object({
  query: boundedSearchText(2, 100, 200)
}).strict();

export const PublicTrainingSuggestionRequestSchema = z.object({
  query: boundedSearchText(2, 100, 200),
  project_name: boundedSearchText(3, 200, 300).optional()
}).strict();

export const PublicCertificateSuggestionSchema = z.object({
  label: z.string().min(1).max(200)
}).strict();

export const PublicCertificateSuggestionResponseSchema = z.object({
  data: z.object({
    suggestions: z.array(PublicCertificateSuggestionSchema).max(PUBLIC_CERTIFICATE_SUGGESTION_LIMIT)
  }).strict(),
  meta: RequestMetaSchema
}).strict();

export const PublicCertificateSearchRequestSchema = z.object({
  certificate_number: boundedSearchText(3, 200, 256).optional(),
  recipient_name: boundedSearchText(4, 200, 300).optional(),
  project_name: boundedSearchText(3, 200, 300).optional(),
  training_name: boundedSearchText(3, 200, 300).optional()
}).strict().superRefine((value, context) => {
  const hasCertificateNumber = value.certificate_number !== undefined;
  const hasRecipient = value.recipient_name !== undefined;
  const hasContext = value.project_name !== undefined || value.training_name !== undefined;
  const validCertificateLookup = hasCertificateNumber && !hasRecipient && !hasContext;
  const validRecipientLookup = !hasCertificateNumber && hasRecipient && hasContext;
  if (!validCertificateLookup && !validRecipientLookup) {
    context.addIssue({ code: "custom", message: "invalid public certificate search combination" });
  }
});

export const PublicCertificateSearchResultSchema = z.object({
  certificate_number: z.string().min(1).max(200),
  recipient_name: z.string().min(1).max(300),
  project_name: z.string().min(1).max(200),
  training_name: z.string().min(1).max(200),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.literal("available"),
  search_result_token: z.string().min(1).max(2_048)
}).strict();

export const PublicCertificateSearchResponseSchema = z.object({
  data: z.object({
    results: z.array(PublicCertificateSearchResultSchema).max(PUBLIC_CERTIFICATE_SEARCH_RESULT_LIMIT),
    too_broad: z.boolean()
  }).strict(),
  meta: RequestMetaSchema
}).strict();

export const PublicSearchDownloadAuthorizationRequestSchema = z.object({
  search_result_token: z.string().min(1).max(2_048)
}).strict();

export const PublicSearchDownloadAuthorizationResponseSchema = PublicDownloadAuthorizationResponseSchema;

export type PublicVerificationData = z.infer<typeof PublicVerificationDataSchema>;
export type PublicVerificationRequest = z.infer<typeof PublicVerificationRequestSchema>;
export type PublicVerificationResponse = z.infer<typeof PublicVerificationResponseSchema>;
export type PublicDownloadAuthorizationData = z.infer<typeof PublicDownloadAuthorizationDataSchema>;
export type PublicDownloadAuthorizationRequest = z.infer<typeof PublicDownloadAuthorizationRequestSchema>;
export type PublicDownloadAuthorizationResponse = z.infer<typeof PublicDownloadAuthorizationResponseSchema>;
export type PublicCertificateDownloadRequest = z.infer<typeof PublicCertificateDownloadRequestSchema>;
export type PublicCertificateSearchRequest = z.infer<typeof PublicCertificateSearchRequestSchema>;
export type PublicCertificateSearchResult = z.infer<typeof PublicCertificateSearchResultSchema>;
export type PublicCertificateSearchResponse = z.infer<typeof PublicCertificateSearchResponseSchema>;
export type PublicProjectSuggestionRequest = z.infer<typeof PublicProjectSuggestionRequestSchema>;
export type PublicTrainingSuggestionRequest = z.infer<typeof PublicTrainingSuggestionRequestSchema>;
export type PublicCertificateSuggestion = z.infer<typeof PublicCertificateSuggestionSchema>;
export type PublicCertificateSuggestionResponse = z.infer<typeof PublicCertificateSuggestionResponseSchema>;
export type PublicSearchDownloadAuthorizationRequest = z.infer<typeof PublicSearchDownloadAuthorizationRequestSchema>;
