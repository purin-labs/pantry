import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { isRecord } from "@purin-labs/std";

import {
  listPlacementActorRegistryEntries,
  type ActorRegistryEntry,
} from "../../src/actors/actor-registry";
import { actorStub } from "../../src/actors/actor-stubs";
import { ORGANISATION_ID } from "./slack-journey-support";

/** Each follow-up of the Connector: when it is due, or how it settled. */
export function readFollowUps(
  _actor: unknown,
  ctx: DurableObjectState,
): {
  readonly eventId: string;
  readonly dueAt: number | null;
  readonly outcome: string | null;
}[] {
  const waiting = ctx.storage.sql
    .exec<{ event_id: string; due_at: number }>(
      "SELECT event_id, due_at FROM connector_case_work WHERE event_id LIKE 'followup!_%' ESCAPE '!'",
    )
    .toArray()
    .map(function waitingFollowUp(row) {
      return { eventId: row.event_id, dueAt: row.due_at, outcome: null };
    });
  const settled = ctx.storage.sql
    .exec<{ event_id: string; outcome: string }>(
      "SELECT event_id, outcome FROM connector_case_work_receipt WHERE event_id LIKE 'followup!_%' ESCAPE '!'",
    )
    .toArray()
    .map(function settledFollowUp(row) {
      return { eventId: row.event_id, dueAt: null, outcome: row.outcome };
    });
  return [...waiting, ...settled];
}

/**
 * The clock of the journey: the follow-up's time is now. A follow-up is due
 * at the time of its message, so both move. The payload keeps its JSON form.
 */
export function makeFollowUpsDue(
  _actor: unknown,
  ctx: DurableObjectState,
): void {
  const now = Date.now();
  const rows = ctx.storage.sql
    .exec<{ event_id: string; payload: string }>(
      "SELECT event_id, payload FROM connector_case_work WHERE event_id LIKE 'followup!_%' ESCAPE '!'",
    )
    .toArray();
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload);
    if (!isRecord(payload)) throw new Error("Follow-up payload is invalid");
    ctx.storage.sql.exec(
      "UPDATE connector_case_work SET due_at = ?, payload = ? WHERE event_id = ?",
      now,
      JSON.stringify({ ...payload, receivedAt: now }),
      row.event_id,
    );
  }
}

/** The steering replies that the Connector holds for a running turn. */
export function readSteeredReplies(
  _actor: unknown,
  ctx: DurableObjectState,
): string[] {
  return ctx.storage.sql
    .exec<{ event_id: string }>(
      "SELECT event_id FROM connector_case_steering ORDER BY event_id",
    )
    .toArray()
    .map(function eventId(row) {
      return row.event_id;
    });
}

/** How the Connector settled the work of one Slack event, if it did. */
export function readReceipt(
  eventId: string,
  _actor: unknown,
  ctx: DurableObjectState,
): string | null {
  return (
    ctx.storage.sql
      .exec<{ outcome: string }>(
        "SELECT outcome FROM connector_case_work_receipt WHERE event_id = ?",
        eventId,
      )
      .toArray()[0]?.outcome ?? null
  );
}

/** The Actor registry entries of the journey's Organisation. */
export async function registryEntries(): Promise<
  readonly ActorRegistryEntry[]
> {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  return entries.value;
}

/** The Connector Actor with this logical id. */
export async function connectorOf(connectorId: string) {
  const entry = (await registryEntries()).find(function isConnector(candidate) {
    return (
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId
    );
  });
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return actorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
}
