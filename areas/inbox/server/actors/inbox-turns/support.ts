import {
  createCancellableTask,
  type CancellableTask,
  type TaskCancellationReason,
} from "@purin-labs/async-control/cancellable-task";
import { readGmailInferenceEligibility } from "../../mail-inbox/contract/gmail-inference-eligibility";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { authorizeMailAssistant } from "../../mail-inbox/assistant-eligibility";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import type { Result } from "@purin-labs/kernel/result";
import type { TransientSessionExecution } from "@purin-labs/agent/actors/session/support";
import type {
  TransientMailAssistantRequest,
  TransientWhatsAppTurnReply,
  TransientWhatsAppTurnResult,
} from "./rpc";

export async function rejectMailAssistantTool(): Promise<
  import("@purin-labs/contracts").AuthorizedHarnessToolResult
> {
  const text = "Inbox assistance has no action or code tools.";
  const digest = await digestCanonical({ text });
  return {
    kind: "read",
    output: { kind: "inline", content: [{ kind: "text", text }], digest },
    authority: { kind: "read", resultDigest: digest },
    status: "failed",
  };
}

export async function reauthorizeTransientMailAssistant(
  env: Env,
  input: TransientMailAssistantRequest,
): Promise<Result<null, Readonly<{ code: string }>>> {
  const current = await authorizeMailAssistant(env, input.mailbox);
  if (!current.ok) return current;
  return current.value.sourcePin === input.sourcePin &&
    current.value.modelRouteDigest === input.modelRouteDigest
    ? { ok: true, value: null }
    : { ok: false, error: { code: "mail_assistant_authority_changed" } };
}

export async function reauthorizeTransientEmail(
  scope: OrganisationExecutionScope,
  organisationId: OrganisationId,
  modelRoute: import("@purin-labs/agent/models/route").OrganisationModelRoute,
): Promise<Result<null, Readonly<{ code: string }>>> {
  const eligibility = await readGmailInferenceEligibility({
    db: scope.database,
    organisationId,
    modelRoute,
    now: Date.now(),
  });
  return eligibility.kind === "eligible"
    ? { ok: true, value: null }
    : { ok: false, error: { code: "gmail_inference_route_blocked" } };
}

/** The byte budget for a mailbox turn's prompt with its accepted Memory. */
export const TRANSIENT_EMAIL_PROMPT_BYTES = 12_000;

export function completeTransientWhatsAppTurn(
  toolHost: import("../whatsapp-harness-tools").WhatsAppHarnessToolHost,
): Result<TransientWhatsAppTurnReply["outcome"], { detail: string }> {
  const outcome = toolHost.outcome();
  return outcome.kind === "none"
    ? { ok: false, error: { detail: "outcome_missing" } }
    : { ok: true, value: outcome };
}

export function startTransientWhatsAppSessionLifecycle(
  completion: Promise<TransientWhatsAppTurnResult>,
  transient: TransientSessionExecution,
): CancellableTask<TransientWhatsAppTurnResult, TransientWhatsAppTurnResult> {
  return createCancellableTask({
    completion,
    cancel: cancelTransientWhatsAppSessionLifecycle.bind(
      null,
      completion,
      transient,
    ),
  });
}

async function cancelTransientWhatsAppSessionLifecycle(
  completion: Promise<TransientWhatsAppTurnResult>,
  transient: TransientSessionExecution,
  _reason: TaskCancellationReason,
): Promise<TransientWhatsAppTurnResult> {
  if (transient.state.kind === "running") {
    const cancelled = await transient.state.turn.cancel();
    if (!cancelled.ok) throw new Error(cancelled.error.detail);
  }
  return completion;
}
