// Moves of the journeys' Organisation (`ORGANISATION_ID` of the Slack actor
// fixture) to the `e2e` cell in `wnam`: the target, the start of a
// relocation, its exported items and the registry entries of a placement.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  startActorRelocation,
  type ActorRelocationId,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { listPlacementActorRegistryEntries } from "@purin-labs/actor-runtime/actors/actor-registry";
import type { ConnectorDO } from "../../src/actors/connector";
import { parseOrganisationPlacementMoveTarget } from "@purin-labs/tenancy/data/organisation-placement";
import { fixtureDatabase } from "./organisation-database";
import { ORGANISATION_ID } from "./slack-journey-support";

/** The `e2e` cell in `wnam`, as a move target. */
export function moveTarget() {
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  return target.value;
}

/** Starts the relocation of the Organisation to the move target. */
export async function startMove(): Promise<ActorRelocationId> {
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: moveTarget(),
    now: Date.now(),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  return started.value.relocationId;
}

/** How many items of a relocation are no longer pending. */
export async function exportedItemCount(relocationId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM state_object_relocation_item WHERE relocation_id = ? AND status <> 'pending'",
  )
    .bind(relocationId)
    .first<{ count: number }>();
  if (row === null) throw new Error("Missing relocation inventory");
  return row.count;
}

/** The registry entries of the Organisation in one placement epoch. */
export async function placementEntries(epoch: number) {
  const result = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: epoch,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/** How many export barriers the Connector holds: one while it exports. */
export function readBarrier(
  connector: DurableObjectStub<ConnectorDO>,
): Promise<number> {
  return runInDurableObject(connector, readLocalBarrier);
}

function readLocalBarrier(_actor: unknown, state: DurableObjectState): number {
  return state.storage.sql
    .exec("SELECT 1 FROM state_object_cleanup_export_barrier")
    .toArray().length;
}
