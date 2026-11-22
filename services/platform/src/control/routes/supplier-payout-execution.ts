import type { Env } from "@purin-labs/kernel/env";
import type { AuthorizedOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import type {
  UnversionedControlMutationBoundary,
  ControlMutationReceiptScope,
} from "@purin-labs/tenancy/data/control-mutation";
import { recordCommerceMutationReceipt } from "../mutation-receipt";
import { readSupplierPayout } from "../../data/supplier-payout-store";
import { payoutIsCertified } from "../../data/supplier-payout-certification";
import { resolveSupplierPayoutProvider } from "../../payout-providers/unavailable";
import { createSupplierPayoutAttemptStore } from "../../data/supplier-payout-attempt";
import {
  resumeSupplierPayoutFunding,
  submitSupplierPayout,
} from "../../payouts/supplier-payout-service";
import { validateSupplierPayoutPlanWithLexicon } from "../../commerce/commerce-wasm";
import { readOrganisationEnvironment } from "../organisation-runtime";
import {
  readSealedPayoutPlan,
  payoutSourceReference,
} from "../../data/supplier-payout-plan";
import type { CommerceActionPath } from "../../commerce/action-model";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Executing an approved supplier payout through the governed action path.
 *
 * The action ledger decides that a person approved this, and this decides
 * whether Pantry may act on that approval. They are separate questions: an
 * approval can be genuine and still not executable, because the payout moved,
 * the economics changed, or the rail has no evidence it works.
 *
 * Nothing here re-approves. Every check below can only refuse.
 */
type ApprovedPayoutExecutionInput = Readonly<{
  request: Request;
  env: Env;
  authorized: AuthorizedOrganisationRequest;
  identity: Readonly<{
    issuer: string;
    subject: string;
    userId: string;
  }>;
  scope: ControlMutationReceiptScope;
  boundary: UnversionedControlMutationBoundary;
  organisation: unknown;
  action: unknown;
  actionNonce: string;
  path: Variant<
    CommerceActionPath,
    "submit_supplier_payout" | "resume_supplier_payout_funding"
  >;
  now: number;
}>;

export async function executeApprovedSupplierPayout(
  input: ApprovedPayoutExecutionInput,
): Promise<Response> {
  const payout = await readSupplierPayout(
    input.authorized.executionScope.database,
    input.authorized.organisationId,
    input.path.payoutId,
  );
  if (payout === undefined)
    return controlError("supplier_payout_not_found", 404);

  // The approval was given against one exact revision. A payout that has moved
  // since is not the one anybody approved, however recently.
  if (payout.revision !== input.path.expectedPayoutRevision) {
    return payoutRefusal("supplier_payout_revision_stale", payout.revision);
  }
  // And against one exact set of economics. A different digest means the quote,
  // fee, recipient or amount changed after someone agreed to them.
  if (payout.approvalDigest !== input.path.approvalDigest) {
    return payoutRefusal("supplier_payout_economics_changed", payout.revision);
  }
  if (
    input.path.kind === "submit_supplier_payout" &&
    payout.stateKind !== "approved"
  ) {
    return payoutRefusal("supplier_payout_not_approved", payout.revision);
  }
  if (
    input.path.kind === "resume_supplier_payout_funding" &&
    payout.stateKind !== "provider_action_required"
  ) {
    return payoutRefusal(
      "supplier_payout_not_funding_required",
      payout.revision,
    );
  }

  const environment = await readOrganisationEnvironment(
    input.authorized.executionScope.database,
    input.authorized.organisationId,
  );
  if (environment === null) return controlError("organisation_not_found", 404);

  // An uncertified rail stays disabled. This is checked here as well as inside
  // the payout service, because the governed path is a second door into the
  // same room and a door that skipped the check would be the one people used.
  const plan = readSealedPayoutPlan(payout, input.authorized.organisationId);
  if (plan === null)
    return payoutRefusal("supplier_payout_plan_invalid", payout.revision);
  const certified = await payoutIsCertified({
    db: input.authorized.executionScope.database,
    organisationId: input.authorized.organisationId,
    rail: payout.rail,
    integrationAccountId: payout.integrationAccountId,
    sourceReference: payoutSourceReference(plan),
    fundingMode: "balance",
    environment,
    currency: payout.currency,
    amountMinor: payout.recipientAmountMinor,
  });
  if (!certified)
    return payoutRefusal("supplier_payout_rail_uncertified", payout.revision);

  const provider = resolveSupplierPayoutProvider(payout.rail);
  const store = createSupplierPayoutAttemptStore({
    db: input.authorized.executionScope.database,
    organisationId: input.authorized.organisationId,
    now: fundingClock.bind(null, input.now),
  });
  const now = new Date(input.now).toISOString();
  const executed =
    input.path.kind === "submit_supplier_payout"
      ? await submitSupplierPayout({
          db: input.authorized.executionScope.database,
          organisationId: input.authorized.organisationId,
          payoutId: payout.payoutId,
          attemptId: `attempt_${input.actionNonce}`,
          plan,
          sourceReference: payoutSourceReference(plan),
          environment,
          now,
          provider,
          store,
          // Lexicon, never a stand-in: this is the path that actually sends.
          validate: validateSupplierPayoutPlanWithLexicon,
        })
      : await resumeSupplierPayoutFunding({
          db: input.authorized.executionScope.database,
          organisationId: input.authorized.organisationId,
          payoutId: payout.payoutId,
          expectedPayoutRevision: input.path.expectedPayoutRevision,
          attemptId: input.path.attemptId,
          providerTransferId: input.path.providerTransferId,
          sourceReference: payoutSourceReference(plan),
          environment,
          now,
          provider,
          store,
          validate: validateSupplierPayoutPlanWithLexicon,
        });
  if (!executed.ok)
    return payoutRefusal(`supplier_payout_${executed.error}`, payout.revision);

  const responseBody = {
    ok: true,
    supplierPayout: {
      payoutId: executed.payout.payoutId,
      state: executed.payout.stateKind,
      revision: executed.payout.revision,
    },
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized: input.authorized,
    identity: input.identity,
    scope: input.scope,
    boundary: input.boundary,
    request: input.request,
    responseBody,
    now: input.now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function fundingClock(now: number): number {
  return now;
}

/**
 * A refusal carries the payout's current revision.
 *
 * An operator whose approval went stale needs to know what it went stale
 * against, so they can look at the payout rather than approve the same thing
 * again and watch it fail identically.
 */
function payoutRefusal(error: string, revision: number): Response {
  return controlJson({ ok: false, error, payoutRevision: revision }, 409);
}
