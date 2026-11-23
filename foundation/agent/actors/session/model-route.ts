import { resolveClaudeAccessToken } from "../../models/claude-connection";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId, type SessionId } from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { MODEL_EXIT_COLO_HEADER } from "../../model-exit/protocol";
import { modelProviderFetch } from "../../model-exit/provider-fetch";
import type { Result } from "@purin-labs/kernel/result";
import {
  SessionExecutionAdmission,
  admittedSessionOperation,
} from "../session-execution-admission";
import { createWorkerMessageLinkEgress } from "../../messages/link-egress";
import type { EmbeddedHarnessModelRouteLease } from "../embedded-harness";
import type { ModelRoute } from "@purin-labs/contracts";
import {
  readOrganisationChatGptSignIn,
  recordOrganisationChatGptResponse,
  resolveOrganisationChatGptAccessToken,
} from "../../models/codex-connection";
import type { ChatGptSubscriptionApi } from "../embedded-harness";
import { resolveOrganisationModelCredentialForRoute } from "@purin-labs/authority/credential-vault/index";
import { assertNever, errorMessage } from "@purin-labs/std";
import type { VariantBy } from "@purin-labs/type-utils";

/**
 * The lease reads the placement fence once, here. Its key resolver reads the
 * key and nothing else, so every holder must wrap the lease with
 * `admittedSessionModelRoute`, which checks admission after each key read and
 * before the key is released.
 */
export async function createEmbeddedHarnessModelRouteLease(input: {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly sessionId: SessionId;
  readonly modelRoute: ModelRoute;
}): Promise<
  Result<
    EmbeddedHarnessModelRouteLease,
    { readonly code: "embedded_harness_model_authority_unavailable" }
  >
> {
  if (!(await input.scope.isActive())) {
    return {
      ok: false,
      error: { code: "embedded_harness_model_authority_unavailable" },
    };
  }
  if (
    input.modelRoute.keySource === "platform" &&
    input.modelRoute.provider === "openai-compatible"
  ) {
    return {
      ok: true,
      value: {
        kind: "platform_api_key",
        resolveModelApiKey: resolveEmbeddedSessionModelApiKey.bind(
          null,
          input.env,
          {
            scope: input.scope,
            sessionId: input.sessionId,
            modelRoute: input.modelRoute,
          },
        ),
      },
    };
  }
  if (input.modelRoute.keySource === "organisation_byo") {
    return {
      ok: true,
      value: {
        kind: API_KEY_LEASE_KIND[input.modelRoute.provider],
        providerFetch: modelProviderFetch(input.env),
        resolveModelApiKey: resolveEmbeddedSessionModelApiKey.bind(
          null,
          input.env,
          {
            scope: input.scope,
            sessionId: input.sessionId,
            modelRoute: input.modelRoute,
          },
        ),
      },
    };
  }
  if (input.modelRoute.keySource === "organisation_oauth") {
    return {
      ok: true,
      value: {
        kind: "organisation_claude_oauth",
        providerFetch: modelProviderFetch(input.env),
        resolveModelApiKey: resolveEmbeddedSessionModelApiKey.bind(
          null,
          input.env,
          {
            scope: input.scope,
            sessionId: input.sessionId,
            modelRoute: input.modelRoute,
          },
        ),
      },
    };
  }
  if (
    input.modelRoute.keySource === "organisation_subscription" &&
    input.modelRoute.provider === "openai"
  ) {
    const pin = {
      revision: input.modelRoute.connectionRevision,
      generation: input.modelRoute.authProfileGeneration,
    };
    // A pin that no longer matches keeps the Codex API; its token read fails.
    const api =
      (await readOrganisationChatGptSignIn(input.scope, pin)) ===
      "chatgpt_agent"
        ? "openai_responses"
        : "chatgpt_backend";
    return {
      ok: true,
      value: {
        kind: "organisation_chatgpt_subscription",
        api,
        providerFetch: modelProviderFetch(input.env),
        resolveModelApiKey: resolveEmbeddedSessionModelApiKey.bind(
          null,
          input.env,
          {
            scope: input.scope,
            sessionId: input.sessionId,
            modelRoute: input.modelRoute,
          },
        ),
        observeResponse: observeChatGptSubscriptionResponse.bind(null, {
          env: input.env,
          scope: input.scope,
          pin,
          api,
          headersTraced: false,
          writes: { tail: Promise.resolve() },
        }),
      },
    };
  }
  return {
    ok: false,
    error: { code: "embedded_harness_model_authority_unavailable" },
  };
}

type ChatGptSubscriptionObserver = {
  readonly env: Env;
  readonly scope: OrganisationExecutionScope;
  readonly pin: { readonly revision: number; readonly generation: number };
  readonly api: ChatGptSubscriptionApi;
  /**
   * Plan 74B: OpenAI documents no allowance header for "Sign in with
   * ChatGPT". The first answer of each lease names its `x-` headers, so the
   * live gate shows if one exists. Names only, never values.
   */
  headersTraced: boolean;
  /** Allowance writes follow each other and never delay the model stream. */
  readonly writes: { tail: Promise<void> };
};

