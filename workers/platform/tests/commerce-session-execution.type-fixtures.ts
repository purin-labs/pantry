import {
  readWorkflowCanvasForEmbeddedHarness,
  moveWorkflowCanvasForEmbeddedHarness,
} from "@purin-labs/area-kitchen/server/agent-tools/kitchen/workflow-canvas-handlers";
import {
  readProductDescriptionDraftForEmbeddedHarness,
  editProductDescriptionDraftForEmbeddedHarness,
} from "@purin-labs/area-commerce/server/agent-tools/commerce/description-draft-handlers";
import type { OrganisationId } from "@purin-labs/kernel/ids";

type WorkflowReadAdmission = Parameters<
  typeof readWorkflowCanvasForEmbeddedHarness
>[0]["execution"];
type WorkflowMoveAdmission = Parameters<
  typeof moveWorkflowCanvasForEmbeddedHarness
>[0]["execution"];
type DraftReadAdmission = Parameters<
  typeof readProductDescriptionDraftForEmbeddedHarness
>[0]["execution"];
type DraftEditAdmission = Parameters<
  typeof editProductDescriptionDraftForEmbeddedHarness
>[0]["execution"];
declare const organisationId: OrganisationId;

// @ts-expect-error Workflow reads require the originating Session admission.
const unboundWorkflowRead: WorkflowReadAdmission = organisationId;
void unboundWorkflowRead;
// @ts-expect-error Workflow effects cannot reacquire authority from organisation identity.
const unboundWorkflowMove: WorkflowMoveAdmission = organisationId;
void unboundWorkflowMove;
// @ts-expect-error Draft reads require captured Session admission.
const unboundDraftRead: DraftReadAdmission = organisationId;
void unboundDraftRead;
// @ts-expect-error Draft edits require the captured origin.
const unboundDraftEdit: DraftEditAdmission = organisationId;
void unboundDraftEdit;
