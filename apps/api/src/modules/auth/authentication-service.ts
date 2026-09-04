import {
  createTotpProvisioningUri,
  findTotpTimestep,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyRecoveryCode,
  verifyPassword,
  type LoginRateLimiter,
  type MfaSecretCipher,
  type RedisMfaChallengeStore,
  type RedisSessionStore,
  type SessionRecord
} from "@certificate-platform/auth";
import type { AuthenticationData, LoginRequest, MfaCodeRequest } from "@certificate-platform/contracts";
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

export interface MfaFactor {
  readonly encryptedTotpSecret: string;
  readonly recoveryCodeHashes: readonly string[];
  readonly lastAcceptedTimestep: number | null;
}

export interface MfaFactorProvider {
  find(userId: string): Promise<MfaFactor | null>;
  enroll(userId: string, encryptedSecret: string, recoveryHashes: readonly string[], timestep: number): Promise<boolean>;
  acceptTimestep(userId: string, timestep: number): Promise<boolean>;
  consumeRecoveryHash(userId: string, hash: string): Promise<boolean>;
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
  readonly mfaPolicy?: "DEFERRED_NON_PRODUCTION" | "REQUIRED";
  readonly mfaChallenges?: RedisMfaChallengeStore;
  readonly mfaFactors?: MfaFactorProvider;
  readonly mfaCipher?: MfaSecretCipher;
  readonly now?: () => number;
}

export type LoginResult =
  | { readonly kind: "AUTHENTICATED"; readonly sessionId: string; readonly data: AuthenticationData }
  | { readonly kind: "MFA_PENDING"; readonly challengeId: string; readonly status: "MFA_REQUIRED" }
  | { readonly kind: "MFA_PENDING"; readonly challengeId: string; readonly status: "MFA_ENROLLMENT_REQUIRED"; readonly provisioningUri: string };

export class AuthenticationService {
  readonly #sessions: RedisSessionStore;
  readonly #rateLimiter: LoginRateLimiter;
  readonly #identities: IdentityProvider;
  readonly #audit: AuditWriter;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #dummyPasswordHash: string;
  readonly #passwordVerifier: typeof verifyPassword;
  readonly #mfaPolicy: "DEFERRED_NON_PRODUCTION" | "REQUIRED";
  readonly #mfaChallenges: RedisMfaChallengeStore | undefined;
  readonly #mfaFactors: MfaFactorProvider | undefined;
  readonly #mfaCipher: MfaSecretCipher | undefined;
  readonly #now: () => number;

  constructor({ sessions, rateLimiter, identities, audit, allowedOrigins, dummyPasswordHash,
    passwordVerifier = verifyPassword, mfaPolicy = "DEFERRED_NON_PRODUCTION", mfaChallenges,
    mfaFactors, mfaCipher, now = Date.now }: AuthenticationServiceOptions) {
    this.#sessions = sessions;
    this.#rateLimiter = rateLimiter;
    this.#identities = identities;
    this.#audit = audit;
    this.#allowedOrigins = new Set(allowedOrigins);
    this.#dummyPasswordHash = dummyPasswordHash;
    this.#passwordVerifier = passwordVerifier;
    this.#mfaPolicy = mfaPolicy;
    this.#mfaChallenges = mfaChallenges;
    this.#mfaFactors = mfaFactors;
    this.#mfaCipher = mfaCipher;
    this.#now = now;
    if (mfaPolicy === "REQUIRED" && (mfaChallenges === undefined || mfaFactors === undefined || mfaCipher === undefined)) {
      throw new Error("Required MFA dependencies are unavailable");
    }
  }

  async login(input: LoginRequest, context: LoginContext): Promise<LoginResult> {
    this.assertAllowedOrigin(context.origin);
    const limit = await this.#rateLimiter.consume(input.email, context.networkAddress);
    if (!limit.allowed) {
      if (limit.auditSuggested) await this.#writeAuthenticationFailure(context.requestId, "RATE_LIMITED");
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

    if (this.#mfaPolicy === "REQUIRED") {
      if (context.previousSessionId !== undefined) await this.#sessions.revoke(context.previousSessionId);
      const factor = await this.#requiredMfaFactors().find(user.id);
      if (factor !== null) {
        const challengeId = await this.#requiredMfaChallenges().create({ userId: user.id, kind: "CHALLENGE" });
        return { kind: "MFA_PENDING", challengeId, status: "MFA_REQUIRED" };
      }
      const secret = generateTotpSecret();
      const recoveryCodes = generateRecoveryCodes();
      const challengeId = await this.#requiredMfaChallenges().create({
        userId: user.id,
        kind: "ENROLLMENT",
        secret,
        recoveryCodes: [...recoveryCodes]
      });
      return {
        kind: "MFA_PENDING",
        challengeId,
        status: "MFA_ENROLLMENT_REQUIRED",
        provisioningUri: createTotpProvisioningUri(secret, user.email)
      };
    }

