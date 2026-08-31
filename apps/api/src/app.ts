import { randomUUID } from "node:crypto";

import { createOperationalMetrics, createStructuredLoggerOptions, type OperationalMetrics, type RateLimitScope } from "@certificate-platform/config";
import multipart from "@fastify/multipart";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import { registerErrorHandler } from "./plugins/error-handler.js";
import { openApiDocument } from "./openapi-document.js";
import { registerHealthRoutes, type ReadinessDependencies } from "./routes/health.js";
import { registerAdminAuthRoutes, type AdminAuthRouteOptions } from "./routes/admin-auth.js";
import { registerAdminPhaseThreeRoutes, type AdminPhaseThreeRouteOptions } from "./routes/admin-phase-three.js";
import { registerAdminPhaseFourRoutes, type AdminPhaseFourRouteOptions } from "./routes/admin-phase-four.js";
import { registerAdminPhaseFiveRoutes, type AdminPhaseFiveRouteOptions } from "./routes/admin-phase-five.js";
import { registerAdminDashboardRoutes, type AdminDashboardRouteOptions } from "./routes/admin-dashboard.js";
import { registerAdminOrganizationSettingsRoutes,
  type AdminOrganizationSettingsRouteOptions } from "./routes/admin-organization-settings.js";
import { registerPublicVerificationRoutes, type PublicVerificationRouteOptions } from "./routes/public-verification.js";
import { registerPublicDownloadAuthorizationRoutes,
  type PublicDownloadAuthorizationRouteOptions } from "./routes/public-download-authorization.js";
import { registerPublicCertificateDownloadRoutes,
  type PublicCertificateDownloadRouteOptions } from "./routes/public-certificate-download.js";
import { registerPublicCertificateSearchRoutes,
  type PublicCertificateSearchRouteOptions } from "./routes/public-certificate-search.js";
import { registerPublicSearchDownloadAuthorizationRoutes,
  type PublicSearchDownloadAuthorizationRouteOptions } from "./routes/public-search-download-authorization.js";

export interface BuildApiOptions {
  readonly dependencies: ReadinessDependencies;
  readonly readinessTimeoutMs: number;
  readonly logLevel?: string;
  readonly logger?: boolean;
  readonly metrics?: OperationalMetrics;
  readonly trustedProxyHops?: number;
  readonly authentication?: AdminAuthRouteOptions;
  readonly phaseThree?: AdminPhaseThreeRouteOptions;
  readonly phaseFour?: AdminPhaseFourRouteOptions;
  readonly phaseFive?: AdminPhaseFiveRouteOptions;
  readonly dashboard?: AdminDashboardRouteOptions;
  readonly organizationSettings?: AdminOrganizationSettingsRouteOptions;
  readonly publicVerification?: PublicVerificationRouteOptions;
  readonly publicDownloadAuthorization?: PublicDownloadAuthorizationRouteOptions;
  readonly publicCertificateDownload?: PublicCertificateDownloadRouteOptions;
  readonly publicCertificateSearch?: PublicCertificateSearchRouteOptions;
  readonly publicSearchDownloadAuthorization?: PublicSearchDownloadAuthorizationRouteOptions;
}

export const API_JSON_BODY_LIMIT_BYTES = 1_048_576;

const publicOperationForRoute = (route: string): "download" | "verification" | undefined => {
  if (route === "/api/public/verify") return "verification";
  if (route === "/api/public/certificates/download") return "download";
  return undefined;
};

const rateLimitScopeForRoute = (route: string): RateLimitScope | undefined => {
  if (route === "/api/admin/auth/login") return "login";
  if (route === "/api/public/verify") return "public_verification";
  if (route === "/api/public/certificates/download" || route === "/api/public/certificates/download-authorize") return "public_download";
  if (route.startsWith("/api/public/certificates/")) return "public_search";
  return undefined;
};

