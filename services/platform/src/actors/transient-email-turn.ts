import type { EmbeddedHarnessModelUsage } from "@seams/contracts";
import { assertNever } from "@seams/std";

import type { Result } from "../result";
import {
  runTransientTurn,
  type TransientTeardownOutcome,
  type TransientTurnInput,
} from "./transient-turn";

export {
  createTransientHarnessSinks,
  type TransientHarnessSinkUsage,
  type TransientHarnessSinks,
} from "./transient-turn";

/**
 * The email flavour of a transient turn: the reply body is the harness's
 * final message, so the body bound is enforced here rather than in the shared
 * runner. Transcripts are not persisted; teardown failure still supersedes
 * the outcome.
 */

export type TransientEmailTurnError =
  | {
      readonly code: "transient_email_construction_failed";
      readonly detail: string;
      readonly modelUsage: null;
    }
  | {
      readonly code: "transient_email_turn_failed";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage | null;
    }
  | {
      readonly code: "transient_email_body_invalid";
      readonly modelUsage: EmbeddedHarnessModelUsage;
    }
  | {
      readonly code: "transient_email_cleanup_failed";
      readonly detail: string;
      readonly modelUsage: EmbeddedHarnessModelUsage | null;
    }
  | {
      readonly code: "transient_email_token_budget_exhausted";
      readonly modelUsage: EmbeddedHarnessModelUsage;
    };

export type TransientEmailTurnSuccess = {
  readonly body: string;
  readonly modelUsage: EmbeddedHarnessModelUsage;
};

export type TransientEmailTeardownOutcome = TransientTeardownOutcome;

export type TransientEmailTurnInput = Omit<
  TransientTurnInput<string>,
  "complete"
> & { readonly maxBodyChars: number };

export async function runTransientEmailTurn(
  input: TransientEmailTurnInput,
): Promise<Result<TransientEmailTurnSuccess, TransientEmailTurnError>> {
  const result = await runTransientTurn<string>({
    adapter: input.adapter,
    construction: input.construction,
    input: input.input,
    maxWallMs: input.maxWallMs,
    onTurnStarted: input.onTurnStarted,
    onTurnSettled: input.onTurnSettled,
    teardown: input.teardown,
    complete: validateTransientEmailBody.bind(null, input.maxBodyChars),
  });
  if (result.ok) {
    return {
      ok: true,
      value: { body: result.value.value, modelUsage: result.value.modelUsage },
    };
  }
  switch (result.error.code) {
    case "transient_turn_construction_failed":
      return {
        ok: false,
        error: {
          code: "transient_email_construction_failed",
          detail: result.error.detail,
          modelUsage: result.error.modelUsage,
        },
      };
    case "transient_turn_failed":
      return {
        ok: false,
        error: {
          code: "transient_email_turn_failed",
          detail: result.error.detail,
          modelUsage: result.error.modelUsage,
        },
      };
    case "transient_turn_output_invalid":
      return {
        ok: false,
        error: {
          code: "transient_email_body_invalid",
          modelUsage: result.error.modelUsage,
        },
      };
    case "transient_turn_cleanup_failed":
      return {
        ok: false,
        error: {
          code: "transient_email_cleanup_failed",
          detail: result.error.detail,
          modelUsage: result.error.modelUsage,
        },
      };
    case "transient_turn_token_budget_exhausted":
      return {
        ok: false,
        error: {
          code: "transient_email_token_budget_exhausted",
          modelUsage: result.error.modelUsage,
        },
      };
    default:
      return assertNever(result.error);
  }
}

function validateTransientEmailBody(
  maxBodyChars: number,
  finalMessage: string,
): Result<string, { readonly detail: string }> {
  if (finalMessage.length === 0 || finalMessage.length > maxBodyChars)
    return { ok: false, error: { detail: "body_invalid" } };
  return { ok: true, value: finalMessage };
}
