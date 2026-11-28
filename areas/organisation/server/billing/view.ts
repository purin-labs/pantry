import type { BillingView } from "@purin-labs/control-api/portal/billing";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { stripeBillingConfig } from "@purin-labs/area-organisation-contract/server/billing/stripe-client";
import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import {
  readBillingAccount,
  readOrganisationBillingProfile,
} from "./billing-account";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * Settings › Billing (Plan 95 step 6): the plan, the payment state and the
 * Jev use of the month. The billing account row is the record of the payment
 * state; the Organisation Actor is the record of the use. The Portal page and
 * the agent's read tool share this view. The caller checks that the person is
 * the owner or an admin.
 */
export async function readBillingView(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<Result<BillingView, Readonly<{ code: string }>>> {
  const { scope } = input;
  const [profile, account] = await Promise.all([
    readOrganisationBillingProfile(scope.database, scope.organisationId),
    readBillingAccount(scope.database, scope.organisationId),
  ]);
  if (profile === null)
    return { ok: false, error: { code: "billing_organisation_not_found" } };
  const organisation = await requireActiveOrganisationActor({
    env: input.env,
    organisationId: scope.organisationId,
    now: input.now,
  });
  const jev = await organisation.readJevFeatures({
    organisationId: scope.organisationId,
  });
  if (!jev.ok) return jev;
  const { allowance, paidUse } = jev.value;
  return {
    ok: true,
    value: {
      plan: {
        id: profile.plan.id,
        name: profile.plan.name,
        freeJevUseMicrousd: profile.plan.freeJevUseMicrousd,
        highestSpendingLimitMinor: profile.plan.highestSpendingLimitMinor,
      },
      open: stripeBillingConfig(input.env) !== null,
      paymentState: account?.paymentState ?? "none",
      freeUse:
        allowance === null
          ? null
          : {
              usedMicrousd: Math.min(
                allowance.usedMicrousd,
                allowance.limitMicrousd,
              ),
              limitMicrousd: allowance.limitMicrousd,
              resetsAt: allowance.resetsAt,
            },
      paidUse: {
        enabled: paidUse.enabled,
        spentMinor: paidUse.spentMinor,
        spendingLimitMinor: paidUse.spendingLimitMinor,
        limitReached: paidUse.limitReached,
      },
    },
  };
}
