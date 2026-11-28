import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { jsonSchema } from "@purin-labs/agent-tools/define-tool";
import { defineOrganisationTool } from "./services";

/**
 * Settings › Billing for the Portal chat agent (Plan 95, "Agent access"). The
 * agent only reads. It has no tool that starts payment setup, opens the
 * payment page, turns paid use on or changes the spending limit: each of
 * these changes what the Organisation pays, so the owner does it on the page
 * (Plan 88 D11).
 */
export const billingAccountRead = defineOrganisationTool({
  name: "billing_account_read",
  description:
    "Read the billing state of this organisation, as Settings › Billing shows it: plan is the plan with its free Jev use of each month; open says if payment setup is available; paymentState is none (no payment set up), active, past_due (a payment failed, so paid use is stopped and free use continues) or canceled; freeUse is the free Jev use of this month in millionths of a US dollar, or null when the organisation's own TypeSafe key pays; paidUse says if paid use is on, the charge of this month and the monthly spending limit in US cents, and if the limit is reached. " +
    "Only the owner or an admin can read it. You cannot change billing: the owner sets up payment, turns paid use on and changes the limit on Settings › Billing and Settings › Jev.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decode: () => null,
  effect: "read",
  rerun: { kind: "any_caller", reason: "A read changes nothing." },
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.billingAccountRead,
  },
  unavailable: "billing read is unavailable",
  handler: ({ readBillingAccount }) =>
    readBillingAccount === undefined ? undefined : () => readBillingAccount(),
});
