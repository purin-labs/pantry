import {
  authorizeActionMutationExecution,
  type ActionMutationExecution,
} from "../action-mutation-execution";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { isOrganisationExecutionActive } from "../actor-execution-quiescence";
import type { CommerceProjection } from "@purin-labs/contracts";
import {
  compileCommerceRelationshipTraversalStepSql,
  compileCommerceQuerySql,
} from "@purin-labs/commerce-query-sqlite";
import {
  beginOnboardingActivation,
  checkpointActivationStep,
  completeOnboardingActivation,
  type ActivationContext,
  type ActivationReceipt,
  type OnboardingActivationInput,
} from "../../data/activation";
import {
  newRequestId,
  type IntegrationAccountId,
  type RequestId,
  type OrganisationId,
} from "../../ids";
import { traceWarn } from "../../observability";
import {
  listCommerceLabRuns,
  requireCommerceLabOrganisationMarker,
  type CommerceLabMetadataError,
} from "../../commerce-lab/lab-metadata";
import type { Result } from "../../result";
import {
  beginActionExecution,
  completeActionExecution,
  getAction,
  proposeAction,
  readActionActivity,
  recordCommerceEntityPlaneEffect,
  rejectAction,
  requestActionApproval,
  reconcileActionExecution,
  retryIndeterminateActionExecution,
  signAction,
  type ActionLedgerActivity,
  type ActionLedgerEntry,
  type ActionLedgerError,
  type BeginActionExecutionInput,
  type CompleteActionExecutionInput,
  type GetActionInput,
  type ProposeActionInput,
  type ReadActionActivityInput,
  type RecordCommerceEntityPlaneEffectInput,
  type RejectActionInput,
  type RequestActionApprovalInput,
  type ReconcileActionExecutionInput,
  type RetryIndeterminateActionExecutionInput,
  type SignActionInput,
} from "../action-ledger";
import {
  claimCueDelivery,
  completeClaimedCueDelivery,
  type ClaimedCueCompletionInput,
  type CueClaimInput,
  type CueClaimResult,
  type CueDeliveryError,
} from "../cue-delivery";
import {
  applyCommerceDelivery,
  markCommerceCuesEnqueued,
  readAcceptedCommerceProjectionSequence,
  readCommerceProjectionHistory,
  readCommerceSystemSyncStatus,
  readCurrentCommerceProjection,
  readExactCommerceProjectionReference,
  readRecoverableCommerceCues,
  resetCommerceLab,
  seedCommerceLab,
  settleCommerceCues,
  validateCommerceSystemProjections,
  verifyCommerceLab,
  type AppliedCommerceDeliveryResult,
  type CommerceLabResetInput,
  type CommerceLabSeedInput,
  type CommerceLabVerification,
  type CommerceProjectionError,
  type CommerceProjectionHistoryEntry,
  type CommerceProjectionRecord,
  type CommerceSystemSyncStatus,
  type CommerceSystemValidationReceipt,
  type PendingCommerceCue,
  type ReadCommerceProjectionHistoryInput,
  type ReadCurrentCommerceProjectionInput,
  type ReadExactCommerceProjectionReferenceInput,
  type ValidateCommerceSystemInput,
} from "../commerce-projection";
import {
  parseCommerceEntityRelationRow,
  parseCommerceRelationshipRelationRow,
  type CommerceEntityRelationRow,
  type CommerceRelationshipRelationRow,
} from "../commerce-query-schema";
import {
  advanceActorActivationSchema,
  type ActorActivationSchemaAdvance,
  type ActorActivationSchemaAdvanceError,
  admitActorRecovery,
} from "../actor-activation";
import {
  armOnboardingActivationAcceptanceFault,
  clearOnboardingActivationAcceptanceFault,
  consumeOnboardingActivationAcceptanceFault,
  inspectOnboardingActivationAcceptanceFault,
  type OnboardingActivationAcceptanceFaultError,
  type OnboardingActivationAcceptanceFaultInput,
  type OnboardingActivationAcceptanceFaultInspection,
  type OnboardingActivationAcceptanceFaultRecord,
} from "../onboarding-activation-acceptance-fault";
import {
  abandonCodeModeCapabilityCalls,
  claimCodeModeCapabilityCall,
  cancelCodeModeOrganisationBudget,
  completeCodeModeCapabilityCall,
  reconcileCodeModeOrganisationBudget,
  rebindCodeModeOrganisationLease,
  reserveWorkspaceExecutorOrganisationAllocation,
  reserveCodeModeOrganisationBudget,
  settleWorkspaceExecutorOrganisationAllocation,
  settleCodeModeOrganisationBudget,
  cancelWorkspaceExecutorOrganisationAllocation,
  type CodeModeCapabilityAbandonInput,
  type CodeModeCapabilityClaimInput,
  type CodeModeCapabilityCompleteInput,
  type CodeModeCapabilityCounter,
  type CodeModeLeaseRebindInput,
  type CodeModeOrganisationCancelInput,
  type CodeModeOrganisationReservation,
  type CodeModeOrganisationReconcileInput,
  type CodeModeOrganisationReserveInput,
  type CodeModeOrganisationSettleInput,
  type WorkspaceExecutorAllocationCancelInput,
  type WorkspaceExecutorAllocationReservation,
  type WorkspaceExecutorAllocationReserveInput,
  type WorkspaceExecutorAllocationSettleInput,
} from "../code-mode-budget";
import {
  inspectOrganisationCutoverQuiescence,
  type OrganisationCutoverInspectionError,
} from "../organisation-cutover-quiescence";
import {
  reconcileCommerceProviderReceipt,
  type CommerceProviderReceiptReconciliationError,
} from "../../commerce/action-model";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import {
  digestFlowBinding,
  flowBindingMatchesIdentity,
  FlowBinding,
} from "../../policy";
import { errorMessage } from "@purin-labs/std";
import type { CommerceProviderReceipt } from "@purin-labs/control-api";
import {
  CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY,
  activationExecutionFailure,
  ensureActivationAccountsStep,
  ensureActivationCueStep,
  ensureActivationPlacementStep,
  ensureActivationPolicyStep,
  ensureActivationReadinessStep,
  hasOnboardingActivationAcceptanceFaultsEnabled,
  isExpiredOrganisationCutoverCue,
  parseCafeCommerceAcceptanceFault,
  recordActivationFailure,
} from "./activation";
import { settleExpiredOrganisationCutoverCue } from "../cue-delivery";
import {
  commerceProjectionKindForRelationType,
  commerceRelationshipTraversalPlan,
  parseCommerceQueryCount,
  validateOrganisationCommercePlan,
} from "./commerce-query";
import {
  armActionExecutionAlarm,
  organisationPlacementConflict,
  validateActionOrganisation,
  validateCodeModeOrganisation,
} from "./support";
import type {
  ActivationExecutionFailure,
  OnboardingActivationError,
} from "./activation-types";
import type {
  CafeCommerceAcceptanceFaultConsumption,
  CafeCommerceAcceptanceFaultRecord,
  CommerceQueryPlanReadError,
  OrganisationApplyCommerceDeliveryInput,
  ReadCommerceQueryPlanInput,
  ReadCommerceQueryPlanValue,
  ReadCommerceRelationshipStepInput,
} from "./commerce-types";
import type { CodeModeOrganisationActorError } from "./code-mode-types";
import type {
  OrganisationCutoverCueSettlementError,
  OrganisationCutoverCueSettlementInput,
  OrganisationStateError,
} from "./types";
import { OrganisationPolicy } from "./organisation-policy";

