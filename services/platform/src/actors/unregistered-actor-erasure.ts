import type { Env } from "../env";
import type { Result } from "../result";

export type UnregisteredActorKind =
  | "session"
  | "case"
  | "connector"
  | "organisation"
  | "conversation_residency"
  | "device_fleet"
  | "code_mode_governor"
  | "custom_connector_fetch";

type UnregisteredActorErasureError =
  { readonly code: "actor_owner_exists" } | { readonly code: "actor_in_use" };

/** Where an Actor of any class records the Organisation it belongs to. */
const OWNER_TABLES = [
  "state_object_activation",
  "connector_meta",
  "case_meta",
  "session_meta",
  "residency_scope",
  "device_fleet_scope",
] as const;

export function isUnregisteredActorKind(
  value: string,
): value is UnregisteredActorKind {
  return (
    value === "session" ||
    value === "case" ||
    value === "connector" ||
    value === "organisation" ||
    value === "conversation_residency" ||
    value === "device_fleet" ||
    value === "code_mode_governor" ||
    value === "custom_connector_fetch"
  );
}

/**
 * Empties an Actor that no registry names, for an operator who holds its
 * object identifier. The Actor refuses while what it holds names an
 * Organisation the directory still has.
 */
export async function eraseUnregisteredActorState(
  env: Pick<Env, "DB">,
  storage: DurableObjectStorage,
): Promise<Result<null, UnregisteredActorErasureError>> {
  for (const owner of storedActorOwners(storage.sql)) {
    const present = await env.DB.withSession("first-primary")
      .prepare("SELECT 1 FROM organisation WHERE organisation_id = ?")
      .bind(owner)
      .first();
    if (present !== null)
      return { ok: false, error: { code: "actor_owner_exists" } };
  }
  await storage.deleteAlarm();
  await storage.deleteAll();
  return { ok: true, value: null };
}

/**
 * Empties the Actor of a fetch container that no Organisation addresses. A
 * container that runs is in use, and it keeps its state.
 */
export async function eraseIdleContainerState(
  ctx: DurableObjectState,
): Promise<Result<null, { readonly code: "actor_in_use" }>> {
  if (ctx.container?.running === true)
    return { ok: false, error: { code: "actor_in_use" } };
  await ctx.storage.deleteAlarm();
  await ctx.storage.deleteAll();
  return { ok: true, value: null };
}

function storedActorOwners(sql: SqlStorage): readonly string[] {
  const owners = new Set<string>();
  for (const table of OWNER_TABLES) {
    const present = sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
      )
      .toArray();
    if (present.length === 0) continue;
    for (const row of sql.exec(`SELECT * FROM ${table}`).toArray()) {
      const owner = row.organisation_id;
      if (typeof owner === "string" && owner.length > 0) owners.add(owner);
    }
  }
  return [...owners];
}
