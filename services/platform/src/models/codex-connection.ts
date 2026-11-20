import type { OrganisationDatabase } from "../database-handles";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
  organisationPlacementPredicate,
  type OrganisationExecutionScopeError,
} from "../organisation-execution-scope";
import {
  newCodexAuthorizationAttemptId,
  newRequestId,
  parseCodexAuthorizationAttemptId,
  parseOrganisationId,
  type CodexAuthorizationAttemptId,
  type UserId,
  type OrganisationId,
} from "../ids";
import { traceWarn } from "../observability";
import type { Env } from "../env";
import type { Result } from "../result";
import type { CredentialVaultBindings } from "../credential-vault/keyring";
import {
  modelProviderFetch,
  type ModelExitBinding,
} from "../model-exit/provider-fetch";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import {
  resolveVaultHandle,
  revokeVaultSecret,
  storeVaultSecret,
} from "../credential-vault/service";
import {
  assertNever,
  isPositiveInteger,
  isRecord,
  parseJsonOrNull,
} from "@purin-labs/std";
import type { CodexAllowance } from "@purin-labs/control-api";
import {
  chatGptAccessTokenExpiry,
  chatGptAllowanceFromHeaders,
  chatGptPlanType,
  parseChatGptAuthProfile,
  pollChatGptDeviceAuthorization,
  readChatGptAllowance,
  refreshChatGptAuthProfile,
  serializeChatGptAuthProfile,
  startChatGptDeviceAuthorization,
  type ChatGptAuthProfile,
  type ChatGptDeviceAuthorization,
  type ChatGptDeviceAuthorizationStatus,
} from "./chatgpt-oauth";
import {
  chatGptAgentPlanType,
  exchangeChatGptAgentCode,
  parseChatGptAgentCallback,
  parseChatGptAgentProfile,
  parseChatGptAgentSignIn,
  refreshChatGptAgentProfile,
  serializeChatGptAgentProfile,
  serializeChatGptAgentSignIn,
  startChatGptAgentSignIn,
  type ChatGptAgentProfile,
  type ChatGptAgentReuse,
  type ChatGptAgentSignIn,
} from "./chatgpt-agent-oauth";

/** How long a person has to finish a sign-in. */
const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
/** A token that expires sooner than this is refreshed before its use. */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_LEASE_MS = 60_000;
const REFRESH_WAIT_MS = 30_000;
/** A Portal read asks the backend for the allowance at most this often. */
const ALLOWANCE_READ_INTERVAL_MS = 5 * 60 * 1000;
/** A sign-in that has not refreshed for this long refreshes at the cron. */
const WEEKLY_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** One cron run refreshes at most this many sign-ins in each database. */
const WEEKLY_REFRESH_BATCH = 50;

type CodexActionRequiredReason =
  | "authorization_expired"
  | "workspace_access_revoked"
  | "device_authorization_unavailable"
  | "allowance_exhausted"
  | "account_unavailable";

/**
 * The sign-in that a connection holds. `codex_device` is the Codex CLI
 * sign-in that calls chatgpt.com (Plan 72). `chatgpt_agent` is "Sign in with
 * ChatGPT", which calls api.openai.com (Plan 74B). The Vault handle kind of
 * the profile names it, so no D1 column is needed while both exist.
 */
export type ChatGptSignInKind = "codex_device" | "chatgpt_agent";

export type OrganisationCodexConnection =
  | {
      readonly kind: "disconnected";
      readonly organisationId: OrganisationId;
      readonly revision: 0;
    }
  | {
      readonly kind: "authorizing";
      readonly organisationId: OrganisationId;
      readonly revision: number;
      readonly attempt: CodexAuthorizationAttempt;
    }
  | {
      readonly kind: "connected";
      readonly organisationId: OrganisationId;
      readonly revision: number;
      readonly authProfileGeneration: number;
      readonly signIn: ChatGptSignInKind;
      readonly planType: string;
      readonly allowance: CodexAllowance;
      readonly connectedAt: number;
      readonly verifiedAt: number;
    }
  | {
      readonly kind: "action_required";
      readonly organisationId: OrganisationId;
      readonly revision: number;
      readonly authProfileGeneration: number;
      readonly signIn: ChatGptSignInKind;
      readonly planType: string;
      readonly allowance: CodexAllowance;
      readonly reason: CodexActionRequiredReason;
      readonly observedAt: number;
    };

type CodexAuthorizationAttempt = {
  readonly attemptId: CodexAuthorizationAttemptId;
  /**
   * `device_code`: the person types `userCode` at OpenAI, and Pantry polls.
   * `pasted_callback`: the person opens `verificationUrl`, approves, and
   * pastes the address of the callback page into Portal.
   */
  readonly method: "device_code" | "pasted_callback";
  readonly verificationUrl: string;
  /** Null for the pasted-callback sign-in, which has no code to type. */
  readonly userCode: string | null;
  readonly expiresAt: number;
};

export type CodexConnectionError =
  | OrganisationExecutionScopeError
  | { readonly code: "codex_connection_invalid" }
  | { readonly code: "codex_authorization_not_found" }
  | { readonly code: "codex_authorization_expired" }
  | { readonly code: "codex_authorization_failed" }
  | { readonly code: "codex_device_authorization_unavailable" }
  | { readonly code: "codex_sign_in_address_invalid" }
  | { readonly code: "codex_plan_usage_not_allowed" }
  | { readonly code: "codex_sign_in_unavailable" }
  | { readonly code: "codex_vault_unavailable" };

type ConnectionRow = {
  readonly lifecycle: unknown;
  readonly revision: unknown;
  readonly authProfileHandle: unknown;
  readonly authProfileGeneration: unknown;
  readonly planType: unknown;
  readonly actionRequiredReason: unknown;
  readonly allowanceJson: unknown;
  readonly connectedAt: unknown;
  readonly verifiedAt: unknown;
  readonly observedAt: unknown;
  readonly refreshLease: unknown;
  readonly refreshUntil: unknown;
};

type PinnedProfileRow = Readonly<{
  handle: VaultHandle;
  lease: Readonly<{ until: number }> | null;
}>;

type WeeklyRefreshRow = {
  readonly organisationId: unknown;
  readonly revision: unknown;
  readonly generation: unknown;
};

type AttemptRow = {
  readonly attemptId: unknown;
  readonly attemptSecretHandle: unknown;
  readonly expiresAt: unknown;
};

/** The connection a Session pinned: its revision and profile generation. */
type ChatGptConnectionPin = Readonly<{
  revision: number;
  generation: number;
}>;

/**
 * `keys` holds the vault roots and the model exit Worker, which sends each
 * request to OpenAI (Plan 73).
 */
type ConnectionContext = Readonly<{
  scope: OrganisationExecutionScope;
  keys: CredentialVaultBindings & ModelExitBinding;
}>;

/** The Vault handle kinds of each sign-in's profile and open attempt. */
const CODEX_PROFILE_HANDLE_KIND = "vault:codex_auth_profile:";
const CODEX_DEVICE_HANDLE_KIND = "vault:codex_device_authorization:";
const AGENT_PROFILE_HANDLE_KIND = "vault:chatgpt_agent_profile:";
const AGENT_SIGN_IN_HANDLE_KIND = "vault:chatgpt_agent_sign_in:";

