import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { collaborationAgentLabel } from "@purin-labs/collaboration/worker/collaboration-agent";
import {
  beginProposalStaging,
  type StageConfigurationDraft,
} from "@purin-labs/agent/actors/session/proposal-staging";
import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import { requireSessionExecution } from "@purin-labs/agent/actors/session-execution-admission";
import { prepareWorkflowProposal } from "../../commerce/bakery/workflow-proposals";
import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
import {
  announceSurfaceEffect,
  executeBakerySurfaceForHarness,
  readSavedBakeryRunForHarness,
} from "../bakery/handlers";
import { withToolContext } from "@purin-labs/agent/agent-tools/context";
import { executeCostsViewForHarness } from "../costs/view-handler";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import { liveDeviceMember } from "@purin-labs/tool-handlers/agent-tools/session-support";
import type { BakeStockLevelInput } from "@purin-labs/kitchen-control-api";
import {
  pauseBakeRunForEmbeddedHarness,
  proposeBakeForEmbeddedHarness,
  readBakeRunForEmbeddedHarness,
  readBakesForEmbeddedHarness,
} from "./bake-handlers";
import {
  embeddedHarnessCostsTools,
  type CostsCommerce,
} from "./costs-handlers";
import {
  createSupplierForEmbeddedHarness,
  readRecipeWorkflowForEmbeddedHarness,
  readRecipesForEmbeddedHarness,
  readSuppliersForEmbeddedHarness,
  saveRecipeForEmbeddedHarness,
} from "./handlers";
import {
  editProductionPlanForEmbeddedHarness,
  readProductionPlanForEmbeddedHarness,
} from "./production-plan-handlers";
import type { KitchenToolServices } from "./services";
import {
  moveWorkflowCanvasForEmbeddedHarness,
  readWorkflowCanvasForEmbeddedHarness,
} from "./workflow-canvas-handlers";

type RecipeWorkflowProposalRequest = Parameters<
  KitchenToolServices["proposeRecipeWorkflow"]
>[0];

/**
 * Runs the view commands of each page (Plan 87): Costs & margins, the Pastry
 * Bench and Café › Register.
 */
export function pageViewCommandExecutor(turn: ToolTurnContext) {
  return executeCostsViewForHarness.bind(null, {
    db: turn.execution.scope.database,
    accountAccess: turn.execution.scope.accountAccess,
    storage: turn.storage,
    organisationId: turn.organisationId,
    sessionId: turn.sessionId,
    requestId: turn.requestId,
    lease: turn.lease,
    browserContext: turn.browserContext,
    agentLabel: collaborationAgentLabel.bind(
      null,
      turn.execution.scope,
      turn.assignment,
    ),
    announceEffect: announceSurfaceEffect.bind(
      null,
      turn.execution.scope,
      turn.lease.requestAuthority,
    ),
  });
}

