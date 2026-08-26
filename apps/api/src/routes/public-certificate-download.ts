import type { PublicVerificationRateLimiter } from "@certificate-platform/auth";
import { createErrorResponse, PublicCertificateDownloadRequestSchema } from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { PublicCertificateDownloadFailureError,
  type PublicCertificateDownloadService } from "../modules/phase-six/public-certificate-download-service.js";

const PUBLIC_ERROR_CODE = "PUBLIC_REQUEST_FAILED";
const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";

export interface PublicCertificateDownloadRouteOptions {
  readonly service: PublicCertificateDownloadService;
  readonly rateLimiter: Pick<PublicVerificationRateLimiter, "consume">;
}

export const registerPublicCertificateDownloadRoutes = (
  app: FastifyInstance,
  options: PublicCertificateDownloadRouteOptions
): void => {
  app.post("/api/public/certificates/download", { bodyLimit: 4_096 }, async (request, reply) => {
    const rateLimit = await options.rateLimiter.consume(request.ip);
    if (!rateLimit.allowed) {
      return reply.status(429).header("retry-after", rateLimit.retryAfterSeconds)
        .send(createErrorResponse(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, request.id));
    }
    const parsed = PublicCertificateDownloadRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
    try {
      const bytes = await options.service.download(parsed.data.download_token);
      return reply.status(200)
        .header("content-type", "application/pdf")
        .header("content-disposition", 'attachment; filename="certificate.pdf"')
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(bytes));
    } catch (error) {
      if (error instanceof PublicCertificateDownloadFailureError) {
        throw new ApplicationError(PUBLIC_ERROR_CODE, PUBLIC_ERROR_MESSAGE, 400);
      }
      throw error;
    }
  });
};
