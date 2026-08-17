import { randomUUID } from "node:crypto";

import { createStructuredLoggerOptions } from "@certificate-platform/config";
import {
  createErrorResponse,
  createLivenessResponse,
  createReadinessResponse
} from "@certificate-platform/contracts";
import Fastify, { type FastifyInstance } from "fastify";

export interface WorkerHealthDependencies {
  readonly checkDatabase: () => Promise<void>;
  readonly checkRedis: () => Promise<void>;
}

export interface BuildWorkerHealthAppOptions {
  readonly dependencies: WorkerHealthDependencies;
  readonly readinessTimeoutMs: number;
  readonly logLevel?: string;
  readonly logger?: boolean;
}

const checkWithTimeout = async (
  dependencies: WorkerHealthDependencies,
  timeoutMs: number
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([dependencies.checkDatabase(), dependencies.checkRedis()]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Readiness check timed out")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

export const buildWorkerHealthApp = ({
  dependencies,
  readinessTimeoutMs,
  logLevel = "info",
  logger = true
}: BuildWorkerHealthAppOptions): FastifyInstance => {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: logger ? createStructuredLoggerOptions(logLevel) : false,
    requestIdHeader: false
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  app.get("/health/live", async (request) => createLivenessResponse("worker", request.id));
  app.get("/health/ready", async (request, reply) => {
    try {
      await checkWithTimeout(dependencies, readinessTimeoutMs);
      return createReadinessResponse("worker", request.id);
    } catch (error) {
      request.log.warn({ err: error, error_code: "SERVICE_UNAVAILABLE" }, "readiness check failed");
      return reply
        .status(503)
        .send(createErrorResponse("SERVICE_UNAVAILABLE", "The service is not ready.", request.id));
    }
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(createErrorResponse("NOT_FOUND", "The requested resource was not found.", request.id));
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, error_code: "INTERNAL_ERROR" }, "worker health request failed");
    void reply
      .status(500)
      .send(createErrorResponse("INTERNAL_ERROR", "The request could not be processed.", request.id));
  });

  return app;
};