/**
 * Commerce actions, cues, the commerce lab, Code Mode leases, workspace executor allocation and onboarding activation for the Organisation.
 */
export abstract class OrganisationCommerce extends OrganisationPolicy {
  async advanceActivationSchema(
    input: ActorActivationSchemaAdvance,
  ): Promise<
    Result<
      { readonly kind: "advanced"; readonly stateVersion: number },
      ActorActivationSchemaAdvanceError
    >
  > {
    return this.ctx.storage.transactionSync(
      advanceActorActivationSchema.bind(null, this.ctx.storage.sql, input),
    );
  }

  async proposeAction(
    input: ProposeActionInput & { execution: ActionMutationExecution },
  ) {
    return this.command(
      input.organisationId,
      this.admittedProposeAction.bind(this, input),
    );
  }

  protected async admittedProposeAction(
    input: ProposeActionInput & { execution: ActionMutationExecution },
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<ActionLedgerEntry, OrganisationStateError | ActionLedgerError>
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    if (
      input.execution.kind === "session_turn" &&
      (input.execution.execution.sessionId !== input.sessionId ||
        JSON.stringify(input.execution.execution.requestAuthority) !==
          JSON.stringify(input.requestAuthority))
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution.identity" },
      };
    const flowBinding = await FlowBinding.restore(input.flowBinding);
    if (!flowBinding.ok) {
      return {
        ok: false,
        error: { code: "invalid_action", field: "flowBinding" },
      };
    }
    if (
      input.execution.kind === "session_turn" &&
      flowBinding.value.turnId !== input.execution.execution.turnId
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution.turnId" },
      };
    if (
      !flowBindingMatchesIdentity(flowBinding.value, {
        organisationId: input.organisationId,
        sessionId: input.sessionId,
        authorityPartitionDigest: input.authorityPartition.digest,
      })
    ) {
      return {
        ok: false,
        error: { code: "invalid_action", field: "flowBinding.identity" },
      };
    }

    if (
      !(await authorizeActionMutationExecution(
        this.env,
        scope,
        input.execution,
      )) ||
      !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution" },
      };
    const result = this.ctx.storage.transactionSync(
      proposeAction.bind(null, this.ctx.storage.sql, {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        requestAuthority: input.requestAuthority,
        authorityPartition: input.authorityPartition,
        authority: input.authority,
        caseId: input.caseId,
        proposalId: input.proposalId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        draft: input.draft,
        exp: input.exp,
        now: input.now,
        flowBinding: flowBinding.value.toJSON(),
      }),
    );
    if (
      !(await authorizeActionMutationExecution(
        this.env,
        scope,
        input.execution,
      ))
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution" },
      };
    return result;
  }

  async requestActionApproval(
    input: RequestActionApprovalInput & { execution: ActionMutationExecution },
  ) {
    return this.command(
      input.organisationId,
      this.admittedRequestActionApproval.bind(this, input),
    );
  }

