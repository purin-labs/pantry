import { DurableObject } from "cloudflare:workers";
import { assertNever, isRecord } from "@seams/std";

import type { Env } from "../env";
import {
  newRequestId,
  parseOrganisationId,
  type ConnectorId,
  type OrganisationId,
} from "../ids";
import { traceWarn } from "../observability";
import { selectOrganisationPlacementDatabase } from "../organisation-execution-scope";
import {
  parseOrganisationPlacement,
  type OrganisationPlacement,
} from "../placement";
import {
  actorPhysicalName,
  isWarmActorSlotNameOf,
  type WarmActorKind,
} from "./actor-registry";
import { eraseUnregisteredActorState } from "./unregistered-actor-erasure";
import {
  caseActorStub,
  connectorActorStub,
  sessionActorStub,
  type SessionActorRoute,
} from "./actor-router";
import { armAlarmBy } from "./lifecycle/actor-alarm";

/**
 * Keeps the Actors of an active conversation in memory.
 *
 * A Durable Object that holds no timer can leave memory 10 s after its last
 * event. A reply that arrives later starts its Connector, its Case and its
 * Session again, which costs 1.6 to 1.8 s. After each turn the Connector
 * names the three Actors here. This Actor then calls each of them on its own
 * alarm until no turn has named them for the residency time.
 *
 * It holds Actor names and one placement, and no content. It decides nothing:
 * a call that it makes does no work in the Actor that receives it. It calls
 * only an Actor that the registry lists as active at the active placement, so
 * a moved, retired or erased Actor is not started again.
 *
 * It also keeps the Connector's warm slots in memory (Plan 55F): a Case and a
 * Session that no thread has named yet. A slot has no registry row, so it is
 * called only while the registry lists its Connector as active at the active
 * placement. Each keep call names the whole set of slots, so a slot that the
 * Connector took out of its store is not called again.
 */

/** How long the Actors stay in memory after the last turn that named them. */
export const CONVERSATION_RESIDENCY_MS = 15 * 60_000;
/**
 * The time between two calls. It is below the 10 s after which an Actor can
 * leave memory. With 50 s between two calls, a Case had left memory at 31 of
 * 78 calls in production.
 */
export const CONVERSATION_RESIDENCY_TICK_MS = 8_000;
/** The most Actors one Connector keeps: 32 conversations and itself. */
const MAX_RESIDENTS = 65;
const MAX_NAMES_PER_REQUEST = 8;
/** One slot of each kind, and room for the slots of one more claim. */
const MAX_WARM_SLOTS = 4;
const MAX_NAME_LENGTH = 512;

type ConversationResidencyRequest = {
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
  readonly physicalObjectNames: readonly string[];
  /** The Connector's current warm slots. They replace the slots kept before. */
  readonly warmSlots: readonly WarmSlotName[];
};

export type WarmSlotName = {
  readonly kind: WarmActorKind;
  readonly physicalObjectName: string;
};

export type ConversationResidencyInspection = {
  readonly residents: readonly {
    readonly physicalObjectName: string;
    readonly residentUntil: number;
  }[];
  readonly warmSlots: readonly (WarmSlotName & {
    readonly residentUntil: number;
  })[];
  readonly alarmAt: number | null;
};

type ResidentKind = "connector" | "case" | "session";

