import type { SessionBudgetError } from "../agent-session-budget";
import type { SessionTurnStreamError } from "../agent-session-turn-stream";
import type { ActorTransitionCommitError } from "../actor-journal";

export const MAX_EVENT_BYTES = 16_384;

export class CompositeCommitAbort extends Error {
  constructor(
    readonly commitError: ActorTransitionCommitError | SessionTurnStreamError,
  ) {
    super(commitError.code);
  }
}

export class JournalTransitionAbort extends Error {
  constructor(readonly commitError: ActorTransitionCommitError) {
    super(commitError.code);
  }
}

export class StartedSessionBudgetAbort extends Error {
  constructor(readonly budgetError: SessionBudgetError) {
    super(budgetError.code);
  }
}
