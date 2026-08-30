import { z } from "zod";

const CountSchema = z.number().int().nonnegative();

export const DashboardSummaryDataSchema = z.object({
  organization: z.object({ public_certificate_search_enabled: z.boolean() }).strict(),
  projects: z.object({ active: CountSchema, total: CountSchema }).strict().optional(),
  trainings: z.object({ active: CountSchema, total: CountSchema }).strict().optional(),
  participants: z.object({ total: CountSchema }).strict().optional(),
  templates: z.object({ active: CountSchema, published_versions: CountSchema }).strict().optional(),
  certificates: z.object({ available: CountSchema, in_progress: CountSchema, revoked: CountSchema }).strict().optional(),
  jobs: z.object({ queued: CountSchema, running: CountSchema, failed: CountSchema, dead_letter: CountSchema }).strict().optional()
}).strict();

export const UpdateOrganizationPublicSearchRequestSchema = z.object({
  public_certificate_search_enabled: z.boolean()
}).strict();

export const OrganizationPublicSearchResponseSchema = z.object({
  data: z.object({ public_certificate_search_enabled: z.boolean() }).strict(),
  meta: z.object({ request_id: z.uuid() }).strict()
}).strict();

export const DashboardSummaryResponseSchema = z.object({
  data: DashboardSummaryDataSchema,
  meta: z.object({ request_id: z.uuid() }).strict()
}).strict();

export type DashboardSummaryData = z.infer<typeof DashboardSummaryDataSchema>;
export type DashboardSummaryResponse = z.infer<typeof DashboardSummaryResponseSchema>;
export type UpdateOrganizationPublicSearchRequest = z.infer<typeof UpdateOrganizationPublicSearchRequestSchema>;
export type OrganizationPublicSearchResponse = z.infer<typeof OrganizationPublicSearchResponseSchema>;
