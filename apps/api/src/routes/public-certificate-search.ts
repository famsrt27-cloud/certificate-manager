import type { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { createErrorResponse, PublicCertificateSearchRequestSchema,
  PublicCertificateSearchResponseSchema, PublicCertificateSuggestionResponseSchema,
  PublicProjectSuggestionRequestSchema, PublicTrainingSuggestionRequestSchema } from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { PublicCertificateSearchFailureError,
  type PublicCertificateSearchService } from "../modules/phase-six/public-certificate-search-service.js";

const PUBLIC_ERROR_CODE = "PUBLIC_REQUEST_FAILED";
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";

export interface PublicCertificateSearchRouteOptions {
  readonly service: PublicCertificateSearchService;
  readonly rateLimiter: Pick<PublicVerificationRateLimiter, "consume">;
}

export const registerPublicCertificateSearchRoutes = (
  app: FastifyInstance, options: PublicCertificateSearchRouteOptions
): void => {
  const consumeRateLimit = async (request: Parameters<typeof options.rateLimiter.consume>[0]) =>
    options.rateLimiter.consume(request);

  app.post("/api/public/certificates/project-suggestions", { bodyLimit: 1_024 }, async (request, reply) => {
    const rateLimit = await consumeRateLimit(request.ip);
    if (!rateLimit.allowed) return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
      .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    const parsed = PublicProjectSuggestionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    const data = await options.service.suggestProjects(parsed.data.query);
    return reply.send(PublicCertificateSuggestionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });

  app.post("/api/public/certificates/training-suggestions", { bodyLimit: 1_024 }, async (request, reply) => {
    const rateLimit = await consumeRateLimit(request.ip);
    if (!rateLimit.allowed) return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
      .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    const parsed = PublicTrainingSuggestionRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    const data = await options.service.suggestTrainings(parsed.data.project_name, parsed.data.query);
    return reply.send(PublicCertificateSuggestionResponseSchema.parse({ data, meta: { request_id: request.id } }));
  });

  app.post("/api/public/certificates/search", { bodyLimit: 4_096 }, async (request, reply) => {
    const rateLimit = await options.rateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
        .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    }
    const parsed = PublicCertificateSearchRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    try {
      const data = await options.service.search(parsed.data);
      return reply.status(200).send(PublicCertificateSearchResponseSchema.parse({ data,
        meta: { request_id: request.id } }));
    } catch (error) {
      if (error instanceof PublicCertificateSearchFailureError) {
        throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
      }
      throw error;
    }
  });
};
