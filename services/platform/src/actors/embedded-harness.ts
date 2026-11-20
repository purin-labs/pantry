import type { GoalModelCallControl } from "./goal-model-calls";
import type {
  AcceptedInputRef,
  AcceptedHarnessEventCursor,
  AuthorizedHarnessToolResult,
  EmbeddedHarnessModelUsage,
  EmbeddedHarnessBackendId,
  HarnessBuildId,
  HarnessCheckpointFormatVersion,
  HarnessHistoryCursor,
  HarnessTurnLease,
  SessionId,
  StoredMessageAttachment,
  Timestamp,
} from "@purin-labs/contracts";
import type { CancellableTask } from "@purin-labs/async-control/cancellable-task";
export type {
  EmbeddedHarnessBackendId,
  EmbeddedHarnessModelUsage,
} from "@purin-labs/contracts";

import type { Result } from "../result";
import type {
  AcceptHarnessEventInput,
  AppendHarnessHistoryInput,
  HarnessAuthorityError,
  HarnessEventAcceptance,
} from "./agent-session-harness-authority";
import type { HarnessHistoryAcceptance } from "./harness-history";
import type { HarnessHistoryRead } from "./harness-history";
import type {
  HarnessCodeModeSandbox,
  HarnessNativeCodeMode,
} from "../agent-tools/catalog/types";
/** `picocodex` and `codex` name retired backends; their checkpoints restart fresh. */
export type ActiveEmbeddedHarnessBackendId = Exclude<
  EmbeddedHarnessBackendId,
  "picocodex" | "codex"
>;

export type EmbeddedHarnessThinkingLevel = "low" | "medium" | "high";

export type EmbeddedHarnessManifest = {
  readonly backendId: ActiveEmbeddedHarnessBackendId;
  readonly harnessBuild: HarnessBuildId;
  readonly checkpointFormat: HarnessCheckpointFormatVersion;
  readonly model: string;
};

export type EmbeddedHarnessSource =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "resume_turn";
      readonly historyCursor: HarnessHistoryCursor;
      readonly history: HarnessHistoryRead;
    }
  | {
      readonly kind: "fresh_after_abandoned_inputs";
      readonly historyCursor: HarnessHistoryCursor;
      readonly history: HarnessHistoryRead;
    }
  | {
      /**
       * The persisted checkpoint belongs to a retired lineage. The adapter
       * starts without opaque continuation bytes while retaining the Actor's
       * accepted history cursor for the next append.
       */
      readonly kind: "fresh_lineage";
      readonly historyCursor: HarnessHistoryCursor | null;
      readonly history: HarnessHistoryRead;
    }
  | {
      readonly kind: "restore";
      readonly checkpoint: ArrayBuffer;
      readonly historyCursor: HarnessHistoryCursor;
      readonly history: HarnessHistoryRead;
    };

export type EmbeddedHarnessUserInput =
  | {
      readonly kind: "project_context";
      readonly snapshotDigest: string;
      readonly text: string;
    }
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "image";
      readonly dataUrl: string;
      readonly detail: "original";
      readonly attachment: StoredMessageAttachment;
    }
  | {
      /**
       * A file admitted and verified whose contents no handler could read.
       *
       * The agent sees the file's identity, class, exact media type, size, and
       * digest, and is told plainly that its contents were not read.
       */
      readonly kind: "attachment_manifest";
      readonly manifest: string;
      readonly attachment: StoredMessageAttachment;
    }
  | {
      /** Bounded text a document preparation handler extracted. */
      readonly kind: "attachment_text";
      readonly manifest: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly attachment: StoredMessageAttachment;
    }
  | {
      /**
       * Deterministic container facts for audio and video. Nothing was decoded
       * and no speech was transcribed.
       */
      readonly kind: "attachment_media";
      readonly manifest: string;
      readonly summary: string;
      readonly attachment: StoredMessageAttachment;
    };

export type HarnessToolDefinition = {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly strict: true;
  readonly parameters: Readonly<Record<string, unknown>>;
};

export type HarnessToolHost = {
  readonly mode: "hybrid";
  readonly catalogDigest: string;
  readonly definitions: readonly HarnessToolDefinition[];
  readonly codeMode: HarnessNativeCodeMode;
  executeTool(
    name: string,
    inputJson: string,
    callId: string,
  ): Promise<AuthorizedHarnessToolResult>;
};

/**
 * Sees the arguments of a direct tool call while the model writes them (Plan
 * 40B phase 7). It changes nothing and grants nothing: a board edit shows as
 * presence on the board until the Session runs the call.
 */
