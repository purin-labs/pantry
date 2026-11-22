import type {
  BakeBoardRecords,
  BakeRunRecord,
} from "@purin-labs/kitchen-control-api";
import {
  listAppliedWorkflows,
  readAppliedWorkflowHead,
} from "../../commerce/bakery/workflow-revisions";
import {
  findActiveDeviceWithCapability,
  listGateways,
} from "../../devices/store";
import type { Env } from "@purin-labs/kernel/env";
import type {
  BakeKitchenPorts,
  CounterStockChange,
} from "../../kitchen/bakes/commands";
import { listBakeAuthority } from "../../kitchen/bakes/authority";
import type { BakeProposal } from "../../kitchen/bakes/records";
import {
  listBakeProposals,
  listBakeStockLevels,
  readBakeProposal,
} from "../../kitchen/bakes/records";
import {
  bakeRunIdOf,
  listBakeRuns,
  readBakeRun,
} from "../../kitchen/bakes/run-records";
import { bakeRunKitchenPorts, bakeRunStub } from "../bake-run-ports";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
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
    ...bakeRunKitchenPorts(env, scope),
  };
}

/**
 * The one read of a proposal's bake run: the run's Durable Object gives the
 * engine view and the dispatch records, and the summary row gives the reason
 * that it did not start and the check. Null when the proposal has no run.
 */
export async function readBakeRunOf(
  env: Env,
  scope: OrganisationExecutionScope,
  proposalId: string,
): Promise<BakeRunRecord | null> {
  const db = scope.database;
  const proposal = await readBakeProposal(db, scope.organisationId, proposalId);
  if (proposal === null) return null;
  const summary = await readBakeRun(
    db,
    scope.organisationId,
    bakeRunIdOf(proposalId),
  );
  if (summary === null) return null;
  const live =
    summary.actorId === null
      ? null
      : await bakeRunStub(env, scope, summary.runId)?.read();
  const check = summary.check;
  const base = {
    runId: summary.runId,
    proposalId,
    productName: proposal.productName,
    problem: summary.problem,
    check,
  };
  if (live === null || live === undefined)
    return {
      ...base,
      mode: summary.mode,
      state: summary.state,
      hold: null,
      approval:
        proposal.decision === null ? null : approvalOf(proposal.decision),
      devices: [],
      oven: null,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      dispatches: [],
      unloadRisk: null,
      settlements: [],
      view: null,
      shadow: null,
    };
  return {
    ...live,
    ...base,
    state: summary.state === "checked" ? "checked" : live.state,
  };
}

function approvalOf(
  decision: NonNullable<BakeProposal["decision"]>,
): BakeRunRecord["approval"] {
  return {
    by: decision.by,
    role: decision.role,
    via: decision.via,
    at: decision.at,
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
  const [levels, proposals, workflows, gateways, runs] = await Promise.all([
    listBakeStockLevels(db, organisationId),
    listBakeProposals(db, organisationId),
    listAppliedWorkflows(db, organisationId),
    listGateways(db, organisationId),
    listBakeRuns(db, organisationId),
  ]);
  const products = listCountedProducts(sql, organisationId);
  const kitchenLocations = [
    ...new Set(
      gateways
        .filter((gateway) => gateway.state === "active")
        .map((gateway) => gateway.locationId),
    ),
  ].sort();
  const authority = await listBakeAuthority(db, organisationId, [
    ...kitchenLocations,
    ...levels.map((level) => level.kitchenLocation),
  ]);
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
    runs: runs.map((run) => ({
      runId: run.runId,
      proposalId: run.proposalId,
      mode: run.mode,
      state: run.state,
      problem: run.problem,
      holdCode: run.holdCode,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      goodPieces: run.check?.goodPieces ?? null,
    })),
    products: [...products],
    workflows: workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      title: workflow.title,
      revision: workflow.revision,
    })),
    kitchenLocations,
    authority: [...authority],
  };
}
