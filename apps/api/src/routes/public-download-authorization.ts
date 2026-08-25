import type { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { createErrorResponse, PublicDownloadAuthorizationRequestSchema,
  PublicDownloadAuthorizationResponseSchema } from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { PublicDownloadAuthorizationFailureError,
  type PublicDownloadAuthorizationService } from "../modules/phase-six/public-download-authorization-service.js";

const PUBLIC_ERROR_CODE = "PUBLIC_REQUEST_FAILED";
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";

export interface PublicDownloadAuthorizationRouteOptions {
  readonly service: PublicDownloadAuthorizationService;
  readonly rateLimiter: Pick<PublicVerificationRateLimiter, "consume">;
}

export const registerPublicDownloadAuthorizationRoutes = (
  app: FastifyInstance,
  options: PublicDownloadAuthorizationRouteOptions
): void => {
  app.post("/api/public/certificates/download-authorize", { bodyLimit: 4_096 }, async (request, reply) => {
    const rateLimit = await options.rateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
        .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    }
    const parsed = PublicDownloadAuthorizationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    try {
      const data = await options.service.authorize(parsed.data.token);
      return reply.status(200).send(PublicDownloadAuthorizationResponseSchema.parse({ data,
        meta: { request_id: request.id } }));
    } catch (error) {
      if (error instanceof PublicDownloadAuthorizationFailureError) {
        throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
      }
      throw error;
    }
  });
};