export type HarnessToolArgumentObserver = {
  /**
   * The arguments so far. A string shows its text so far; a number or a
   * literal shows only once the model finished it. `complete` is the final
   * value of the call's arguments.
   */
  observe(
    call: Readonly<{
      callId: string;
      name: string;
      arguments: Readonly<Record<string, unknown>>;
      complete: boolean;
    }>,
  ): void;
  /** The model stream failed: the observed calls will not run. */
  abandon(): void;
  /** Waits for the frames already sent, before a tool call runs. */
  settle(): Promise<void>;
};

/** Reaches the sandbox Worker that runs the VM of one execution. */
export type { HarnessCodeModeSandbox, HarnessNativeCodeMode };

/**
 * A route that calls the provider directly sends each model request with
 * `providerFetch`, through the model exit Worker (Plan 73). The platform
 * route calls OpenRouter with the runtime's fetch.
 */
export type EmbeddedHarnessModelRouteLease =
  | {
      readonly kind: "platform_api_key";
      resolveModelApiKey(): Promise<string>;
    }
  | {
      readonly kind: "organisation_openai_api_key";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      readonly kind: "organisation_claude_oauth";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      readonly kind: "organisation_anthropic_api_key";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      /** The organisation's own Gemini API key (spec FND-04). */
      readonly kind: "organisation_google_api_key";
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
    }
  | {
      /**
       * The organisation's ChatGPT subscription. The key is the access token
       * of its sign-in. `api` is the OpenAI API that the sign-in reaches:
       * the ChatGPT backend of the Codex sign-in (Plan 72), or the Responses
       * API of "Sign in with ChatGPT" (Plan 74B).
       */
      readonly kind: "organisation_chatgpt_subscription";
      readonly api: ChatGptSubscriptionApi;
      readonly providerFetch: typeof fetch;
      resolveModelApiKey(): Promise<string>;
      observeResponse(response: ChatGptModelResponse): void;
    };

export type ChatGptSubscriptionApi = "chatgpt_backend" | "openai_responses";

export type ChatGptModelResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
};

export type EmbeddedHarnessCheckpointBinding = {
  readonly cursor: AcceptedHarnessEventCursor | null;
  readonly modelRouteDigest: string;
  readonly instructionDigest: string;
  readonly toolCatalogDigest: string;
  readonly workspaceRevision: string;
  readonly policyRevision: string;
};

export type CanonicalHarnessEventSink = {
  acceptCanonicalHarnessEvent(
    input: AcceptHarnessEventInput,
  ): Promise<
    Result<
      HarnessEventAcceptance,
      | HarnessAuthorityError
      | { readonly code: "canonical_session_schema_mismatch" }
    >
  >;
};

export type CanonicalHarnessHistorySink = {
  appendHarnessHistory(
    input: AppendHarnessHistoryInput,
  ): Promise<
    Result<
      HarnessHistoryAcceptance,
      | HarnessAuthorityError
      | { readonly code: "canonical_session_schema_mismatch" }
    >
  >;
};

export type EmbeddedHarnessTurnResult = {
  readonly finalMessage: string;
  readonly checkpoint: ArrayBuffer;
  readonly cursor: AcceptedHarnessEventCursor;
  readonly historyCursor: HarnessHistoryCursor;
  readonly modelUsage: EmbeddedHarnessModelUsage;
};

export type EmbeddedHarnessConstructionInput = {
  readonly persistence:
    | {
        readonly kind: "actor";
        readonly storage: DurableObjectStorage;
        preflight(): void;
      }
    | { readonly kind: "transient"; readonly storage?: never };
  readonly inheritedAttachments: Readonly<
    Record<string, readonly EmbeddedHarnessUserInput[]>
  >;
  readonly inheritedHistory: readonly import("./harness-history").HarnessHistoryEntry[];
  readonly source: EmbeddedHarnessSource;
  readonly sessionId: SessionId;
  readonly acceptedInput: AcceptedInputRef;
  readonly model: string;
  readonly modelTokenAllowance: number;
  readonly goalModelCalls: GoalModelCallControl;
  readonly harnessInstructions: string;
  /** Per-turn reasoning preference. Omitted for non-Portal callers. */
  readonly thinkingLevel?: EmbeddedHarnessThinkingLevel;
  readonly modelRouteLease: EmbeddedHarnessModelRouteLease;
  readonly checkpointBinding: EmbeddedHarnessCheckpointBinding;
  readonly toolHost: HarnessToolHost;
  /**
   * The rules of a tool, by tool name: its replay rule after a lost process,
   * and what a script gets of it. The caller takes them from the one list of
   * the agent tools.
   */
  readonly toolRules: (name: string) => import("./pi-tool-replay").PiToolRules;
  /** Sees tool arguments while they stream (Plan 40B phase 7). */
  readonly toolArguments?: HarnessToolArgumentObserver;
  readonly eventSink: CanonicalHarnessEventSink;
  readonly historySink: CanonicalHarnessHistorySink;
  readonly turnLease: HarnessTurnLease;
  readonly now: () => Timestamp;
};

