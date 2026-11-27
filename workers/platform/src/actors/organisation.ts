import type { ScreenRelevanceCheckInput } from "@purin-labs/area-integrations/server/jev-features/screen-relevance-check";
import { deleteOldScreenRelevanceRecords } from "@purin-labs/area-integrations/server/jev-features/screen-relevance";
import { sealJevUsageHours } from "@purin-labs/area-integrations/server/jev-features/usage-records";
import {
  mailSwitchMoveDue,
  moveMailSwitch,
} from "@purin-labs/agent/integrations/typesafe/authority";
import {
  actorMachineCensus,
  type MachineCensus,
} from "@purin-labs/actor-runtime/actors/lifecycle/machine-census";
import { ACTOR_MACHINES } from "./actor-machines";
import {
  armAlarmAfterFailedSteps,
  runAlarmSteps,
} from "@purin-labs/actor-runtime/actors/lifecycle/actor-alarm";
import type { CollaborationAgent } from "@purin-labs/collaboration";
import { screenMediaBase } from "@purin-labs/area-cafe-contract/server/media";
import {
  CHAT_SIGNAL_SOCKET_HANDLER,
  isChatSignalSocket,
  openChatSignalSocket,
  sendChatSignal,
  sweepChatSignalSockets,
} from "@purin-labs/conversation/actors/chat-signal-sockets";
import type { ChatSignalTarget } from "@purin-labs/conversation/chat/signals";
import {
  authorizeChatSignalRequest,
  matchChatSignalRoute,
} from "@purin-labs/conversation/control/admission/chat-signals";
import {
  ensureWorkspaceCanvasChat,
  continueWorkspaceCanvasChat,
} from "@purin-labs/conversation/chat/workspace-canvas";
import { readWorkspaceCanvasChat } from "@purin-labs/surface-portal/server/chat/workspace-canvas-read";
import {
  CHAT_SIGNAL,
  SURFACE_EFFECT_SIGNAL,
  isConversationId,
  type ChatSignal,
} from "@purin-labs/control-api";
import { workflowCanvasDocumentId } from "@purin-labs/bakery-model/bakery-canvas-source";
import type { WorkflowCanvasSource } from "@purin-labs/bakery-model/bakery-canvas-source";
import { savedBakeryRunArchiveKeys } from "@purin-labs/area-kitchen/server/bakery/saved-runs";
import {
  reconcileFrozenOrganisationReceipt,
  type RelocationReceiptRequest,
} from "@purin-labs/area-commerce/server/actors/organisation-relocation-receipt";
import { workspaceRevisionArchiveKeys } from "@purin-labs/agent/workspace-revision-store";
import { readPortalChatAttachmentKeys } from "@purin-labs/conversation/chat/attachments";
import { readChatForkAttachmentKeys } from "@purin-labs/agent/chat/fork-history";
import {
  captureOrganisationDataArchive,
  deleteOrganisationDataArchivePages,
  restoreOrganisationDataArchive,
} from "@purin-labs/actor-runtime/data/organisation-regional-copy";
import type { SessionTurnExecution } from "@purin-labs/conversation/chat/turn-access";
import { type MailEvaluationInput } from "@purin-labs/area-inbox/server/mail-inbox/evaluation";
import {
  canAdmitOrganisationArchiveCleanup,
  closeOrganisationArchiveCleanupAdmission,
  type OrganisationArchiveCleanupError,
  type OrganisationArchiveCleanupRequest,
} from "@purin-labs/actor-runtime/actors/organisation-archive-cleanup";
import type { ActorFenceToken } from "@purin-labs/actor-runtime/actors/actor-registry";
import type { RelocationReceiptOrganisationRpc } from "@purin-labs/actor-runtime/actors/actor-relocation";
import type { OrganisationQuiescenceRpc } from "@purin-labs/actor-runtime/actors/placement-execution-quiescence";
import type { OrganisationArchiveCleanupRpc } from "@purin-labs/area-organisation/server/data/onboarding-reconciliation";
import type { OrganisationBakeStockLevelRpc } from "@purin-labs/area-organisation/server/data/operator-configuration-draft";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import {
  CostsSheetRooms,
  type CostsSheetAgentEdit,
  type CostsSheetSettleInput,
} from "@purin-labs/area-kitchen/server/actors/costs-sheet-draft";
import { cafeCollaborationRooms } from "@purin-labs/area-cafe/server/actors/cafe-collaboration-rooms";
import {
  dispatchCollaborationFetch,
  resolveCollaborationSocket,
  type CollaborationRoomRoute,
  type CollaborationSocketRooms,
} from "@purin-labs/collaboration/worker/collaboration-room-dispatch";
import { commerceCollaborationRooms } from "@purin-labs/area-commerce/server/actors/commerce-collaboration-rooms";
import { inboxCollaborationRooms } from "@purin-labs/area-inbox/server/actors/inbox-collaboration-rooms";
import { kitchenCollaborationRooms } from "@purin-labs/area-kitchen/server/actors/kitchen-collaboration-rooms";
import {
  ProductDescriptionDraftRooms,
  type DraftAgentEdit,
  type DraftAgentReadRequest,
  type OrganisationDescriptionDraftThreadRpc,
} from "@purin-labs/area-commerce/server/actors/product-description-draft";
import {
  EmailDraftRooms,
  type EmailDraftAgentEdit,
} from "@purin-labs/area-inbox/server/actors/email-draft";
import {
  MailReplyDraftRooms,
  type MailReplyDraftAgentEdit,
} from "@purin-labs/area-inbox/server/actors/mail-reply-draft";
import {
  MenuDraftRooms,
  type MenuDraftAgentEdit,
} from "@purin-labs/area-cafe/server/actors/menu-draft";
import {
  MenuBoardRooms,
  type MenuBoardAgentEdit,
  type MenuBoardAgentPreview,
  type OrganisationMenuBoardPreviewRpc,
} from "@purin-labs/area-cafe/server/actors/menu-boards";
import {
  MenuScreens,
  isMenuScreenSocket,
  isMenuScreenSocketPath,
  menuScreenSocketToken,
  parseMenuScreenToken,
} from "@purin-labs/area-cafe/server/actors/menu-screens";
import {
  runMenuBoardCommand,
  type MenuBoardCommand,
  type MenuBoardCommandReply,
} from "@purin-labs/area-cafe/server/actors/menu-board-commands";
import {
  ProductionPlanRooms,
  type ProductionPlanAgentEdit,
} from "@purin-labs/area-kitchen/server/actors/production-plan";
import {
  openCanvasPages,
  signalCanvasChat,
  WorkflowCanvasRooms,
} from "@purin-labs/area-kitchen/server/actors/workflow-canvas-rooms";
import type {
  DraftChangeSet,
  DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft-shape";
import { WorkflowDraftRooms } from "@purin-labs/area-kitchen/server/actors/workflow-draft";
import {
  collaborationSocketRoute,
  type CollaborationSocketRoom,
} from "@purin-labs/collaboration/worker/collaboration-room";
import {
  acceptedSocket,
  closeAcceptedSocket,
  closeAllSockets,
  closeSocket,
  createSocketSweepSchema,
  finishSocketSweep,
  installSocketAutoResponse,
  openSockets,
  readSocketSweepDueAt,
  scheduleSocketSweep,
} from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import type { ControlSessionId } from "@purin-labs/kernel/ids";
import type { UserId } from "@purin-labs/control-api/ids";
import {
  CanvasAgentRequest,
  CanvasMoveRequest,
} from "@purin-labs/workflow-canvas-crdt/move";
import {
  authorizeWorkflowCanvasRequest,
  matchWorkflowCanvasRoute,
} from "@purin-labs/area-kitchen/server/control/admission/workflow-canvas";
import {
  authorizeMenuBoardSocketRequest,
  matchMenuBoardSocketRoute,
} from "@purin-labs/area-cafe/server/control/admission/menu-boards";
import {
  controlError,
  readBoundedJsonRecord,
} from "@purin-labs/control/worker/http";
import type { Env } from "@purin-labs/kernel/env";
import {
  parseOrganisationId,
  newRequestId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import type { Result } from "@purin-labs/kernel/result";
import {
  admitActorRecovery,
  advanceActorActivationSchema,
  pinnedActorDatabase,
  type ActorActivationSchemaAdvance,
  type ActorActivationSchemaAdvanceError,
} from "@purin-labs/actor-runtime/actors/actor-activation";
import {
  exportActorPlacement,
  importActorExport,
  loadActorExport,
  readActivationExportSource,
  type ActorExportError,
  type ActorExportRef,
  type ActorExportRequest,
  type ActorImportRequest,
  type ActorImportedState,
} from "@purin-labs/actor-runtime/actors/actor-export";
import { createCodeModeBudgetSchema } from "@purin-labs/agent/actors/code-mode-budget";
import { SHOPIFY_ORGANISATION_PART } from "@purin-labs/area-integrations/shopify/organisation-part";
import type { CaseExecutionEffectRecords } from "@purin-labs/agent/case-execution/records";
import type { OrganisationBrainRpc } from "@purin-labs/area-brain/server/actors/organisation-brain-rpc";
import type { OrganisationInboxRpc } from "@purin-labs/area-inbox/server/actors/organisation/organisation-inbox-rpc";
import type { OrganisationKitchenRpc } from "@purin-labs/area-kitchen/server/actors/organisation-kitchen-rpc";
import type { OrganisationMenuBoardRpc } from "@purin-labs/area-cafe-contract/server/menu-board-commands";
import { readCaseEffectRecords } from "@purin-labs/area-brain/server/actors/organisation-execution-records";
import { type AcceptedMemoryCursor } from "@purin-labs/area-brain/server/memory/store";
import { cleanupTypeSafeCredentials } from "@purin-labs/agent/integrations/typesafe/connection";
import { assertNever, errorMessage } from "@purin-labs/std";
import type { CommerceBoardPresenceEntry } from "@purin-labs/commerce-control-api";
import {
  OrganisationActivation,
  type OrganisationActivationRpc,
} from "@purin-labs/area-organisation/server/actors/organisation/activation";
import {
  CASE_CONTEXT_SOURCE_FOR_POLICY,
  deliverCaseContextCollectionInvalidations,
} from "@purin-labs/area-inbox/server/actors/organisation/case-context-collection";
import { createOrganisationSchema } from "./organisation/schema";
import { schemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import { expireOrganisationLeases } from "@purin-labs/agent/actors/organisation-alarm";
import {
  organisationRowToMeta,
  resolveOrganisationActorDatabase,
} from "@purin-labs/actor-runtime/actors/organisation-actor";
import {
  pruneCommerceBoardPresence,
  readCommerceBoardPresence,
} from "@purin-labs/area-commerce/server/actors/organisation/board-presence";
import {
  socketSweepInterval,
  sweepSafely,
} from "@purin-labs/collaboration/worker/socket-sweep";
import type {
  CommerceBoardPresenceRead,
  CommerceBoardPresenceUpdate,
  OrganisationBoardPresenceRpc,
} from "@purin-labs/area-commerce/server/actors/organisation/commerce-types";
import type {
  OrganisationMeta,
  OrganisationMetaRequest,
  OrganisationPing,
  OrganisationStateError,
} from "@purin-labs/tenancy/actors/organisation/types";
import {
  OrganisationCommerce,
  type OrganisationCommerceRpc,
} from "@purin-labs/area-commerce/server/actors/organisation/organisation-commerce";
import { OrganisationActorBase } from "./organisation/organisation-actor-base";
import {
  activateOrganisationPolicy,
  admittedEvaluateCaseContextDiscovery,
  admittedManageTypeSafeConnection,
  admittedPublishCaseContextDiscoveryConfiguration,
  admittedReadCaseContextDiscoveryConfiguration,
  admittedReadCaseContextDiscoverySourceReadiness,
  admittedReadTypeSafeConnectionConfiguration,
  type OrganisationPolicyHost,
  type OrganisationPolicyRpc,
} from "@purin-labs/agent/actors/organisation/organisation-policy";
import {
  admittedCommitCaseContextCollectionEffectFence,
  admittedEraseCaseContextCollectionSource,
  admittedInvalidateCaseContextCollectionVerification,
  admittedPrepareCaseContextCollectionEvidence,
  admittedReadCaseContextCollection,
  admittedReadCaseContextCollectionsForCase,
  admittedReviewCaseContextCollectionRelationship,
  admittedValidateCaseContextCollectionEvidence,
  type OrganisationCaseContextCollectionRpc,
  type OrganisationCollectionHost,
} from "@purin-labs/area-inbox/server/actors/organisation/case-context-collection-commands";
import {
  JEV_FOR_POLICY,
  manageJevFeatureForOrganisation,
  manageJevPaidUseForOrganisation,
  readJevFeaturesForOrganisation,
  type OrganisationJevHost,
  type OrganisationJevRpc,
} from "@purin-labs/area-integrations/server/jev-features/organisation-settings";
import type {
  OrganisationActivatePolicyInput,
  OrganisationPolicyActivation,
  OrganisationPolicyActivationError,
} from "@purin-labs/authority/actors/organisation/policy-types";
import {
  organisationPlacementConflict,
  readOrganisationMetaRow,
  validateActionOrganisation,
} from "@purin-labs/tenancy/actors/organisation/organisation-record";

import {
  bakeKitchenPorts,
  readBakeRunOf,
  counterStockChanges,
  readBakeBoard,
} from "@purin-labs/area-kitchen/server/bakes/organisation-part";
import {
  readApprovedBakeProposal,
  runBakeCommand,
  type BakeCommand,
} from "@purin-labs/area-kitchen/server/bakes/commands";
import { setBakeStockLevel } from "@purin-labs/area-kitchen/server/bakes/levels";
import type { BakeStockLevelInput } from "@purin-labs/kitchen-control-api";
import type { InventoryStockChange } from "@purin-labs/area-commerce-contract/server/commerce-projection";
/** The RPC methods of the Shopify part of the Organisation. */
type ShopifyRpc = ReturnType<(typeof SHOPIFY_ORGANISATION_PART)["open"]>;

export class OrganisationDO
  extends OrganisationActorBase
  implements
    OrganisationPolicyRpc,
    OrganisationJevRpc,
    OrganisationCaseContextCollectionRpc,
    OrganisationCommerceRpc,
    OrganisationActivationRpc,
    OrganisationBrainRpc,
    OrganisationInboxRpc,
    OrganisationKitchenRpc,
    OrganisationMenuBoardRpc,
    OrganisationMenuBoardPreviewRpc,
    OrganisationBoardPresenceRpc,
    OrganisationDescriptionDraftThreadRpc,
    OrganisationQuiescenceRpc,
    RelocationReceiptOrganisationRpc,
    OrganisationArchiveCleanupRpc,
    OrganisationBakeStockLevelRpc
{
  // Commerce (`actors/organisation/organisation-commerce.ts`): the actions,
  // the cues, the commerce lab, the Code Mode leases and the workspace
  // executor allocation.

  protected readonly commerce = new OrganisationCommerce(
    this.moduleHost,
    // Plan 24 S1: a fall of the counter stock can open a bake proposal.
    {
      afterStockChanges: (scope, changes) =>
        this.afterCommerceStockChanges(scope, changes),
    },
  );

  // Shopify (`shopify/organisation-part.ts` of the integrations area): the
  // observed locations of the selected shop. A removal of Shopify deletes
  // this part, its two RPC methods and its schema line.

  protected readonly shopify = SHOPIFY_ORGANISATION_PART.open(this.moduleHost);

  // Activation (`actors/organisation/activation.ts`): the onboarding
  // activation and its acceptance fault.

  protected readonly activation = new OrganisationActivation(this.moduleHost, {
    ensureOrganisation: (input) => this.ensureOrganisation(input),
    activatePolicy: (input) => this.activatePolicy(input),
  });

  proposeAction(...input: Parameters<OrganisationCommerce["proposeAction"]>) {
    return this.commerce.proposeAction(...input);
  }

  requestActionApproval(
    ...input: Parameters<OrganisationCommerce["requestActionApproval"]>
  ) {
    return this.commerce.requestActionApproval(...input);
  }

  getAction(...input: Parameters<OrganisationCommerce["getAction"]>) {
    return this.commerce.getAction(...input);
  }

  readActionActivity(
    ...input: Parameters<OrganisationCommerce["readActionActivity"]>
  ) {
    return this.commerce.readActionActivity(...input);
  }

  signAction(...input: Parameters<OrganisationCommerce["signAction"]>) {
    return this.commerce.signAction(...input);
  }

  rejectAction(...input: Parameters<OrganisationCommerce["rejectAction"]>) {
    return this.commerce.rejectAction(...input);
  }

  beginActionExecution(
    ...input: Parameters<OrganisationCommerce["beginActionExecution"]>
  ) {
    return this.commerce.beginActionExecution(...input);
  }

  retryIndeterminateActionExecution(
    ...input: Parameters<
      OrganisationCommerce["retryIndeterminateActionExecution"]
    >
  ) {
    return this.commerce.retryIndeterminateActionExecution(...input);
  }

  completeActionExecution(
    ...input: Parameters<OrganisationCommerce["completeActionExecution"]>
  ) {
    return this.commerce.completeActionExecution(...input);
  }

  recordCommerceEntityPlaneEffect(
    ...input: Parameters<
      OrganisationCommerce["recordCommerceEntityPlaneEffect"]
    >
  ) {
    return this.commerce.recordCommerceEntityPlaneEffect(...input);
  }

  reconcileActionExecution(
    ...input: Parameters<OrganisationCommerce["reconcileActionExecution"]>
  ) {
    return this.commerce.reconcileActionExecution(...input);
  }

  reconcileCommerceProviderReceipt(
    ...input: Parameters<
      OrganisationCommerce["reconcileCommerceProviderReceipt"]
    >
  ) {
    return this.commerce.reconcileCommerceProviderReceipt(...input);
  }

  claimCueDelivery(
    ...input: Parameters<OrganisationCommerce["claimCueDelivery"]>
  ) {
    return this.commerce.claimCueDelivery(...input);
  }

  completeClaimedCueDelivery(
    ...input: Parameters<OrganisationCommerce["completeClaimedCueDelivery"]>
  ) {
    return this.commerce.completeClaimedCueDelivery(...input);
  }

  applyCommerceDelivery(
    ...input: Parameters<OrganisationCommerce["applyCommerceDelivery"]>
  ) {
    return this.commerce.applyCommerceDelivery(...input);
  }

  readRecoverableCommerceCues(
    ...input: Parameters<OrganisationCommerce["readRecoverableCommerceCues"]>
  ) {
    return this.commerce.readRecoverableCommerceCues(...input);
  }

  readCurrentCommerceProjection(
    ...input: Parameters<OrganisationCommerce["readCurrentCommerceProjection"]>
  ) {
    return this.commerce.readCurrentCommerceProjection(...input);
  }

  readCommerceProjectionHistory(
    ...input: Parameters<OrganisationCommerce["readCommerceProjectionHistory"]>
  ) {
    return this.commerce.readCommerceProjectionHistory(...input);
  }

  readExactCommerceProjectionReference(
    ...input: Parameters<
      OrganisationCommerce["readExactCommerceProjectionReference"]
    >
  ) {
    return this.commerce.readExactCommerceProjectionReference(...input);
  }

  markCommerceCuesEnqueued(
    ...input: Parameters<OrganisationCommerce["markCommerceCuesEnqueued"]>
  ) {
    return this.commerce.markCommerceCuesEnqueued(...input);
  }

  settleCommerceCues(
    ...input: Parameters<OrganisationCommerce["settleCommerceCues"]>
  ) {
    return this.commerce.settleCommerceCues(...input);
  }

  readAcceptedCommerceProjectionSequence(
    ...input: Parameters<
      OrganisationCommerce["readAcceptedCommerceProjectionSequence"]
    >
  ) {
    return this.commerce.readAcceptedCommerceProjectionSequence(...input);
  }

  readCommerceQueryPlan(
    ...input: Parameters<OrganisationCommerce["readCommerceQueryPlan"]>
  ) {
    return this.commerce.readCommerceQueryPlan(...input);
  }

  readCommerceRelationshipStep(
    ...input: Parameters<OrganisationCommerce["readCommerceRelationshipStep"]>
  ) {
    return this.commerce.readCommerceRelationshipStep(...input);
  }

  readCommerceSystemSyncStatus(
    ...input: Parameters<OrganisationCommerce["readCommerceSystemSyncStatus"]>
  ) {
    return this.commerce.readCommerceSystemSyncStatus(...input);
  }

  validateCommerceSystemProjections(
    ...input: Parameters<
      OrganisationCommerce["validateCommerceSystemProjections"]
    >
  ) {
    return this.commerce.validateCommerceSystemProjections(...input);
  }

  seedCommerceLab(
    ...input: Parameters<OrganisationCommerce["seedCommerceLab"]>
  ) {
    return this.commerce.seedCommerceLab(...input);
  }

  resetCommerceLab(
    ...input: Parameters<OrganisationCommerce["resetCommerceLab"]>
  ) {
    return this.commerce.resetCommerceLab(...input);
  }

  verifyCommerceLab(
    ...input: Parameters<OrganisationCommerce["verifyCommerceLab"]>
  ) {
    return this.commerce.verifyCommerceLab(...input);
  }

  activateOnboarding(
    ...input: Parameters<OrganisationActivation["activateOnboarding"]>
  ) {
    return this.activation.activateOnboarding(...input);
  }

  armOnboardingActivationAcceptanceFault(
    ...input: Parameters<
      OrganisationActivation["armOnboardingActivationAcceptanceFault"]
    >
  ) {
    return this.activation.armOnboardingActivationAcceptanceFault(...input);
  }

  inspectOnboardingActivationAcceptanceFault(
    ...input: Parameters<
      OrganisationActivation["inspectOnboardingActivationAcceptanceFault"]
    >
  ) {
    return this.activation.inspectOnboardingActivationAcceptanceFault(...input);
  }

  clearOnboardingActivationAcceptanceFault(
    ...input: Parameters<
      OrganisationActivation["clearOnboardingActivationAcceptanceFault"]
    >
  ) {
    return this.activation.clearOnboardingActivationAcceptanceFault(...input);
  }

  armCafeCommerceAcceptanceFault(
    ...input: Parameters<OrganisationCommerce["armCafeCommerceAcceptanceFault"]>
  ) {
    return this.commerce.armCafeCommerceAcceptanceFault(...input);
  }

  inspectCafeCommerceAcceptanceFault(
    ...input: Parameters<
      OrganisationCommerce["inspectCafeCommerceAcceptanceFault"]
    >
  ) {
    return this.commerce.inspectCafeCommerceAcceptanceFault(...input);
  }

  consumeCafeCommerceAcceptanceFault(
    ...input: Parameters<
      OrganisationCommerce["consumeCafeCommerceAcceptanceFault"]
    >
  ) {
    return this.commerce.consumeCafeCommerceAcceptanceFault(...input);
  }

  clearCafeCommerceAcceptanceFault(
    ...input: Parameters<
      OrganisationCommerce["clearCafeCommerceAcceptanceFault"]
    >
  ) {
    return this.commerce.clearCafeCommerceAcceptanceFault(...input);
  }

  settleCutoverCue(
    ...input: Parameters<OrganisationCommerce["settleCutoverCue"]>
  ) {
    return this.commerce.settleCutoverCue(...input);
  }

  reserveCodeModeBudget(
    ...input: Parameters<OrganisationCommerce["reserveCodeModeBudget"]>
  ) {
    return this.commerce.reserveCodeModeBudget(...input);
  }

  settleCodeModeBudget(
    ...input: Parameters<OrganisationCommerce["settleCodeModeBudget"]>
  ) {
    return this.commerce.settleCodeModeBudget(...input);
  }

  claimCodeModeCapability(
    ...input: Parameters<OrganisationCommerce["claimCodeModeCapability"]>
  ) {
    return this.commerce.claimCodeModeCapability(...input);
  }

  abandonCodeModeCapabilityCalls(
    ...input: Parameters<OrganisationCommerce["abandonCodeModeCapabilityCalls"]>
  ) {
    return this.commerce.abandonCodeModeCapabilityCalls(...input);
  }

  rebindCodeModeLease(
    ...input: Parameters<OrganisationCommerce["rebindCodeModeLease"]>
  ) {
    return this.commerce.rebindCodeModeLease(...input);
  }

  completeCodeModeCapability(
    ...input: Parameters<OrganisationCommerce["completeCodeModeCapability"]>
  ) {
    return this.commerce.completeCodeModeCapability(...input);
  }

  reserveWorkspaceExecutorAllocation(
    ...input: Parameters<
      OrganisationCommerce["reserveWorkspaceExecutorAllocation"]
    >
  ) {
    return this.commerce.reserveWorkspaceExecutorAllocation(...input);
  }

  settleWorkspaceExecutorAllocation(
    ...input: Parameters<
      OrganisationCommerce["settleWorkspaceExecutorAllocation"]
    >
  ) {
    return this.commerce.settleWorkspaceExecutorAllocation(...input);
  }

  cancelWorkspaceExecutorAllocation(
    ...input: Parameters<
      OrganisationCommerce["cancelWorkspaceExecutorAllocation"]
    >
  ) {
    return this.commerce.cancelWorkspaceExecutorAllocation(...input);
  }

  cancelCodeModeBudget(
    ...input: Parameters<OrganisationCommerce["cancelCodeModeBudget"]>
  ) {
    return this.commerce.cancelCodeModeBudget(...input);
  }

  reconcileCodeModeBudget(
    ...input: Parameters<OrganisationCommerce["reconcileCodeModeBudget"]>
  ) {
    return this.commerce.reconcileCodeModeBudget(...input);
  }

  // The policy of the Organisation (`actors/organisation/organisation-policy.ts`):
  // the policy activation, the TypeSafe connection and the Case context
  // discovery configuration. The Inbox gives the source of a collection, and
  // the integrations area gives the Jev parts.

  #policyHost(): OrganisationPolicyHost {
    return {
      env: this.env,
      storage: this.ctx.storage,
      transaction: () =>
        schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      rearm: () => this.rearm(),
      jev: JEV_FOR_POLICY,
      caseContextSource: CASE_CONTEXT_SOURCE_FOR_POLICY,
    };
  }

  async readCaseContextDiscoveryConfiguration(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReadCaseContextDiscoveryConfiguration.bind(
        null,
        this.#policyHost(),
      ),
    );
  }

  async readTypeSafeConnectionConfiguration(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReadTypeSafeConnectionConfiguration.bind(
        null,
        this.#policyHost(),
      ),
    );
  }

  async manageTypeSafeConnection(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedManageTypeSafeConnection.bind(null, this.#policyHost(), input),
    );
  }

  async readCaseContextDiscoverySourceReadiness(
    input: Readonly<{
      organisationId: OrganisationId;
      source: "gmail" | "whatsapp" | "commerce";
      integrationAccountId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReadCaseContextDiscoverySourceReadiness.bind(
        null,
        this.#policyHost(),
        input,
      ),
    );
  }

  async publishCaseContextDiscoveryConfiguration(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedPublishCaseContextDiscoveryConfiguration.bind(
        null,
        this.#policyHost(),
        input,
      ),
    );
  }

  async evaluateCaseContextDiscovery(
    input: Readonly<{
      organisationId: OrganisationId;
      request: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedEvaluateCaseContextDiscovery.bind(
        null,
        this.#policyHost(),
        input,
      ),
    );
  }

  async activatePolicy(
    input: OrganisationActivatePolicyInput,
  ): Promise<
    Result<OrganisationPolicyActivation, OrganisationPolicyActivationError>
  > {
    return activateOrganisationPolicy(this.#policyHost(), input);
  }

  // The Case context collection of the Inbox
  // (`actors/organisation/case-context-collection-commands.ts`).

  #collectionHost(): OrganisationCollectionHost {
    return {
      env: this.env,
      storage: this.ctx.storage,
      transaction: () =>
        schemaTransaction(this.ctx.storage, this.ctx.storage.sql),
      validateOrganisation: validateActionOrganisation.bind(
        null,
        this.ctx.storage.sql,
      ),
      rearm: () => this.rearm(),
    };
  }

  async prepareCaseContextCollectionEvidence(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
      integrationAccountId: string;
      triggeringMessageId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedPrepareCaseContextCollectionEvidence.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async validateCaseContextCollectionEvidence(
    input: Readonly<{ organisationId: OrganisationId; dependency: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      admittedValidateCaseContextCollectionEvidence.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async commitCaseContextCollectionEffectFence(
    input: Readonly<{ organisationId: OrganisationId; attempt: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      admittedCommitCaseContextCollectionEffectFence.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async invalidateCaseContextCollectionVerification(
    input: Readonly<{
      organisationId: OrganisationId;
      verificationId: string;
      revision: number;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedInvalidateCaseContextCollectionVerification.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async eraseCaseContextCollectionSource(
    input: Readonly<{ organisationId: OrganisationId; selection: unknown }>,
  ) {
    return this.command(
      input.organisationId,
      admittedEraseCaseContextCollectionSource.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async readCaseContextCollection(
    input: Readonly<{
      organisationId: OrganisationId;
      caseContextCollectionId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReadCaseContextCollection.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async readCaseContextCollectionsForCase(
    input: Readonly<{
      organisationId: OrganisationId;
      caseId: string;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReadCaseContextCollectionsForCase.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  async reviewCaseContextCollectionRelationship(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      caseContextCollectionId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      admittedReviewCaseContextCollectionRelationship.bind(
        null,
        this.#collectionHost(),
        input,
      ),
    );
  }

  // The Jev settings of the integrations area (`jev-features/`).

  #jevHost(): OrganisationJevHost {
    return {
      env: this.env,
      storage: this.ctx.storage,
      validateOrganisation: validateActionOrganisation.bind(
        null,
        this.ctx.storage.sql,
      ),
      publishCaseContextDiscoveryConfiguration:
        admittedPublishCaseContextDiscoveryConfiguration.bind(
          null,
          this.#policyHost(),
        ),
    };
  }

  async readJevFeatures(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      readJevFeaturesForOrganisation.bind(null, this.#jevHost()),
    );
  }

  async manageJevPaidUse(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      manageJevPaidUseForOrganisation.bind(null, this.#jevHost(), input),
    );
  }

  async manageJevFeature(
    input: Readonly<{
      organisationId: OrganisationId;
      actorId: string;
      body: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      manageJevFeatureForOrganisation.bind(null, this.#jevHost(), input),
    );
  }

  /** State counts of this Actor's machines, for the census (Refactor 15, S5). */
  machineCensus(): Promise<readonly MachineCensus[]> {
    return actorMachineCensus(this.ctx.storage, ACTOR_MACHINES);
  }

  readonly #commerceBoardPresence = new Map<
    string,
    CommerceBoardPresenceEntry
  >();
  readonly #costsSheets: CostsSheetRooms;
  readonly #descriptionDrafts: ProductDescriptionDraftRooms;
  readonly #emailDrafts: EmailDraftRooms;
  readonly #mailReplyDrafts: MailReplyDraftRooms;
  readonly #menuDrafts: MenuDraftRooms;
  readonly #menuBoards: MenuBoardRooms;
  readonly #menuScreens: MenuScreens;
  readonly #productionPlans: ProductionPlanRooms;
  readonly #workflowCanvases: WorkflowCanvasRooms;
  readonly #workflowDrafts: WorkflowDraftRooms;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { executionBarrier: false });
    createOrganisationSchema(this.ctx.storage);
    SHOPIFY_ORGANISATION_PART.createSchema(this.ctx.storage.sql);
    createCodeModeBudgetSchema(this.ctx.storage);
    createSocketSweepSchema(this.ctx.storage.sql);
    installSocketAutoResponse(this.ctx);
    this.#costsSheets = new CostsSheetRooms(this.ctx, this.env);
    this.#descriptionDrafts = new ProductDescriptionDraftRooms(
      this.ctx,
      this.env,
    );
    this.#emailDrafts = new EmailDraftRooms(this.ctx, this.env);
    this.#mailReplyDrafts = new MailReplyDraftRooms(this.ctx, this.env);
    this.#menuDrafts = new MenuDraftRooms(this.ctx, this.env);
    this.#menuBoards = new MenuBoardRooms(this.ctx, this.env);
    this.#menuScreens = new MenuScreens(this.ctx);
    this.#productionPlans = new ProductionPlanRooms(this.ctx, this.env);
    this.#workflowCanvases = new WorkflowCanvasRooms(this.ctx, this.env);
    this.#workflowDrafts = new WorkflowDraftRooms(this.ctx, this.env);
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const handler = await this.#socketHandler(socket);
    if (handler === null) {
      closeSocket(socket, 1011, "Unknown collaboration socket");
      return;
    }
    handler.receive(socket, message);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    (await this.#socketHandler(socket))?.closed(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    (await this.#socketHandler(socket))?.closed(socket);
  }

  /**
   * Sends a chat signal after a committed write. A lost signal costs a later
   * read, so the signal never fails its writer. The recipient query reads the
   * regional database that this Actor's activation pins; a signal changes
   * nothing, so it needs no admission.
   */
  async signalChat(
    input: Readonly<{
      organisationId: OrganisationId;
      target: ChatSignalTarget;
      /** Absent from a caller of an earlier build: the chat changed. */
      kind?: ChatSignal["kind"];
    }>,
  ): Promise<void> {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined || row.organisation_id !== input.organisationId)
      return;
    await sendChatSignal(
      this.ctx,
      input.organisationId,
      input.target,
      () =>
        pinnedActorDatabase(
          this.env,
          this.ctx.storage.sql,
          input.organisationId,
        ),
      { open: openCanvasPages, signal: signalCanvasChat },
      input.kind === SURFACE_EFFECT_SIGNAL
        ? SURFACE_EFFECT_SIGNAL
        : CHAT_SIGNAL,
    );
  }

  /** What handles an accepted socket's events: its chat page or its room. */
  async #socketHandler(
    socket: WebSocket,
  ): Promise<Pick<CollaborationSocketRoom, "receive" | "closed"> | null> {
    if (isChatSignalSocket(socket)) return CHAT_SIGNAL_SOCKET_HANDLER;
    if (isMenuScreenSocket(socket)) return this.#menuScreens.socketHandler;
    return this.#socketRoom(socket);
  }

  /**
   * The shared document rooms. Each area gives its routes and its socket
   * rooms. This class sets the order in which the dispatch tries the routes.
   */
  #collaborationRooms(): Readonly<{
    routes: readonly CollaborationRoomRoute[];
    sockets: CollaborationSocketRooms;
  }> {
    const kitchen = kitchenCollaborationRooms({
      costsSheets: this.#costsSheets,
      productionPlans: this.#productionPlans,
      workflowCanvases: this.#workflowCanvases,
      workflowDrafts: this.#workflowDrafts,
    });
    const commerce = commerceCollaborationRooms({
      descriptionDrafts: this.#descriptionDrafts,
    });
    const inbox = inboxCollaborationRooms({
      emailDrafts: this.#emailDrafts,
      mailReplyDrafts: this.#mailReplyDrafts,
    });
    const cafe = cafeCollaborationRooms({
      menuBoards: this.#menuBoards,
      menuDrafts: this.#menuDrafts,
    });
    return {
      routes: [
        kitchen.routes.costsSheet,
        commerce.routes.productDescription,
        kitchen.routes.workflowDraft,
        kitchen.routes.productionPlan,
        inbox.routes.mailReplyDraft,
        inbox.routes.emailDraft,
        cafe.routes.menuDraft,
      ],
      sockets: {
        ...kitchen.sockets,
        ...commerce.sockets,
        ...inbox.sockets,
        ...cafe.sockets,
      },
    };
  }

  /** The room of an accepted socket, built again after a wake. */
  async #socketRoom(
    socket: WebSocket,
  ): Promise<CollaborationSocketRoom | null> {
    const route = collaborationSocketRoute(socket.deserializeAttachment());
    if (route === null) return null;
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined) return null;
    const organisationId = parseOrganisationId(row.organisation_id);
    if (!organisationId.ok) return null;
    return resolveCollaborationSocket(
      this.#collaborationRooms().sockets,
      organisationId.value,
      route,
    );
  }

  /**
   * Runs the chat sweep and each room's sweep once, then sets the next sweep
   * while a socket stays open. A sweep that fails leaves the others, and the
   * next sweep, to run. A room that cannot be built now closes its sockets,
   * so that their clients open them again instead of staying unswept.
   */
  async #sweepSockets(scope: OrganisationExecutionScope): Promise<void> {
    await sweepSafely("chat", () =>
      sweepChatSignalSockets(this.ctx, this.env, scope),
    );
    await sweepSafely("menu_screens", async () =>
      this.#menuScreens.sweep(Date.now()),
    );
    const rooms = new Map<
      string,
      { room: Promise<CollaborationSocketRoom | null>; sockets: WebSocket[] }
    >();
    for (const socket of openSockets(this.ctx)) {
      if (isChatSignalSocket(socket) || isMenuScreenSocket(socket)) continue;
      const route = collaborationSocketRoute(socket.deserializeAttachment());
      if (route === null) {
        closeSocket(socket, 1011, "Unknown collaboration socket");
        continue;
      }
      const key = JSON.stringify([route.kind, route.key]);
      const entry = rooms.get(key) ?? {
        room: this.#socketRoom(socket),
        sockets: [],
      };
      entry.sockets.push(socket);
      rooms.set(key, entry);
    }
    for (const [key, entry] of rooms)
      await sweepSafely(key, async () => {
        const room = await entry.room;
        if (room !== null) return room.sweep();
        for (const socket of entry.sockets)
          closeSocket(socket, 1013, "room_unavailable");
      });
    this.ctx.storage.transactionSync(
      finishSocketSweep.bind(
        null,
        this.ctx.storage.sql,
        Date.now(),
        socketSweepInterval(this.ctx),
      ),
    );
  }

  async fetch(request: Request): Promise<Response> {
    return this.trackExecution(this.executeDraftRequest.bind(this, request));
  }

  private async executeDraftRequest(request: Request): Promise<Response> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    )
      return controlError("organisation_placement_conflict", 409);
    const response = await this.admittedDraftRequest(request, admission.scope);
    if (
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    ) {
      closeAcceptedSocket(response, "Organisation placement changed");
      return controlError("organisation_placement_conflict", 409);
    }
    if (acceptedSocket(response)) {
      try {
        const interval = socketSweepInterval(this.ctx);
        if (interval !== null)
          this.ctx.storage.transactionSync(
            scheduleSocketSweep.bind(
              null,
              this.ctx.storage.sql,
              Date.now(),
              interval,
            ),
          );
        await this.rearm();
      } catch (error) {
        // A socket without its sweep would never be checked again.
        closeAcceptedSocket(response, "Socket sweep unavailable");
        throw error;
      }
    }
    return response;
  }

  private async admittedDraftRequest(
    request: Request,
    scope: OrganisationExecutionScope,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (isMenuScreenSocketPath(pathname)) {
      const raw = menuScreenSocketToken(request);
      const token = raw === null ? null : parseMenuScreenToken(raw);
      const screen =
        token === null || token.organisationId !== scope.organisationId
          ? null
          : await this.#menuScreens.verify(token.screenId, token.secret);
      return screen === null
        ? controlError("menu_screen_refused", 401)
        : this.#menuScreens.openSocket(screen, Date.now());
    }
    const boardRoute = matchMenuBoardSocketRoute(pathname);
    if (boardRoute !== null) {
      const authorized = await authorizeMenuBoardSocketRequest(
        request,
        this.env,
        boardRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        authorized.organisationId,
      );
      if (!organisation.ok) return controlError(organisation.error.code, 404);
      return this.#menuBoards.open(authorized, boardRoute.boardId, scope);
    }
    const chatSignalRoute = matchChatSignalRoute(pathname);
    if (chatSignalRoute !== null) {
      const authorized = await authorizeChatSignalRequest(
        request,
        this.env,
        chatSignalRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      return openChatSignalSocket(this.ctx, authorized);
    }
    const canvasRoute = matchWorkflowCanvasRoute(pathname);
    if (canvasRoute !== null) {
      const authorized = await authorizeWorkflowCanvasRequest(
        request,
        this.env,
        canvasRoute,
      );
      if (!authorized.ok) return authorized.response;
      if (
        authorized.organisationId !== scope.organisationId ||
        !(await isOrganisationExecutionActive(this.ctx.storage.sql, scope))
      )
        return controlError("organisation_placement_conflict", 409);
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        authorized.organisationId,
      );
      if (!organisation.ok) return controlError(organisation.error.code, 404);
      const userId = authorized.authenticated.session.userId;
      switch (canvasRoute.transport) {
        case "undo": {
          const body = await readBoundedJsonRecord(request, 1024);
          if (
            body === null ||
            typeof body.expectedRevision !== "number" ||
            !Number.isSafeInteger(body.expectedRevision) ||
            body.expectedRevision < 1 ||
            typeof body.operationId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/u.test(body.operationId)
          )
            return controlError("invalid_move", 422);
          return Response.json(
            await this.#workflowCanvases.undo(
              scope,
              canvasRoute.reference,
              body.expectedRevision,
              body.operationId,
              userId,
              authorized.authenticated.session.controlSessionId,
            ),
          );
        }
        case "chat/continue": {
          const body = await readBoundedJsonRecord(request, 1024);
          if (body === null || !isConversationId(body.conversationId))
            return controlError("invalid_conversation", 422);
          const conversationId = await continueWorkspaceCanvasChat(
            this.env,
            scope,
            userId,
            workflowCanvasDocumentId(canvasRoute.reference),
            body.conversationId,
          );
          return Response.json({ conversationId });
        }
        case "chat": {
          if (request.method === "GET") {
            const query = new URL(request.url).searchParams;
            const conversationId = query.get("conversation");
            const cursor = query.get("after");
            if (
              (conversationId !== null && !isConversationId(conversationId)) ||
              (cursor !== null && !/^[a-f0-9]{64}$/u.test(cursor))
            )
              return controlError("invalid_conversation", 422);
            return Response.json(
              await readWorkspaceCanvasChat(
                this.env,
                scope,
                userId,
                workflowCanvasDocumentId(canvasRoute.reference),
                conversationId === null
                  ? { kind: "current" }
                  : { kind: "history", conversationId },
                cursor,
              ),
            );
          }
          const source = await this.#workflowCanvases.read(
            scope,
            canvasRoute.reference,
            userId,
            { kind: "human" },
          );
          if (!source.ok) return controlError(source.error.code, 503);
          const conversationId = await ensureWorkspaceCanvasChat(
            this.env,
            scope,
            userId,
            source.value.documentId,
          );
          return Response.json({ conversationId });
        }
        case "socket":
          return this.#workflowCanvases.open(
            authorized,
            scope,
            canvasRoute.reference,
          );
        case "snapshot": {
          const read = await this.#workflowCanvases.read(
            scope,
            canvasRoute.reference,
            userId,
            { kind: "human" },
          );
          const current = await authorizeWorkflowCanvasRequest(
            request,
            this.env,
            canvasRoute,
          );
          if (!current.ok) return current.response;
          return read.ok
            ? Response.json(read)
            : controlError(read.error.code, 503);
        }
        case "move": {
          const body = await readBoundedJsonRecord(request, 2048);
          if (body === null) return controlError("invalid_move", 422);
          const move = CanvasMoveRequest.parse(body);
          if (move === null) return controlError("invalid_move", 422);
          const result = await this.#workflowCanvases.move(
            scope,
            canvasRoute.reference,
            move,
            userId,
            Date.now() + 30_000,
            {
              kind: "control_session",
              controlSessionId:
                authorized.authenticated.session.controlSessionId,
            },
            null,
          );
          return Response.json(result);
        }
        default:
          return assertNever(canvasRoute.transport);
      }
    }
    return dispatchCollaborationFetch({
      request,
      pathname,
      env: this.env,
      sql: this.ctx.storage.sql,
      scope,
      routes: this.#collaborationRooms().routes,
      validateOrganisation: validateActionOrganisation.bind(
        null,
        this.ctx.storage.sql,
      ),
    });
  }

  async readCostsSheetDraft(
    input: Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, async () =>
      this.#costsSheets.read(),
    );
  }

  async editCostsSheetDraft(input: CostsSheetAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#costsSheets.edit(input, scope),
    );
  }

  async settleCostsSheetDraft(input: CostsSheetSettleInput) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#costsSheets.settleSaved(scope, input),
    );
  }

  /** Plan 40D: an agent's read of an Inbox reply's shared draft. */
  async readMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.read(scope, input.proposalId, input.userId),
    );
  }

  async editMailReplyDraft(input: MailReplyDraftAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.edit(input, scope),
    );
  }

  /** The draft's text for a reviewed save, read by the reply route. */
  async mailReplyDraftForSave(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      saver: UserId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.forSave(input.proposalId, input.saver),
    );
  }

  async markMailReplyDraftSaved(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
      body: string;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.markSaved(
        input.proposalId,
        input.version,
        input.body,
      ),
    );
  }

  /** Whether a send of `version` sends what the shared draft shows. */
  async mailReplyDraftApproval(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      version: number;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, () =>
      this.#mailReplyDrafts.approval(input.proposalId, input.version),
    );
  }

  async reloadMailReplyDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      proposalId: string;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#mailReplyDrafts.reload(
        scope,
        input.organisationId,
        input.proposalId,
        {
          userId: input.userId,
          controlSessionId: input.controlSessionId,
        },
      ),
    );
  }

  /** Plan 40D: a location plan's draft quantities, for an agent read. */
  /** A person applied a workflow revision. Open draft pages read it again. */
  bakeryWorkflowApplied(workflowId: string): void {
    this.#workflowDrafts.revisionApplied(workflowId);
  }

  bakeryWorkflowDraftSnapshot(
    input: Readonly<{ organisationId: OrganisationId; workflowId: string }>,
  ): DraftSnapshot | null {
    return this.#workflowDrafts.snapshot(input.workflowId);
  }

  /** Plan 84: an approved proposal reaches the shared draft and its open pages. */
  async bakeryWorkflowMergeProposal(
    input: Readonly<{
      organisationId: OrganisationId;
      workflowId: string;
      change: DraftChangeSet;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#workflowDrafts.mergeProposal(
        scope,
        input.organisationId,
        input.workflowId,
        input.change,
        { userId: input.userId, controlSessionId: input.controlSessionId },
      ),
    );
  }

  async readProductionPlan(
    input: Readonly<{ organisationId: OrganisationId; locationId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async () =>
      this.#productionPlans.read(input.locationId),
    );
  }

  /** Plan 40D: the Slack thread or Portal chat shared with a plan. */
  async readProductionPlanShare(
    input: Readonly<{ organisationId: OrganisationId; locationId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async (scope) => ({
      ok: true as const,
      value: await this.#productionPlans.sharedTarget(scope, input.locationId),
    }));
  }

  /** Plan 40D: an agent's change of one line of a location's plan. */
  async editProductionPlan(input: ProductionPlanAgentEdit) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#productionPlans.edit(input, scope),
    );
  }

  /** Plan 40D: removes settled requests from a location's shared plan. */
  async clearProductionPlanLines(
    input: Readonly<{
      organisationId: OrganisationId;
      locationId: string;
      requestIds: readonly string[];
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#productionPlans.clear(
        scope,
        input.organisationId,
        input.locationId,
        input.requestIds,
        { userId: input.userId, controlSessionId: input.controlSessionId },
      ),
    );
  }

  /** Deletes the draft's text after the reply was sent, rejected or closed. */
  async closeMailReplyDraft(
    input: Readonly<{ organisationId: OrganisationId; proposalId: string }>,
  ) {
    return this.#roomCommand(input.organisationId, async () => {
      await this.#mailReplyDrafts.close(input.organisationId, input.proposalId);
      return { ok: true as const, value: null };
    });
  }

  #roomCommand<Outcome extends Result<unknown, { readonly code: string }>>(
    organisationId: OrganisationId,
    run: (scope: OrganisationExecutionScope) => Promise<Outcome>,
  ) {
    type Outcomes = Outcome | Result<never, OrganisationStateError>;
    const start = async (
      scope: OrganisationExecutionScope,
    ): Promise<Outcomes> => {
      const organisation = validateActionOrganisation(
        this.ctx.storage.sql,
        organisationId,
      );
      if (!organisation.ok) return organisation;
      return run(scope);
    };
    return this.command(organisationId, start);
  }

  async readProductDescriptionDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      request: DraftAgentReadRequest;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadProductDescriptionDraft.bind(this, input),
    );
  }

  async readWorkflowCanvas(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      userId: UserId;
      agentRequest: ReturnType<CanvasAgentRequest["toJSON"]>;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadWorkflowCanvas.bind(this, input),
    );
  }

  private async admittedReadWorkflowCanvas(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      userId: UserId;
      agentRequest: ReturnType<CanvasAgentRequest["toJSON"]>;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const request = CanvasAgentRequest.parse(input.agentRequest);
    if (request === null)
      return {
        ok: false as const,
        error: { code: "invalid_request" as const },
      };
    return this.#workflowCanvases.read(scope, input.reference, input.userId, {
      kind: "agent",
      request,
    });
  }

  async moveWorkflowCanvasObject(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      request: ReturnType<CanvasMoveRequest["toJSON"]>;
      userId: UserId;
      deadlineAt: number;
      execution: SessionTurnExecution;
      agent: CollaborationAgent;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedMoveWorkflowCanvasObject.bind(this, input),
    );
  }

  private async admittedMoveWorkflowCanvasObject(
    input: Readonly<{
      organisationId: OrganisationId;
      reference: WorkflowCanvasSource;
      request: ReturnType<CanvasMoveRequest["toJSON"]>;
      userId: UserId;
      deadlineAt: number;
      execution: SessionTurnExecution;
      agent: CollaborationAgent;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const request = CanvasMoveRequest.parse(input.request);
    if (request === null)
      return { ok: false as const, error: { code: "invalid_move" as const } };
    return this.#workflowCanvases.move(
      scope,
      input.reference,
      request,
      input.userId,
      input.deadlineAt,
      { kind: "session_turn", execution: input.execution },
      input.agent,
    );
  }

  private async admittedReadProductDescriptionDraft(
    input: Readonly<{
      organisationId: OrganisationId;
      request: DraftAgentReadRequest;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#descriptionDrafts.read(scope, input.request.productId);
  }

  async checkScreenRelevance(input: ScreenRelevanceCheckInput) {
    return this.command(
      input.organisationId,
      this.admittedCheckScreenRelevance.bind(this, input),
    );
  }

  async decideScreenRelevance(
    input: Parameters<OrganisationDO["admittedDecideScreenRelevance"]>[0],
  ) {
    return this.command(
      input.organisationId,
      this.admittedDecideScreenRelevance.bind(this, input),
    );
  }

  /** The daily pass of the Organisation deletes its old relevance records. */
  async deleteOldScreenRelevanceRecords(
    input: Readonly<{ organisationId: OrganisationId; now: number }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedDeleteOldScreenRelevanceRecords.bind(this, input),
    );
  }

  private async admittedDeleteOldScreenRelevanceRecords(
    input: Readonly<{ organisationId: OrganisationId; now: number }>,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    deleteOldScreenRelevanceRecords(this.ctx.storage.sql, input.now);
    return { ok: true as const, value: null };
  }

  async evaluateMailClassification(input: MailEvaluationInput) {
    return this.trackExecution(
      this.evaluateAdmittedMailClassification.bind(this, input),
    );
  }

  /**
   * Every Memory with its labels, for the authorized reader to filter. The
   * caller decides what a viewer or a turn may see; nothing here is released
   * to either without that check.
   */
  async readMemories(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadMemories.bind(this),
    );
  }

  /** One Memory with its labels, or null, for the authorized reader. */
  async readMemory(
    input: Readonly<{ organisationId: OrganisationId; memoryId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadMemory.bind(this, input.memoryId),
    );
  }

  /** The receipt one applied Memory command left, or null. */
  async readMemoryCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadMemoryCommandReceipt.bind(this, input.commandId),
    );
  }

  /**
   * One page of the accepted revisions scoped to one of `applicabilityKeys`,
   * with their labels, for the turn reader to filter.
   */
  async readAcceptedMemories(
    input: Readonly<{
      organisationId: OrganisationId;
      applicabilityKeys: readonly string[];
      after: AcceptedMemoryCursor | null;
      limit: number;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadAcceptedMemories.bind(this, input),
    );
  }

  /** The accepted revision of each named Memory that has one. */
  async readAcceptedMemoryRevisions(
    input: Readonly<{
      organisationId: OrganisationId;
      memoryIds: readonly string[];
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadAcceptedMemoryRevisions.bind(this, input.memoryIds),
    );
  }

  /**
   * Applies one Memory command for a principal the caller authenticated. A
   * proposal carries the label the caller joined from its evidence and author.
   */
  async commandMemory(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedCommandMemory.bind(this, input),
    );
  }

  /**
   * Every Eval with its labels, for the authorized reader to filter. The
   * caller decides what a viewer may see; nothing here is released without
   * that check.
   */
  async readEvals(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadEvals.bind(this),
    );
  }

  /** One Eval with its labels, or null, for the authorized reader. */
  async readEval(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEval.bind(this, input.evalId),
    );
  }

  /** The receipt one applied Eval command left, or null. */
  async readEvalCommandReceipt(
    input: Readonly<{ organisationId: OrganisationId; commandId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEvalCommandReceipt.bind(this, input.commandId),
    );
  }

  /**
   * Applies one Eval command for a principal the caller authenticated. A
   * proposal or a revision carries the label the caller joined for it.
   */
  async commandEval(
    input: Readonly<{
      organisationId: OrganisationId;
      principal: unknown;
      body: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedCommandEval.bind(this, input),
    );
  }

  /**
   * Records the settled result of one eval run. Run execution stays with the
   * run's Case and Sessions; this Actor receives only the result.
   */
  async settleEvalRun(
    input: Readonly<{
      organisationId: OrganisationId;
      result: unknown;
      flowLabel: unknown;
    }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedSettleEvalRun.bind(this, input),
    );
  }

  /**
   * The governed actions the ledger holds for one Case, for the Case
   * execution projection. The read changes nothing.
   */
  async readCaseExecutionEffects(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ): Promise<CaseExecutionEffectRecords | null> {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    return organisation.ok
      ? readCaseEffectRecords(
          this.ctx.storage.sql,
          input.organisationId,
          input.caseId,
        )
      : null;
  }

  /** The settled runs of one Eval with their labels, for the authorized reader. */
  async readEvalRunResults(
    input: Readonly<{ organisationId: OrganisationId; evalId: string }>,
  ) {
    return this.command(
      input.organisationId,
      this.admittedReadEvalRunResults.bind(this, input.evalId),
    );
  }

  async editProductDescriptionDraft(input: DraftAgentEdit) {
    return this.command(
      input.organisationId,
      this.admittedEditProductDescriptionDraft.bind(this, input),
    );
  }

  private async admittedEditProductDescriptionDraft(
    input: DraftAgentEdit,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#descriptionDrafts.edit(input, scope);
  }

  async readProductDescriptionDraftThread(
    input: Readonly<{
      organisationId: OrganisationId;
      productId: string;
      caseId: string;
    }>,
  ) {
    const start = this.admittedReadProductDescriptionDraftThread.bind(
      this,
      input,
    );
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  async readConnectedProductDescriptionDrafts(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const start = this.admittedReadConnectedProductDescriptionDrafts.bind(
      this,
      input,
    );
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  private async admittedReadConnectedProductDescriptionDrafts(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return {
      ok: true as const,
      value: this.#descriptionDrafts.connectedProducts(input.caseId),
    };
  }

  private async admittedReadProductDescriptionDraftThread(
    input: Readonly<{
      organisationId: OrganisationId;
      productId: string;
      caseId: string;
    }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const sharing = await this.#descriptionDrafts.sharedThread(
      scope,
      input.productId,
      input.caseId,
    );
    return { ok: true as const, value: sharing };
  }

  /** Plan 40B: a board or screen command of the menu board routes. */
  async menuBoardCommand(
    input: Readonly<{
      organisationId: OrganisationId;
      command: MenuBoardCommand;
    }>,
  ): Promise<MenuBoardCommandReply<MenuBoardCommand>> {
    return this.command(
      input.organisationId,
      this.admittedMenuBoardCommand.bind(this, input.command),
    );
  }

  private async admittedMenuBoardCommand(
    command: MenuBoardCommand,
    scope: OrganisationExecutionScope,
  ): Promise<MenuBoardCommandReply<MenuBoardCommand>> {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok)
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    return runMenuBoardCommand(
      {
        boards: this.#menuBoards,
        screens: this.#menuScreens,
        drafts: this.#menuDrafts,
        // A release names the Platform's screen media route: it serves an
        // image only while a published board names it.
        mediaBase: () => Promise.resolve(screenMediaBase(scope.organisationId)),
      },
      command,
      Date.now(),
      scope,
    );
  }

  /**
   * Plan 24 S1: the one entry to the bake proposals. The Portal, Slack, the
   * agent and the bake run (S4: `{ kind: "end" }`) change a proposal through
   * it, so every decision passes the same policy check.
   */
  async runBakeCommand(
    input: Readonly<{ organisationId: OrganisationId; command: BakeCommand }>,
  ) {
    return this.command(input.organisationId, (scope) =>
      runBakeCommand(
        scope.database,
        scope.organisationId,
        input.command,
        bakeKitchenPorts(this.env, scope, this.ctx.storage.sql),
        Date.now(),
      ),
    );
  }

  /**
   * Plan 24 S1: sets a stock level that an admin confirmed on an agent's
   * configuration card. The Bakes page calls the same Kitchen function.
   */
  async setBakeStockLevel(
    input: Readonly<{
      organisationId: OrganisationId;
      level: BakeStockLevelInput;
      setBy: string;
    }>,
  ) {
    return this.command(input.organisationId, (scope) =>
      setBakeStockLevel(
        scope.database,
        scope.organisationId,
        input.level,
        input.setBy,
        Date.now(),
      ),
    );
  }

  /**
   * Plan 24 S1: the approved proposal that a bake run starts from (S4), or
   * null when the proposal is not approved.
   */
  async readApprovedBakeProposal(
    input: Readonly<{ organisationId: OrganisationId; proposalId: string }>,
  ) {
    return this.command(input.organisationId, async (scope) => ({
      ok: true as const,
      value: await readApprovedBakeProposal(
        scope.database,
        scope.organisationId,
        input.proposalId,
      ),
    }));
  }

  /**
   * Plan 24 S4: the one read of a proposal's bake run, which the canvas, the
   * timeline and the 3D kitchen show. Null when the proposal has no run.
   */
  async readBakeRun(
    input: Readonly<{ organisationId: OrganisationId; proposalId: string }>,
  ) {
    return this.command(input.organisationId, async (scope) => ({
      ok: true as const,
      value: await readBakeRunOf(this.env, scope, input.proposalId),
    }));
  }

  /** Plan 24 S1: the stock levels, the proposals and what a level may name. */
  async readBakeBoard(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(input.organisationId, async (scope) => ({
      ok: true as const,
      value: await readBakeBoard(scope, this.ctx.storage.sql),
    }));
  }

  private async afterCommerceStockChanges(
    scope: OrganisationExecutionScope,
    changes: readonly InventoryStockChange[],
  ): Promise<void> {
    const counted = counterStockChanges(changes);
    if (counted.length === 0) return;
    try {
      await runBakeCommand(
        scope.database,
        scope.organisationId,
        { kind: "stock_changes", changes: counted },
        bakeKitchenPorts(this.env, scope, this.ctx.storage.sql),
        Date.now(),
      );
    } catch (error) {
      traceWarn("kitchen.bake_stock_check_failed", {
        requestId: newRequestId(),
        organisationId: scope.organisationId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Plan 40B: tells the shop's screens to read their feed again, after the
   * menu or its stock changed. A signal changes nothing, so it needs no
   * admission, and it never fails its caller.
   */
  async signalMenuScreens(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<number> {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);
    if (row === undefined || row.organisation_id !== input.organisationId)
      return 0;
    return this.#menuScreens.signal({ kind: "all" });
  }

  /**
   * Plan 40B phase 4: the shop's boards for an agent, each with its draft
   * and its newest release, and the menu copy that they name.
   */
  async readMenuBoards(
    input: Readonly<{ organisationId: OrganisationId; boardId: string | null }>,
  ) {
    return this.#roomCommand(input.organisationId, async () => {
      const summaries = this.#menuBoards.list(this.#menuScreens.countByBoard());
      const chosen =
        input.boardId === null
          ? summaries
          : summaries.filter((board) => board.boardId === input.boardId);
      if (input.boardId !== null && chosen.length === 0)
        return {
          ok: false as const,
          error: { code: "menu_board_missing" as const },
        };
      const boards = [];
      for (const summary of chosen) {
        const read = this.#menuBoards.read(summary.boardId);
        if (!read.ok) return read;
        boards.push({ ...read.value, screens: summary.screens });
      }
      const menu = this.#menuDrafts.read();
      return {
        ok: true as const,
        value: {
          boards,
          archivedBoards:
            input.boardId === null ? this.#menuBoards.archivedBoards() : [],
          menu: menu.ok
            ? menu.value.draft
            : { title: "Café menu", sections: [], items: [] },
        },
      };
    });
  }

  /** Plan 40B phase 4: an agent's change of one board's draft. */
  async editMenuBoard(
    input: MenuBoardAgentEdit & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) => {
      const menu = this.#menuDrafts.read();
      return this.#menuBoards.edit(
        input.organisationId,
        input,
        menu.ok
          ? menu.value.draft
          : { title: "Café menu", sections: [], items: [] },
        scope,
      );
    });
  }

  /** Plan 40B phase 7: an agent's board edit while its model writes it. */
  async previewMenuBoardEdit(
    input: MenuBoardAgentPreview & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#menuBoards.preview(input.organisationId, input, scope),
    );
  }

  /** Plan 81: an agent's change of the shared menu. */
  async editMenuDraft(
    input: MenuDraftAgentEdit & Readonly<{ organisationId: OrganisationId }>,
  ) {
    return this.#roomCommand(input.organisationId, (scope) =>
      this.#menuDrafts.edit(input.organisationId, input, scope),
    );
  }

  async readMenuDraft(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadMenuDraft.bind(this),
    );
  }

  private async admittedReadMenuDraft(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#menuDrafts.read();
  }

  async readEmailDraft(input: Readonly<{ organisationId: OrganisationId }>) {
    return this.command(
      input.organisationId,
      this.admittedReadEmailDraft.bind(this),
    );
  }

  private async admittedReadEmailDraft(scope: OrganisationExecutionScope) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      scope.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#emailDrafts.read();
  }

  async editEmailDraft(input: EmailDraftAgentEdit) {
    return this.command(
      input.organisationId,
      this.admittedEditEmailDraft.bind(this, input),
    );
  }

  private async admittedEditEmailDraft(
    input: EmailDraftAgentEdit,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    return this.#emailDrafts.edit(input, scope);
  }

  async readEmailDraftThread(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
  ) {
    const start = this.admittedReadEmailDraftThread.bind(this, input);
    const result = await this.command(input.organisationId, start);
    return result.ok ? result.value : null;
  }

  private async admittedReadEmailDraftThread(
    input: Readonly<{ organisationId: OrganisationId; caseId: string }>,
    scope: OrganisationExecutionScope,
  ) {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    const sharing = await this.#emailDrafts.sharedThread(scope, input.caseId);
    return { ok: true as const, value: sharing };
  }

  protected acceptsActivation(): boolean {
    return true;
  }

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

  async reconcileRelocationReceipt(request: RelocationReceiptRequest) {
    return reconcileFrozenOrganisationReceipt(
      this.env.DB,
      this.ctx.storage,
      request,
    );
  }

  protected override async referencedArchiveKeys(): Promise<
    Result<Iterable<string>, ActorExportError>
  > {
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (!activation.ok) return activation;
    const organisationId = activation.value.identity.organisationId;
    const references = await workspaceRevisionArchiveKeys(
      database.value,
      this.env.ARCHIVE,
      organisationId,
    );
    if (!references.ok)
      return {
        ok: false,
        error: { code: "export_read_failed", detail: references.error.code },
      };
    return {
      ok: true,
      value: [
        ...(await savedBakeryRunArchiveKeys(this.env.ARCHIVE, organisationId)),
        ...(await readPortalChatAttachmentKeys(
          database.value,
          this.env.ARCHIVE,
          organisationId,
        )),
        ...(await readChatForkAttachmentKeys(database.value, organisationId)),
      ],
    };
  }

  protected override async prepareErasure(): Promise<() => Promise<void>> {
    // The Organisation's clients reconnect to the Actor that serves it next.
    closeAllSockets(this.ctx);
    return async () => {};
  }

  protected quiesceForExport(expectedFenceToken: ActorFenceToken) {
    return this.quiesceArchiveCleanup({ expectedFenceToken });
  }

  /**
   * The Organisation keeps its own export frame: the export captures the
   * Organisation's data archive and deletes its pages after the copy.
   */
  override async exportPlacementState(
    input: ActorExportRequest,
  ): Promise<Result<ActorExportRef, ActorExportError>> {
    const organisation = await this.quiesceForExport(input.expectedFenceToken);
    if (!organisation.ok) return organisation;
    // The Organisation moves: each client reconnects to the Actor that
    // serves it next.
    closeAllSockets(this.ctx);
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    let dataKeys: readonly string[] = [];
    try {
      const workspaceKeys = await workspaceRevisionArchiveKeys(
        database.value,
        this.env.ARCHIVE,
        organisation.value,
      );
      if (!workspaceKeys.ok)
        return {
          ok: false,
          error: {
            code: "export_read_failed",
            detail: workspaceKeys.error.code,
          },
        };
      dataKeys = await captureOrganisationDataArchive(
        database.value,
        this.env.ARCHIVE,
        organisation.value,
        input.exportId,
      );
      const referencedR2Keys = [
        ...(await savedBakeryRunArchiveKeys(
          this.env.ARCHIVE,
          organisation.value,
        )),
        ...(await readPortalChatAttachmentKeys(
          database.value,
          this.env.ARCHIVE,
          organisation.value,
        )),
        ...(await readChatForkAttachmentKeys(
          database.value,
          organisation.value,
        )),
      ];
      return await exportActorPlacement({
        storage: this.ctx.storage,
        bucket: this.env.ARCHIVE,
        root: this.env.DATA_ENCRYPTION_ROOT,
        request: input,
        referencedR2Keys: [
          ...referencedR2Keys,
          ...workspaceKeys.value,
          ...dataKeys,
        ],
      });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "export_write_failed",
          detail: error instanceof Error ? error.message : "chat_export_failed",
        },
      };
    } finally {
      await deleteOrganisationDataArchivePages(this.env.ARCHIVE, dataKeys);
    }
  }

  async reconcileArchiveCleanup(
    input: OrganisationArchiveCleanupRequest,
  ): Promise<Result<number, OrganisationArchiveCleanupError>> {
    if (
      !canAdmitOrganisationArchiveCleanup(this.ctx.storage.sql, input) ||
      this.archiveCleanup !== null
    )
      return {
        ok: false,
        error: { code: "organisation_archive_cleanup_conflict" },
      };
    this.archiveCleanup = this.admitArchiveCleanup(input);
    try {
      return await this.archiveCleanup;
    } finally {
      this.archiveCleanup = null;
    }
  }

  async quiesceArchiveCleanup(input: {
    readonly expectedFenceToken: ActorFenceToken;
  }): Promise<Result<OrganisationId, ActorExportError>> {
    const closed = closeOrganisationArchiveCleanupAdmission(
      this.ctx.storage.sql,
      input.expectedFenceToken,
    );
    if (!closed.ok) return closed;
    if (this.archiveQuiescence === null)
      this.archiveQuiescence = this.drainArchiveCleanup(closed.value);
    const result = await this.archiveQuiescence;
    if (!result.ok) this.archiveQuiescence = null;
    return result;
  }

  override async importPlacementState(
    input: ActorImportRequest,
  ): Promise<Result<ActorImportedState, ActorExportError>> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    traceLog("organisation.import_started", {
      requestId,
      export_id: input.exportRef.exportId,
    });
    const loaded = await loadActorExport({
      bucket: this.env.ARCHIVE,
      root: this.env.DATA_ENCRYPTION_ROOT,
      ref: input.exportRef,
    });
    if (!loaded.ok) return loaded;
    traceLog("organisation.import_manifest_loaded", {
      requestId,
      export_id: input.exportRef.exportId,
      elapsed_ms: Date.now() - startedAt,
    });
    const database = await resolveOrganisationActorDatabase(
      this.env,
      this.ctx.storage.sql,
    );
    if (!database.ok) return database;
    const imported = await importActorExport({
      storage: this.ctx.storage,
      bucket: this.env.ARCHIVE,
      envelope: loaded.value,
      expectedTargetFenceToken: input.expectedTargetFenceToken,
      now: input.requestedAt,
    });
    if (!imported.ok) return imported;
    traceLog("organisation.import_actor_restored", {
      requestId,
      export_id: input.exportRef.exportId,
      elapsed_ms: Date.now() - startedAt,
    });
    const activation = readActivationExportSource(this.ctx.storage.sql);
    if (!activation.ok) return activation;
    try {
      await restoreOrganisationDataArchive({
        directory: this.env.DB,
        database: database.value,
        bucket: this.env.ARCHIVE,
        envelope: loaded.value,
        targetPlacementEpoch: activation.value.placementEpoch,
      });
      traceLog("organisation.import_data_restored", {
        requestId,
        export_id: input.exportRef.exportId,
        elapsed_ms: Date.now() - startedAt,
      });
    } catch (error) {
      return {
        ok: false,
        error: { code: "export_read_failed", detail: errorMessage(error) },
      };
    }
    return imported;
  }

  async ping(): Promise<OrganisationPing> {
    return { ok: true, kind: "organisation" };
  }

  async updateCommerceBoardPresence(input: CommerceBoardPresenceUpdate) {
    return this.command(
      input.organisationId,
      this.admittedUpdateCommerceBoardPresence.bind(this, input),
    );
  }

  private async admittedUpdateCommerceBoardPresence(
    input: CommerceBoardPresenceUpdate,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceBoardPresenceEntry[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    pruneCommerceBoardPresence(this.#commerceBoardPresence, input.now);
    this.#commerceBoardPresence.set(input.userId, {
      userId: input.userId,
      displayName: input.displayName,
      resourceKey: input.resourceKey,
      selection: input.selection,
      dragPreview: input.dragPreview,
      observedAt: input.now,
    });
    return {
      ok: true,
      value: readCommerceBoardPresence(
        this.#commerceBoardPresence,
        input.resourceKey,
      ),
    };
  }

  async readCommerceBoardPresence(input: CommerceBoardPresenceRead) {
    return this.command(
      input.organisationId,
      this.admittedReadCommerceBoardPresence.bind(this, input),
    );
  }

  private async admittedReadCommerceBoardPresence(
    input: CommerceBoardPresenceRead,
    _scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      readonly CommerceBoardPresenceEntry[],
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const organisation = validateActionOrganisation(
      this.ctx.storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) return organisation;
    pruneCommerceBoardPresence(this.#commerceBoardPresence, input.now);
    return {
      ok: true,
      value: readCommerceBoardPresence(
        this.#commerceBoardPresence,
        input.resourceKey,
      ),
    };
  }

  acceptShopifyLocationObservation(
    ...input: Parameters<ShopifyRpc["acceptShopifyLocationObservation"]>
  ) {
    return this.shopify.acceptShopifyLocationObservation(...input);
  }

  assignShopifyLocationClassification(
    ...input: Parameters<ShopifyRpc["assignShopifyLocationClassification"]>
  ) {
    return this.shopify.assignShopifyLocationClassification(...input);
  }

  async getOrganisation(
    request: OrganisationMetaRequest,
  ): Promise<
    Result<
      OrganisationMeta,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
    >
  > {
    const row = readOrganisationMetaRow(this.ctx.storage.sql);

    if (row === undefined) {
      return { ok: false, error: { code: "organisation_not_initialized" } };
    }

    if (row.organisation_id !== request.requestingOrganisationId) {
      return { ok: false, error: { code: "organisation_mismatch" } };
    }

    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (
      admission.kind !== "admitted" ||
      admission.scope.organisationId !== request.requestingOrganisationId ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    )
      return organisationPlacementConflict();
    return { ok: true, value: organisationRowToMeta(row) };
  }

  async alarm(): Promise<void> {
    if (this.alarmExecution !== null) {
      await this.alarmExecution;
      return;
    }
    const work = this.runAlarm();
    this.alarmExecution = work;
    try {
      await work;
    } finally {
      this.alarmExecution = null;
    }
  }

  private async runAlarm(): Promise<void> {
    const admission = await admitActorRecovery(this.env, this.ctx.storage);
    if (admission.kind === "deferred") return;
    if (
      admission.kind === "inactive" ||
      !(await isOrganisationExecutionActive(
        this.ctx.storage.sql,
        admission.scope,
      ))
    ) {
      // Another Actor serves the Organisation now. The runtime still answers
      // these sockets' pings, so their clients would never notice.
      closeAllSockets(this.ctx);
      return;
    }
    // Without an identity no reconciler can read the Organisation's rows,
    // so the alarm stops.
    const organisation = readOrganisationMetaRow(this.ctx.storage.sql);
    if (organisation === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const organisationId = parseOrganisationId(organisation.organisation_id);
    if (!organisationId.ok) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    // Each step runs on its own (Refactor 15, S3): a failed step does not
    // stop the others, and the alarm comes back for it after a backoff.
    const failed = await runAlarmSteps("organisation", [
      {
        name: "leases",
        run: () =>
          this.ctx.storage.transactionSync(
            expireOrganisationLeases.bind(
              null,
              this.ctx.storage.sql,
              organisationId.value,
              now,
            ),
          ),
      },
      {
        name: "socket_sweep",
        run: async () => {
          const sweepDueAt = readSocketSweepDueAt(this.ctx.storage.sql);
          if (sweepDueAt !== null && sweepDueAt <= now)
            await this.#sweepSockets(admission.scope);
        },
      },
      {
        // Candidate credentials belong to admitted mutations until those
        // executions settle.
        name: "typesafe_credentials",
        run: async () => {
          if (this.executions.size > 0) return;
          const credentials = await cleanupTypeSafeCredentials({
            sql: this.ctx.storage.sql,
            db: admission.scope.database,
            organisationId: admission.scope.organisationId,
            now,
          });
          if (!credentials.ok) throw new Error(credentials.error.code);
        },
      },
      {
        // Plan 88: each closed hour of Jev use on Pantry's key is sealed.
        name: "jev_usage",
        run: async () => {
          this.ctx.storage.transactionSync(
            sealJevUsageHours.bind(
              null,
              this.ctx.storage.sql,
              organisationId.value,
              now,
            ),
          );
        },
      },
      {
        // Plan 88: a move of the mail switch to a new TypeSafe key that
        // failed runs again when it is due.
        name: "jev_mail_repin",
        run: async () => {
          if (!mailSwitchMoveDue(this.ctx.storage.sql, now)) return;
          await moveMailSwitch({
            sql: this.ctx.storage.sql,
            transaction: this.ctx.storage.transactionSync.bind(
              this.ctx.storage,
            ),
            db: admission.scope.database,
            organisationId: organisationId.value,
            previous: null,
            repin: JEV_FOR_POLICY.repinMailClassification,
            now,
          });
        },
      },
      {
        name: "case_context_invalidations",
        run: () =>
          deliverCaseContextCollectionInvalidations(
            this.env,
            this.ctx.storage.sql,
            admission.scope,
          ),
      },
    ]);
    await this.rearm();
    await armAlarmAfterFailedSteps(this.ctx.storage, this.alarmRetries, failed);
  }

  /** Runs in a row with a failed alarm step; the backoff grows with it. */
  private readonly alarmRetries = { failures: 0 };
}

declare module "@purin-labs/kernel/env" {
  interface Env {
    ORGANISATION: DurableObjectNamespace<OrganisationDO>;
  }
}