/** The tokens of one connection, with the sign-in that issued them. */
type ChatGptSignInProfile =
  | Readonly<{ kind: "codex_device"; profile: ChatGptAuthProfile }>
  | Readonly<{ kind: "chatgpt_agent"; profile: ChatGptAgentProfile }>;

/** What an open sign-in waits for. */
type AttemptSecret =
  | Readonly<{ kind: "device_code"; device: ChatGptDeviceAuthorization }>
  | Readonly<{ kind: "pasted_callback"; signIn: ChatGptAgentSignIn }>;

export async function readOrganisationCodexConnection(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly reconcile: boolean;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const resolvedScope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolvedScope.ok) return resolvedScope;
  return readOrganisationCodexConnectionAtScope({
    env: input.env,
    scope: resolvedScope.value,
    now: input.now,
    reconcile: input.reconcile,
  });
}

/**
 * The connection as Portal and the model route see it. With `reconcile`, an
 * open device-code sign-in polls the authorization server once, and a Codex
 * connection whose allowance was not read for a while reads it from the
 * ChatGPT backend.
 */
export async function readOrganisationCodexConnectionAtScope(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly now: number;
  readonly reconcile: boolean;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const scope = input.scope;
  if (!(await scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };

  const openAttempt = await readOpenAttempt(
    scope.database,
    scope.organisationId,
  );
  if (openAttempt !== null) {
    const attempt = await resolveAttempt(
      scope,
      input.env,
      scope.organisationId,
      openAttempt,
    );
    if (!attempt.ok) return attempt;
    if (input.now >= attempt.value.expiresAt) {
      await expireAttempt(
        scope.database,
        scope.organisationId,
        attempt.value.attemptId,
        input.now,
      );
      await revokeAttemptSecret(
        scope.database,
        scope.organisationId,
        openAttempt,
        input.now,
      );
    } else if (input.reconcile) {
      return reconcileAttempt(
        scope,
        input.env,
        scope.organisationId,
        attempt.value,
        input.now,
      );
    } else {
      return authorizingProjection(
        scope.database,
        scope.organisationId,
        attempt.value,
      );
    }
  }

  const connection = await readConnectionRow(
    scope.database,
    scope.organisationId,
  );
  if (connection === null) {
    return {
      ok: true,
      value: {
        kind: "disconnected",
        organisationId: scope.organisationId,
        revision: 0,
      },
    };
  }
  const parsed = parseConnectionRow(
    scope.organisationId,
    connection,
    input.now,
  );
  if (!parsed.ok) return parsed;
  const current = parsed.value;
  if (
    current.kind === "action_required" &&
    current.reason === "allowance_exhausted" &&
    !input.reconcile &&
    allowanceWindowReset(current.allowance, input.now)
  ) {
    await resumeExhaustedConnection(
      { scope, keys: input.env },
      { revision: current.revision, generation: current.authProfileGeneration },
      current.allowance,
      input.now,
    );
    return readOrganisationCodexConnectionAtScope({
      ...input,
      reconcile: false,
    });
  }
  if (
    input.reconcile &&
    (current.kind === "connected" ||
      (current.kind === "action_required" &&
        current.reason === "allowance_exhausted")) &&
    // OpenAI reports no allowance to "Sign in with ChatGPT" (Plan 74B).
    current.signIn === "codex_device" &&
    allowanceReadDue(connection, input.now)
  ) {
    const pin = {
      revision: current.revision,
      generation: current.authProfileGeneration,
    };
    if (await claimAllowanceRead(scope, pin, input.now))
      await observeChatGptAllowance({ scope, keys: input.env }, pin, input.now);
    return readOrganisationCodexConnectionAtScope({
      ...input,
      reconcile: false,
    });
  }
  return parsed;
}

/**
 * Start a ChatGPT sign-in. Portal starts "Sign in with ChatGPT" (Plan 74B):
 * the person opens the address, approves Pantry at OpenAI, and pastes the
 * address of the callback page into Portal. A later sign-in of the
 * organisation reuses its issued client and host id, so OpenAI skips the
 * consent screen. The Codex device-code sign-in (Plan 72) stays until one
 * production turn passes on the new route; Portal no longer starts it.
 */
export async function startOrganisationCodexAuthorization(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly userId: UserId;
  readonly now: number;
  readonly reconnect: boolean;
  readonly signIn: ChatGptSignInKind;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const resolvedScope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolvedScope.ok) return resolvedScope;
  const scope = resolvedScope.value;

  const existing = await readOpenAttempt(scope.database, input.organisationId);
  if (existing !== null) {
    const attempt = await resolveAttempt(
      scope,
      input.env,
      input.organisationId,
      existing,
    );
    return attempt.ok
      ? authorizingProjection(
          scope.database,
          input.organisationId,
          attempt.value,
        )
      : attempt;
  }

  const started = await startAttemptSecret(scope, input.env, input.signIn);
  if (!started.ok) return started;
  if (input.reconnect)
    await fenceConnectedProfile(
      scope.database,
      input.organisationId,
      input.now,
    );

  const attemptId = newCodexAuthorizationAttemptId();
  const handle = requireVaultHandle(
    `${started.value.kind === "pasted_callback" ? AGENT_SIGN_IN_HANDLE_KIND : CODEX_DEVICE_HANDLE_KIND}${crypto.randomUUID()}`,
  );
  const expiresAt = input.now + AUTHORIZATION_TTL_MS;
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: input.env,
    organisationId: input.organisationId,
    handle,
    secret: {
      kind: "opaque_profile",
      ...(started.value.kind === "pasted_callback"
        ? {
            format: "chatgpt_agent_sign_in_v1",
            value: serializeChatGptAgentSignIn(started.value.signIn),
          }
        : {
            format: "codex_device_authorization_v1",
            value: JSON.stringify(started.value.device),
          }),
    },
    now: input.now,
  });
  if (!stored.ok)
    return { ok: false, error: { code: "codex_vault_unavailable" } };

  try {
    await scope.database
      .prepare(
        `INSERT INTO organisation_codex_authorization_attempt (
         attempt_id, organisation_id, user_id, lifecycle,
         attempt_secret_handle, expires_at, connection_revision,
         failure_reason_code, created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, 'awaiting_user', ?, ?, NULL, NULL, ?, ?, NULL)`,
      )
      .bind(
        attemptId,
        input.organisationId,
        input.userId,
        handle,
        expiresAt,
        input.now,
        input.now,
      )
      .run();
  } catch (error) {
    await revokeVaultSecret({
      db: scope.database,
      organisationId: input.organisationId,
      handle,
      now: input.now,
    });
    throw error;
  }

  return authorizingProjection(
    scope.database,
    input.organisationId,
    attemptOf(attemptId, started.value, expiresAt),
  );
}

/** What a new sign-in waits for: a device code, or the pasted address. */
async function startAttemptSecret(
  scope: OrganisationExecutionScope,
  env: Env,
  signIn: ChatGptSignInKind,
): Promise<Result<AttemptSecret, CodexConnectionError>> {
  switch (signIn) {
    case "chatgpt_agent": {
      const started = await startChatGptAgentSignIn(
        await readAgentSignInReuse({ scope, keys: env }),
      );
      return {
        ok: true,
        value: { kind: "pasted_callback", signIn: started.signIn },
      };
    }
    case "codex_device": {
      const device = await startChatGptDeviceAuthorization(
        modelProviderFetch(env),
      );
      return device.ok
        ? { ok: true, value: { kind: "device_code", device: device.value } }
        : {
            ok: false,
            error: { code: "codex_device_authorization_unavailable" },
          };
    }
    default:
      return assertNever(signIn, "Unhandled ChatGPT sign-in value");
  }
}

