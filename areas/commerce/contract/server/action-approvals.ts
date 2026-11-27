import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type {
  ActionLedgerEntry,
  LedgerCanonicalAction,
} from "@purin-labs/authority/actors/action-ledger";
import type { MerchantActionRejectionEvidence } from "@purin-labs/authority/approval-authentication";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import type { Env } from "@purin-labs/kernel/env";
import type { CaseId, OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { VariantBy } from "@purin-labs/type-utils";
import type {
  CommerceActionError,
  CommerceActionPath,
} from "./action-requests";

type CommerceCaseOutcomeDelivery =
  | {
      readonly kind: "delivered" | "already_settled";
      readonly caseRevision: number;
      readonly deliveryReceiptId: string;
    }
  | { readonly kind: "unaddressed"; readonly caseRevision: number }
  | { readonly kind: "held"; readonly caseRevision: number }
  | {
      readonly kind: "pending";
      readonly caseRevision: number;
      readonly retryAt: number;
    };

/** What happened to the outcome of a commerce action in its Case. */
export type CommerceCaseOutcomeResult =
  | { readonly ok: true; readonly value: CommerceCaseOutcomeDelivery }
  | { readonly ok: false; readonly error: { readonly code: string } };

/** A decided commerce action whose outcome goes to its Case. */
export type DeliverCommerceOutcomeInput =
  | {
      readonly kind: "provider_receipt";
      readonly env: Env;
      readonly entry: ActionLedgerEntry;
      readonly receipt: CommerceProviderReceipt;
      readonly now: number;
    }
  | {
      readonly kind: "merchant_rejection";
      readonly env: Env;
      readonly entry: VariantBy<ActionLedgerEntry, "state", "rejected">;
      readonly rejection: MerchantActionRejectionEvidence;
      readonly now: number;
    }
  | {
      readonly kind: "execution_failure";
      readonly env: Env;
      readonly entry: VariantBy<ActionLedgerEntry, "state", "failed">;
      readonly now: number;
    };

/** One approved commerce action to run, or one with an unknown outcome. */
type CommerceActionExecution = Readonly<{
  env: Env;
  executionScope: OrganisationExecutionScope;
  organisation: OrganisationActorStub;
  action: ActionLedgerEntry;
  actionNonce: string;
  now: number;
}>;

/**
 * The commerce half of a decision on a governed commerce action, for the
 * Slack approval card: the parse of the action's path, the run of an
 * approved action, the outcome of a rejection, and the sync of the Case
 * that waits on the action. Commerce owns the actions, and the Worker
 * registers the implementation (`worker-ports.ts`).
 */
export type CommerceActionApprovals = Readonly<{
  /** The typed change that a recorded action's verb and path name. */
  parseActionPath(
    action: Pick<LedgerCanonicalAction, "verb" | "path">,
  ): Result<CommerceActionPath, CommerceActionError>;
  /** Tells the waiting Case the decision; false when it did not take it. */
  syncCaseApprovalWait(
    env: Env,
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: CaseId;
      actionNonce: string;
      now: number;
    }>,
  ): Promise<boolean>;
  /**
   * Runs an approved action against its provider, or reconciles one whose
   * outcome is unknown. The ledger then holds the outcome.
   */
  executeCommerceAction(
    input: CommerceActionExecution,
  ): Promise<Readonly<{ ok: boolean }>>;
  /** Records the outcome of a decided action and delivers it to its Case. */
  acceptAndDeliverCommerceOutcome(
    input: DeliverCommerceOutcomeInput,
  ): Promise<CommerceCaseOutcomeResult>;
}>;

export const commerceActionApprovals = definePort<CommerceActionApprovals>(
  "commerce_action_approvals",
);
