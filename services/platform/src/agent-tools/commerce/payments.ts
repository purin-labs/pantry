import { Type } from "typebox";
import { isPaymentWindow } from "../../commerce/payments-read";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { defineTool } from "../define-tool";
import { ProposalArgumentError } from "../errors";

export const paymentsRead = defineTool({
  name: "payments_read",
  description:
    "Read the shop's card payments of a time window, as staff see them on the Payments page: each payment that the provider answered, paid or declined, with its amount, channel, lines, the provider's reason for a decline and the pickup code of the order that a paid payment placed. " +
    "A try that follows a declined payment names it in follows, so the steps of one buyer's tries form one run. summary counts the runs: paid on the first try, paid after a decline, and not recovered. " +
    "Give start and end as ISO 8601 timestamps with an offset, such as the start and end of the shop's day. The window is at most 32 days, and the read lists at most 500 runs: truncated says when there are more. " +
    "It lists no payment that still waits for the provider, and no refund. It names no buyer.",
  input: Type.Object(
    {
      start: Type.String({
        description:
          "The start of the window, inclusive, as an ISO 8601 timestamp.",
      }),
      end: Type.String({
        description:
          "The end of the window, exclusive, as an ISO 8601 timestamp.",
      }),
    },
    { additionalProperties: false },
  ),
  decode: (input) => {
    const start = Date.parse(input.start);
    const end = Date.parse(input.end);
    if (!isPaymentWindow(start, end)) {
      throw new ProposalArgumentError(
        "payments_read needs a start and an end as ISO 8601 timestamps, with the start first and a window of at most 32 days. Nothing was read. Ask the person for the period if you do not know it.",
      );
    }
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  },
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.commerceEntityPlaneContext,
  },
  unavailable: "payments read is unavailable",
  handler: ({ readPayments }) =>
    readPayments === undefined ? undefined : (request) => readPayments(request),
});