function attemptOf(
  attemptId: CodexAuthorizationAttemptId,
  secret: AttemptSecret,
  expiresAt: number,
): CodexAuthorizationAttempt {
  return secret.kind === "device_code"
    ? {
        attemptId,
        method: "device_code",
        verificationUrl: secret.device.verificationUrl,
        userCode: secret.device.userCode,
        expiresAt,
      }
    : {
        attemptId,
        method: "pasted_callback",
        verificationUrl: secret.signIn.authorizationUrl,
        userCode: null,
        expiresAt,
      };
}

/**
 * Finish "Sign in with ChatGPT" with the callback address that the person
 * pasted. An address that is not this sign-in's callback leaves the sign-in
 * open for another paste. A refusal at OpenAI ends it.
 */
export async function completeOrganisationChatGptSignIn(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly attemptId: CodexAuthorizationAttemptId;
  readonly callbackUrl: unknown;
  readonly now: number;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const resolvedScope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolvedScope.ok) return resolvedScope;
  const scope = resolvedScope.value;
  const row = await readOpenAttempt(scope.database, input.organisationId);
  if (row === null || parseAttemptId(row.attemptId) !== input.attemptId)
    return { ok: false, error: { code: "codex_authorization_not_found" } };
  if (!isPositiveInteger(row.expiresAt))
    return { ok: false, error: { code: "codex_connection_invalid" } };
  if (input.now >= row.expiresAt) {
    await expireAttempt(
      scope.database,
      input.organisationId,
      input.attemptId,
      input.now,
    );
    await revokeAttemptSecret(
      scope.database,
      input.organisationId,
      row,
      input.now,
    );
    return { ok: false, error: { code: "codex_authorization_expired" } };
  }
  const secret = await resolveAttemptSecret(
    scope,
    input.env,
    input.organisationId,
    row,
  );
  if (!secret.ok) return secret;
  if (secret.value.kind !== "pasted_callback")
    return { ok: false, error: { code: "codex_authorization_not_found" } };
  const signIn = secret.value.signIn;
  const attempt = attemptOf(input.attemptId, secret.value, row.expiresAt);

  const callback = parseChatGptAgentCallback(input.callbackUrl, signIn);
  if (!callback.ok) {
    if (callback.error.code === "chatgpt_sign_in_address_invalid")
      return { ok: false, error: { code: "codex_sign_in_address_invalid" } };
    return endFailedSignIn(
      scope,
      input.env,
      row,
      attempt,
      { code: "codex_authorization_failed" },
      input.now,
    );
  }
  const exchanged = await exchangeChatGptAgentCode(
    modelProviderFetch(input.env),
    signIn,
    callback.value,
  );
  if (!exchanged.ok) {
    switch (exchanged.error.code) {
      // The code may still be unused: the person can paste it again.
      case "chatgpt_oauth_provider_unavailable":
        return { ok: false, error: { code: "codex_sign_in_unavailable" } };
      case "chatgpt_oauth_scope_missing":
        return endFailedSignIn(
          scope,
          input.env,
          row,
          attempt,
          { code: "codex_plan_usage_not_allowed" },
          input.now,
        );
      case "chatgpt_oauth_grant_refused":
        return endFailedSignIn(
          scope,
          input.env,
          row,
          attempt,
          { code: "codex_authorization_failed" },
          input.now,
        );
      default:
        return assertNever(
          exchanged.error.code,
          "Unhandled ChatGPT sign-in value",
        );
    }
  }
  return connectAuthorizedProfile(
    scope,
    input.env,
    input.organisationId,
    attempt,
    row,
    { kind: "chatgpt_agent", profile: exchanged.value },
    input.now,
  );
}

/**
 * End a sign-in that OpenAI refused. A second paste of the same address may
 * have connected first; then the connection is the answer.
 */
async function endFailedSignIn(
  scope: OrganisationExecutionScope,
  env: Env,
  row: AttemptRow,
  attempt: CodexAuthorizationAttempt,
  error: CodexConnectionError,
  now: number,
): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const open = await readOpenAttempt(scope.database, scope.organisationId);
  if (open === null || parseAttemptId(open.attemptId) !== attempt.attemptId)
    return readOrganisationCodexConnection({
      env,
      organisationId: scope.organisationId,
      now,
      reconcile: false,
    });
  await failAttempt(
    scope.database,
    scope.organisationId,
    attempt.attemptId,
    now,
  );
  await revokeAttemptSecret(scope.database, scope.organisationId, row, now);
  return { ok: false, error };
}

export async function cancelOrganisationCodexAuthorization(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly attemptId: CodexAuthorizationAttemptId;
  readonly now: number;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const resolvedScope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolvedScope.ok) return resolvedScope;
  const scope = resolvedScope.value;

  const row = await readOpenAttempt(scope.database, input.organisationId);
  if (row === null || parseAttemptId(row.attemptId) !== input.attemptId)
    return { ok: false, error: { code: "codex_authorization_not_found" } };
  await scope.database
    .prepare(
      `UPDATE organisation_codex_authorization_attempt
     SET lifecycle = 'cancelled', updated_at = ?, completed_at = ?
     WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'awaiting_user'`,
    )
    .bind(input.now, input.now, input.organisationId, input.attemptId)
    .run();
  await revokeAttemptSecret(
    scope.database,
    input.organisationId,
    row,
    input.now,
  );
  return readOrganisationCodexConnection({ ...input, reconcile: false });
}

