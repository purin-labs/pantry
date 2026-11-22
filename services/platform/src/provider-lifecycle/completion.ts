import {
  OrganisationExecutionScope,
  dispatchWithOrganisationPlacement,
} from "@purin-labs/tenancy/organisation-execution-scope";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import { hashOpaqueSecret } from "@purin-labs/tenancy/data/control-plane";
import {
  beginProviderProvisioning,
  consumeProviderAuthorizationState,
  failProviderAttempt,
  providerAttemptWire,
  type ProviderAuthorizationContext,
  type ProviderFailureEvidence,
} from "@purin-labs/connections/data/provider-attempt";
import type { Env } from "@purin-labs/kernel/env";
import {
  completeProviderConnection,
  parseProviderStartContext,
} from "../provider-adapters/catalogue";
import { parseActiveIntegrationProvider } from "@purin-labs/connections/data/integration-provider-directory";
import type { ProviderStartContext } from "../integrations/contract/provider-adapter";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CompleteProviderInput,
  OnboardingProvider,
  ProviderCompletion,
  ProviderOAuthAttempt,
  ProviderOnboardingError,
} from "../integrations/contract/provider-lifecycle";
import { assertNever, isRecord } from "@purin-labs/std";

export async function completeProviderOAuth(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly provider: OnboardingProvider;
  readonly url: URL;
  readonly now: number;
  readonly fetcher: typeof fetch;
}): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  const code = input.url.searchParams.get("code") ?? "";
  const state = input.url.searchParams.get("state") ?? "";
  const providerError = input.url.searchParams.get("error");
  if ((code.length === 0 && providerError === null) || state.length === 0) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  const scope = input.scope;
  if (!(await scope.isActive())) {
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  }
  const completion: CompleteProviderInput = {
    scope: scope,
    env: input.env,
    provider: input.provider,
    url: input.url,
    now: input.now,
    fetcher: dispatchWithOrganisationPlacement.bind(null, scope, input.fetcher),
  };
  const callbackEvidence =
    providerError === null ? code : `error:${providerError}`;
  const consumed = await consumeProviderAuthorizationState({
    scope: scope,
    provider: input.provider,
    stateHash: await hashOpaqueSecret(state),
    callbackCodeHash: await hashOpaqueSecret(callbackEvidence),
    now: input.now,
  });
  if (!consumed.ok) return { ok: false, error: consumed.error };
  if (consumed.value.kind === "replayed") {
    switch (consumed.value.attempt.kind) {
      case "created":
      case "authorizing":
      case "callback_received":
      case "provisioning":
        return { ok: false, error: { code: "provider_attempt_open" } };
      case "connected":
      case "cancelled":
      case "failed":
      case "expired":
        break;
      default:
        return assertNever(consumed.value.attempt);
    }
    if (!(await scope.isActive())) {
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    }
    return {
      ok: true,
      value: {
        provider: input.provider,
        attempt: providerAttemptWire(consumed.value.attempt),
        returnPath: consumed.value.returnPath,
      },
    };
  }
  const authorization = parseProviderOAuthAttempt(consumed.value.value);
  if (!authorization.ok) return authorization;
  if (providerError !== null) {
    return settleCancelledAuthorization(completion, authorization.value);
  }
  const provisioning = await beginProviderProvisioning({
    scope: scope,
    attempt: authorization.value.state.attempt,
    now: input.now,
  });
  if (!provisioning.ok) return { ok: false, error: provisioning.error };
  const provisioningAuthorization: ProviderOAuthAttempt = {
    state: {
      attempt: authorization.value.state.attempt,
      pkceVerifier: authorization.value.state.pkceVerifier,
      providerContext: authorization.value.state.providerContext,
      returnPath: authorization.value.state.returnPath,
      portalSubjectHash: authorization.value.state.portalSubjectHash,
    },
    context: authorization.value.context,
  };
  const completed = await completeProviderConnection(
    completion,
    provisioningAuthorization,
    provisioning.value,
    code,
  );
  if (!(await scope.isActive())) {
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  }
  return completed;
}

export async function resolveProviderCallbackScope(
  env: Env,
  state: string,
): Promise<Result<OrganisationExecutionScope, ProviderOnboardingError>> {
  const separator = state.indexOf(".");
  if (separator < 1 || separator === state.length - 1) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  const organisationId = parseOrganisationId(state.slice(0, separator));
  if (!organisationId.ok)
    return { ok: false, error: { code: "provider_state_invalid" } };
  return OrganisationExecutionScope.resolve(env, organisationId.value);
}

async function settleCancelledAuthorization(
  input: CompleteProviderInput,
  authorization: ProviderOAuthAttempt,
): Promise<Result<ProviderCompletion, ProviderOnboardingError>> {
  const failed = await failProviderAttempt({
    scope: input.scope,
    attempt: authorization.state.attempt,
    reasonCode: "authorization_cancelled",
    retryable: true,
    providerEvidence: emptyProviderFailureEvidence(),
    portalSubjectHash: authorization.state.portalSubjectHash,
    now: input.now,
  });
  if (!failed.ok) return { ok: false, error: failed.error };
  return {
    ok: true,
    value: {
      provider: input.provider,
      attempt: providerAttemptWire(failed.value),
      returnPath: authorization.state.returnPath,
    },
  };
}

function parseProviderOAuthAttempt(
  state: ProviderAuthorizationContext,
): Result<ProviderOAuthAttempt, ProviderOnboardingError> {
  const context = parseProviderContext(state.providerContext);
  if (!context.ok || context.value.provider !== state.attempt.provider) {
    return { ok: false, error: { code: "provider_context_invalid" } };
  }
  return { ok: true, value: { state, context: context.value } };
}

function parseProviderContext(
  raw: unknown,
): Result<ProviderStartContext, ProviderOnboardingError> {
  if (typeof raw !== "string") {
    return { ok: false, error: { code: "provider_context_invalid" } };
  }
  try {
    const value: unknown = JSON.parse(raw);
    const provider = isRecord(value)
      ? parseActiveIntegrationProvider(value.provider)
      : null;
    if (provider === null) {
      return { ok: false, error: { code: "provider_context_invalid" } };
    }
    const context = parseProviderStartContext(provider, value);
    return context === null
      ? { ok: false, error: { code: "provider_context_invalid" } }
      : { ok: true, value: context };
  } catch {
    return { ok: false, error: { code: "provider_context_invalid" } };
  }
}

function emptyProviderFailureEvidence(): ProviderFailureEvidence {
  return { redactedProviderStatus: null, redactedProviderRequestId: null };
}
