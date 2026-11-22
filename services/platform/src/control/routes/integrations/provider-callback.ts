import { runtimeFetch } from "@purin-labs/kernel/runtime-fetch";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import { hashOpaqueSecret } from "@purin-labs/tenancy/data/control-plane";
import type { ProviderAttemptStateWire } from "../../../data/provider-attempt";
import { parseOrganisationId } from "@purin-labs/kernel/ids";
import {
  completeProviderOAuth,
  resolveProviderCallbackScope,
} from "../../../provider-lifecycle/completion";
import type {
  OnboardingProvider,
  ProviderOnboardingError,
} from "../../../integrations/contract/provider-lifecycle";
import { requirePublicOrigin as requireConfiguredPublicOrigin } from "@purin-labs/kernel/public-origin";
import { controlError } from "../../http";
import { assertNever } from "@purin-labs/std";
import { readProviderAuthorizationState } from "../../../data/provider-authorization-state";
import {
  providerCallbackFailurePage,
  providerCompletionPage,
} from "./provider-callback-page";
import { providerErrorStatus } from "./provider-start";

export async function handleProviderCallback(
  request: Request,
  env: Env,
  url: URL,
  provider: OnboardingProvider,
): Promise<Response> {
  if (request.method !== "GET") {
    return controlError("method_not_allowed", 405);
  }
  const now = Date.now();
  const context = await readProviderCallbackContext(env, url, provider);
  if (!context.ok) {
    return providerCallbackFailurePage(
      context.error.code,
      503,
      requirePublicOrigin(env),
      "/portal",
    );
  }
  const completed = await completeProviderOAuth({
    env,
    scope: context.value.scope,
    provider,
    url,
    now,
    fetcher: runtimeFetch,
  });
  if (!completed.ok) {
    return providerCallbackFailurePage(
      completed.error.code,
      providerErrorStatus(completed.error.code),
      requirePublicOrigin(env),
      context.value.returnPath,
    );
  }
  const terminal = providerCompletionTerminal(completed.value.attempt.state);
  return providerCompletionPage(
    completed.value.provider,
    completed.value.attempt.attempt_id,
    terminal,
    requirePublicOrigin(env),
    completed.value.returnPath,
  );
}

export type ProviderCompletionTerminal =
  | { readonly kind: "connected"; readonly failureReasonCode: null }
  | { readonly kind: "cancelled"; readonly failureReasonCode: null }
  | { readonly kind: "failed"; readonly failureReasonCode: string }
  | { readonly kind: "expired"; readonly failureReasonCode: null };

function providerCompletionTerminal(
  state: ProviderAttemptStateWire,
): ProviderCompletionTerminal {
  switch (state.kind) {
    case "connected":
    case "cancelled":
    case "expired":
      return { kind: state.kind, failureReasonCode: null };
    case "failed":
      return { kind: "failed", failureReasonCode: state.reason_code };
    case "created":
    case "authorizing":
    case "callback_received":
    case "provisioning":
      throw new Error(
        `provider callback completed in open state: ${state.kind}`,
      );
    default:
      return assertNever(state);
  }
}

type ProviderCallbackContext = {
  readonly returnPath: string;
  readonly scope: OrganisationExecutionScope;
};

type ProviderCallbackContextResult =
  | { readonly ok: true; readonly value: ProviderCallbackContext }
  | {
      readonly ok: false;
      readonly error:
        | ProviderOnboardingError
        | { readonly code: "provider_callback_state_corrupt" };
    };

async function readProviderCallbackContext(
  env: Env,
  url: URL,
  provider: OnboardingProvider,
): Promise<ProviderCallbackContextResult> {
  const state = url.searchParams.get("state");
  if (state === null || state.length === 0) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  const scope = await resolveProviderCallbackScope(env, state);
  if (!scope.ok) return scope;
  const row = await readProviderAuthorizationState(
    scope.value.database,
    await hashOpaqueSecret(state),
    provider,
  );
  if (row === null) {
    return { ok: false, error: { code: "provider_state_invalid" } };
  }
  if (typeof row.organisationId !== "string") {
    return { ok: false, error: { code: "provider_callback_state_corrupt" } };
  }
  const organisationId = parseOrganisationId(row.organisationId);
  if (
    !organisationId.ok ||
    organisationId.value !== scope.value.organisationId
  ) {
    return { ok: false, error: { code: "provider_callback_state_corrupt" } };
  }
  return {
    ok: true,
    value: {
      returnPath:
        typeof row.returnPath === "string" ? row.returnPath : "/portal",
      scope: scope.value,
    },
  };
}

function requirePublicOrigin(env: Env): string {
  return requireConfiguredPublicOrigin(env.PANTRY_PUBLIC_ORIGIN);
}