export async function disconnectOrganisationCodex(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const resolvedScope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!resolvedScope.ok) return resolvedScope;
  const scope = resolvedScope.value;

  const connection = await readConnectionRow(
    scope.database,
    input.organisationId,
  );
  if (connection !== null && typeof connection.authProfileHandle === "string") {
    const handle = parseVaultHandle(connection.authProfileHandle);
    if (handle.ok) {
      await revokeVaultSecret({
        db: scope.database,
        organisationId: input.organisationId,
        handle: handle.value,
        now: input.now,
      });
    }
  }
  const attempt = await readOpenAttempt(scope.database, input.organisationId);
  const attemptId = attempt === null ? null : parseAttemptId(attempt.attemptId);
  if (attemptId !== null) {
    const cancelled = await cancelOrganisationCodexAuthorization({
      ...input,
      attemptId,
    });
    if (!cancelled.ok) return cancelled;
  }
  await scope.database
    .prepare(
      `DELETE FROM organisation_codex_connection WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .run();
  return {
    ok: true,
    value: {
      kind: "disconnected",
      organisationId: input.organisationId,
      revision: 0,
    },
  };
}

/**
 * The access token of the connection that a Session pinned. A token that
 * expires within five minutes is refreshed first. OpenAI rotates the refresh
 * token at each exchange, so only the request that claims the refresh lease
 * exchanges it; the others wait for its result.
 */
export async function resolveOrganisationChatGptAccessToken(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
): Promise<Result<string, CodexConnectionError>> {
  const profile = await resolveChatGptProfile(context, pin, "connected");
  return profile.ok
    ? { ok: true, value: profile.value.profile.accessToken }
    : profile;
}

/**
 * Which sign-in the pinned connection holds, from its row alone. Null when
 * the row no longer matches the pin; the token read then fails as well.
 */
export async function readOrganisationChatGptSignIn(
  scope: OrganisationExecutionScope,
  pin: ChatGptConnectionPin,
): Promise<ChatGptSignInKind | null> {
  const row = await readConnectionRow(scope.database, scope.organisationId);
  return row !== null &&
    row.revision === pin.revision &&
    row.authProfileGeneration === pin.generation
    ? signInOfRow(row)
    : null;
}

/**
 * Store what one model response says about the allowance. A refused request
 * reads the allowance again: when its limit is reached and no credits are
 * left, the connection pauses until a window resets. A token that chatgpt.com
 * rejects asks for a new sign-in. For "Sign in with ChatGPT", OpenAI asks
 * agents to sign in again only after a refused refresh, so a rejected token
 * waits for its next refresh to decide (Plan 74B).
 */
export async function recordOrganisationChatGptResponse(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  response: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
  }>,
  now: number,
): Promise<void> {
  if (response.status === 401) {
    const row = await readConnectionRow(
      context.scope.database,
      context.scope.organisationId,
    );
    if (row !== null && signInOfRow(row) === "codex_device")
      await markConnectionActionRequired(
        context.scope.database,
        context.scope.organisationId,
        pin,
        "account_unavailable",
        now,
      );
    return;
  }
  const observed = chatGptAllowanceFromHeaders(response.headers);
  if (observed !== null)
    await writeAllowance(context.scope, pin, observed, now);
  if (response.status === 429) await observeChatGptAllowance(context, pin, now);
}

async function resolveChatGptProfile(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  lifecycle: "connected" | "connected_or_exhausted",
): Promise<Result<ChatGptSignInProfile, CodexConnectionError>> {
  if (!(await context.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const pinned = await readPinnedProfile(context, pin, lifecycle);
  if (!pinned.ok) return pinned;
  const { current, profile } = pinned.value;
  if (tokenFresh(profile)) return { ok: true, value: profile };

  if (current.lease !== null) {
    if (current.lease.until <= Date.now())
      return abandonRefresh(context, pin, current);
    return waitForRefresh(context, pin, lifecycle);
  }
  return (
    (await refreshUnderLease(context, pin, current, profile)) ??
    waitForRefresh(context, pin, lifecycle)
  );
}

/**
 * Refresh each ChatGPT sign-in that has not refreshed for a week, also when
 * no turn uses it. A turn refreshes only near access-token expiry, and OpenAI
 * publishes no refresh-token lifetime. `verified_at` records the last sign-in
 * or refresh, so the due check reads no Vault secret. Only an active
 * Organisation refreshes: an archived one keeps its sign-in for the 30 days
 * before its purge, and Pantry does not use the person's ChatGPT account for
 * it.
 */
export async function runWeeklyChatGptLoginRefresh(
  env: Env,
  now: number,
): Promise<void> {
  const dueBefore = now - WEEKLY_REFRESH_AGE_MS;
  for (const database of configuredOrganisationDatabases(env)) {
    const due = await database
      .withSession("first-primary")
      .prepare(
        `SELECT c.organisation_id AS organisationId, c.revision,
         c.auth_profile_generation AS generation
       FROM organisation_codex_connection c
       JOIN organisation o ON o.organisation_id = c.organisation_id
       WHERE c.verified_at <= ? AND c.refresh_lease IS NULL
         AND (c.lifecycle = 'connected' OR c.action_required_reason = 'allowance_exhausted')
         AND o.status = 'active'
       ORDER BY c.verified_at LIMIT ?`,
      )
      .bind(dueBefore, WEEKLY_REFRESH_BATCH)
      .all<WeeklyRefreshRow>();
    for (const row of due.results) {
      const organisationId = parseOrganisationId(String(row.organisationId));
      if (
        !organisationId.ok ||
        !isPositiveInteger(row.revision) ||
        !isPositiveInteger(row.generation)
      )
        continue;
      const execution = await OrganisationExecutionScope.resolve(
        env,
        organisationId.value,
      );
      if (!execution.ok || execution.value.database !== database) continue;
      let failure: string | null;
      try {
        const refreshed = await refreshWeekOldLogin(
          { scope: execution.value, keys: env },
          { revision: row.revision, generation: row.generation },
          dueBefore,
        );
        failure = refreshed.ok ? null : refreshed.error.code;
      } catch (error) {
        failure = error instanceof Error ? error.name : "unknown";
      }
      if (failure !== null)
        traceWarn("chatgpt_login.weekly_refresh_failed", {
          requestId: newRequestId(),
          organisation_id: organisationId.value,
          reason: failure,
        });
    }
  }
}

async function refreshWeekOldLogin(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  dueBefore: number,
): Promise<Result<void, CodexConnectionError>> {
  if (!(await context.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  const pinned = await readPinnedProfile(
    context,
    pin,
    "connected_or_exhausted",
  );
  // A turn signed in again, or refreshed after the due read: nothing is due.
  if (!pinned.ok)
    return pinned.error.code === "codex_connection_invalid"
      ? { ok: true, value: undefined }
      : pinned;
  const { row, current, profile } = pinned.value;
  if (
    current.lease !== null ||
    !isPositiveInteger(row.verifiedAt) ||
    row.verifiedAt > dueBefore
  )
    return { ok: true, value: undefined };
  const refreshed = await refreshUnderLease(context, pin, current, profile);
  return refreshed === null || refreshed.ok
    ? { ok: true, value: undefined }
    : refreshed;
}

/**
 * The pinned connection row and its profile. A refresh that publishes
 * between the row read and the Vault read revokes the handle that the row
 * named, so the read starts again one time.
 */
async function readPinnedProfile(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  lifecycle: "connected" | "connected_or_exhausted",
  retried = false,
): Promise<
  Result<
    Readonly<{
      row: ConnectionRow;
      current: PinnedProfileRow;
      profile: ChatGptSignInProfile;
    }>,
    CodexConnectionError
  >
> {
  const row = await readConnectionRow(
    context.scope.database,
    context.scope.organisationId,
  );
  const current = pinnedProfileRow(row, pin, lifecycle);
  if (row === null || current === null)
    return { ok: false, error: { code: "codex_connection_invalid" } };
  const profile = await readProfile(context, current.handle);
  if (profile !== null) return { ok: true, value: { row, current, profile } };
  return retried
    ? { ok: false, error: { code: "codex_vault_unavailable" } }
    : readPinnedProfile(context, pin, lifecycle, true);
}

/**
 * Claim the refresh lease and exchange the refresh token one time. Null
 * means that another request holds the lease or changed the connection.
 */
async function refreshUnderLease(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  current: PinnedProfileRow,
  profile: ChatGptSignInProfile,
): Promise<Result<ChatGptSignInProfile, CodexConnectionError> | null> {
  const { scope } = context;
  const now = Date.now();
  const placement = organisationPlacementPredicate(scope);
  const lease = crypto.randomUUID();
  const claimed = await scope.database
    .prepare(
      `UPDATE organisation_codex_connection
     SET refresh_lease = ?, refresh_until = ?
     WHERE organisation_id = ? AND revision = ? AND auth_profile_generation = ?
       AND auth_profile_handle = ? AND refresh_lease IS NULL
       AND (lifecycle = 'connected' OR action_required_reason = 'allowance_exhausted')
       AND ${placement.sql}`,
    )
    .bind(
      lease,
      now + REFRESH_LEASE_MS,
      scope.organisationId,
      pin.revision,
      pin.generation,
      current.handle,
      ...placement.bindings,
    )
    .run();
  if (claimed.meta.changes !== 1) return null;

  const refreshed = await refreshSignInProfile(
    modelProviderFetch(context.keys),
    profile,
  );
  if (refreshed === null) {
    // An exchange can consume the refresh token even if its answer is lost.
    // Ask for a new sign-in instead of repeating an uncertain exchange.
    await scope.database
      .prepare(
        `UPDATE organisation_codex_connection
       SET lifecycle = 'action_required', action_required_reason = 'authorization_expired',
         refresh_lease = NULL, refresh_until = NULL, observed_at = ?, updated_at = ?
       WHERE organisation_id = ? AND refresh_lease = ?`,
      )
      .bind(Date.now(), Date.now(), scope.organisationId, lease)
      .run();
    return { ok: false, error: { code: "codex_authorization_expired" } };
  }
  const refreshedAt = Date.now();
  const handle = newProfileHandle(refreshed);
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: context.keys,
    organisationId: scope.organisationId,
    handle,
    secret: profileSecret(refreshed, refreshedAt),
    now: refreshedAt,
  });
  if (!stored.ok) {
    await abandonRefresh(context, pin, { handle: current.handle });
    return { ok: false, error: { code: "codex_vault_unavailable" } };
  }
  const published = await scope.database
    .prepare(
      `UPDATE organisation_codex_connection
     SET auth_profile_handle = ?, refresh_lease = NULL, refresh_until = NULL,
       verified_at = ?, updated_at = ?
     WHERE organisation_id = ? AND refresh_lease = ? AND refresh_until > ?
       AND revision = ? AND auth_profile_generation = ? AND ${placement.sql}`,
    )
    .bind(
      handle,
      refreshedAt,
      refreshedAt,
      scope.organisationId,
      lease,
      Date.now(),
      pin.revision,
      pin.generation,
      ...placement.bindings,
    )
    .run();
  if (published.meta.changes !== 1 || !(await scope.isActive())) {
    await revokeVaultSecret({
      db: scope.database,
      organisationId: scope.organisationId,
      handle,
      now: Date.now(),
    });
    return { ok: false, error: { code: "codex_connection_invalid" } };
  }
  await revokeVaultSecret({
    db: scope.database,
    organisationId: scope.organisationId,
    handle: current.handle,
    now: Date.now(),
  });
  return { ok: true, value: refreshed };
}

/** One refresh exchange of either sign-in; null when OpenAI refused it. */
async function refreshSignInProfile(
  providerFetch: typeof fetch,
  current: ChatGptSignInProfile,
): Promise<ChatGptSignInProfile | null> {
  switch (current.kind) {
    case "codex_device": {
      const refreshed = await refreshChatGptAuthProfile(
        providerFetch,
        current.profile,
      );
      return refreshed.ok
        ? { kind: current.kind, profile: refreshed.value }
        : null;
    }
    case "chatgpt_agent": {
      const refreshed = await refreshChatGptAgentProfile(
        providerFetch,
        current.profile,
      );
      return refreshed.ok
        ? { kind: current.kind, profile: refreshed.value }
        : null;
    }
    default:
      return assertNever(current, "Unhandled ChatGPT sign-in value");
  }
}

function newProfileHandle(profile: ChatGptSignInProfile): VaultHandle {
  return requireVaultHandle(
    `${profile.kind === "chatgpt_agent" ? AGENT_PROFILE_HANDLE_KIND : CODEX_PROFILE_HANDLE_KIND}${crypto.randomUUID()}`,
  );
}

function profileSecret(
  profile: ChatGptSignInProfile,
  savedAt: number,
): Parameters<typeof storeVaultSecret>[0]["secret"] {
  switch (profile.kind) {
    case "codex_device":
      return {
        kind: "opaque_profile",
        format: "codex_auth_json_v1",
        value: serializeChatGptAuthProfile(profile.profile, savedAt),
      };
    case "chatgpt_agent":
      return {
        kind: "opaque_profile",
        format: "chatgpt_agent_profile_v1",
        value: serializeChatGptAgentProfile(profile.profile),
      };
    default:
      return assertNever(profile, "Unhandled ChatGPT sign-in value");
  }
}

async function waitForRefresh(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  lifecycle: "connected" | "connected_or_exhausted",
): Promise<Result<ChatGptSignInProfile, CodexConnectionError>> {
  const deadline = Date.now() + REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    await scheduler.wait(250);
    if (!(await context.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    const row = await readConnectionRow(
      context.scope.database,
      context.scope.organisationId,
    );
    const current = pinnedProfileRow(row, pin, lifecycle);
    if (current === null)
      return { ok: false, error: { code: "codex_connection_invalid" } };
    if (current.lease !== null) {
      if (current.lease.until <= Date.now())
        return abandonRefresh(context, pin, current);
      continue;
    }
    const profile = await readProfile(context, current.handle);
    return profile !== null && tokenFresh(profile)
      ? { ok: true, value: profile }
      : { ok: false, error: { code: "codex_vault_unavailable" } };
  }
  return { ok: false, error: { code: "codex_connection_invalid" } };
}

/**
 * A lease whose holder did not publish may have consumed the refresh token.
 * Nobody repeats that exchange; the connection asks for a new sign-in.
 */
async function abandonRefresh(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  current: Readonly<{ handle: VaultHandle }>,
): Promise<Result<never, CodexConnectionError>> {
  const now = Date.now();
  await context.scope.database
    .prepare(
      `UPDATE organisation_codex_connection
     SET lifecycle = 'action_required', action_required_reason = 'authorization_expired',
       refresh_lease = NULL, refresh_until = NULL, observed_at = ?, updated_at = ?
     WHERE organisation_id = ? AND revision = ? AND auth_profile_generation = ?
       AND auth_profile_handle = ?`,
    )
    .bind(
      now,
      now,
      context.scope.organisationId,
      pin.revision,
      pin.generation,
      current.handle,
    )
    .run();
  return { ok: false, error: { code: "codex_authorization_expired" } };
}

/** Read the allowance with no turn, and pause or resume the connection. */
async function observeChatGptAllowance(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  now: number,
): Promise<void> {
  const profile = await resolveChatGptProfile(
    context,
    pin,
    "connected_or_exhausted",
  );
  // OpenAI reports no allowance to "Sign in with ChatGPT" (Plan 74B).
  if (!profile.ok || profile.value.kind !== "codex_device") return;
  const observed = await readChatGptAllowance(
    modelProviderFetch(context.keys),
    profile.value.profile,
  );
  if (!observed.ok) return;
  const exhausted =
    observed.value.limitReached &&
    observed.value.allowance.credits !== "available";
  if (exhausted) {
    await writeAllowance(context.scope, pin, observed.value, now);
    await markConnectionActionRequired(
      context.scope.database,
      context.scope.organisationId,
      pin,
      "allowance_exhausted",
      now,
    );
    return;
  }
  await resumeExhaustedConnection(context, pin, observed.value.allowance, now);
  await writeAllowance(context.scope, pin, observed.value, now);
}

async function resumeExhaustedConnection(
  context: ConnectionContext,
  pin: ChatGptConnectionPin,
  allowance: CodexAllowance,
  now: number,
): Promise<void> {
  await context.scope.database
    .prepare(
      `UPDATE organisation_codex_connection
     SET lifecycle = 'connected', action_required_reason = NULL,
       allowance_json = ?, observed_at = ?, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'action_required'
       AND action_required_reason = 'allowance_exhausted'
       AND revision = ? AND auth_profile_generation = ?`,
    )
    .bind(
      JSON.stringify(allowance),
      now,
      now,
      context.scope.organisationId,
      pin.revision,
      pin.generation,
    )
    .run();
}

async function writeAllowance(
  scope: OrganisationExecutionScope,
  pin: ChatGptConnectionPin,
  observed: Readonly<{ planType: string | null; allowance: CodexAllowance }>,
  now: number,
): Promise<void> {
  // Usage percentages describe included allowance; OpenAI also supports credits.
  await scope.database
    .prepare(
      `UPDATE organisation_codex_connection
     SET plan_type = COALESCE(?, plan_type), allowance_json = ?,
       observed_at = ?, updated_at = ?
     WHERE organisation_id = ? AND revision = ? AND auth_profile_generation = ?`,
    )
    .bind(
      observed.planType,
      JSON.stringify(observed.allowance),
      now,
      now,
      scope.organisationId,
      pin.revision,
      pin.generation,
    )
    .run();
}

async function markConnectionActionRequired(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  pin: ChatGptConnectionPin,
  reason: "account_unavailable" | "allowance_exhausted",
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_codex_connection
     SET lifecycle = 'action_required', action_required_reason = ?,
       observed_at = ?, updated_at = ?
     WHERE organisation_id = ? AND lifecycle = 'connected' AND revision = ?
       AND auth_profile_generation = ? AND refresh_lease IS NULL`,
    )
    .bind(reason, now, now, organisationId, pin.revision, pin.generation)
    .run();
}

