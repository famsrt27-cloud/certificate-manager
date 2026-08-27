import { createErrorResponse, PublicVerificationRequestSchema, PublicVerificationResponseSchema } from "@certificate-platform/contracts";
import type { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { PublicVerificationFailureError, type PublicVerificationService } from "../modules/phase-six/public-verification-service.js";

const PUBLIC_ERROR_CODE = "PUBLIC_REQUEST_FAILED";
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";

export interface PublicVerificationRouteOptions {
  readonly service: PublicVerificationService;
  readonly rateLimiter: Pick<PublicVerificationRateLimiter, "consume">;
}

export const registerPublicVerificationRoutes = (app: FastifyInstance, options: PublicVerificationRouteOptions): void => {
  app.post("/api/public/verify", { bodyLimit: 4_096 }, async (request, reply) => {
    const rateLimit = await options.rateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
        .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    }
    const parsed = PublicVerificationRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    try {
      const data = await options.service.verify(parsed.data.token);
      return reply.status(200).send(PublicVerificationResponseSchema.parse({ data, meta: { request_id: request.id } }));
    } catch (error) {
      if (error instanceof PublicVerificationFailureError) {
        throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
      }
      throw error;
    }
  });
};
