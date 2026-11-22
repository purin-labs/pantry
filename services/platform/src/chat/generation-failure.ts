import { assertNever } from "@purin-labs/std";
import type { DirectCaseCommandError } from "@purin-labs/conversation/actors/case-direct-processing";
import type { RequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { ConversationScope } from "@purin-labs/conversation/chat/store";

/**
 * A turn that settles as a failure the person sees. `code` is the internal
 * reason; the person sees only `message`, so the code goes to the log.
 */
export class ConversationGenerationFailure extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

export function conversationCommandFailure(
  error: DirectCaseCommandError,
): ConversationGenerationFailure {
  return new ConversationGenerationFailure(
    conversationGenerationError(error),
    error.kind === "budget_exhausted" ? "budget_exhausted" : error.code,
  );
}

export function traceConversationFailure(
  requestId: RequestId,
  scope: ConversationScope,
  conversationId: string,
  failure: ConversationGenerationFailure,
): void {
  traceWarn("chat.turn_failed", {
    requestId,
    organisation_id: scope.organisationId,
    conversation_id: conversationId,
    error_code: failure.code ?? "unspecified",
  });
}

function conversationGenerationError(
  error: DirectCaseCommandError,
): string {
  if (error.kind === "budget_exhausted") {
    const { exhaustion, budget } = error;
    const suffix = ` Budget ${budget.budgetRevision}. An owner or admin can change AI budgets in Access for new sessions. Provider limits still apply.`;
    switch (exhaustion.dimension) {
      case "tokens":
        return `This session reached its token limit (${exhaustion.observedUsage.tokens} used; ${budget.maxTokens} allowed).${suffix}`;
      case "active_wall_ms":
        return `This session reached its active runtime limit (${Math.ceil(exhaustion.observedUsage.activeWallMs / 1000)} seconds used; ${budget.maxWallMs / 1000} allowed).${suffix}`;
      case "capability_calls":
        return `This session reached its tool-call limit (${exhaustion.observedUsage.capabilityCalls} used; ${budget.maxToolCalls} allowed).${suffix}`;
      default:
        return assertNever(exhaustion.dimension);
    }
  }
  switch (error.code) {
    case "session_turn:budget_exhausted":
      return "This session reached an AI budget limit. The older result does not identify which limit. An owner or admin can review AI budgets in Access before retrying.";
    case "case_waiting_for_approval":
      return "This chat waits for a decision on its approval card. Approve or reject the card, then send your message again.";
    default:
      return "The selected AI could not finish this response. Check its connection and budget, then retry.";
  }
}
