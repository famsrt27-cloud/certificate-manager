import {
  AuthenticationResponseSchema,
  LoginResponseSchema,
  LoginRequestSchema,
  MfaCodeRequestSchema,
  MfaCompletionResponseSchema,
  LogoutResponseSchema
} from "@certificate-platform/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "../errors/application-error.js";
import { LoginRateLimitError, type AuthenticationService } from "../modules/auth/authentication-service.js";
import {
  createAdminSessionCookie,
  createAdminMfaCookie,
  expireAdminSessionCookie,
  expireAdminMfaCookie,
  readAdminMfaCookie,
  readAdminSessionCookie
} from "../modules/auth/cookie.js";

export interface AdminAuthRouteOptions {
  readonly service: AuthenticationService;
  readonly absoluteTtlSeconds: number;
}

const safeAuthenticationOperation = async <Result>(
  request: FastifyRequest,
  operation: () => Promise<Result>
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    request.log.error({ error_code: "AUTH_STATE_UNAVAILABLE" }, "authentication state unavailable");
    throw new ApplicationError("SERVICE_UNAVAILABLE", "The service is temporarily unavailable.", 503);
  }
};

const noStore = { "cache-control": "no-store" } as const;

export const registerAdminAuthRoutes = (app: FastifyInstance, options: AdminAuthRouteOptions): void => {
  app.post("/api/admin/auth/login", async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    }
    try {
      const result = await safeAuthenticationOperation(request, () => options.service.login(parsed.data, {
        requestId: request.id,
        networkAddress: request.ip,
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        previousSessionId: readAdminSessionCookie(request.headers.cookie)
      }));
      if (result.kind === "MFA_PENDING") {
        const data = result.status === "MFA_REQUIRED"
          ? { status: result.status }
          : { status: result.status, provisioning_uri: result.provisioningUri };
        void reply
          .headers(noStore)
          .header("set-cookie", [createAdminMfaCookie(result.challengeId), expireAdminSessionCookie()])
          .send(LoginResponseSchema.parse({ data, meta: { request_id: request.id } }));
        return;
      }
      void reply
        .headers(noStore)
        .header("set-cookie", createAdminSessionCookie(result.sessionId, options.absoluteTtlSeconds))
        .send(AuthenticationResponseSchema.parse({ data: result.data, meta: { request_id: request.id } }));
    } catch (error) {
      if (error instanceof LoginRateLimitError) void reply.header("retry-after", error.retryAfterSeconds);
      throw error;
    }
  });

  app.post("/api/admin/auth/mfa", async (request, reply) => {
    const parsed = MfaCodeRequestSchema.safeParse(request.body);
    if (!parsed.success) throw new ApplicationError("VALIDATION_FAILED", "The request could not be processed.", 400);
    const result = await safeAuthenticationOperation(request, () => options.service.completeMfa(
      readAdminMfaCookie(request.headers.cookie),
      parsed.data,
      {
        requestId: request.id,
        networkAddress: request.ip,
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
        previousSessionId: readAdminSessionCookie(request.headers.cookie)
      }
    ));
    void reply
      .headers(noStore)
      .header("set-cookie", [
        createAdminSessionCookie(result.sessionId, options.absoluteTtlSeconds),
        expireAdminMfaCookie()
      ])
      .send(MfaCompletionResponseSchema.parse({
        data: { ...result.data, ...(result.recoveryCodes === undefined ? {} : { recovery_codes: result.recoveryCodes }) },
        meta: { request_id: request.id }
      }));
  });

  app.get("/api/admin/auth/session", async (request, reply) => {
    const sessionId = readAdminSessionCookie(request.headers.cookie);
    const context = await safeAuthenticationOperation(request, () => options.service.authenticate(sessionId, request.id));
    if (context === null) {
      void reply.header("set-cookie", expireAdminSessionCookie());
      throw new ApplicationError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    }
    void reply
      .headers(noStore)
      .send(AuthenticationResponseSchema.parse({
        data: options.service.inspect(context),
        meta: { request_id: request.id }
      }));
  });

  app.post("/api/admin/auth/logout", async (request, reply) => {
    const sessionId = readAdminSessionCookie(request.headers.cookie);
    const context = await safeAuthenticationOperation(request, () => options.service.authenticate(sessionId, request.id, false));
    await safeAuthenticationOperation(request, () => options.service.logout(
      context,
      typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      typeof request.headers["x-csrf-token"] === "string" ? request.headers["x-csrf-token"] : undefined,
      request.id
    ));
    void reply
      .headers(noStore)
      .header("set-cookie", expireAdminSessionCookie())
      .send(LogoutResponseSchema.parse({ data: { logged_out: true }, meta: { request_id: request.id } }));
  });
};