export type EmbeddedHarnessConstructionError =
  | { readonly code: "embedded_harness_checkpoint_invalid" }
  | { readonly code: "embedded_harness_model_unsupported" }
  | { readonly code: "embedded_harness_session_conflict" }
  | { readonly code: "embedded_harness_identity_mismatch" }
  | {
      readonly code: "embedded_harness_runtime_unavailable";
      readonly detail: string;
    }
  | {
      readonly code: "embedded_harness_construction_failed";
      readonly detail: string;
    };

export type EmbeddedHarnessUnaccountedTurnError = (
  | { readonly code: "embedded_harness_input_unsupported" }
  | { readonly code: "embedded_harness_turn_failed"; readonly detail: string }
  | {
      readonly code: "embedded_harness_history_failed";
      readonly detail: string;
    }
  | { readonly code: "embedded_harness_turn_checkpoint_invalid" }
  | { readonly code: "embedded_harness_event_invalid" }
  | { readonly code: "embedded_harness_event_order_invalid" }
  | { readonly code: "embedded_harness_event_after_terminal" }
  | { readonly code: "embedded_harness_event_queue_full" }
  | { readonly code: "embedded_harness_terminal_missing" }
  | {
      readonly code: "embedded_harness_model_usage_missing";
      /**
       * Present when the provider refused the request because the
       * credential has no allowance left. The request used nothing.
       */
      readonly refusal?: "authority_exhausted";
    }
  | {
      readonly code: "embedded_harness_event_sink_failed";
      readonly detail: string;
    }
) & {
  readonly modelUsage?: never;
  readonly allowanceTokens?: never;
  readonly cause?: never;
};

export type EmbeddedHarnessTurnError =
  | EmbeddedHarnessUnaccountedTurnError
  | {
      readonly code: "embedded_harness_turn_failed_with_usage";
      readonly cause: EmbeddedHarnessUnaccountedTurnError;
      readonly modelUsage: EmbeddedHarnessModelUsage;
      readonly allowanceTokens?: never;
    }
  | {
      readonly code: "embedded_harness_token_budget_exhausted";
      readonly allowanceTokens: number;
      readonly modelUsage: EmbeddedHarnessModelUsage;
      readonly cause?: never;
    };

export type EmbeddedHarnessCancelError = {
  readonly code: "embedded_harness_cancel_failed";
  readonly detail: string;
};

/**
 * A message from the turn's requester that joins the running turn (Plan 71).
 * The Session admitted it under `inputId`, and the harness places it under
 * the same id.
 */
export type EmbeddedHarnessSteeringInput = {
  readonly inputId: string;
  readonly input: readonly EmbeddedHarnessUserInput[];
};

/**
 * `queued`: the harness holds the input and places it before its next model
 * request. `refused`: the input did not join the turn, so the surface runs
 * it as the next turn.
 */
export type EmbeddedHarnessSteerOutcome =
  | { readonly kind: "queued"; readonly reason?: never }
  | {
      readonly kind: "refused";
      readonly reason: "turn_not_running" | "steering_unsupported";
    };

export type EmbeddedHarnessSteerError = {
  readonly code: "embedded_harness_steer_failed";
  readonly detail: string;
};

export type EmbeddedHarnessActiveTurn = {
  complete(): Promise<
    Result<EmbeddedHarnessTurnResult, EmbeddedHarnessTurnError>
  >;
  cancel(): Promise<Result<null, EmbeddedHarnessCancelError>>;
  steer(
    input: EmbeddedHarnessSteeringInput,
  ): Promise<Result<EmbeddedHarnessSteerOutcome, EmbeddedHarnessSteerError>>;
  /**
   * Ends the turn before its next model call: a call already running still
   * returns its answer and usage, and a turn cut short completes with
   * `notice` as its last answer and history entry. Runtimes without it are
   * cancelled instead.
   */
  stopAtNextStep?(notice: string): void;
};

export type EmbeddedHarnessStartTask = CancellableTask<
  Result<EmbeddedHarnessActiveTurn, EmbeddedHarnessTurnError>,
  Result<null, EmbeddedHarnessCancelError>
>;

export type EmbeddedHarnessRuntime = {
  startTurn(
    input: readonly EmbeddedHarnessUserInput[],
  ): EmbeddedHarnessStartTask;
  close(): void | Promise<void>;
};

export type EmbeddedHarnessAdapter = {
  readonly manifest: EmbeddedHarnessManifest;
  construct(
    input: EmbeddedHarnessConstructionInput,
  ): Result<EmbeddedHarnessRuntime, EmbeddedHarnessConstructionError>;
};
