import type { PendingDecisionList } from "@purin-labs/control-api";
import { hasExactKeys, isRecord } from "@purin-labs/std";
import { defineToolFamily, jsonSchema } from "../define-tool";

/**
 * What a turn gives to the decision tools: the one read of the decisions that
 * wait for the person who asked (FND-06), with that person's own checks.
 */
export type DecisionToolServices = {
  readonly readPendingDecisions: () => Promise<PendingDecisionList>;
};

const defineDecisionTool =
  defineToolFamily<DecisionToolServices>()("decisions");

/**
 * The decisions that wait for the person who asks, as the Portal shows them to
 * that person. A turn of a person who may be asked offers it; the handler reads
 * the person's own Portal sign-in, so a Slack turn gets a refusal.
 */
export const pendingDecisionsRead = defineDecisionTool({
  name: "pending_decisions_read",
  description:
    "List the decisions that wait for the person who asks, newest first, as their Portal shows them: actions to approve, held answers and steps, permission requests and email reviews. " +
    "Use it when the person asks what waits for them. It reads only, and it shows only what this person may see; the person decides each one in the Portal. Only a Portal chat can read it.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: parsePendingDecisionsReadArgs,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: { kind: "turn", flag: "permissionRequest" },
  unavailable: "pending decisions read is unavailable",
  handler: ({ readPendingDecisions }) =>
    readPendingDecisions === undefined
      ? undefined
      : () => readPendingDecisions(),
});

function parsePendingDecisionsReadArgs(input: unknown): Record<string, never> {
  if (!isRecord(input) || !hasExactKeys(input, []))
    throw new TypeError("pending_decisions_read arguments are invalid");
  return {};
}
