import type { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { createErrorResponse, PublicSearchDownloadAuthorizationRequestSchema,
  PublicSearchDownloadAuthorizationResponseSchema } from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { PublicSearchDownloadAuthorizationFailureError,
  type PublicSearchDownloadAuthorizationService } from "../modules/phase-six/public-search-download-authorization-service.js";

const PUBLIC_ERROR_CODE = "PUBLIC_REQUEST_FAILED";
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";

export interface PublicSearchDownloadAuthorizationRouteOptions {
  readonly service: PublicSearchDownloadAuthorizationService;
  readonly rateLimiter: Pick<PublicVerificationRateLimiter, "consume">;
}

export const registerPublicSearchDownloadAuthorizationRoutes = (
  app: FastifyInstance, options: PublicSearchDownloadAuthorizationRouteOptions
): void => {
  app.post("/api/public/certificates/search-download-authorize", { bodyLimit: 4_096 }, async (request, reply) => {
    const rateLimit = await options.rateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
        .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    }
    const parsed = PublicSearchDownloadAuthorizationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    try {
      const data = await options.service.authorize(parsed.data.search_result_token);
      return reply.status(200).send(PublicSearchDownloadAuthorizationResponseSchema.parse({ data,
        meta: { request_id: request.id } }));
    } catch (error) {
      if (error instanceof PublicSearchDownloadAuthorizationFailureError) {
        throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
      }
      throw error;
    }
  });
};