    return this.#createFullSession(user.id, identity, input.email, context.requestId, context.previousSessionId);
  }

  async completeMfa(
    challengeId: string | undefined,
    input: MfaCodeRequest,
    context: LoginContext
  ): Promise<{ sessionId: string; data: AuthenticationData; recoveryCodes?: readonly string[] }> {
    this.assertAllowedOrigin(context.origin);
    if (this.#mfaPolicy !== "REQUIRED" || challengeId === undefined) this.#throwMfaFailure();
    const challenges = this.#requiredMfaChallenges();
    const challenge = await challenges.take(challengeId);
    if (challenge === null) this.#throwMfaFailure();
    const identity = await this.#identities.loadEffectiveIdentity(challenge.userId);
    if (identity === null) {
      this.#throwMfaFailure();
    }

    let recoveryCodes: readonly string[] | undefined;
    let accepted = false;
    if (challenge.kind === "ENROLLMENT") {
      const timestep = findTotpTimestep(challenge.secret!, input.code, this.#now());
      if (timestep !== null) {
        const hashes = await Promise.all(challenge.recoveryCodes!.map(hashRecoveryCode));
        accepted = await this.#requiredMfaFactors().enroll(
          challenge.userId,
          this.#requiredMfaCipher().encrypt(challenge.secret!),
          hashes,
          timestep
        );
        if (accepted) recoveryCodes = challenge.recoveryCodes;
      }
    } else {
      const factor = await this.#requiredMfaFactors().find(challenge.userId);
      if (factor !== null) {
        if (/^\d{6}$/.test(input.code)) {
          const timestep = findTotpTimestep(this.#requiredMfaCipher().decrypt(factor.encryptedTotpSecret), input.code, this.#now());
          accepted = timestep !== null && await this.#requiredMfaFactors().acceptTimestep(challenge.userId, timestep);
        } else {
          for (const hash of factor.recoveryCodeHashes) {
            if (await verifyRecoveryCode(input.code, hash)) {
              accepted = await this.#requiredMfaFactors().consumeRecoveryHash(challenge.userId, hash);
              break;
            }
          }
        }
      }
    }
    if (!accepted) {
      await challenges.recordFailure(challengeId, challenge);
      await this.#writeAuthenticationFailure(context.requestId, "INVALID_CREDENTIALS");
      this.#throwMfaFailure();
    }

    const completed = await this.#createFullSession(
      challenge.userId,
      identity,
      identity.user.email.toLowerCase(),
      context.requestId,
      context.previousSessionId
    );
    return { sessionId: completed.sessionId, data: completed.data, ...(recoveryCodes === undefined ? {} : { recoveryCodes }) };
  }

  async #createFullSession(
    userId: string,
    identity: EffectiveIdentity,
    normalizedEmail: string,
    requestId: string,
    previousSessionId: string | undefined
  ): Promise<{ kind: "AUTHENTICATED"; sessionId: string; data: AuthenticationData }> {
    const created = await this.#sessions.create(
      userId,
      createAuthorizationVersion(identity),
      previousSessionId,
      this.#mfaPolicy === "REQUIRED"
    );
    try {
      await this.#rateLimiter.resetAccount(normalizedEmail);
      await this.#audit.write(this.#auditEvent({
        action: "AUTH_LOGIN_SUCCEEDED",
        requestId,
        actorUserId: userId,
        resourceId: userId,
        metadata: null
      }));
    } catch (error) {
      await this.#sessions.revoke(created.sessionId);
      throw error;
    }
    return { kind: "AUTHENTICATED", sessionId: created.sessionId, data: this.#toData(identity, created.record) };
  }

  async authenticate(
    sessionId: string | undefined,
    requestId: string,
    touch = true
  ): Promise<AuthenticatedContext | null> {
    if (sessionId === undefined) return null;
    const session = await this.#sessions.resolve(sessionId);
    if (session === null) return null;
    if (this.#mfaPolicy === "REQUIRED" && !session.mfaVerified) {
      await this.#sessions.revoke(sessionId);
      return null;
    }

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

  #throwMfaFailure(): never {
    throw new ApplicationError("AUTHENTICATION_FAILED", "Authentication failed.", 401);
  }

  #requiredMfaChallenges(): RedisMfaChallengeStore {
    if (this.#mfaChallenges === undefined) throw new Error("MFA challenge store is unavailable");
    return this.#mfaChallenges;
  }

  #requiredMfaFactors(): MfaFactorProvider {
    if (this.#mfaFactors === undefined) throw new Error("MFA factor provider is unavailable");
    return this.#mfaFactors;
  }

  #requiredMfaCipher(): MfaSecretCipher {
    if (this.#mfaCipher === undefined) throw new Error("MFA secret cipher is unavailable");
    return this.#mfaCipher;
  }
}
