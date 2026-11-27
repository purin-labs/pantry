import type { CostsSheetFailureCode } from "@purin-labs/costs-sheet-crdt/protocol";
import type { UserId } from "@purin-labs/control-api/ids";
import type { BakeBoardRecords } from "@purin-labs/kitchen-control-api";
import type { PlanFailureCode } from "@purin-labs/production-plan-crdt/protocol";
import type {
  DraftChangeSet,
  DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft-shape";
import type { DraftProtocolFailureCode } from "@purin-labs/workflow-canvas-crdt/draft-protocol";
import type { PlacedActorRpc } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { ControlSessionId, OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type {
  OrganisationCommandFailure,
  OrganisationPlacementConflict,
} from "@purin-labs/tenancy/actors/organisation/types";
import type {
  BakeCommand,
  BakeCommandError,
  BakeCommandOutcome,
} from "../bakes/commands";
import type {
  CostsSheetAgentEdit,
  CostsSheetDraftRead,
  CostsSheetSettleInput,
} from "./costs-sheet-draft";
import type { ProductionPlanSharedTarget } from "./production-plan";

/** A change of a shared draft that its room refused. */
type RoomChangeFailure = Readonly<{
  code:
    | "organisation_placement_conflict"
    | "access_revoked"
    | "room_full"
    | "stored_access_ended";
}>;

/**
 * The RPC methods of the Organisation Actor that Kitchen calls: the bake
 * board and its commands, the shared costs sheet, the shared production plan
 * and the shared workflow draft. `OrganisationDO`, the class of the Worker,
 * implements this interface, and Kitchen names it, not the class. The class
 * gives the comment of each method.
 */
export interface OrganisationKitchenRpc {
  readBakeBoard(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<Result<BakeBoardRecords, OrganisationPlacementConflict>>;
  runBakeCommand(
    input: Readonly<{ organisationId: OrganisationId; command: BakeCommand }>,
  ): Promise<
    Result<BakeCommandOutcome, OrganisationPlacementConflict | BakeCommandError>
  >;
  readCostsSheetDraft(
    input: Readonly<{ organisationId: OrganisationId }>,
  ): Promise<
    Result<
      CostsSheetDraftRead,
      OrganisationCommandFailure | Readonly<{ code: CostsSheetFailureCode }>
    >
  >;
  editCostsSheetDraft(input: CostsSheetAgentEdit): Promise<
    Result<
      CostsSheetDraftRead,
      | OrganisationCommandFailure
      | Readonly<{
          code:
            | CostsSheetFailureCode
            | "organisation_placement_conflict"
            | "stored_access_ended";
        }>
    >
  >;
  settleCostsSheetDraft(
    input: CostsSheetSettleInput,
  ): Promise<
    Result<
      null,
      | OrganisationCommandFailure
      | Readonly<{ code: CostsSheetFailureCode }>
      | RoomChangeFailure
    >
  >;
  readProductionPlanShare(
    input: Readonly<{ organisationId: OrganisationId; locationId: string }>,
  ): Promise<
    Result<ProductionPlanSharedTarget | null, OrganisationCommandFailure>
  >;
  clearProductionPlanLines(
    input: Readonly<{
      organisationId: OrganisationId;
      locationId: string;
      requestIds: readonly string[];
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ): Promise<
    Result<
      null,
      | OrganisationCommandFailure
      | RoomChangeFailure
      | Readonly<{ code: PlanFailureCode }>
    >
  >;
  bakeryWorkflowApplied(workflowId: string): void;
  bakeryWorkflowDraftSnapshot(
    input: Readonly<{ organisationId: OrganisationId; workflowId: string }>,
  ): DraftSnapshot | null;
  bakeryWorkflowMergeProposal(
    input: Readonly<{
      organisationId: OrganisationId;
      workflowId: string;
      change: DraftChangeSet;
      userId: UserId;
      controlSessionId: ControlSessionId;
    }>,
  ): Promise<
    Result<
      null,
      | OrganisationCommandFailure
      | RoomChangeFailure
      | Readonly<{ code: DraftProtocolFailureCode }>
    >
  >;
}

/** The Organisation Actor as Kitchen sees it: its placement and its RPC. */
export type KitchenOrganisationActor = PlacedActorRpc & OrganisationKitchenRpc;
