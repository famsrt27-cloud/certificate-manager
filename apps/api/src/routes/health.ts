import {
  createErrorResponse,
  createLivenessResponse,
  createReadinessResponse
} from "@certificate-platform/contracts";
import type { FastifyInstance } from "fastify";

export interface ReadinessDependencies {
  readonly checkDatabase: () => Promise<void>;
  readonly checkRedis: () => Promise<void>;
}

const withTimeout = async (operation: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Readiness check timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const registerHealthRoutes = (
  app: FastifyInstance,
  dependencies: ReadinessDependencies,
  timeoutMs: number
): void => {
  app.get("/health/live", async (request) => createLivenessResponse("api", request.id));

  app.get("/health/ready", async (request, reply) => {
    try {
      await withTimeout(
        Promise.all([dependencies.checkDatabase(), dependencies.checkRedis()]).then(() => undefined),
        timeoutMs
      );
      return createReadinessResponse("api", request.id);
    } catch (error) {
      request.log.warn({ err: error, error_code: "SERVICE_UNAVAILABLE" }, "readiness check failed");
      return reply
        .status(503)
        .send(createErrorResponse("SERVICE_UNAVAILABLE", "The service is not ready.", request.id));
    }
  });
};
