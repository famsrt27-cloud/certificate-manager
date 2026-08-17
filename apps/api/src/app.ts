import { randomUUID } from "node:crypto";

import { createStructuredLoggerOptions } from "@certificate-platform/config";
import Fastify, { type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerHealthRoutes, type ReadinessDependencies } from "./routes/health.js";
import { registerAdminAuthRoutes, type AdminAuthRouteOptions } from "./routes/admin-auth.js";

export interface BuildApiOptions {
  readonly dependencies: ReadinessDependencies;
  readonly readinessTimeoutMs: number;
  readonly logLevel?: string;
  readonly logger?: boolean;
  readonly authentication?: AdminAuthRouteOptions;
}

export const buildApi = ({
  dependencies,
  readinessTimeoutMs,
  logLevel = "info",
  logger = true,
  authentication
}: BuildApiOptions): FastifyInstance => {
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: logger ? createStructuredLoggerOptions(logLevel) : false,
    requestIdHeader: false
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });

  registerErrorHandler(app);
  registerHealthRoutes(app, dependencies, readinessTimeoutMs);
  if (authentication !== undefined) registerAdminAuthRoutes(app, authentication);
  return app;
};