function observeChatGptSubscriptionResponse(
  observer: ChatGptSubscriptionObserver,
  response: import("../embedded-harness").ChatGptModelResponse,
): void {
  if (response.status >= 400)
    traceWarn("session.chatgpt_model_request_refused", {
      requestId: newRequestId(),
      organisation_id: observer.scope.organisationId,
      status: response.status,
      content_type: response.headers["content-type"] ?? null,
      cf_mitigated: response.headers["cf-mitigated"] ?? null,
      cf_ray: response.headers["cf-ray"] ?? null,
      // Plan 73: the data centre of the model exit Worker that sent it.
      exit_colo: response.headers[MODEL_EXIT_COLO_HEADER] ?? null,
      api: observer.api,
    });
  if (observer.api === "openai_responses" && !observer.headersTraced) {
    observer.headersTraced = true;
    traceLog("session.chatgpt_agent_response_headers", {
      requestId: newRequestId(),
      organisation_id: observer.scope.organisationId,
      status: response.status,
      names: Object.keys(response.headers)
        .filter((name) => name.startsWith("x-"))
        .sort()
        .join(","),
    });
  }
  observer.writes.tail = observer.writes.tail
    .then(
      recordOrganisationChatGptResponse.bind(
        null,
        { scope: observer.scope, keys: observer.env },
        observer.pin,
        response,
        Date.now(),
      ),
    )
    .catch(traceChatGptAllowanceFailure.bind(null, observer));
}

function traceChatGptAllowanceFailure(
  observer: ChatGptSubscriptionObserver,
  error: unknown,
): void {
  traceWarn("session.chatgpt_allowance_write_failed", {
    requestId: newRequestId(),
    organisation_id: observer.scope.organisationId,
    reason: errorMessage(error),
  });
}

/** The lease of an Organisation's own key, for each provider. */
const API_KEY_LEASE_KIND = {
  openai: "organisation_openai_api_key",
  anthropic: "organisation_anthropic_api_key",
  google: "organisation_google_api_key",
} as const satisfies Readonly<
  Record<
    VariantBy<ModelRoute, "keySource", "organisation_byo">["provider"],
    EmbeddedHarnessModelRouteLease["kind"]
  >
>;

async function resolveEmbeddedSessionModelApiKey(
  env: Env,
  authority: {
    readonly scope: OrganisationExecutionScope;
    readonly sessionId: SessionId;
    readonly modelRoute: ModelRoute;
  },
): Promise<string> {
  if (authority.sessionId.length === 0) {
    throw new Error("embedded_harness_model_authority_unavailable");
  }
  if (
    authority.modelRoute.keySource === "platform" &&
    authority.modelRoute.provider === "openai-compatible"
  ) {
    const key = env.OPENROUTER_API_KEY?.trim() ?? "";
    if (key.length === 0) {
      throw new Error("embedded_harness_model_credential_unavailable");
    }
    return key;
  }
  if (authority.modelRoute.keySource === "organisation_byo") {
    const credential = await resolveOrganisationModelCredentialForRoute({
      db: authority.scope.database,
      keys: env,
      organisationId: authority.scope.organisationId,
      provider: authority.modelRoute.provider,
      route: authority.modelRoute,
    });
    if (!credential.ok) {
      throw new Error("embedded_harness_model_credential_unavailable");
    }
    return credential.value.apiKey;
  }
  if (authority.modelRoute.keySource === "organisation_oauth") {
    const token = await resolveClaudeAccessToken(
      { scope: authority.scope, keys: env },
      authority.modelRoute,
    );
    if (!token.ok) throw new Error(token.error.code);
    return token.value;
  }
  if (authority.modelRoute.keySource === "organisation_subscription") {
    const token = await resolveOrganisationChatGptAccessToken(
      { scope: authority.scope, keys: env },
      {
        revision: authority.modelRoute.connectionRevision,
        generation: authority.modelRoute.authProfileGeneration,
      },
    );
    if (!token.ok) throw new Error(token.error.code);
    return token.value;
  }
  throw new Error("embedded_harness_model_authority_unavailable");
}

/**
 * Binds an attachment read into the session's cumulative information flow.
 *
 * The attachment's own digest is the content digest, so the observation names
 * the exact bytes that were read rather than a summary of them.
 */
export function admittedMessageLinkEgress(
  execution: SessionExecutionAdmission,
  lease: HarnessTurnLease,
  env: Env,
) {
  const egress = createWorkerMessageLinkEgress(
    env.MESSAGE_LINK_FETCH,
    execution.scope.placement,
  );
  return {
    resolve: admittedSessionOperation(execution, lease, egress.resolve),
    fetchValidated: admittedSessionOperation(
      execution,
      lease,
      egress.fetchValidated,
    ),
  };
}

export function authorizedTransientModelLease(
  lease: EmbeddedHarnessModelRouteLease,
  reauthorize: () => Promise<Result<null, Readonly<{ code: string }>>>,
): EmbeddedHarnessModelRouteLease {
  switch (lease.kind) {
    case "platform_api_key":
      return {
        kind: lease.kind,
        resolveModelApiKey: authorizedTransientModelKey.bind(
          null,
          lease.resolveModelApiKey,
          reauthorize,
        ),
      };
    case "organisation_openai_api_key":
    case "organisation_claude_oauth":
    case "organisation_anthropic_api_key":
    case "organisation_google_api_key":
      return {
        kind: lease.kind,
        providerFetch: lease.providerFetch,
        resolveModelApiKey: authorizedTransientModelKey.bind(
          null,
          lease.resolveModelApiKey,
          reauthorize,
        ),
      };
    case "organisation_chatgpt_subscription":
      return {
        kind: lease.kind,
        api: lease.api,
        providerFetch: lease.providerFetch,
        resolveModelApiKey: authorizedTransientModelKey.bind(
          null,
          lease.resolveModelApiKey,
          reauthorize,
        ),
        observeResponse: lease.observeResponse,
      };
    default:
      return assertNever(lease);
  }
}

async function authorizedTransientModelKey(
  resolve: () => Promise<string>,
  reauthorize: () => Promise<Result<null, Readonly<{ code: string }>>>,
): Promise<string> {
  const key = await resolve();
  const authorized = await reauthorize();
  if (!authorized.ok) throw new Error(authorized.error.code);
  return key;
}