export const buildApi = ({
  dependencies,
  readinessTimeoutMs,
  logLevel = "info",
  logger = true,
  metrics = createOperationalMetrics("api"),
  trustedProxyHops = 0,
  authentication,
  phaseThree,
  phaseFour,
  phaseFive,
  dashboard,
  organizationSettings,
  publicVerification,
  publicDownloadAuthorization,
  publicCertificateDownload,
  publicCertificateSearch,
  publicSearchDownloadAuthorization
}: BuildApiOptions): FastifyInstance => {
  const app = Fastify({
    bodyLimit: API_JSON_BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    logger: logger ? createStructuredLoggerOptions(logLevel, "api") : false,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: "request_id" }),
    requestIdHeader: false,
    trustProxy: trustedProxyHops === 1 ? 1 : false
  });

  const requestStartedAt = new WeakMap<object, number>();
  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request, performance.now());
    if (request.url.startsWith("/api/public/") || request.url.startsWith("/api/admin/auth/")) {
      void reply.header("cache-control", "no-store");
    }
    if (request.url.startsWith("/api/public/")) {
      void reply.header("x-robots-tag", "noindex, nofollow, noarchive");
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request) ?? performance.now();
    const durationMs = Math.max(0, performance.now() - startedAt);
    const route = request.routeOptions?.url ?? "unmatched";
    if (route !== "/metrics") {
      metrics.recordHttpRequest({ method: request.method, route, statusCode: reply.statusCode, durationMs });
      const publicOperation = publicOperationForRoute(route);
      if (publicOperation === "verification") metrics.recordVerification(reply.statusCode === 200 ? "success" : "failure");
      if (publicOperation === "download") metrics.recordDownload(reply.statusCode === 200 ? "success" : "failure");
      if (reply.statusCode === 429) {
        const rateLimitScope = rateLimitScopeForRoute(route);
        if (rateLimitScope !== undefined) metrics.recordRateLimit(rateLimitScope);
      }
      request.log.info({
        route,
        status: reply.statusCode,
        duration_ms: Math.round(durationMs),
        ...(reply.statusCode >= 400 ? { error_code: `HTTP_${reply.statusCode}` } : {})
      }, "request completed");
    }
  });

  registerErrorHandler(app);
  app.get("/openapi.json", async (_request, reply) => reply.header("cache-control", "no-store").send(openApiDocument));
  app.get("/metrics", async (_request, reply) => reply
    .header("cache-control", "no-store")
    .type("text/plain; version=0.0.4; charset=utf-8")
    .send(metrics.renderPrometheus()));
  registerHealthRoutes(app, dependencies, readinessTimeoutMs, metrics);
  if (authentication !== undefined) registerAdminAuthRoutes(app, authentication);
  if (phaseThree !== undefined || phaseFour !== undefined) {
    void app.register(multipart, {
      limits: { fileSize: Math.max(phaseThree?.participantImportMaxBytes ?? 0, phaseFour?.templateAssetMaxBytes ?? 0), files: 1, fields: 0, parts: 1 },
      throwFileSizeLimit: true
    });
  }
  if (phaseThree !== undefined) {
    registerAdminPhaseThreeRoutes(app, phaseThree);
  }
  if (phaseFour !== undefined) registerAdminPhaseFourRoutes(app, phaseFour);
  if (phaseFive !== undefined) registerAdminPhaseFiveRoutes(app, phaseFive);
  if (dashboard !== undefined) registerAdminDashboardRoutes(app, dashboard);
  if (organizationSettings !== undefined) registerAdminOrganizationSettingsRoutes(app, organizationSettings);
  if (publicVerification !== undefined) registerPublicVerificationRoutes(app, publicVerification);
  if (publicDownloadAuthorization !== undefined) {
    registerPublicDownloadAuthorizationRoutes(app, publicDownloadAuthorization);
  }
  if (publicCertificateDownload !== undefined) {
    registerPublicCertificateDownloadRoutes(app, publicCertificateDownload);
  }
  if (publicCertificateSearch !== undefined) registerPublicCertificateSearchRoutes(app, publicCertificateSearch);
  if (publicSearchDownloadAuthorization !== undefined) {
    registerPublicSearchDownloadAuthorizationRoutes(app, publicSearchDownloadAuthorization);
  }
  return app;
};
