import { randomUUID } from "node:crypto";

import { createStructuredLoggerOptions } from "@certificate-platform/config";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

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

export const buildApi = ({
  dependencies,
  readinessTimeoutMs,
  logLevel = "info",
  logger = true,
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
    logger: logger ? createStructuredLoggerOptions(logLevel) : false,
    requestIdHeader: false
  });

  app.addHook("onSend", async (request, reply, payload) => {
    void reply.header("x-request-id", request.id);
    return payload;
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/public/") || request.url.startsWith("/api/admin/auth/")) {
      void reply.header("cache-control", "no-store");
    }
    if (request.url.startsWith("/api/public/")) {
      void reply.header("x-robots-tag", "noindex, nofollow, noarchive");
    }
  });

  registerErrorHandler(app);
  app.get("/openapi.json", async (_request, reply) => reply.header("cache-control", "no-store").send(openApiDocument));
  registerHealthRoutes(app, dependencies, readinessTimeoutMs);
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
