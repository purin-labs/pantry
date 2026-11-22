import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type {
  PayoutIndeterminateOperation,
  SupplierPayoutExecutionPlan,
  SupplierPayoutState,
} from "@purin-labs/commerce-contracts";
import { readOrganisationEnvironment } from "../control/organisation-runtime";
import {
  createSupplierPayoutAttemptStore,
  listSupplierPayoutAttempts,
} from "../data/supplier-payout-attempt";
import {
  admitSupplierPayoutEvent,
  type SupplierPayoutEvidence,
} from "../data/supplier-payout-event-inbox";
import {
  payoutSourceReference,
  readSealedPayoutPlan,
} from "../data/supplier-payout-plan";
import {
  advanceSupplierPayout,
  listSupplierPayoutsForInquiry,
} from "../data/supplier-payout-store";
import { validateSupplierPayoutPlanWithLexicon } from "../commerce/commerce-wasm";
import type { Env } from "@purin-labs/kernel/env";
import { parseOrganisationId, type OrganisationId } from "@purin-labs/kernel/ids";
import {
  recoverSupplierPayout,
  type SupplierPayoutProvider,
} from "./executor";
import { resolveSupplierPayoutProvider } from "../payout-providers/unavailable";
import { reconcilePayoutInbox } from "./reconciliation";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";

export type PayoutRecoveryProvider = SupplierPayoutProvider &
  Readonly<{
    inquireStatus(
      plan: SupplierPayoutExecutionPlan,
      target: Readonly<{ kind: "transfer" | "request"; identity: string }>,
    ): Promise<SupplierPayoutEvidence | null>;
  }>;

type PayoutRecoveryReport = Readonly<{
  examined: number;
  unknown: number;
  updated: number;
  conflicts: number;
}>;

/** All unresolved provider states need inquiry, even when webhooks previously arrived. */
export async function recoverUnresolvedPayouts(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: string;
    providerFor: (plan: SupplierPayoutExecutionPlan) => PayoutRecoveryProvider;
  }>,
): Promise<PayoutRecoveryReport> {
  const now = Date.parse(input.now);
  const environment = await readOrganisationEnvironment(
    input.db,
    input.organisationId,
  );
  if (environment === null || !Number.isFinite(now)) {
    throw new Error("payout_recovery_context_invalid");
  }
  const payouts = await listSupplierPayoutsForInquiry(
    input.db,
    input.organisationId,
    now,
  );
  let unknown = 0;
  let updated = 0;
  let conflicts = 0;
  for (const payout of payouts) {
    const nextInquiryAt =
      now + (payout.stateKind === "settled" ? 86_400_000 : 60_000);
    const claimed = await input.db
      .prepare(
        `UPDATE supplier_payout SET next_inquiry_at = ?
      WHERE organisation_id = ? AND payout_id = ? AND next_inquiry_at <= ?`,
      )
      .bind(nextInquiryAt, input.organisationId, payout.payoutId, now)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) {
      continue;
    }

    const plan = readSealedPayoutPlan(payout, input.organisationId);
    if (plan === null || payout.approvalDigest === null) {
      conflicts += 1;
      continue;
    }
    const attempts = await listSupplierPayoutAttempts(
      input.db,
      input.organisationId,
      payout.payoutId,
    );
    const attempt = attempts[0];
    if (
      attempts.length !== 1 ||
      attempt === undefined ||
      attempt.approvalDigest !== payout.approvalDigest ||
      attempt.requestIdentity !== plan.seal.idempotencyKey
    ) {
      conflicts += 1;
      continue;
    }
    const provider = input.providerFor(plan);
    try {
      const target =
        attempt.providerTransferId === null
          ? { kind: "request" as const, identity: attempt.requestIdentity }
          : { kind: "transfer" as const, identity: attempt.providerTransferId };
      const evidence = await provider.inquireStatus(plan, target);
      if (evidence !== null) {
        if (
          evidence.rail !== payout.rail ||
          evidence.integrationAccountId !== payout.integrationAccountId ||
          evidence.sourceReference !== payoutSourceReference(plan) ||
          evidence.environment !== environment ||
          evidence.targetKind !== target.kind ||
          evidence.targetId !== target.identity
        ) {
          conflicts += 1;
          continue;
        }
        await admitSupplierPayoutEvent({
          db: input.db,
          organisationId: input.organisationId,
          event: evidence,
        });
        continue;
      }

      if (
        payout.stateKind !== "submitting" &&
        payout.stateKind !== "indeterminate"
      ) {
        unknown += 1;
        continue;
      }
      let operation: PayoutIndeterminateOperation;
      if (
        attempt.providerTransferId !== null &&
        attempt.fundingOperationId !== null
      ) {
        operation = {
          kind: "funding",
          providerTransferId: attempt.providerTransferId,
          fundingOperationId: attempt.fundingOperationId,
        };
      } else {
        operation = {
          kind: "transfer_creation",
          requestIdentity: attempt.requestIdentity,
        };
      }
      const store = createSupplierPayoutAttemptStore({
        db: input.db,
        organisationId: input.organisationId,
        now: recoveryClock.bind(null, now),
      });
      const result = await recoverSupplierPayout({
        plan,
        attemptId: attempt.attemptId,
        payoutApprovalDigest: payout.approvalDigest,
        operation,
        now: input.now,
        provider,
        store,
        validate: validateSupplierPayoutPlanWithLexicon,
      });
      if (
        result.kind !== "provider_pending" &&
        result.kind !== "provider_action_required"
      ) {
        unknown += 1;
        continue;
      }
      let state: Variant<
        SupplierPayoutState,
        "provider_pending" | "provider_action_required"
      >;
      if (result.kind === "provider_pending") {
        state = {
          kind: "provider_pending",
          providerTransferId: result.providerTransferId,
          providerState: "accepted",
          observedAt: input.now,
        };
      } else {
        state = {
          kind: "provider_action_required",
          providerTransferId: result.providerTransferId,
          attemptId: attempt.attemptId,
          actionCode: result.actionCode,
          observedAt: input.now,
        };
      }

      const document: unknown = JSON.parse(payout.payoutJson);
      if (!isRecord(document)) {
        conflicts += 1;
        continue;
      }
      const advanced = await advanceSupplierPayout({
        db: input.db,
        organisationId: input.organisationId,
        payoutId: payout.payoutId,
        expectedRevision: payout.revision,
        stateKind: state.kind,
        approvalDigest: payout.approvalDigest,
        payoutJson: JSON.stringify({
          plan,
          approval: document.approval,
          state,
        }),
        now,
      });
      if (advanced.ok) {
        updated += 1;
      }
    } catch {
      // A failed inquiry is never evidence that the provider did not move money.
      unknown += 1;
    }
  }
  const reconciled = await reconcilePayoutInbox(
    input.db,
    input.organisationId,
    now,
  );
  updated += reconciled.filter(isApplied).length;
  conflicts += reconciled.filter(isConflict).length;
  return { examined: payouts.length, unknown, updated, conflicts };
}

