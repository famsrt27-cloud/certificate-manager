import { z } from "zod";

const CountSchema = z.number().int().nonnegative();

export const DashboardSummaryDataSchema = z.object({
  projects: z.object({ active: CountSchema, total: CountSchema }).strict().optional(),
  trainings: z.object({ active: CountSchema, total: CountSchema }).strict().optional(),
  participants: z.object({ total: CountSchema }).strict().optional(),
  templates: z.object({ active: CountSchema, published_versions: CountSchema }).strict().optional(),
  certificates: z.object({ available: CountSchema, in_progress: CountSchema, revoked: CountSchema }).strict().optional(),
  jobs: z.object({ queued: CountSchema, running: CountSchema, failed: CountSchema, dead_letter: CountSchema }).strict().optional()
}).strict();

export const DashboardSummaryResponseSchema = z.object({
  data: DashboardSummaryDataSchema,
  meta: z.object({ request_id: z.uuid() }).strict()
}).strict();

export type DashboardSummaryData = z.infer<typeof DashboardSummaryDataSchema>;
export type DashboardSummaryResponse = z.infer<typeof DashboardSummaryResponseSchema>;