  protected async admittedRequestActionApproval(
    input: RequestActionApprovalInput & { execution: ActionMutationExecution },
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<ActionLedgerEntry, OrganisationStateError | ActionLedgerError>
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    if (
      !(await authorizeActionMutationExecution(
        this.env,
        scope,
        input.execution,
      )) ||
      !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution" },
      };
    const result = this.ctx.storage.transactionSync(
      requestActionApproval.bind(null, this.ctx.storage.sql, input),
    );
    if (
      !(await authorizeActionMutationExecution(
        this.env,
        scope,
        input.execution,
      ))
    )
      return {
        ok: false,
        error: { code: "invalid_action", field: "execution" },
      };
    return result;
  }

  async getAction(input: GetActionInput) {
    return this.command(
      input.organisationId,
      this.admittedGetAction.bind(this, input),
    );
  }

  protected async admittedGetAction(
    input: GetActionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    return this.ctx.storage.transactionSync(
      getAction.bind(null, this.ctx.storage.sql, input),
    );
  }

  async readActionActivity(input: ReadActionActivityInput) {
    return this.command(
      input.organisationId,
      this.admittedReadActionActivity.bind(this, input),
    );
  }

  protected async admittedReadActionActivity(
    input: ReadActionActivityInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly ActionLedgerActivity[],
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return readActionActivity(this.ctx.storage.sql, input);
  }

  async signAction(input: SignActionInput) {
    return this.command(
      input.organisationId,
      this.admittedSignAction.bind(this, input),
    );
  }

  protected async admittedSignAction(
    input: SignActionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    return this.ctx.storage.transactionSync(
      signAction.bind(null, this.ctx.storage.sql, input),
    );
  }

  async rejectAction(input: RejectActionInput) {
    return this.command(
      input.organisationId,
      this.admittedRejectAction.bind(this, input),
    );
  }

