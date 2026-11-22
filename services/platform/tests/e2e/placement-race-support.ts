import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "@purin-labs/kernel/database-handles";
import { env } from "cloudflare:workers";
import { expect, vi } from "vitest";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import {
  startActorRelocation,
  resumeActorRelocation,
  type ActorRelocationId,
} from "../../src/actors/actor-relocation";

export type PlacementRace = {
  readonly organisationId: OrganisationId;
  phase:
    | { kind: "waiting" | "freezing"; relocationId?: never }
    | { kind: "frozen"; relocationId: ActorRelocationId };
};

export function interceptPlacementSession(
  race: PlacementRace,
  withSession: OrganisationDatabase["withSession"],
  constraint?: D1SessionBookmark | D1SessionConstraint,
): OrganisationDatabaseSession {
  const session = withSession(constraint);
  if (race.phase.kind === "waiting") {
    vi.spyOn(session, "batch").mockImplementationOnce(
      freezeBeforeBatch.bind(null, race, session.batch.bind(session)),
    );
  }
  return session;
}

async function freezeBeforeBatch<T>(
  race: PlacementRace,
  batch: D1DatabaseSession["batch"],
  statements: D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  await freezePlacement(race);
  return batch<T>(statements);
}

export async function freezePlacement(race: PlacementRace): Promise<void> {
  race.phase = { kind: "freezing" };
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const started = await startActorRelocation({
    env,
    organisationId: race.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(started.error.code);
  await env.DB.prepare(
    `CREATE TRIGGER lifecycle_interrupt_publication
    BEFORE UPDATE OF status ON state_object_relocation WHEN NEW.status = 'published'
    BEGIN SELECT RAISE(ABORT, 'lifecycle_publication_interrupted'); END`,
  ).run();
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("lifecycle_publication_interrupted");
  race.phase = { kind: "frozen", relocationId: started.value.relocationId };
}

export async function completeRetainedPlacement(
  relocationId: ActorRelocationId,
): Promise<void> {
  const resumed = await resumeActorRelocation({
    env,
    relocationId,
    now: Date.now(),
  });
  if (!resumed.ok) throw new Error(resumed.error.code);
  if (resumed.value.status !== "retained")
    throw new Error("Relocation did not retain its source");
  const retentionMs = resumed.value.retainUntil - resumed.value.resumedAt;
  const expiredAt = Date.now() - 1;
  await env.DB.prepare(
    "UPDATE state_object_relocation SET resumed_at = ?, retain_until = ? WHERE relocation_id = ?",
  )
    .bind(expiredAt - retentionMs, expiredAt, relocationId)
    .run();
  expect(
    await resumeActorRelocation({ env, relocationId, now: Date.now() }),
  ).toMatchObject({ ok: true, value: { status: "complete" } });
}
