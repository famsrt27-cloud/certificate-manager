import {
  verifyPassword,
  type LoginRateLimiter,
  type RedisSessionStore,
  type SessionRecord
} from "@certificate-platform/auth";
import type { AuthenticationData, LoginRequest } from "@certificate-platform/contracts";
import {
  createAuthorizationVersion,
  type AuditEvent,
  type AuditWriter,
  type EffectiveIdentity
} from "@certificate-platform/domain";

import { ApplicationError } from "../../errors/application-error.js";

export interface AuthenticationUser {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
}

export interface IdentityProvider {
  findByNormalizedEmail(email: string): Promise<AuthenticationUser | null>;
  loadEffectiveIdentity(userId: string): Promise<EffectiveIdentity | null>;
}

export interface LoginContext {
  readonly requestId: string;
  readonly networkAddress: string;
  readonly origin: string | undefined;
  readonly previousSessionId: string | undefined;
}

export interface AuthenticatedContext {
  readonly sessionId: string;
  readonly session: SessionRecord;
  readonly identity: EffectiveIdentity;
}

export class LoginRateLimitError extends ApplicationError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("TOO_MANY_REQUESTS", "Authentication failed.", 429);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AuthenticationServiceOptions {
  readonly sessions: RedisSessionStore;
  readonly rateLimiter: LoginRateLimiter;
  readonly identities: IdentityProvider;
  readonly audit: AuditWriter;
  readonly allowedOrigins: readonly string[];
  readonly dummyPasswordHash: string;
  readonly passwordVerifier?: typeof verifyPassword;
}

export class AuthenticationService {
  readonly #sessions: RedisSessionStore;
  readonly #rateLimiter: LoginRateLimiter;
  readonly #identities: IdentityProvider;
  readonly #audit: AuditWriter;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #dummyPasswordHash: string;
  readonly #passwordVerifier: typeof verifyPassword;

  constructor({ sessions, rateLimiter, identities, audit, allowedOrigins, dummyPasswordHash,
    passwordVerifier = verifyPassword }: AuthenticationServiceOptions) {
    this.#sessions = sessions;
    this.#rateLimiter = rateLimiter;
    this.#identities = identities;
    this.#audit = audit;
    this.#allowedOrigins = new Set(allowedOrigins);
    this.#dummyPasswordHash = dummyPasswordHash;
    this.#passwordVerifier = passwordVerifier;
  }