  protected async admittedRejectAction(
    input: RejectActionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      rejectAction.bind(null, this.ctx.storage.sql, input),
    );
  }

  async beginActionExecution(input: BeginActionExecutionInput) {
    return this.command(
      input.organisationId,
      this.admittedBeginActionExecution.bind(this, input),
    );
  }

  protected async admittedBeginActionExecution(
    input: BeginActionExecutionInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    await armActionExecutionAlarm(this.ctx.storage, input.now);
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const result = this.ctx.storage.transactionSync(
      beginActionExecution.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async retryIndeterminateActionExecution(
    input: RetryIndeterminateActionExecutionInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedRetryIndeterminateActionExecution.bind(this, input),
    );
  }

  protected async admittedRetryIndeterminateActionExecution(
    input: RetryIndeterminateActionExecutionInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    await armActionExecutionAlarm(this.ctx.storage, input.now);
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    const result = this.ctx.storage.transactionSync(
      retryIndeterminateActionExecution.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async completeActionExecution(input: CompleteActionExecutionInput) {
    return this.command(
      input.organisationId,
      this.admittedCompleteActionExecution.bind(this, input),
    );
  }

  protected async admittedCompleteActionExecution(
    input: CompleteActionExecutionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const result = this.ctx.storage.transactionSync(
      completeActionExecution.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async recordCommerceEntityPlaneEffect(
    input: RecordCommerceEntityPlaneEffectInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedRecordCommerceEntityPlaneEffect.bind(this, input),
    );
  }

  protected async admittedRecordCommerceEntityPlaneEffect(
    input: RecordCommerceEntityPlaneEffectInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      recordCommerceEntityPlaneEffect.bind(null, this.ctx.storage.sql, input),
    );
  }

  async reconcileActionExecution(input: ReconcileActionExecutionInput) {
    return this.command(
      input.organisationId,
      this.admittedReconcileActionExecution.bind(this, input),
    );
  }

  protected async admittedReconcileActionExecution(
    input: ReconcileActionExecutionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | ActionLedgerError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const result = this.ctx.storage.transactionSync(
      reconcileActionExecution.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async reconcileCommerceProviderReceipt(input: {
    readonly organisationId: OrganisationId;
    readonly nonce: string;
    readonly receipt: CommerceProviderReceipt;
    readonly now: number;
  }): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | CommerceProviderReceiptReconciliationError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    return this.command(
      input.organisationId,
      this.admittedReconcileCommerceProviderReceipt.bind(this, input),
    );
  }

  protected async admittedReconcileCommerceProviderReceipt(
    input: {
      readonly organisationId: OrganisationId;
      readonly nonce: string;
      readonly receipt: CommerceProviderReceipt;
      readonly now: number;
    },
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ActionLedgerEntry,
      | OrganisationStateError
      | CommerceProviderReceiptReconciliationError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const action = getAction(this.ctx.storage.sql, {
      organisationId: input.organisationId,
      nonce: input.nonce,
      now: input.now,
    });
    if (!action.ok) return action;
    const flowBinding = await FlowBinding.restore(
      action.value.action.flowBinding,
    );
    if (
      !flowBinding.ok ||
      input.receipt.flowBindingDigest !==
        (await digestFlowBinding(flowBinding.value))
    ) {
      return {
        ok: false,
        error: { code: "commerce_provider_receipt_action_mismatch" },
      };
    }

    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();

    const result = this.ctx.storage.transactionSync(
      reconcileCommerceProviderReceipt.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async claimCueDelivery(input: CueClaimInput) {
    return this.command(
      input.organisationId,
      this.admittedClaimCueDelivery.bind(this, input),
    );
  }

  protected async admittedClaimCueDelivery(
    input: CueClaimInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CueClaimResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CueDeliveryError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const claimed = this.ctx.storage.transactionSync(
      claimCueDelivery.bind(null, this.ctx.storage.sql, input),
    );
    if (claimed.ok && claimed.value.kind === "claimed") await this.rearm();
    return claimed;
  }

  async completeClaimedCueDelivery(input: ClaimedCueCompletionInput) {
    return this.command(
      input.organisationId,
      this.admittedCompleteClaimedCueDelivery.bind(this, input),
    );
  }

  protected async admittedCompleteClaimedCueDelivery(
    input: ClaimedCueCompletionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      null,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CueDeliveryError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const completed = this.ctx.storage.transactionSync(
      completeClaimedCueDelivery.bind(null, this.ctx.storage.sql, input),
    );
    // A completed claim needs no sweep; the alarm follows the claims left.
    if (completed.ok) await this.rearm();
    return completed;
  }

  async applyCommerceDelivery(input: OrganisationApplyCommerceDeliveryInput) {
    return this.command(
      input.organisationId,
      this.admittedApplyCommerceDelivery.bind(this, input),
    );
  }

  protected async admittedApplyCommerceDelivery(
    input: OrganisationApplyCommerceDeliveryInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      AppliedCommerceDeliveryResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    if (input.commerceSystem.kind !== "lab") {
      const selected = await resolveOrganisationCommerceSystemAuthority({
        db: scope.database,
        organisationId: input.organisationId,
      });
      if (
        !selected.ok ||
        selected.value.commerceSystem.kind !== input.commerceSystem.kind ||
        selected.value.commerceSystem.revision !==
          input.commerceSystem.revision ||
        selected.value.integrationAccountId !== input.integrationAccountId
      ) {
        return {
          ok: false,
          error: { code: "commerce_system_authority_mismatch" },
        };
      }
    }
    if (!(await isOrganisationExecutionActive(this.ctx.storage.sql, scope)))
      return organisationPlacementConflict();
    return this.ctx.storage.transactionSync(
      applyCommerceDelivery.bind(
        null,
        this.ctx.storage.sql,
        input,
        input.commerceSystem,
      ),
    );
  }

  async readRecoverableCommerceCues(input: {
    readonly organisationId: OrganisationId;
    readonly limit: number;
    readonly retryBefore: number;
  }) {
    return this.command(
      input.organisationId,
      this.admittedReadRecoverableCommerceCues.bind(this, input),
    );
  }

  protected async admittedReadRecoverableCommerceCues(
    input: {
      readonly organisationId: OrganisationId;
      readonly limit: number;
      readonly retryBefore: number;
    },
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly PendingCommerceCue[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return readRecoverableCommerceCues(this.ctx.storage.sql, input);
  }

  async readCurrentCommerceProjection(
    input: ReadCurrentCommerceProjectionInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCurrentCommerceProjection.bind(this, input),
    );
  }

  protected async admittedReadCurrentCommerceProjection(
    input: ReadCurrentCommerceProjectionInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CommerceProjection | null,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return readCurrentCommerceProjection(this.ctx.storage.sql, input);
  }

  async readCommerceProjectionHistory(
    input: ReadCommerceProjectionHistoryInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceProjectionHistory.bind(this, input),
    );
  }

  protected async admittedReadCommerceProjectionHistory(
    input: ReadCommerceProjectionHistoryInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceProjectionHistoryEntry[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return readCommerceProjectionHistory(this.ctx.storage.sql, input);
  }

  async readExactCommerceProjectionReference(
    input: ReadExactCommerceProjectionReferenceInput,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadExactCommerceProjectionReference.bind(this, input),
    );
  }

  protected async admittedReadExactCommerceProjectionReference(
    input: ReadExactCommerceProjectionReferenceInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CommerceProjectionRecord | null,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return readExactCommerceProjectionReference(this.ctx.storage.sql, input);
  }

  async markCommerceCuesEnqueued(input: {
    readonly organisationId: OrganisationId;
    readonly nativeIds: readonly string[];
    readonly enqueuedAt: number;
  }) {
    return this.command(
      input.organisationId,
      this.admittedMarkCommerceCuesEnqueued.bind(this, input),
    );
  }

  protected async admittedMarkCommerceCuesEnqueued(
    input: {
      readonly organisationId: OrganisationId;
      readonly nativeIds: readonly string[];
      readonly enqueuedAt: number;
    },
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      null,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return this.ctx.storage.transactionSync(
      markCommerceCuesEnqueued.bind(null, this.ctx.storage.sql, input),
    );
  }

  async settleCommerceCues(input: {
    readonly organisationId: OrganisationId;
    readonly nativeIds: readonly string[];
    readonly settledAt: number;
  }) {
    return this.command(
      input.organisationId,
      this.admittedSettleCommerceCues.bind(this, input),
    );
  }

  protected async admittedSettleCommerceCues(
    input: {
      readonly organisationId: OrganisationId;
      readonly nativeIds: readonly string[];
      readonly settledAt: number;
    },
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      null,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    return this.ctx.storage.transactionSync(
      settleCommerceCues.bind(null, this.ctx.storage.sql, input),
    );
  }

  async readAcceptedCommerceProjectionSequence(
    input: Readonly<{
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadAcceptedCommerceProjectionSequence.bind(this, input),
    );
  }

  protected async admittedReadAcceptedCommerceProjectionSequence(
    input: Readonly<{
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
    }>,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      number,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return readAcceptedCommerceProjectionSequence(this.ctx.storage.sql, input);
  }

  async readCommerceQueryPlan(input: ReadCommerceQueryPlanInput) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceQueryPlan.bind(this, input),
    );
  }

  protected async admittedReadCommerceQueryPlan(
    input: ReadCommerceQueryPlanInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ReadCommerceQueryPlanValue,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceQueryPlanReadError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const acceptedSequence = readAcceptedCommerceProjectionSequence(
      this.ctx.storage.sql,
      {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
      },
    );
    if (!acceptedSequence.ok)
      return { ok: false, error: { code: "commerce_query_relation_corrupt" } };
    const validated = validateOrganisationCommercePlan(
      input.planRequest,
      input.plan,
      acceptedSequence.value,
    );
    if (!validated.ok) return validated;
    const plan = validated.value;

    const compiled = compileCommerceQuerySql({
      plan,
      ownerId: input.integrationAccountId,
    });
    if (compiled.kind === "unsupported") {
      return {
        ok: false,
        error: {
          code: "commerce_query_plan_unsupported",
          capability: compiled.capability,
        },
      };
    }

    const rawRows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        compiled.statement.sql,
        ...compiled.statement.bindings,
      )
      .toArray();
    if (compiled.statement.execution.kind === "count") {
      const count = parseCommerceQueryCount(rawRows);
      return count === null
        ? { ok: false, error: { code: "commerce_query_relation_corrupt" } }
        : {
            ok: true,
            value: {
              kind: "count",
              aggregation: { kind: "count", value: count },
            },
          };
    }

    const rows: CommerceEntityRelationRow[] = [];
    for (const rawRow of rawRows) {
      const row = parseCommerceEntityRelationRow(rawRow);
      if (!row.ok || row.value.merchant_id !== input.integrationAccountId) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      rows.push(row.value);
    }
    const hasMore =
      compiled.statement.execution.kind === "page" &&
      rows.length > compiled.statement.execution.requestedLimit;
    const retainedRows =
      compiled.statement.execution.kind === "page"
        ? rows.slice(0, compiled.statement.execution.requestedLimit)
        : rows;
    const records: CommerceProjectionRecord[] = [];
    for (const row of retainedRows) {
      const kind = commerceProjectionKindForRelationType(row.entity_type);
      if (kind === null) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      const relationText = this.ctx.storage.sql
        .exec<Readonly<{ readonly count: number }>>(
          `SELECT COUNT(*) AS count
           FROM commerce_projection_relation_text
          WHERE integration_account_id = ?
            AND projection_kind = ?
            AND canonical_id = ?`,
          input.integrationAccountId,
          kind,
          row.entity_id,
        )
        .toArray()[0]?.count;
      if (relationText !== 1) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      const hydrated = readExactCommerceProjectionReference(
        this.ctx.storage.sql,
        {
          organisationId: input.organisationId,
          integrationAccountId: input.integrationAccountId,
          kind,
          canonicalId: row.entity_id,
        },
      );
      if (!hydrated.ok || hydrated.value === null) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      const record = hydrated.value;
      if (
        record.kind !== kind ||
        record.canonicalId !== row.entity_id ||
        record.revision !== row.revision ||
        record.updatedAt !== row.updated_at
      ) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      records.push(record);
    }
    return {
      ok: true,
      value: { kind: "rows", rows: retainedRows, records, hasMore },
    };
  }

  async readCommerceRelationshipStep(input: ReadCommerceRelationshipStepInput) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceRelationshipStep.bind(this, input),
    );
  }

  protected async admittedReadCommerceRelationshipStep(
    input: ReadCommerceRelationshipStepInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceRelationshipRelationRow[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceQueryPlanReadError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const acceptedSequence = readAcceptedCommerceProjectionSequence(
      this.ctx.storage.sql,
      {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
      },
    );
    if (!acceptedSequence.ok)
      return { ok: false, error: { code: "commerce_query_relation_corrupt" } };
    const validated = validateOrganisationCommercePlan(
      input.planRequest,
      input.plan,
      acceptedSequence.value,
    );
    if (!validated.ok) return validated;
    const traversalPlan = commerceRelationshipTraversalPlan(validated.value);
    if (traversalPlan === null) {
      return { ok: false, error: { code: "commerce_query_plan_invalid" } };
    }
    const compiled = compileCommerceRelationshipTraversalStepSql({
      ownerId: input.integrationAccountId,
      plan: traversalPlan,
      frontier: input.frontier,
      remaining: input.remaining,
    });
    if (compiled.kind === "unsupported") {
      return {
        ok: false,
        error: {
          code: "commerce_query_plan_unsupported",
          capability: compiled.capability,
        },
      };
    }
    const rawRows = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(
        compiled.statement.sql,
        ...compiled.statement.bindings,
      )
      .toArray();
    const rows: CommerceRelationshipRelationRow[] = [];
    for (const rawRow of rawRows) {
      const row = parseCommerceRelationshipRelationRow(rawRow);
      if (!row.ok || row.value.merchant_id !== input.integrationAccountId) {
        return {
          ok: false,
          error: { code: "commerce_query_relation_corrupt" },
        };
      }
      rows.push(row.value);
    }
    return { ok: true, value: rows };
  }

  async readCommerceSystemSyncStatus(input: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly now: number;
  }) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceSystemSyncStatus.bind(this, input),
    );
  }

  protected async admittedReadCommerceSystemSyncStatus(
    input: {
      readonly organisationId: OrganisationId;
      readonly integrationAccountId: IntegrationAccountId;
      readonly now: number;
    },
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CommerceSystemSyncStatus,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return readCommerceSystemSyncStatus(this.ctx.storage.sql, input);
  }

  async validateCommerceSystemProjections(input: ValidateCommerceSystemInput) {
    return this.command(
      input.organisationId,
      this.admittedValidateCommerceSystemProjections.bind(this, input),
    );
  }

  protected async admittedValidateCommerceSystemProjections(
    input: ValidateCommerceSystemInput,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      CommerceSystemValidationReceipt,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | CommerceProjectionError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      validateCommerceSystemProjections.bind(null, this.ctx.storage.sql, input),
    );
  }

  async seedCommerceLab(
    input: CommerceLabSeedInput,
  ): Promise<
    Result<
      readonly AppliedCommerceDeliveryResult[],
      | OrganisationStateError
      | CommerceProjectionError
      | CommerceLabMetadataError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.organisationId
    ) {
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    }
    const marker = await requireCommerceLabOrganisationMarker({
      db: admission.scope.database,
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
    });
    if (!marker.ok) {
      return marker;
    }
    return this.ctx.storage.transactionSync(
      seedCommerceLab.bind(null, this.ctx.storage.sql, input),
    );
  }

  async resetCommerceLab(
    input: CommerceLabResetInput,
  ): Promise<
    Result<
      null,
      | OrganisationStateError
      | CommerceProjectionError
      | CommerceLabMetadataError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.organisationId
    ) {
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    }
    const marker = await requireCommerceLabOrganisationMarker({
      db: admission.scope.database,
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
    });
    if (!marker.ok) {
      return marker;
    }
    return this.ctx.storage.transactionSync(
      resetCommerceLab.bind(null, this.ctx.storage.sql, input),
    );
  }

  async verifyCommerceLab(input: {
    readonly organisationId: OrganisationId;
    readonly labNamespace: string;
    readonly limit: number;
  }): Promise<
    Result<
      CommerceLabVerification,
      | OrganisationStateError
      | CommerceProjectionError
      | CommerceLabMetadataError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== input.organisationId
    ) {
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    }
    const marker = await requireCommerceLabOrganisationMarker({
      db: admission.scope.database,
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
    });
    if (!marker.ok) {
      return marker;
    }
    const runs = await listCommerceLabRuns({
      db: admission.scope.database,
      organisationId: input.organisationId,
      limit: input.limit,
    });
    if (!runs.ok) {
      return runs;
    }
    return verifyCommerceLab(this.ctx.storage.sql, {
      organisationId: input.organisationId,
      labNamespace: input.labNamespace,
      runs: runs.value,
    });
  }

  async activateOnboarding(
    input: OnboardingActivationInput,
  ): Promise<Result<ActivationReceipt, OnboardingActivationError>> {
    return this.command(
      input.organisationId,
      this.admittedActivateOnboarding.bind(this, input),
    );
  }

  protected async admittedActivateOnboarding(
    input: OnboardingActivationInput,
    scope: OrganisationExecutionScope,
  ): Promise<Result<ActivationReceipt, OnboardingActivationError>> {
    const started = await beginOnboardingActivation({
      db: scope.database,
      request: input,
      fence: scope,
    });
    if (!started.ok) {
      return started;
    }
    if (started.value.kind === "completed") {
      return { ok: true, value: started.value.receipt };
    }
    const context = started.value.context;
    try {
      await ensureActivationReadinessStep(scope.database, context, input.now);
      await ensureActivationPlacementStep(
        this,
        scope.database,
        context,
        input.now,
      );
      const interrupted = await this.interruptOnboardingActivationForAcceptance(
        scope,
        context,
        input.now,
      );
      if (interrupted !== null) {
        return { ok: false, error: interrupted };
      }
      const policy = await ensureActivationPolicyStep(
        this,
        this.env,
        scope,
        context,
        input.now,
      );
      if (!policy.ok) {
        const failure = await recordActivationFailure(
          scope.database,
          context,
          policy.error.code,
          input.now,
        );
        return {
          ok: false,
          error: activationExecutionFailure(policy.error.code, failure),
        };
      }
      const cues = await ensureActivationCueStep(
        this.env,
        scope,
        context,
        input.now,
      );
      if (!cues.ok) {
        const failure = await recordActivationFailure(
          scope.database,
          context,
          cues.error.code,
          input.now,
        );
        return {
          ok: false,
          error: activationExecutionFailure(cues.error.code, failure),
        };
      }
      await ensureActivationAccountsStep(scope.database, context, input.now);
      await checkpointActivationStep({
        db: scope.database,
        context,
        step: "publish",
        receipt: { activationReadyToFinalize: true },
        now: input.now,
      });
      const receipt = await completeOnboardingActivation({
        db: scope.database,
        context,
        now: input.now,
      });
      return { ok: true, value: receipt };
    } catch (error) {
      const failure = await recordActivationFailure(
        scope.database,
        context,
        "activation_publish_failed",
        input.now,
      );
      traceWarn("organisation.onboarding_activation_failed", {
        requestId: newRequestId(),
        organisation_id: context.organisationId,
        activation_attempt_id: context.attemptId,
        error: errorMessage(error),
      });
      return {
        ok: false,
        error: activationExecutionFailure("activation_publish_failed", failure),
      };
    }
  }

  async armOnboardingActivationAcceptanceFault(
    input: OnboardingActivationAcceptanceFaultInput,
  ): Promise<
    Result<
      OnboardingActivationAcceptanceFaultRecord,
      OnboardingActivationAcceptanceFaultError
    >
  > {
    return armOnboardingActivationAcceptanceFault(this.ctx.storage, input);
  }

  async inspectOnboardingActivationAcceptanceFault(): Promise<
    Result<
      OnboardingActivationAcceptanceFaultInspection,
      OnboardingActivationAcceptanceFaultError
    >
  > {
    return inspectOnboardingActivationAcceptanceFault(this.ctx.storage);
  }

  async clearOnboardingActivationAcceptanceFault(): Promise<void> {
    await clearOnboardingActivationAcceptanceFault(this.ctx.storage);
  }

  async armCafeCommerceAcceptanceFault(
    input: Readonly<{
      requestId: RequestId;
      merchantId: string;
      armedAt: number;
    }>,
  ): Promise<CafeCommerceAcceptanceFaultRecord> {
    const fault: CafeCommerceAcceptanceFaultRecord = {
      schemaVersion: 1,
      requestId: input.requestId,
      merchantId: input.merchantId,
      armedAt: input.armedAt,
      queueConsumedAt: null,
    };
    await this.ctx.storage.put(CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY, fault);
    return fault;
  }

  async inspectCafeCommerceAcceptanceFault(): Promise<CafeCommerceAcceptanceFaultRecord | null> {
    const raw = await this.ctx.storage.get(CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY);
    return raw === undefined ? null : parseCafeCommerceAcceptanceFault(raw);
  }

  async consumeCafeCommerceAcceptanceFault(
    input: Readonly<{
      merchantId: string;
      consumedAt: number;
    }>,
  ): Promise<CafeCommerceAcceptanceFaultConsumption> {
    const current = await this.inspectCafeCommerceAcceptanceFault();
    if (current === null || current.merchantId !== input.merchantId) {
      return { kind: "inactive" };
    }
    if (current.queueConsumedAt !== null) {
      return { kind: "inactive" };
    }
    const fault: CafeCommerceAcceptanceFaultRecord = {
      ...current,
      queueConsumedAt: input.consumedAt,
    };
    await this.ctx.storage.put(CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY, fault);
    return { kind: "consumed", fault };
  }

  async clearCafeCommerceAcceptanceFault(): Promise<void> {
    await this.ctx.storage.delete(CAFE_COMMERCE_ACCEPTANCE_FAULT_KEY);
  }

  protected async interruptOnboardingActivationForAcceptance(
    scope: OrganisationExecutionScope,
    context: ActivationContext,
    now: number,
  ): Promise<ActivationExecutionFailure | null> {
    if (!hasOnboardingActivationAcceptanceFaultsEnabled(this.env)) {
      return null;
    }
    const consumed = await consumeOnboardingActivationAcceptanceFault(
      this.ctx.storage,
      now,
    );
    if (!consumed.ok) {
      throw new Error(consumed.error.code);
    }
    if (consumed.value.kind === "inactive") {
      return null;
    }
    const failure = await recordActivationFailure(
      scope.database,
      context,
      "activation_interrupted",
      now,
    );
    traceWarn("organisation.onboarding_activation_acceptance_interrupted", {
      requestId: consumed.value.fault.requestId,
      organisation_id: context.organisationId,
      activation_attempt_id: context.attemptId,
      activation_phase: consumed.value.fault.phase,
    });
    return activationExecutionFailure("activation_interrupted", failure);
  }

  async settleCutoverCue(
    input: OrganisationCutoverCueSettlementInput,
  ): Promise<
    Result<
      { readonly kind: "settled" },
      | OrganisationStateError
      | OrganisationCutoverInspectionError
      | OrganisationCutoverCueSettlementError
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );

    if (!organisation.ok) {
      return organisation;
    }

    const inspection = inspectOrganisationCutoverQuiescence({
      sql: this.ctx.storage.sql,
      organisationId: input.organisationId,
      inspectedAt: input.settledAt,
      alarmAt: await this.ctx.storage.getAlarm(),
    });

    if (
      !inspection.ok ||
      !isExpiredOrganisationCutoverCue(inspection.value, input.settledAt)
    ) {
      return {
        ok: false,
        error: { code: "organisation_cutover_cue_mismatch" },
      };
    }

    const settled = this.ctx.storage.transactionSync(
      settleExpiredOrganisationCutoverCue.bind(
        null,
        this.ctx.storage.sql,
        input.organisationId,
        input.settledAt,
      ),
    );

    if (!settled) {
      return {
        ok: false,
        error: { code: "organisation_cutover_cue_mismatch" },
      };
    }

    const finalInspection = inspectOrganisationCutoverQuiescence({
      sql: this.ctx.storage.sql,
      organisationId: input.organisationId,
      inspectedAt: Date.now(),
      alarmAt: await this.ctx.storage.getAlarm(),
    });

    return finalInspection.ok && finalInspection.value.kind === "quiescent"
      ? { ok: true, value: { kind: "settled" } }
      : { ok: false, error: { code: "organisation_cutover_cue_mismatch" } };
  }

  async reserveCodeModeBudget(
    input: CodeModeOrganisationReserveInput,
  ): Promise<
    Result<CodeModeOrganisationReservation, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      true,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const result = this.ctx.storage.transactionSync(
      reserveCodeModeOrganisationBudget.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async settleCodeModeBudget(
    input: CodeModeOrganisationSettleInput,
  ): Promise<
    Result<CodeModeOrganisationReservation, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const result = this.ctx.storage.transactionSync(
      settleCodeModeOrganisationBudget.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async claimCodeModeCapability(
    input: CodeModeCapabilityClaimInput,
  ): Promise<
    Result<CodeModeCapabilityCounter, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      true,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      claimCodeModeCapabilityCall.bind(null, this.ctx.storage.sql, input),
    );
  }

  /**
   * Ends the capability calls that a lost Session Actor process left in
   * flight. It is settlement work, so it does not require an active Organisation.
   */
  async abandonCodeModeCapabilityCalls(
    input: CodeModeCapabilityAbandonInput,
  ): Promise<
    Result<CodeModeCapabilityCounter, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      abandonCodeModeCapabilityCalls.bind(null, this.ctx.storage.sql, input),
    );
  }

  /**
   * Binds a live reservation to the lease of the Session Actor's next runtime
   * generation. It admits further work, so the Organisation must be active.
   */
  async rebindCodeModeLease(
    input: CodeModeLeaseRebindInput,
  ): Promise<
    Result<CodeModeOrganisationReservation, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      true,
    );
    if (!organisation.ok) return organisation;
    const result = this.ctx.storage.transactionSync(
      rebindCodeModeOrganisationLease.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async completeCodeModeCapability(
    input: CodeModeCapabilityCompleteInput,
  ): Promise<
    Result<CodeModeCapabilityCounter, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      completeCodeModeCapabilityCall.bind(null, this.ctx.storage.sql, input),
    );
  }

  async reserveWorkspaceExecutorAllocation(
    input: WorkspaceExecutorAllocationReserveInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModeOrganisationActorError
    >
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      true,
    );
    if (!organisation.ok) return organisation;
    const result = this.ctx.storage.transactionSync(
      reserveWorkspaceExecutorOrganisationAllocation.bind(
        null,
        this.ctx.storage.sql,
        input,
      ),
    );
    await this.rearm();
    return result;
  }

  async settleWorkspaceExecutorAllocation(
    input: WorkspaceExecutorAllocationSettleInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModeOrganisationActorError
    >
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) return organisation;
    const result = this.ctx.storage.transactionSync(
      settleWorkspaceExecutorOrganisationAllocation.bind(
        null,
        this.ctx.storage.sql,
        input,
      ),
    );
    await this.rearm();
    return result;
  }

  async cancelWorkspaceExecutorAllocation(
    input: WorkspaceExecutorAllocationCancelInput,
  ): Promise<
    Result<
      WorkspaceExecutorAllocationReservation,
      CodeModeOrganisationActorError
    >
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) return organisation;
    const result = this.ctx.storage.transactionSync(
      cancelWorkspaceExecutorOrganisationAllocation.bind(
        null,
        this.ctx.storage.sql,
        input,
      ),
    );
    await this.rearm();
    return result;
  }

  async cancelCodeModeBudget(
    input: CodeModeOrganisationCancelInput,
  ): Promise<
    Result<CodeModeOrganisationReservation, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const result = this.ctx.storage.transactionSync(
      cancelCodeModeOrganisationBudget.bind(null, this.ctx.storage.sql, input),
    );
    await this.rearm();
    return result;
  }

  async reconcileCodeModeBudget(
    input: CodeModeOrganisationReconcileInput,
  ): Promise<
    Result<CodeModeOrganisationReservation, CodeModeOrganisationActorError>
  > {
    const organisation = validateCodeModeOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
      false,
    );
    if (!organisation.ok) return organisation;
    return this.ctx.storage.transactionSync(
      reconcileCodeModeOrganisationBudget.bind(
        null,
        this.ctx.storage.sql,
        input,
      ),
    );
  }
}
