import type { Env } from "@purin-labs/kernel/env";
import { samePlacement } from "../data/organisation-placement";
import { newRequestId, type OrganisationId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import { newWarmActorSlotName, type WarmActorKind } from "./actor-registry";
import { CASE_ACTOR_SCHEMA_VERSION } from "./actor-schema-versions";
import { actorStub } from "./actor-stubs";
import { CANONICAL_SESSION_SCHEMA_VERSION } from "./actor-schema-versions";

/**
 * Warm Case and Session slots of one Connector (Plan 55F).
 *
 * A new Durable Object takes about 1.2 s to start, and a new Slack thread
 * starts two: its Case and its Session. A slot is a Case or a Session object
 * that the Connector names before any thread does, under a random name. The
 * residency Actor keeps it in memory. It holds no identity and no content:
 * its constructor made empty tables, and it has no activation row.
 *
 * A new thread takes one slot of each kind, and the registry row of each new
 * Actor names the slot. Activation then records the thread's identity in the
 * object, and the object refuses every other identity after that. The
 * registry keeps physical names unique, so a slot serves at most one
 * identity.
 *
 * A slot belongs to one placement and to the schema version of the code that
 * named it. Constructors create tables only when they are missing, so a slot
 * named by older code is never taken. It is erased.
 */

export type WarmActorSlot = {
  readonly kind: WarmActorKind;
  readonly physicalObjectName: string;
  readonly placement: OrganisationPlacement;
  readonly schemaVersion: number;
  readonly createdAt: number;
};

type WarmActorSlotPair = {
  readonly case: WarmActorSlot;
  readonly session: WarmActorSlot;
};

/** The Connector's slot store, under the scope one item uses. */
export type ConnectorWarmActorSlots = {
  /** One slot of each kind, taken out of the store. Null when it has none. */
  take(): WarmActorSlotPair | null;
  /** Slots that no registry row took. They still hold no identity. */
  giveBack(slots: readonly WarmActorSlot[]): void;
  /**
   * Keep one slot of each kind for this placement. The slots of another
   * placement or schema are taken out of the store. Erase them after the
   * residency Actor has dropped them.
   */
  refresh(): {
    readonly current: readonly WarmActorSlot[];
    readonly stale: readonly WarmActorSlot[];
  };
};

const SLOT_KINDS: readonly WarmActorKind[] = ["case", "session"];

function currentSchemaVersion(kind: WarmActorKind): number {
  return kind === "case"
    ? CASE_ACTOR_SCHEMA_VERSION
    : CANONICAL_SESSION_SCHEMA_VERSION;
}

export function createWarmActorSlotSchema(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS warm_actor_slot (
       physical_object_name TEXT PRIMARY KEY,
       object_kind TEXT NOT NULL CHECK (object_kind IN ('case', 'session')),
       placement_json TEXT NOT NULL,
       schema_version INTEGER NOT NULL CHECK (schema_version > 0),
       created_at INTEGER NOT NULL
     )`,
  );
}

export function connectorWarmActorSlots(
  storage: DurableObjectStorage,
  organisationId: OrganisationId,
  placement: OrganisationPlacement,
): ConnectorWarmActorSlots {
  return {
    take: () =>
      storage.transactionSync(
        takeWarmActorSlotPair.bind(null, storage.sql, placement),
      ),
    giveBack: (slots) =>
      storage.transactionSync(
        returnWarmActorSlots.bind(null, storage.sql, slots),
      ),
    refresh: () =>
      storage.transactionSync(
        refreshWarmActorSlots.bind(
          null,
          storage.sql,
          organisationId,
          placement,
          Date.now(),
        ),
      ),
  };
}

function takeWarmActorSlotPair(
  sql: SqlStorage,
  placement: OrganisationPlacement,
): WarmActorSlotPair | null {
  const usable = readWarmActorSlots(sql).filter(
    isUsableSlot.bind(null, placement),
  );
  const caseSlot = usable.find(isKind.bind(null, "case"));
  const sessionSlot = usable.find(isKind.bind(null, "session"));
  if (caseSlot === undefined || sessionSlot === undefined) return null;
  sql.exec(
    "DELETE FROM warm_actor_slot WHERE physical_object_name IN (?, ?)",
    caseSlot.physicalObjectName,
    sessionSlot.physicalObjectName,
  );
  return { case: caseSlot, session: sessionSlot };
}

function returnWarmActorSlots(
  sql: SqlStorage,
  slots: readonly WarmActorSlot[],
): void {
  for (const slot of slots) writeSlot(sql, slot);
}

function refreshWarmActorSlots(
  sql: SqlStorage,
  organisationId: OrganisationId,
  placement: OrganisationPlacement,
  now: number,
): {
  readonly current: readonly WarmActorSlot[];
  readonly stale: readonly WarmActorSlot[];
} {
  const current: WarmActorSlot[] = [];
  const stale: WarmActorSlot[] = [];
  // The oldest usable slot of each kind has been in memory longest. A second
  // one, from a slot given back after a new one was named, is not kept.
  for (const slot of readWarmActorSlots(sql)) {
    if (
      isUsableSlot(placement, slot) &&
      !current.some(isKind.bind(null, slot.kind))
    )
      current.push(slot);
    else stale.push(slot);
  }
  for (const slot of stale)
    sql.exec(
      "DELETE FROM warm_actor_slot WHERE physical_object_name = ?",
      slot.physicalObjectName,
    );
  for (const kind of SLOT_KINDS) {
    if (current.some(isKind.bind(null, kind))) continue;
    const slot: WarmActorSlot = {
      kind,
      physicalObjectName: newWarmActorSlotName(organisationId, kind),
      placement,
      schemaVersion: currentSchemaVersion(kind),
      createdAt: now,
    };
    writeSlot(sql, slot);
    current.push(slot);
  }
  return { current, stale };
}

/** Every slot in the store, oldest first. */
export function readWarmActorSlots(sql: SqlStorage): WarmActorSlot[] {
  const slots: WarmActorSlot[] = [];
  const rows = sql
    .exec<{
      physical_object_name: string;
      object_kind: string;
      placement_json: string;
      schema_version: number;
      created_at: number;
    }>(
      `SELECT physical_object_name, object_kind, placement_json,
              schema_version, created_at
       FROM warm_actor_slot ORDER BY created_at, physical_object_name`,
    )
    .toArray();
  for (const row of rows) {
    let placementValue: unknown;
    try {
      placementValue = JSON.parse(row.placement_json);
    } catch {
      continue;
    }
    const placement = parseOrganisationPlacement(placementValue);
    if (
      !placement.ok ||
      (row.object_kind !== "case" && row.object_kind !== "session")
    )
      continue;
    slots.push({
      kind: row.object_kind,
      physicalObjectName: row.physical_object_name,
      placement: placement.value,
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
    });
  }
  return slots;
}

/**
 * Empty slot objects. A slot that a thread took names its Organisation, so it
 * refuses, and only an object that holds nothing is emptied. It never
 * rejects: a slot that is not emptied holds empty tables only.
 */
export async function eraseWarmActorSlots(
  env: Pick<Env, "CASE" | "SESSION">,
  slots: readonly WarmActorSlot[],
): Promise<void> {
  if (slots.length === 0) return;
  const erased = await Promise.allSettled(
    slots.map(eraseWarmActorSlot.bind(null, env)),
  );
  const failed = erased.filter((result) => result.status === "rejected");
  if (failed.length > 0)
    traceWarn("warm_actor_slot.erase_failed", {
      requestId: newRequestId(),
      failed: failed.length,
      slots: slots.length,
    });
}

async function eraseWarmActorSlot(
  env: Pick<Env, "CASE" | "SESSION">,
  slot: WarmActorSlot,
): Promise<void> {
  if (slot.kind === "case")
    await actorStub(
      env.CASE,
      slot.physicalObjectName,
      slot.placement,
    ).eraseUnregisteredState();
  else
    await actorStub(
      env.SESSION,
      slot.physicalObjectName,
      slot.placement,
    ).eraseUnregisteredState();
}

function writeSlot(sql: SqlStorage, slot: WarmActorSlot): void {
  sql.exec(
    `INSERT OR IGNORE INTO warm_actor_slot (
       physical_object_name, object_kind, placement_json, schema_version, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
    slot.physicalObjectName,
    slot.kind,
    JSON.stringify(slot.placement),
    slot.schemaVersion,
    slot.createdAt,
  );
}

function isUsableSlot(
  placement: OrganisationPlacement,
  slot: WarmActorSlot,
): boolean {
  return (
    samePlacement(slot.placement, placement) &&
    slot.schemaVersion === currentSchemaVersion(slot.kind)
  );
}

function isKind(kind: WarmActorKind, slot: WarmActorSlot): boolean {
  return slot.kind === kind;
}
