import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { ActiveControlSession } from "../data/control-plane";
import { hashOpaqueSecret } from "../data/control-plane";
import type { Env } from "../env";
import {
  createAuthorizingProviderAttempt,
  providerAttemptWire,
  readResumableProviderAuthorization,
  type ProviderAttemptMutation,
} from "../data/provider-attempt";
import type { IntegrationAccount } from "../data/integration-account";
import type { OrganisationId } from "../ids";
import {
  providerAuthorizationSecret,
  providerAuthorizationUrl as buildProviderAuthorizationUrl,
  providerConfigurationIsValid,
  providerStateTtlMs,
  providerUsesPkce,
} from "../provider-adapters/catalogue";
import type { ProviderStartContext } from "../integrations/contract/provider-adapter";
import type { Result } from "../result";
import { requirePublicOrigin } from "../public-origin";
import { readSquareConfiguration } from "../provider-adapters/square";
import type {
  OnboardingProvider,
  ProviderOnboardingError,
  ProviderOAuthStartEnv,
} from "../integrations/contract/provider-lifecycle";
import { encodeBase64Url } from "@purin-labs/std";
export type { ProviderOAuthStartEnv } from "../integrations/contract/provider-lifecycle";

type ProviderAuthorizationMutationFence = Pick<
  ProviderAttemptMutation,
  "boundary" | "scope"
>;

export async function beginProviderOAuth(input: {
  readonly env: ProviderOAuthStartEnv;
  readonly session: ActiveControlSession;
  readonly organisationId: OrganisationId;
  readonly context: ProviderStartContext;
  readonly existingIntegrationAccountId:
    IntegrationAccount["integrationAccountId"] | null;
  readonly purpose: "connect" | "reconnect" | "rotate";
  readonly returnPath: string;
  readonly mutation: ProviderAttemptMutation;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly attempt: ReturnType<typeof providerAttemptWire>;
      readonly authorizationUrl: string;
      readonly receiptId: string;
    },
    ProviderOnboardingError
  >
> {
  if (
    !providerConfigurationIsValid(
      input.env,
      input.context.provider,
      input.context,
    )
  ) {
    return { ok: false, error: { code: "provider_configuration_missing" } };
  }
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) return scope;
  if (input.context.provider === "square") {
    const configuration = readSquareConfiguration(input.env);
    const organisation = await scope.value.database
      .prepare(
        "SELECT environment FROM organisation_onboarding WHERE organisation_id = ?",
      )
      .bind(input.organisationId)
      .first<{ environment: unknown }>();
    if (
      configuration.kind !== "configured" ||
      organisation?.environment !== configuration.application.environment
    ) {
      return { ok: false, error: { code: "provider_environment_mismatch" } };
    }
  }
  const providerContext = JSON.stringify(input.context);
  const resumable = await readResumableProviderAuthorization({
    db: scope.value.database,
    organisationId: input.organisationId,
    provider: input.context.provider,
    userId: input.session.userId,
    existingIntegrationAccountId: input.existingIntegrationAccountId,
    purpose: input.purpose,
    providerContext,
  });
  if (resumable !== null && resumable.attempt.expiresAt > input.now) {
    return {
      ok: true,
      value: {
        attempt: providerAttemptWire(resumable.attempt),
        authorizationUrl: await providerAuthorizationUrlForMutation({
          env: input.env,
          context: input.context,
          mutation: resumable.mutation,
        }),
        receiptId: resumable.receiptId,
      },
    };
  }
  const state = await providerAuthorizationState(
    input.env,
    input.context,
    input.mutation,
  );
  const nonce = await providerAuthorizationNonce(
    input.env,
    input.context,
    input.mutation,
  );
  const usesPkce = providerUsesPkce(input.context.provider);
  const authorizationUrl = await buildProviderAuthorizationUrl({
    env: input.env,
    context: input.context,
    state,
    redirectUri: providerCallbackUri(input.env, input.context.provider),
    pkceVerifier: usesPkce ? nonce : null,
  });
  const created = await createAuthorizingProviderAttempt({
    db: scope.value.database,
    organisationId: input.organisationId,
    provider: input.context.provider,
    userId: input.session.userId,
    existingIntegrationAccountId: input.existingIntegrationAccountId,
    purpose: input.purpose,
    portalSubjectHash: input.mutation.identity.portalSubjectHash,
    stateHash: await hashOpaqueSecret(state),
    nonceHash: await hashOpaqueSecret(nonce),
    pkceVerifier: usesPkce ? nonce : null,
    providerContext,
    returnPath: normalizeReturnPath(input.returnPath),
    expiresAt: input.now + providerStateTtlMs(input.context.provider),
    mutation: input.mutation,
    now: input.now,
  });
  if (!created.ok) return { ok: false, error: created.error };
  return {
    ok: true,
    value: {
      attempt: providerAttemptWire(created.value.attempt),
      authorizationUrl,
      receiptId: created.value.receiptId,
    },
  };
}