function pinnedProfileRow(
  row: ConnectionRow | null,
  pin: ChatGptConnectionPin,
  lifecycle: "connected" | "connected_or_exhausted",
): PinnedProfileRow | null {
  if (
    row === null ||
    row.revision !== pin.revision ||
    row.authProfileGeneration !== pin.generation ||
    typeof row.authProfileHandle !== "string" ||
    !(
      row.lifecycle === "connected" ||
      (lifecycle === "connected_or_exhausted" &&
        row.lifecycle === "action_required" &&
        row.actionRequiredReason === "allowance_exhausted")
    )
  )
    return null;
  const handle = parseVaultHandle(row.authProfileHandle);
  if (!handle.ok) return null;
  if (row.refreshLease === null) return { handle: handle.value, lease: null };
  return typeof row.refreshLease === "string" &&
    isPositiveInteger(row.refreshUntil)
    ? { handle: handle.value, lease: { until: row.refreshUntil } }
    : null;
}

async function readProfile(
  context: ConnectionContext,
  handle: VaultHandle,
): Promise<ChatGptSignInProfile | null> {
  const secret = await resolveVaultHandle({
    db: context.scope.database,
    keys: context.keys,
    organisationId: context.scope.organisationId,
    handle,
  });
  if (!secret.ok || secret.value.kind !== "opaque_profile") return null;
  if (secret.value.format === "codex_auth_json_v1") {
    const profile = parseChatGptAuthProfile(secret.value.value);
    return profile === null ? null : { kind: "codex_device", profile };
  }
  if (secret.value.format === "chatgpt_agent_profile_v1") {
    const profile = parseChatGptAgentProfile(secret.value.value);
    return profile === null ? null : { kind: "chatgpt_agent", profile };
  }
  return null;
}

