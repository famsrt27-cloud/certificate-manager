import { randomUUID } from "node:crypto";

import { createStructuredLoggerOptions } from "@certificate-platform/config";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./plugins/error-handler.js";
import { openApiDocument } from "./openapi-document.js";
import { registerHealthRoutes, type ReadinessDependencies } from "./routes/health.js";
import { registerAdminAuthRoutes, type AdminAuthRouteOptions } from "./routes/admin-auth.js";
import { registerAdminPhaseThreeRoutes, type AdminPhaseThreeRouteOptions } from "./routes/admin-phase-three.js";

export interface BuildApiOptions {
  readonly dependencies: ReadinessDependencies;
  readonly readinessTimeoutMs: number;
  readonly logLevel?: string;
  readonly logger?: boolean;
  readonly authentication?: AdminAuthRouteOptions;
  readonly phaseThree?: AdminPhaseThreeRouteOptions;
}

export const buildApi = ({
  dependencies,
  readinessTimeoutMs,
  logLevel = "info",
  logger = true,
  authentication,
  phaseThree
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
  app.get("/openapi.json", async (_request, reply) => reply.header("cache-control", "no-store").send(openApiDocument));
  registerHealthRoutes(app, dependencies, readinessTimeoutMs);
  if (authentication !== undefined) registerAdminAuthRoutes(app, authentication);
  if (phaseThree !== undefined) {
    void app.register(multipart, {
      limits: { fileSize: phaseThree.participantImportMaxBytes, files: 1, fields: 0, parts: 1 },
      throwFileSizeLimit: true
    });
    registerAdminPhaseThreeRoutes(app, phaseThree);
  }
  return app;
};
