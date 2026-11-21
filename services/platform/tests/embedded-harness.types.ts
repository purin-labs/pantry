import type { AuthorizedHarnessToolResult, ModelRoute } from "@purin-labs/contracts";
import type {
  ActiveEmbeddedHarnessBackendId,
  EmbeddedHarnessBackendId,
  EmbeddedHarnessModelRouteLease,
  EmbeddedHarnessSource,
  EmbeddedHarnessTurnResult,
} from "../src/actors/embedded-harness";
import type { CanonicalHarnessCheckpointInput } from "../src/actors/agent-session-harness-checkpoint";
import type { CommitHarnessCheckpointInput } from "../src/actors/agent-session-harness-authority";
import { PLATFORM_DEFAULT_PI_MODEL } from "../src/actors/pi-model-transport";

const invalidAuthorizedRead: AuthorizedHarnessToolResult = {
  kind: "read",
  output: {
    kind: "inline",
    content: [{ kind: "text", text: "value" }],
    digest: "a".repeat(64),
  },
  authority: {
    kind: "provider_effect",
    // @ts-expect-error read results cannot carry provider-effect authority.
    receiptId: "receipt_type",
    resultDigest: "a".repeat(64),
  },
  status: "succeeded",
};

// @ts-expect-error surface effects require receipt-bound surface authority.
const invalidAuthorizedSurface: AuthorizedHarnessToolResult = {
  kind: "surface_effect",
  output: {
    kind: "inline",
    content: [{ kind: "text", text: "value" }],
    digest: "a".repeat(64),
  },
  authority: {
    kind: "read",
    resultDigest: "a".repeat(64),
  },
  status: "succeeded",
};

// @ts-expect-error backend identities reject values without an adapter.
const unsupportedBackend: EmbeddedHarnessBackendId = "unknown";

// @ts-expect-error retired checkpoints cannot select an active adapter.
const retiredActiveBackend: ActiveEmbeddedHarnessBackendId = "picocodex";

// @ts-expect-error canonical checkpoint writes accept active backends only.
const retiredCanonicalCheckpointBackend: CanonicalHarnessCheckpointInput["backendId"] =
  "picocodex";

// @ts-expect-error committed checkpoint writes accept active backends only.
const retiredCheckpointCommitBackend: CommitHarnessCheckpointInput["checkpoint"]["backendId"] =
  "picocodex";

// @ts-expect-error organisation subscription authority always fences both connection and profile generation.
const incompleteOrganisationSubscriptionRoute: ModelRoute = {
  keySource: "organisation_subscription",
  provider: "openai",
  model: "gpt-5.6-luna",
  connectionRevision: 1,
};

const modelRouteBranches: readonly ModelRoute[] = [
  {
    keySource: "platform",
    provider: "openai-compatible",
    model: PLATFORM_DEFAULT_PI_MODEL,
  },
  {
    keySource: "organisation_byo",
    provider: "openai",
    model: "gpt-5.6-luna",
    byoKeyRef: "vault:organisation:model:openai:g1",
  },
  {
    keySource: "organisation_subscription",
    provider: "openai",
    model: "gpt-5.6-luna",
    connectionRevision: 1,
    authProfileGeneration: 1,
  },
];

// @ts-expect-error platform authority is only executable with OpenAI-compatible models.
const invalidPlatformModelProvider: ModelRoute = {
  keySource: "platform",
  provider: "openai",
  model: "gpt-5.6-luna",
};

// @ts-expect-error organisation BYO authority is only executable with OpenAI models.
const invalidOrganisationByoModelProvider: ModelRoute = {
  keySource: "organisation_byo",
  provider: "openai-compatible",
  model: PLATFORM_DEFAULT_PI_MODEL,
  byoKeyRef: "vault:organisation:model:openai:g1",
};

// @ts-expect-error organisation subscription authority is only executable with OpenAI models.
const invalidOrganisationSubscriptionModelProvider: ModelRoute = {
  keySource: "organisation_subscription",
  provider: "anthropic",
  model: "claude-sonnet",
  connectionRevision: 1,
  authProfileGeneration: 1,
};

// @ts-expect-error organisation OpenAI routes require their scoped key reference.
const incompleteOrganisationOpenAiRoute: ModelRoute = {
  keySource: "organisation_byo",
  provider: "openai",
  model: "gpt-5.6-luna",
};

// @ts-expect-error Platform routes cannot carry organisation BYO identity.
const mixedPlatformRoute: ModelRoute = {
  keySource: "platform",
  provider: "openai-compatible",
  model: PLATFORM_DEFAULT_PI_MODEL,
  byoKeyRef: "vault:organisation:model:openai:g1",
};

// @ts-expect-error Subscription routes cannot carry organisation BYO identity.
const mixedSubscriptionRoute: ModelRoute = {
  keySource: "organisation_subscription",
  provider: "openai",
  model: "gpt-5.6-luna",
  connectionRevision: 1,
  authProfileGeneration: 1,
  byoKeyRef: "vault:organisation:model:openai:g1",
};

const legacyOptionsRoute: ModelRoute = {
  keySource: "platform",
  provider: "openai-compatible",
  model: PLATFORM_DEFAULT_PI_MODEL,
  // @ts-expect-error Model routes have no options bag.
  options: null,
};

// @ts-expect-error organisation OpenAI authority always carries a scoped key resolver.
const incompleteOrganisationOpenAiLease: EmbeddedHarnessModelRouteLease = {
  kind: "organisation_openai_api_key",
};

// @ts-expect-error restored construction always carries authenticated bytes.
const incompleteRestore: EmbeddedHarnessSource = { kind: "restore" };

const backendEventLeak = {
  finalMessage: "done",
  checkpoint: new ArrayBuffer(0),
  cursor: {
    turn: {
      turnId: "turn_type",
      inputId: "input_type",
      turnLeaseGeneration: 1,
      budgetRevision: "budget_type",
    },
    lastSequence: 1,
    lastEventDigest: "a".repeat(64),
  },
  modelUsage: {
    modelCalls: 1,
    callsWithUsage: 1,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    totalTokens: 2,
  },
  // @ts-expect-error backend-native events never cross the adapter result.
  backendEvent: { kind: "run.completed" },
} satisfies EmbeddedHarnessTurnResult;

void unsupportedBackend;
void retiredActiveBackend;
void retiredCanonicalCheckpointBackend;
void retiredCheckpointCommitBackend;
void modelRouteBranches;
void incompleteOrganisationOpenAiRoute;
void mixedPlatformRoute;
void mixedSubscriptionRoute;
void legacyOptionsRoute;
void invalidAuthorizedRead;
void incompleteRestore;
void incompleteOrganisationOpenAiLease;
void backendEventLeak;