function tokenFresh(profile: ChatGptSignInProfile): boolean {
  const expiresAt =
    profile.kind === "chatgpt_agent"
      ? profile.profile.expiresAt
      : chatGptAccessTokenExpiry(profile.profile.accessToken);
  return (
    expiresAt !== null &&
    expiresAt - Date.now() > ACCESS_TOKEN_REFRESH_MARGIN_MS
  );
}

/** The sign-in of a connection row, from the kind of its profile handle. */
function signInOfRow(row: ConnectionRow): ChatGptSignInKind {
  return typeof row.authProfileHandle === "string" &&
    row.authProfileHandle.startsWith(AGENT_PROFILE_HANDLE_KIND)
    ? "chatgpt_agent"
    : "codex_device";
}

/**
 * The issued client, host id and ID token of the organisation's current
 * "Sign in with ChatGPT" profile, for its next sign-in. Null when the
 * organisation has none, so OpenAI registers a new client.
 */
async function readAgentSignInReuse(
  context: ConnectionContext,
): Promise<ChatGptAgentReuse | null> {
  const row = await readConnectionRow(
    context.scope.database,
    context.scope.organisationId,
  );
  if (
    row === null ||
    signInOfRow(row) !== "chatgpt_agent" ||
    typeof row.authProfileHandle !== "string"
  )
    return null;
  const handle = parseVaultHandle(row.authProfileHandle);
  if (!handle.ok) return null;
  const profile = await readProfile(context, handle.value);
  return profile?.kind === "chatgpt_agent"
    ? {
        clientId: profile.profile.clientId,
        hostId: profile.profile.hostId,
        idToken: profile.profile.idToken,
      }
    : null;
}

/**
 * Claim the Portal allowance read for this interval before it runs. A read
 * that fails still uses its interval, and of Portal reads that run at the
 * same time only one claims it. So a backend that refuses each read sees at
 * most one read in each interval, however often Portal asks.
 */
async function claimAllowanceRead(
  scope: OrganisationExecutionScope,
  pin: ChatGptConnectionPin,
  now: number,
): Promise<boolean> {
  const claimed = await scope.database
    .prepare(
      `UPDATE organisation_codex_connection SET observed_at = ?
     WHERE organisation_id = ? AND revision = ? AND auth_profile_generation = ?
       AND observed_at <= ?`,
    )
    .bind(
      now,
      scope.organisationId,
      pin.revision,
      pin.generation,
      now - ALLOWANCE_READ_INTERVAL_MS,
    )
    .run();
  return claimed.meta.changes === 1;
}

function allowanceReadDue(row: ConnectionRow, now: number): boolean {
  return (
    !isPositiveInteger(row.observedAt) ||
    now - row.observedAt >= ALLOWANCE_READ_INTERVAL_MS
  );
}

/** Whether every window that the exhausted allowance named has reset. */
function allowanceWindowReset(allowance: CodexAllowance, now: number): boolean {
  if (allowance.kind !== "available") return false;
  const resets = [allowance.resetsAt, allowance.secondaryResetsAt].filter(
    (resetAt): resetAt is number => resetAt !== null,
  );
  return resets.length > 0 && resets.every((resetAt) => resetAt <= now);
}

async function reconcileAttempt(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  attempt: CodexAuthorizationAttempt,
  now: number,
): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const row = await readOpenAttempt(scope.database, organisationId);
  if (row === null)
    return { ok: false, error: { code: "codex_authorization_not_found" } };
  const secret = await resolveAttemptSecret(scope, env, organisationId, row);
  if (!secret.ok) return secret;
  // A pasted-callback sign-in waits for the paste; there is nothing to poll.
  if (secret.value.kind === "pasted_callback")
    return authorizingProjection(scope.database, organisationId, attempt);
  const status = await pollChatGptDeviceAuthorization(
    modelProviderFetch(env),
    secret.value.device,
  );
  // The authorization server did not answer: the person can still approve.
  if (!status.ok)
    return authorizingProjection(scope.database, organisationId, attempt);
  return settleAuthorizationStatus(
    scope,
    env,
    organisationId,
    attempt,
    row,
    status.value,
    now,
  );
}

