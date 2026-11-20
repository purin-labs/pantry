import type { BakeBoardRecords } from "@purin-labs/kitchen-control-api";
import {
  listAppliedWorkflows,
  readAppliedWorkflowHead,
} from "../../commerce/bakery/workflow-revisions";
import {
  findActiveDeviceWithCapability,
  listGateways,
} from "../../devices/store";
import type { Env } from "../../env";
import type {
  BakeKitchenPorts,
  CounterStockChange,
} from "../../kitchen/bakes/commands";
import {
  listBakeProposals,
  listBakeStockLevels,
} from "../../kitchen/bakes/records";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { announceBakeProposal } from "../../slack/bake-proposal-announce";
import {
  listCountedProducts,
  pieceCount,
  readInventoryItemStock,
  type InventoryStockChange,
} from "../commerce-projection/stock-changes";

/**
 * The Organisation Actor's side of the bake proposals (Plan 24 S1). Kitchen
 * owns the proposals; this file gives Kitchen the ports that it cannot import:
 * the oven from the Devices records, the counter stock from the commerce
 * projection in the Actor's storage, and the Case with its Slack card.
 */

/** The oven capability that a gateway reports for a bake device. */
const BAKE_CAPABILITY = "bake";

export function bakeKitchenPorts(
  env: Env,
  scope: OrganisationExecutionScope,
  sql: SqlStorage,
): BakeKitchenPorts {
  return {
    findOven: async (kitchenLocation) => {
      const device = await findActiveDeviceWithCapability(
        scope.database,
        scope.organisationId,
        { capabilityId: BAKE_CAPABILITY, locationId: kitchenLocation },
      );
      return device === null
        ? null
        : { deviceId: device.deviceId, name: device.name };
    },
    counterStock: (inventoryItemId) => {
      for (const position of readInventoryItemStock(
        sql,
        scope.organisationId,
        inventoryItemId,
      )) {
        const pieces = pieceCount(position.available);
        if (pieces !== null)
          return Promise.resolve({ locationId: position.locationId, pieces });
      }
      return Promise.resolve(null);
    },
    announce: (proposal) =>
      announceBakeProposal(env, scope, proposal, Date.now()),
  };
}

/** The changes of stock counted in pieces; other units have no bake level. */
export function counterStockChanges(
  changes: readonly InventoryStockChange[],
): readonly CounterStockChange[] {
  const counted: CounterStockChange[] = [];
  for (const change of changes) {
    const afterPieces = pieceCount(change.after);
    if (afterPieces === null) continue;
    counted.push({
      inventoryItemId: change.inventoryItemId,
      locationId: change.locationId,
      beforePieces: change.before === null ? null : pieceCount(change.before),
      afterPieces,
    });
  }
  return counted;
}

/** What the Bakes page and the agent's read show. */
export async function readBakeBoard(
  scope: OrganisationExecutionScope,
  sql: SqlStorage,
): Promise<BakeBoardRecords> {
  const db = scope.database;
  const organisationId = scope.organisationId;
  const [levels, proposals, workflows, gateways] = await Promise.all([
    listBakeStockLevels(db, organisationId),
    listBakeProposals(db, organisationId),
    listAppliedWorkflows(db, organisationId),
    listGateways(db, organisationId),
  ]);
  const products = listCountedProducts(sql, organisationId);
  const recipes = await Promise.all(
    levels.map((level) =>
      readAppliedWorkflowHead(db, organisationId, level.workflowId),
    ),
  );
  return {
    ok: true,
    levels: levels.map((level, index) => {
      const recipe = recipes[index] ?? null;
      return {
        ...level,
        counterPieces:
          products.find(
            (product) => product.inventoryItemId === level.inventoryItemId,
          )?.counterPieces ?? null,
        recipe:
          recipe === null
            ? null
            : { title: recipe.title, revision: recipe.revision },
      };
    }),
    proposals: proposals.map((proposal) => ({ ...proposal })),
    products: [...products],
    workflows: workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      title: workflow.title,
      revision: workflow.revision,
    })),
    kitchenLocations: [
      ...new Set(
        gateways
          .filter((gateway) => gateway.state === "active")
          .map((gateway) => gateway.locationId),
      ),
    ].sort(),
  };
}