function recoveryClock(now: number): number {
  return now;
}

function isApplied(result: string): boolean {
  return result === "applied";
}

function isConflict(result: string): boolean {
  return result === "conflict";
}

export async function runScheduledPayoutReconciliation(
  env: Env,
  now: number,
): Promise<void> {
  for (const database of configuredOrganisationDatabases(env)) {
    const organisations = await database
      .prepare(
        `SELECT DISTINCT organisation_id AS organisationId FROM supplier_payout
    WHERE next_inquiry_at <= ? AND state_kind IN ('submitting', 'indeterminate', 'provider_pending', 'provider_action_required', 'return_pending', 'reversal_pending', 'settled')
    UNION SELECT DISTINCT organisation_id AS organisationId FROM supplier_payout_event WHERE status = 'pending'`,
      )
      .bind(now)
      .all<{ organisationId: string }>();
    for (const organisation of organisations.results) {
      const organisationId = parseOrganisationId(organisation.organisationId);
      if (!organisationId.ok) {
        continue;
      }
      try {
        const execution = await OrganisationExecutionScope.resolve(
          env,
          organisationId.value,
        );
        if (!execution.ok || execution.value.database !== database) continue;
        await recoverUnresolvedPayouts({
          db: execution.value.database,
          organisationId: organisationId.value,
          now: new Date(now).toISOString(),
          providerFor: recoveryProvider,
        });
      } catch {
        console.error("supplier_payout_reconciliation_failed", {
          organisationId: organisationId.value,
        });
      }
    }
  }
}

function recoveryProvider(
  plan: SupplierPayoutExecutionPlan,
): PayoutRecoveryProvider {
  return resolveSupplierPayoutProvider(
    plan.kind === "gmo_aozora"
      ? "gmo_aozora_private"
      : "wise_enterprise_payouts",
  );
}