export class ConversationResidencyActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS residency_scope (
         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
         organisation_id TEXT NOT NULL,
         placement_json TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS resident_actor (
         physical_object_name TEXT PRIMARY KEY,
         resident_until INTEGER NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS warm_slot (
         physical_object_name TEXT PRIMARY KEY,
         object_kind TEXT NOT NULL CHECK (object_kind IN ('case', 'session')),
         resident_until INTEGER NOT NULL
       )`,
    );
  }

  /** Keep the named Actors in memory for the residency time from now. */
  async keep(raw: unknown): Promise<void> {
    const request = parseConversationResidencyRequest(raw);
    if (request === null) return;
    const now = Date.now();
    const placementJson = JSON.stringify(request.placement);
    const newSlots = this.ctx.storage.transactionSync(
      recordResidents.bind(
        null,
        this.ctx.storage.sql,
        request,
        placementJson,
        now,
      ),
    );
    // A new slot starts at once, so it is in memory before the next thread.
    const due = newSlots ? now : now + CONVERSATION_RESIDENCY_TICK_MS;
    await armAlarmBy(this.ctx.storage, due);
  }

  /** Empties this Actor when its Organisation is gone. */
  async eraseUnregisteredState() {
    return eraseUnregisteredActorState(this.env, this.ctx.storage);
  }

  async inspect(): Promise<ConversationResidencyInspection> {
    return {
      residents: this.ctx.storage.sql
        .exec<{ physical_object_name: string; resident_until: number }>(
          "SELECT physical_object_name, resident_until FROM resident_actor ORDER BY physical_object_name",
        )
        .toArray()
        .map((row) => ({
          physicalObjectName: row.physical_object_name,
          residentUntil: row.resident_until,
        })),
      warmSlots: readWarmSlots(this.ctx.storage.sql),
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    sql.exec("DELETE FROM resident_actor WHERE resident_until <= ?", now);
    sql.exec("DELETE FROM warm_slot WHERE resident_until <= ?", now);
    const scope = readResidencyScope(sql);
    const names = sql
      .exec<{ physical_object_name: string }>(
        "SELECT physical_object_name FROM resident_actor",
      )
      .toArray()
      .map((row) => row.physical_object_name);
    if (scope === null || names.length === 0) {
      sql.exec("DELETE FROM resident_actor");
      sql.exec("DELETE FROM warm_slot");
      return;
    }
    let active: readonly ActiveResident[];
    try {
      active = await readActiveResidents(this.env, scope, names);
    } catch {
      // The registry was not read. The next call decides again.
      await this.ctx.storage.setAlarm(now + CONVERSATION_RESIDENCY_TICK_MS);
      return;
    }
    if (active.length === 0) {
      // The organisation moved, or no named Actor is active. Nothing is kept.
      sql.exec("DELETE FROM resident_actor");
      sql.exec("DELETE FROM warm_slot");
      return;
    }
    // Slots have no registry row. They are kept while their Connector is.
    const slots = active.some(isConnectorResident) ? readWarmSlots(sql) : [];
    if (slots.length === 0) sql.exec("DELETE FROM warm_slot");
    const calls = await Promise.allSettled([
      ...active.map(callResident.bind(null, this.env, scope.placement)),
      ...slots.map(callResident.bind(null, this.env, scope.placement)),
    ]);
    const failed = calls.filter((call) => call.status === "rejected").length;
    if (failed > 0) {
      traceWarn("residency.resident_call_failed", {
        requestId: newRequestId(),
        organisation_id: scope.organisationId,
        failed,
        called: calls.length,
      });
    }
    await this.ctx.storage.setAlarm(now + CONVERSATION_RESIDENCY_TICK_MS);
  }
}

/**
 * Name the three Actors of a conversation, and the Connector's warm slots, to
 * the residency Actor of its Connector. It never fails the turn: a
 * conversation that is not kept starts its Actors again and loses nothing
 * else.
 */
export async function keepConversationResident(input: {
  readonly env: Env;
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
  readonly connectorId: ConnectorId;
  readonly casePhysicalObjectName: string;
  readonly sessionPhysicalObjectName: string;
  readonly warmSlots: readonly WarmSlotName[];
}): Promise<void> {
  const namespace = input.env.CONVERSATION_RESIDENCY;
  if (namespace === undefined) return;
  const connectorName = actorPhysicalName(
    {
      objectKind: "connector",
      organisationId: input.organisationId,
      logicalObjectId: input.connectorId,
    },
    input.placement,
  );
  const request: ConversationResidencyRequest = {
    organisationId: input.organisationId,
    placement: input.placement,
    physicalObjectNames: [
      connectorName,
      input.casePhysicalObjectName,
      input.sessionPhysicalObjectName,
    ],
    warmSlots: input.warmSlots.map((slot) => ({
      kind: slot.kind,
      physicalObjectName: slot.physicalObjectName,
    })),
  };
  try {
    await conversationResidencyStub(
      namespace,
      connectorName,
      input.placement,
    ).keep(request);
  } catch {
    traceWarn("residency.keep_failed", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
    });
  }
}

/**
 * Start a Session that left memory, before the turn's own call reaches it.
 *
 * A reply that comes after the residency time finds its Case and its Session
 * out of memory. The turn calls the Session only after the Case admits the
 * message and the turn's last reads end, so the two Actors started one after
 * the other. A Session then took 0.4 to 0.5 s to start in production. The
 * Connector makes this call when it finds the Session in the registry, beside
 * the admission. The call does no work in the Session, as a call of the
 * residency Actor does none, and the same rule holds: the registry lists the
 * Session as active at the active placement.
 *
 * The call has its own stub, so its failure leaves the turn's stub as it is.
 * It never fails the turn: the turn's own call reports what the Session does.
 */
export async function startSessionBeforeItsTurn(input: {
  readonly env: Pick<Env, "SESSION">;
  readonly organisationId: OrganisationId;
  readonly route: SessionActorRoute;
}): Promise<void> {
  try {
    await sessionActorStub(
      input.env.SESSION,
      input.route.physicalObjectName,
      input.route.placement,
    ).keepResident();
  } catch {
    traceWarn("residency.session_start_failed", {
      requestId: newRequestId(),
      organisation_id: input.organisationId,
    });
  }
}

/** The residency Actor of one Connector, placed beside it. */
export function conversationResidencyStub(
  namespace: DurableObjectNamespace<ConversationResidencyActor>,
  connectorPhysicalObjectName: string,
  placement: OrganisationPlacement,
): DurableObjectStub<ConversationResidencyActor> {
  const placed =
    placement.kind === "residency"
      ? namespace.jurisdiction(placement.residencyJurisdiction)
      : namespace;
  return placed.get(
    placed.idFromName(`residency:${connectorPhysicalObjectName}`),
    { locationHint: placement.locationHint },
  );
}

type ResidencyScope = {
  readonly organisationId: OrganisationId;
  readonly placement: OrganisationPlacement;
};

type ActiveResident = {
  readonly kind: ResidentKind;
  readonly physicalObjectName: string;
};

function parseConversationResidencyRequest(
  raw: unknown,
): ConversationResidencyRequest | null {
  if (
    !isRecord(raw) ||
    typeof raw.organisationId !== "string" ||
    !Array.isArray(raw.physicalObjectNames)
  )
    return null;
  const organisationId = parseOrganisationId(raw.organisationId);
  const placement = parseOrganisationPlacement(raw.placement);
  const names: unknown[] = raw.physicalObjectNames;
  if (
    !organisationId.ok ||
    !placement.ok ||
    names.length === 0 ||
    names.length > MAX_NAMES_PER_REQUEST ||
    !names.every(isActorName)
  )
    return null;
  const slots: unknown[] =
    raw.warmSlots === undefined
      ? []
      : Array.isArray(raw.warmSlots)
        ? raw.warmSlots
        : [null];
  const warmSlots: WarmSlotName[] = [];
  for (const slot of slots) {
    if (
      !isRecord(slot) ||
      (slot.kind !== "case" && slot.kind !== "session") ||
      typeof slot.physicalObjectName !== "string" ||
      !isWarmActorSlotNameOf(
        slot.physicalObjectName,
        organisationId.value,
        slot.kind,
      )
    )
      return null;
    warmSlots.push({
      kind: slot.kind,
      physicalObjectName: slot.physicalObjectName,
    });
  }
  if (warmSlots.length > MAX_WARM_SLOTS) return null;
  return {
    organisationId: organisationId.value,
    placement: placement.value,
    physicalObjectNames: names,
    warmSlots,
  };
}

function isActorName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH
  );
}

/** Record the request. True when it names a slot that was not kept before. */
function recordResidents(
  sql: SqlStorage,
  request: ConversationResidencyRequest,
  placementJson: string,
  now: number,
): boolean {
  const stored = sql
    .exec<{ organisation_id: string; placement_json: string }>(
      "SELECT organisation_id, placement_json FROM residency_scope WHERE singleton = 1",
    )
    .toArray()[0];
  if (
    stored !== undefined &&
    (stored.organisation_id !== request.organisationId ||
      stored.placement_json !== placementJson)
  ) {
    // The Connector serves another placement now. The earlier names are void.
    sql.exec("DELETE FROM resident_actor");
    sql.exec("DELETE FROM warm_slot");
  }
  sql.exec(
    `INSERT INTO residency_scope (singleton, organisation_id, placement_json)
     VALUES (1, ?, ?)
     ON CONFLICT (singleton) DO UPDATE SET
       organisation_id = excluded.organisation_id,
       placement_json = excluded.placement_json`,
    request.organisationId,
    placementJson,
  );
  for (const name of request.physicalObjectNames) {
    sql.exec(
      `INSERT INTO resident_actor (physical_object_name, resident_until)
       VALUES (?, ?)
       ON CONFLICT (physical_object_name) DO UPDATE SET
         resident_until = excluded.resident_until`,
      name,
      now + CONVERSATION_RESIDENCY_MS,
    );
  }
  sql.exec(
    `DELETE FROM resident_actor WHERE physical_object_name NOT IN (
       SELECT physical_object_name FROM resident_actor
       ORDER BY resident_until DESC LIMIT ?
     )`,
    MAX_RESIDENTS,
  );
  const kept = new Set(readWarmSlots(sql).map(slotName));
  sql.exec("DELETE FROM warm_slot");
  for (const slot of request.warmSlots)
    sql.exec(
      `INSERT INTO warm_slot (physical_object_name, object_kind, resident_until)
       VALUES (?, ?, ?)`,
      slot.physicalObjectName,
      slot.kind,
      now + CONVERSATION_RESIDENCY_MS,
    );
  return request.warmSlots.some((slot) => !kept.has(slot.physicalObjectName));
}

function readWarmSlots(
  sql: SqlStorage,
): (WarmSlotName & { readonly residentUntil: number })[] {
  const slots: (WarmSlotName & { readonly residentUntil: number })[] = [];
  const rows = sql
    .exec<{
      physical_object_name: string;
      object_kind: string;
      resident_until: number;
    }>(
      "SELECT physical_object_name, object_kind, resident_until FROM warm_slot ORDER BY physical_object_name",
    )
    .toArray();
  for (const row of rows)
    if (row.object_kind === "case" || row.object_kind === "session")
      slots.push({
        kind: row.object_kind,
        physicalObjectName: row.physical_object_name,
        residentUntil: row.resident_until,
      });
  return slots;
}

function slotName(slot: WarmSlotName): string {
  return slot.physicalObjectName;
}

function isConnectorResident(resident: ActiveResident): boolean {
  return resident.kind === "connector";
}

function readResidencyScope(sql: SqlStorage): ResidencyScope | null {
  const row = sql
    .exec<{ organisation_id: string; placement_json: string }>(
      "SELECT organisation_id, placement_json FROM residency_scope WHERE singleton = 1",
    )
    .toArray()[0];
  if (row === undefined) return null;
  const organisationId = parseOrganisationId(row.organisation_id);
  let placementValue: unknown;
  try {
    placementValue = JSON.parse(row.placement_json);
  } catch {
    return null;
  }
  const placement = parseOrganisationPlacement(placementValue);
  return organisationId.ok && placement.ok
    ? { organisationId: organisationId.value, placement: placement.value }
    : null;
}

/**
 * The named Actors that the registry lists as active at the organisation's
 * active placement. The statement names the placement, so it returns nothing
 * after a move or while the placement is frozen.
 */
async function readActiveResidents(
  env: Env,
  scope: ResidencyScope,
  names: readonly string[],
): Promise<readonly ActiveResident[]> {
  const database = selectOrganisationPlacementDatabase(
    env,
    scope.organisationId,
    scope.placement,
  );
  if (!database.ok) return [];
  const rows = await database.value
    .prepare(
      `SELECT registry.object_kind AS kind,
              registry.physical_object_name AS physicalObjectName
       FROM organisation_placement AS placement
       JOIN durable_object_registry AS registry
         ON registry.organisation_id = placement.organisation_id
        AND registry.placement_epoch = placement.placement_epoch
        AND registry.placement_cell_id = placement.placement_cell_id
       WHERE placement.organisation_id = ?
         AND placement.placement_epoch = ?
         AND placement.placement_cell_id = ?
         AND placement.status = 'active'
         AND registry.lifecycle_status = 'active'
         AND registry.object_kind IN ('connector', 'case', 'session')
         AND registry.physical_object_name IN (${names.map(placeholder).join(", ")})`,
    )
    .bind(
      scope.organisationId,
      scope.placement.placementEpoch,
      scope.placement.placementCellId,
      ...names,
    )
    .all<{ kind: unknown; physicalObjectName: unknown }>();
  const active: ActiveResident[] = [];
  for (const row of rows.results) {
    if (
      typeof row.physicalObjectName === "string" &&
      (row.kind === "connector" ||
        row.kind === "case" ||
        row.kind === "session")
    )
      active.push({
        kind: row.kind,
        physicalObjectName: row.physicalObjectName,
      });
  }
  return active;
}

function placeholder(): string {
  return "?";
}

function callResident(
  env: Env,
  placement: OrganisationPlacement,
  resident: ActiveResident,
): Promise<void> {
  switch (resident.kind) {
    case "connector":
      return connectorActorStub(
        env.CONNECTOR,
        resident.physicalObjectName,
        placement,
      ).keepResident();
    case "case":
      return caseActorStub(
        env.CASE,
        resident.physicalObjectName,
        placement,
      ).keepResident();
    case "session":
      return sessionActorStub(
        env.SESSION,
        resident.physicalObjectName,
        placement,
      ).keepResident();
    default:
      return assertNever(resident.kind);
  }
}
