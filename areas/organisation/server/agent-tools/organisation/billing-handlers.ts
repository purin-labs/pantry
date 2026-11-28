import type { BillingView } from "@purin-labs/control-api/portal/billing";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";
import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
import { readMemberRecord } from "@purin-labs/tool-handlers/agent-tools/member-record-read";
import { readBillingView } from "../../billing/view";
import { BillingRequestError } from "./services";

/**
 * The billing state for the agent: the view that Settings › Billing reads.
 * The person who asked must be the owner or an admin now, as on the page. The
 * value enters the turn under a label that only the owner and the admins
 * read.
 */
export function readBillingAccountForEmbeddedHarness(
  context: SessionToolContext,
): Promise<BillingView> {
  const { scope } = context.execution;
  return readMemberRecord(context, {
    source: "billing_account",
    recordId: "billing-account",
    mayRead: (member) => roleMayConfigure(member.role),
    refusal: () =>
      new BillingRequestError(
        "Only the owner or an admin can read the billing state, and the person who asked is neither now. Nothing was read. Tell the person. Do not ask for a permission or retry.",
      ),
    read: async () => {
      const view = await readBillingView({
        env: context.env,
        scope,
        now: Date.now(),
      });
      if (!view.ok) throw new Error(`Billing read failed: ${view.error.code}`);
      return view.value;
    },
  });
}