async function settleAuthorizationStatus(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  attempt: CodexAuthorizationAttempt,
  row: AttemptRow,
  status: ChatGptDeviceAuthorizationStatus,
  now: number,
): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  switch (status.kind) {
    case "awaiting_user":
      return authorizingProjection(scope.database, organisationId, attempt);
    case "failed": {
      // Another read may have used the same approval first.
      const open = await readOpenAttempt(scope.database, organisationId);
      if (open === null)
        return readOrganisationCodexConnection({
          env,
          organisationId,
          now,
          reconcile: false,
        });
      await failAttempt(scope.database, organisationId, attempt.attemptId, now);
      await revokeAttemptSecret(scope.database, organisationId, row, now);
      return { ok: false, error: { code: "codex_authorization_failed" } };
    }
    case "authorized":
      return connectAuthorizedProfile(
        scope,
        env,
        organisationId,
        attempt,
        row,
        { kind: "codex_device", profile: status.profile },
        now,
      );
    default:
      return assertNever(status, "Unhandled ChatGPT sign-in value");
  }
}

async function connectAuthorizedProfile(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  attempt: CodexAuthorizationAttempt,
  row: AttemptRow,
  profile: ChatGptSignInProfile,
  now: number,
): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const current = await readConnectionRow(scope.database, organisationId);
  const revision =
    typeof current?.revision === "number" ? current.revision + 1 : 1;
  const handle = newProfileHandle(profile);
  const stored = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId,
    handle,
    secret: profileSecret(profile, now),
    now,
  });
  if (!stored.ok)
    return { ok: false, error: { code: "codex_vault_unavailable" } };
  const { planType, allowance } = await firstAllowance(env, profile);
  const allowanceJson = JSON.stringify(allowance);
  const session = scope.database.withSession("first-primary");
  let results: D1Result[];
  try {
    results = await session.batch([
      session
        .prepare(
          `INSERT INTO organisation_codex_connection (
         organisation_id, lifecycle, revision, auth_profile_handle,
         auth_profile_generation, plan_type, action_required_reason,
         allowance_json, connected_at, verified_at, observed_at, updated_at,
         refresh_lease, refresh_until
       ) SELECT ?, 'connected', ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL
         FROM organisation_codex_authorization_attempt
        WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'awaiting_user'
       ON CONFLICT (organisation_id) DO UPDATE SET
         lifecycle = 'connected', revision = excluded.revision,
         auth_profile_handle = excluded.auth_profile_handle,
         auth_profile_generation = excluded.auth_profile_generation,
         plan_type = excluded.plan_type, action_required_reason = NULL,
         allowance_json = excluded.allowance_json,
         connected_at = excluded.connected_at, verified_at = excluded.verified_at,
         observed_at = excluded.observed_at, updated_at = excluded.updated_at,
         refresh_lease = NULL, refresh_until = NULL`,
        )
        .bind(
          organisationId,
          revision,
          handle,
          planType,
          allowanceJson,
          now,
          now,
          now,
          now,
          organisationId,
          attempt.attemptId,
        ),
      session
        .prepare(
          `UPDATE organisation_codex_authorization_attempt
       SET lifecycle = 'connected', connection_revision = ?, updated_at = ?, completed_at = ?
       WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'awaiting_user'`,
        )
        .bind(revision, now, now, organisationId, attempt.attemptId),
    ]);
  } catch (error) {
    await revokeVaultSecret({
      db: scope.database,
      organisationId,
      handle,
      now,
    });
    throw error;
  }
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    await revokeVaultSecret({
      db: scope.database,
      organisationId,
      handle,
      now,
    });
    return readOrganisationCodexConnection({
      env,
      organisationId,
      now,
      reconcile: false,
    });
  }
  if (current !== null && typeof current.authProfileHandle === "string") {
    const previous = parseVaultHandle(current.authProfileHandle);
    if (previous.ok)
      await revokeVaultSecret({
        db: scope.database,
        organisationId,
        handle: previous.value,
        now,
      });
  }
  await revokeAttemptSecret(scope.database, organisationId, row, now);
  return readOrganisationCodexConnection({
    env,
    organisationId,
    now,
    reconcile: false,
  });
}

/**
 * The plan and the allowance that a new connection starts with. The Codex
 * sign-in reads them from the ChatGPT backend. OpenAI reports no allowance
 * to "Sign in with ChatGPT".
 */
async function firstAllowance(
  env: Env,
  profile: ChatGptSignInProfile,
): Promise<Readonly<{ planType: string; allowance: CodexAllowance }>> {
  switch (profile.kind) {
    case "codex_device": {
      const usage = await readChatGptAllowance(
        modelProviderFetch(env),
        profile.profile,
      );
      return {
        planType:
          (usage.ok ? usage.value.planType : null) ??
          chatGptPlanType(profile.profile) ??
          "unknown",
        allowance: usage.ok ? usage.value.allowance : { kind: "unavailable" },
      };
    }
    case "chatgpt_agent":
      return {
        planType: chatGptAgentPlanType(profile.profile) ?? "unknown",
        allowance: { kind: "not_reported" },
      };
    default:
      return assertNever(profile, "Unhandled ChatGPT sign-in value");
  }
}

async function authorizingProjection(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  attempt: CodexAuthorizationAttempt,
): Promise<Result<OrganisationCodexConnection, CodexConnectionError>> {
  const row = await readConnectionRow(db, organisationId);
  const revision = typeof row?.revision === "number" ? row.revision : 1;
  return {
    ok: true,
    value: { kind: "authorizing", organisationId, revision, attempt },
  };
}

