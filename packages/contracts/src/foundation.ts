import { z } from "zod";

export const RequestMetaSchema = z.object({
  request_id: z.uuid()
});

export const LivenessDataSchema = z.object({
  status: z.literal("ok"),
  service: z.enum(["api", "worker"])
});

export const ReadinessDataSchema = z.object({
  status: z.literal("ready"),
  service: z.enum(["api", "worker"])
});

export const LivenessResponseSchema = z.object({
  data: LivenessDataSchema,
  meta: RequestMetaSchema
});

export const ReadinessResponseSchema = z.object({
  data: ReadinessDataSchema,
  meta: RequestMetaSchema
});

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1)
  }),
  meta: RequestMetaSchema
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type LivenessResponse = z.infer<typeof LivenessResponseSchema>;
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;

export const createLivenessResponse = (
  service: "api" | "worker",
  requestId: string
): LivenessResponse => LivenessResponseSchema.parse({ data: { status: "ok", service }, meta: { request_id: requestId } });

export const createReadinessResponse = (
  service: "api" | "worker",
  requestId: string
): ReadinessResponse => ReadinessResponseSchema.parse({
  data: { status: "ready", service },
  meta: { request_id: requestId }
});

export const createErrorResponse = (
  code: string,
  message: string,
  requestId: string
): ErrorResponse => ErrorResponseSchema.parse({
  error: { code, message },
  meta: { request_id: requestId }
});