export async function providerAuthorizationUrlForMutation(input: {
  readonly env: ProviderOAuthStartEnv;
  readonly context: ProviderStartContext;
  readonly mutation: ProviderAuthorizationMutationFence;
}): Promise<string> {
  const state = await providerAuthorizationState(
    input.env,
    input.context,
    input.mutation,
  );
  const nonce = await providerAuthorizationNonce(
    input.env,
    input.context,
    input.mutation,
  );
  return buildProviderAuthorizationUrl({
    env: input.env,
    context: input.context,
    state,
    redirectUri: providerCallbackUri(input.env, input.context.provider),
    pkceVerifier: providerUsesPkce(input.context.provider) ? nonce : null,
  });
}

export function providerOAuthStateTtlMs(provider: OnboardingProvider): number {
  return providerStateTtlMs(provider);
}

async function providerAuthorizationState(
  env: ProviderOAuthStartEnv,
  context: ProviderStartContext,
  mutation: ProviderAuthorizationMutationFence,
): Promise<string> {
  const signature = await deriveProviderAuthorizationValue(
    env,
    context,
    mutation,
    "state",
  );
  return `${mutation.scope.organisationScope}.${signature}`;
}

function providerAuthorizationNonce(
  env: ProviderOAuthStartEnv,
  context: ProviderStartContext,
  mutation: ProviderAuthorizationMutationFence,
): Promise<string> {
  return deriveProviderAuthorizationValue(env, context, mutation, "nonce");
}

async function deriveProviderAuthorizationValue(
  env: ProviderOAuthStartEnv,
  context: ProviderStartContext,
  mutation: ProviderAuthorizationMutationFence,
  purpose: "state" | "nonce",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      providerAuthorizationKey(env, context.provider, context),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = [
    "pantry-provider-authorization-v1",
    purpose,
    context.provider,
    JSON.stringify(context),
    mutation.scope.userId,
    mutation.scope.organisationScope,
    mutation.scope.route,
    mutation.scope.operation,
    mutation.boundary.idempotencyKey,
    mutation.boundary.requestHash,
    String(mutation.boundary.expectedConfigurationVersion),
  ].join("\u0000");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

function providerAuthorizationKey(
  env: ProviderOAuthStartEnv,
  provider: OnboardingProvider,
  context?: ProviderStartContext,
): string {
  const secret = providerAuthorizationSecret(env, provider, context);
  if (secret === null) throw new Error("provider configuration missing");
  return secret;
}

export function providerCallbackUri(
  env: ProviderOAuthStartEnv,
  provider: OnboardingProvider,
): string {
  return `${providerPublicOrigin(env)}/v1/control/providers/${provider}/callback`;
}

type ProviderPublicOriginEnv = Pick<
  Env,
  "PANTRY_OAUTH_CALLBACK_ORIGIN" | "PANTRY_PUBLIC_ORIGIN"
>;

function providerPublicOrigin(env: ProviderPublicOriginEnv): string {
  return requirePublicOrigin(
    env.PANTRY_OAUTH_CALLBACK_ORIGIN ?? env.PANTRY_PUBLIC_ORIGIN,
  );
}

function normalizeReturnPath(raw: string): string {
  return raw.startsWith("/portal") && !raw.startsWith("//") ? raw : "/portal";
}
