import { randomUUID } from "node:crypto";

import { createOperationalMetrics, createStructuredLoggerOptions, type OperationalMetrics } from "@certificate-platform/config";
import {
  createErrorResponse,
  createLivenessResponse,
  createReadinessResponse
} from "@certificate-platform/contracts";
import Fastify, { LogController, type FastifyInstance } from "fastify";

export interface WorkerHealthDependencies {
  readonly checkDatabase: () => Promise<void>;
  readonly checkRedis: () => Promise<void>;
}

export interface BuildWorkerHealthAppOptions {
  readonly dependencies: WorkerHealthDependencies;
  readonly readinessTimeoutMs: number;
  readonly logLevel?: string;
  readonly logger?: boolean;
  readonly metrics?: OperationalMetrics;
}

const checkWithTimeout = async (
  dependencies: WorkerHealthDependencies,
  timeoutMs: number,
  metrics: OperationalMetrics
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([
        dependencies.checkDatabase().then(
          () => metrics.recordReadiness("database", "success"),
          (error: unknown) => {
            metrics.recordReadiness("database", "failure");
            metrics.recordDependencyFailure("database");
            throw error;
          }
        ),
        dependencies.checkRedis().then(
          () => metrics.recordReadiness("redis", "success"),
          (error: unknown) => {
            metrics.recordReadiness("redis", "failure");
            metrics.recordDependencyFailure("redis");
            throw error;
          }
        )
      ]),
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
  logger = true,
  metrics = createOperationalMetrics("worker")
}: BuildWorkerHealthAppOptions): FastifyInstance => {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: logger ? createStructuredLoggerOptions(logLevel, "worker") : false,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    requestIdHeader: false
  });

  const requestStartedAt = new WeakMap<object, number>();
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, performance.now());
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    const durationMs = Math.max(0, performance.now() - (requestStartedAt.get(request) ?? performance.now()));
    metrics.recordHttpRequest({ method: request.method, route, statusCode: reply.statusCode, durationMs });
    request.log.info({
      route,
      status: reply.statusCode,
      duration_ms: Math.round(durationMs),
      ...(reply.statusCode >= 400 ? { error_code: `HTTP_${reply.statusCode}` } : {})
    }, "request completed");
  });

  app.get("/health/live", async (request) => createLivenessResponse("worker", request.id));
  app.get("/health/ready", async (request, reply) => {
    try {
      await checkWithTimeout(dependencies, readinessTimeoutMs, metrics);
      return createReadinessResponse("worker", request.id);
    } catch (error) {
      request.log.warn({ err: error, error_code: "SERVICE_UNAVAILABLE" }, "readiness check failed");
      return reply
        .status(503)
        .send(createErrorResponse("SERVICE_UNAVAILABLE", "The service is not ready.", request.id));
    }
  });
  app.get("/metrics", async (_request, reply) => reply
    .header("cache-control", "no-store")
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(metrics.renderPrometheus()));

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