async function readConnectionRow(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<ConnectionRow | null> {
  return db
    .withSession("first-primary")
    .prepare(
      `SELECT lifecycle, revision, auth_profile_handle AS authProfileHandle,
       auth_profile_generation AS authProfileGeneration, plan_type AS planType,
       action_required_reason AS actionRequiredReason, allowance_json AS allowanceJson,
       connected_at AS connectedAt, verified_at AS verifiedAt, observed_at AS observedAt,
       refresh_lease AS refreshLease, refresh_until AS refreshUntil
     FROM organisation_codex_connection WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<ConnectionRow>();
}

async function readOpenAttempt(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<AttemptRow | null> {
  return db
    .withSession("first-primary")
    .prepare(
      `SELECT attempt_id AS attemptId, attempt_secret_handle AS attemptSecretHandle,
       expires_at AS expiresAt
     FROM organisation_codex_authorization_attempt
     WHERE organisation_id = ? AND lifecycle = 'awaiting_user' LIMIT 1`,
    )
    .bind(organisationId)
    .first<AttemptRow>();
}

async function resolveAttempt(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  row: AttemptRow,
): Promise<Result<CodexAuthorizationAttempt, CodexConnectionError>> {
  const attemptId = parseAttemptId(row.attemptId);
  if (attemptId === null || !isPositiveInteger(row.expiresAt)) {
    return { ok: false, error: { code: "codex_connection_invalid" } };
  }
  const secret = await resolveAttemptSecret(scope, env, organisationId, row);
  return secret.ok
    ? { ok: true, value: attemptOf(attemptId, secret.value, row.expiresAt) }
    : secret;
}

async function resolveAttemptSecret(
  scope: OrganisationExecutionScope,
  env: Env,
  organisationId: OrganisationId,
  row: AttemptRow,
): Promise<Result<AttemptSecret, CodexConnectionError>> {
  if (typeof row.attemptSecretHandle !== "string") {
    return { ok: false, error: { code: "codex_connection_invalid" } };
  }
  const handle = parseVaultHandle(row.attemptSecretHandle);
  if (!handle.ok)
    return { ok: false, error: { code: "codex_connection_invalid" } };
  const resolved = await resolveVaultHandle({
    db: scope.database,
    keys: env,
    organisationId,
    handle: handle.value,
  });
  if (!resolved.ok || resolved.value.kind !== "opaque_profile")
    return { ok: false, error: { code: "codex_vault_unavailable" } };
  if (resolved.value.format === "chatgpt_agent_sign_in_v1") {
    const signIn = parseChatGptAgentSignIn(resolved.value.value);
    return signIn === null
      ? { ok: false, error: { code: "codex_connection_invalid" } }
      : { ok: true, value: { kind: "pasted_callback", signIn } };
  }
  if (resolved.value.format !== "codex_device_authorization_v1")
    return { ok: false, error: { code: "codex_vault_unavailable" } };
  const device = parseDeviceAuthorizationSecret(resolved.value.value);
  return device.ok
    ? { ok: true, value: { kind: "device_code", device: device.value } }
    : device;
}

function parseDeviceAuthorizationSecret(
  raw: string,
): Result<ChatGptDeviceAuthorization, CodexConnectionError> {
  const parsed = parseJsonOrNull(raw);
  if (
    !isRecord(parsed) ||
    typeof parsed.deviceAuthId !== "string" ||
    parsed.deviceAuthId.length === 0 ||
    typeof parsed.verificationUrl !== "string" ||
    typeof parsed.userCode !== "string" ||
    parsed.userCode.length === 0
  ) {
    return { ok: false, error: { code: "codex_connection_invalid" } };
  }
  return {
    ok: true,
    value: {
      deviceAuthId: parsed.deviceAuthId,
      verificationUrl: parsed.verificationUrl,
      userCode: parsed.userCode,
    },
  };
}

function parseConnectionRow(
  organisationId: OrganisationId,
  row: ConnectionRow,
  now: number,
): Result<OrganisationCodexConnection, CodexConnectionError> {
  if (
    !isPositiveInteger(row.revision) ||
    !isPositiveInteger(row.authProfileGeneration) ||
    typeof row.planType !== "string" ||
    row.planType.length === 0 ||
    !isPositiveInteger(row.connectedAt) ||
    !isPositiveInteger(row.verifiedAt) ||
    !isPositiveInteger(row.observedAt) ||
    typeof row.allowanceJson !== "string"
  ) {
    return { ok: false, error: { code: "codex_connection_invalid" } };
  }
  const allowance = parseStoredAllowance(row.allowanceJson);
  if (allowance === null)
    return { ok: false, error: { code: "codex_connection_invalid" } };
  // A refresh whose holder never published may have used the refresh token.
  const refreshAbandoned =
    isPositiveInteger(row.refreshUntil) && row.refreshUntil <= now;
  if (
    row.lifecycle === "connected" &&
    row.actionRequiredReason === null &&
    !refreshAbandoned
  ) {
    return {
      ok: true,
      value: {
        kind: "connected",
        organisationId,
        revision: row.revision,
        authProfileGeneration: row.authProfileGeneration,
        signIn: signInOfRow(row),
        planType: row.planType,
        allowance,
        connectedAt: row.connectedAt,
        verifiedAt: row.verifiedAt,
      },
    };
  }
  const reason = refreshAbandoned
    ? "authorization_expired"
    : parseActionRequiredReason(row.actionRequiredReason);
  return (row.lifecycle === "action_required" || refreshAbandoned) &&
    reason !== null
    ? {
        ok: true,
        value: {
          kind: "action_required",
          organisationId,
          revision: row.revision,
          authProfileGeneration: row.authProfileGeneration,
          signIn: signInOfRow(row),
          planType: row.planType,
          allowance,
          reason,
          observedAt: row.observedAt,
        },
      }
    : { ok: false, error: { code: "codex_connection_invalid" } };
}

function parseStoredAllowance(raw: string): CodexAllowance | null {
  const value = parseJsonOrNull(raw);
  if (!isRecord(value)) return null;
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (value.kind === "not_reported") return { kind: "not_reported" };
  const credits = value.credits;
  return value.kind === "available" &&
    typeof value.usedPercent === "number" &&
    (value.resetsAt === null || typeof value.resetsAt === "number") &&
    (value.secondaryUsedPercent === null ||
      typeof value.secondaryUsedPercent === "number") &&
    (value.secondaryResetsAt === null ||
      typeof value.secondaryResetsAt === "number") &&
    (credits === "available" ||
      credits === "exhausted" ||
      credits === "unknown")
    ? {
        kind: "available",
        usedPercent: value.usedPercent,
        resetsAt: value.resetsAt,
        secondaryUsedPercent: value.secondaryUsedPercent,
        secondaryResetsAt: value.secondaryResetsAt,
        credits,
      }
    : null;
}

async function fenceConnectedProfile(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_codex_connection
     SET lifecycle = 'action_required', action_required_reason = 'authorization_expired',
       refresh_lease = NULL, refresh_until = NULL,
       observed_at = ?, updated_at = ? WHERE organisation_id = ?`,
    )
    .bind(now, now, organisationId)
    .run();
}

async function expireAttempt(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  attemptId: CodexAuthorizationAttemptId,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_codex_authorization_attempt
     SET lifecycle = 'expired', updated_at = ?, completed_at = ?
     WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'awaiting_user'`,
    )
    .bind(now, now, organisationId, attemptId)
    .run();
}

async function failAttempt(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  attemptId: CodexAuthorizationAttemptId,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE organisation_codex_authorization_attempt
     SET lifecycle = 'failed', failure_reason_code = 'authorization_failed',
       updated_at = ?, completed_at = ?
     WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'awaiting_user'`,
    )
    .bind(now, now, organisationId, attemptId)
    .run();
}

async function revokeAttemptSecret(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  row: AttemptRow,
  now: number,
): Promise<void> {
  if (typeof row.attemptSecretHandle !== "string") return;
  const handle = parseVaultHandle(row.attemptSecretHandle);
  if (handle.ok)
    await revokeVaultSecret({ db, organisationId, handle: handle.value, now });
}

function requireVaultHandle(raw: string): VaultHandle {
  const parsed = parseVaultHandle(raw);
  if (!parsed.ok) throw new Error("Codex Vault handle invariant failed");
  return parsed.value;
}

function parseAttemptId(raw: unknown): CodexAuthorizationAttemptId | null {
  if (typeof raw !== "string") return null;
  const parsed = parseCodexAuthorizationAttemptId(raw);
  return parsed.ok ? parsed.value : null;
}

function parseActionRequiredReason(
  raw: unknown,
): CodexActionRequiredReason | null {
  return raw === "authorization_expired" ||
    raw === "workspace_access_revoked" ||
    raw === "device_authorization_unavailable" ||
    raw === "allowance_exhausted" ||
    raw === "account_unavailable"
    ? raw
    : null;
}