/** What Kitchen gives to one turn: the services of the Kitchen tools. */
export function kitchenToolServices(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
  executeCostsViewCommand: ReturnType<typeof pageViewCommandExecutor>,
  costsCommerce: CostsCommerce,
): KitchenToolServices {
  const tool = withToolContext({ ...turn, commerce: costsCommerce });
  return {
    readProductionPlan: tool(readProductionPlanForEmbeddedHarness),
    editProductionPlan: tool(editProductionPlanForEmbeddedHarness),
    readWorkflowCanvas: tool(readWorkflowCanvasForEmbeddedHarness),
    moveWorkflowCanvasObject: tool(moveWorkflowCanvasForEmbeddedHarness),
    readSavedBakeryRun: readSavedBakeryRunForHarness.bind(
      null,
      turn.requestId,
      turn.env,
      turn.storage,
      turn.execution,
      turn.lease,
      turn.browserContext,
    ),
    executeBakerySurface: executeBakerySurfaceForHarness.bind(null, {
      db: turn.execution.scope.database,
      accountAccess: turn.execution.scope.accountAccess,
      archive: turn.env.ARCHIVE,
      storage: turn.storage,
      organisationId: turn.organisationId,
      sessionId: turn.sessionId,
      requestId: turn.requestId,
      lease: turn.lease,
      browserContext: turn.browserContext,
      announceEffect: announceSurfaceEffect.bind(
        null,
        turn.execution.scope,
        turn.lease.requestAuthority,
      ),
      surfaceReadiness: { kind: "unprepared" },
    }),
    executeCostsViewCommand,
    readRecipes: tool(readRecipesForEmbeddedHarness),
    saveRecipe: tool(saveRecipeForEmbeddedHarness),
    ...embeddedHarnessCostsTools(
      turn.env,
      turn.storage,
      turn.execution,
      turn.lease,
      turn.assignment,
      costsCommerce,
    ),
    readSuppliers: tool(readSuppliersForEmbeddedHarness),
    createSupplier: tool(createSupplierForEmbeddedHarness),
    readRecipeWorkflow: tool(readRecipeWorkflowForEmbeddedHarness),
    proposeRecipeWorkflow: proposeRecipeWorkflowForEmbeddedHarness.bind(
      null,
      turn,
      stageConfigurationDraft,
    ),
    readBakes: tool(readBakesForEmbeddedHarness),
    proposeBake: tool(proposeBakeForEmbeddedHarness),
    proposeBakeStockLevel: proposeBakeStockLevelForEmbeddedHarness.bind(
      null,
      turn,
      stageConfigurationDraft,
    ),
    readBakeRun: tool(readBakeRunForEmbeddedHarness),
    pauseBakeRun: tool(pauseBakeRunForEmbeddedHarness),
  };
}

/**
 * Plan 24 S1: stages a bake stock level, for the admin who asked to confirm
 * on a card. An admin or the owner sets a level on the Bakes page, so only
 * such a person may ask for one.
 */
async function proposeBakeStockLevelForEmbeddedHarness(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
  request: BakeStockLevelInput,
): Promise<unknown> {
  const { scope } = turn.execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    turn.lease,
  );
  if (member === null || !roleMayConfigure(member.role))
    throw new ToolRequestError(
      "Only an admin or the owner sets a stock level, and the person who asked cannot. Nothing changed. Tell the person to ask an admin.",
    );
  const staging = await beginProposalStaging(
    turn,
    "bake stock level proposal",
    { portalChat: true },
  );
  return stageConfigurationDraft(
    staging,
    { family: "bake_stock_level", level: request },
    {},
  );
}

/**
 * Plan 84: stores a proposed change to a recipe, for the person who asked to approve.
 * The result must pass the engine's admission. The words come from this chat, which
 * is private, so nobody else reads the proposal until that person approves it.
 */
async function proposeRecipeWorkflowForEmbeddedHarness(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
  request: RecipeWorkflowProposalRequest,
  operationId: string,
): Promise<unknown> {
  const { scope } = turn.execution;
  const { lease } = turn;
  const refuse = (message: string): ToolRequestError =>
    new ToolRequestError(`${message} Nothing was stored.`);
  if (lease.requestAuthority.kind !== "control")
    throw refuse("A person proposes a recipe change from the Portal chat.");
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null || !roleMayConfigure(member.role))
    throw refuse(
      "Only an owner or administrator approves a recipe change, and this person cannot. Tell the person to ask one of them.",
    );
  const staging = await beginProposalStaging(turn, "recipe workflow proposal", {
    portalChat: true,
  });
  const prepared = await prepareWorkflowProposal(turn.env, scope, {
    ...request,
    sessionId: String(lease.session.sessionId),
    turnId: String(lease.turn.turnId),
    operationId,
  });
  await requireSessionExecution(turn.execution, lease);
  if (prepared.kind === "refused") throw refuse(prepared.message);
  const staged = await stageConfigurationDraft(
    staging,
    { family: "workflow_change", change: prepared.command },
    {
      approval:
        "The words of this chat are private, so only the person who asked sees this proposal. They approve it on the card in this chat or on the recipe's Workflow page, which runs the comparison.",
    },
  );
  // An open page reads the proposal. A lost signal waits for the next read.
  const organisation = await requireActiveOrganisationActor({
    env: turn.env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  organisation.bakeryWorkflowApplied(request.workflowId);
  return staged;
}