  async login(input: LoginRequest, context: LoginContext): Promise<{ sessionId: string; data: AuthenticationData }> {
    this.assertAllowedOrigin(context.origin);
    const limit = await this.#rateLimiter.consume(input.email, context.networkAddress);
    if (!limit.allowed) {
      await this.#writeAuthenticationFailure(context.requestId, "RATE_LIMITED");
      throw new LoginRateLimitError(limit.retryAfterSeconds);
    }

    const user = await this.#identities.findByNormalizedEmail(input.email);
    const passwordMatches = await this.#passwordVerifier(input.password, user?.passwordHash ?? this.#dummyPasswordHash);
    if (!passwordMatches || user?.status !== "ACTIVE") {
      await this.#writeAuthenticationFailure(context.requestId, "INVALID_CREDENTIALS");
      throw new ApplicationError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
    }

    const identity = await this.#identities.loadEffectiveIdentity(user.id);
    if (identity === null) {
      await this.#writeAuthenticationFailure(context.requestId, "INVALID_CREDENTIALS");
      throw new ApplicationError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
    }

    const created = await this.#sessions.create(
      user.id,
      createAuthorizationVersion(identity),
      context.previousSessionId
    );
    try {
      await this.#rateLimiter.resetAccount(input.email);
      await this.#audit.write(this.#auditEvent({
        action: "AUTH_LOGIN_SUCCEEDED",
        requestId: context.requestId,
        actorUserId: user.id,
        resourceId: user.id,
        metadata: null
      }));
    } catch (error) {
      await this.#sessions.revoke(created.sessionId);
      throw error;
    }
    return { sessionId: created.sessionId, data: this.#toData(identity, created.record) };
  }

  async authenticate(
    sessionId: string | undefined,
    requestId: string,
    touch = true
  ): Promise<AuthenticatedContext | null> {
    if (sessionId === undefined) return null;
    const session = await this.#sessions.resolve(sessionId);
    if (session === null) return null;

    const identity = await this.#identities.loadEffectiveIdentity(session.userId);
    if (identity === null) {
      await this.#sessions.revoke(sessionId);
      await this.#audit.write(this.#auditEvent({
        action: "AUTH_SESSION_REVOKED",
        requestId,
        actorUserId: session.userId,
        resourceId: session.userId,
        metadata: { reason: "USER_INACTIVE" }
      }));
      return null;
    }
    if (createAuthorizationVersion(identity) !== session.authorizationVersion) {
      await this.#sessions.revoke(sessionId);
      await this.#audit.write(this.#auditEvent({
        action: "AUTH_SESSION_REVOKED",
        requestId,
        actorUserId: session.userId,
        resourceId: session.userId,
        metadata: { reason: "AUTHORIZATION_CHANGED" }
      }));
      return null;
    }

    if (!touch) return { sessionId, session, identity };
    const touched = await this.#sessions.touch(sessionId, session);
    return touched === null ? null : { sessionId, session: touched, identity };
  }

  inspect(context: AuthenticatedContext): AuthenticationData {
    return this.#toData(context.identity, context.session);
  }

  validateStateChangingRequest(
    context: AuthenticatedContext,
    origin: string | undefined,
    csrfToken: string | undefined
  ): void {
    this.assertAllowedOrigin(origin);
    if (!this.#sessions.validateCsrf(context.session, csrfToken)) {
      throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
    }
  }

  async logout(
    context: AuthenticatedContext | null,
    origin: string | undefined,
    csrfToken: string | undefined,
    requestId: string
  ): Promise<void> {
    this.assertAllowedOrigin(origin);
    if (context === null) return;
    this.validateStateChangingRequest(context, origin, csrfToken);

    try {
      await this.#audit.write(this.#auditEvent({
        action: "AUTH_LOGOUT",
        requestId,
        actorUserId: context.identity.user.id,
        resourceId: context.identity.user.id,
        metadata: null
      }));
    } finally {
      await this.#sessions.revoke(context.sessionId);
    }
  }

  assertAllowedOrigin(origin: string | undefined): void {
    if (origin === undefined || !this.#allowedOrigins.has(origin)) {
      throw new ApplicationError("REQUEST_FORBIDDEN", "The request could not be authorized.", 403);
    }
  }

  #toData(identity: EffectiveIdentity, session: SessionRecord): AuthenticationData {
    return {
      user: identity.user,
      memberships: identity.memberships.map((membership) => ({
        id: membership.id,
        organization: { id: membership.organizationId, name: membership.organizationName },
        roles: membership.roles.filter((role): role is "ORG_ADMIN" | "CERTIFICATE_MANAGER" | "TEMPLATE_MANAGER" | "VIEWER" =>
          role === "ORG_ADMIN" || role === "CERTIFICATE_MANAGER" || role === "TEMPLATE_MANAGER" || role === "VIEWER"
        ),
        permissions: [...membership.permissions]
      })),
      csrf_token: session.csrfToken
    };
  }

  async #writeAuthenticationFailure(
    requestId: string,
    reason: "INVALID_CREDENTIALS" | "RATE_LIMITED"
  ): Promise<void> {
    await this.#audit.write(this.#auditEvent({
      action: "AUTH_LOGIN_FAILED",
      requestId,
      actorUserId: null,
      resourceId: null,
      metadata: { reason }
    }));
  }

  #auditEvent(input: {
    action: AuditEvent["action"];
    requestId: string;
    actorUserId: string | null;
    resourceId: string | null;
    metadata: AuditEvent["metadata"];
  }): AuditEvent {
    return {
      organizationId: null,
      actorUserId: input.actorUserId,
      actorMembershipId: null,
      action: input.action,
      resourceType: "authentication",
      resourceId: input.resourceId,
      requestId: input.requestId,
      metadata: input.metadata
    };
  }
}
