import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";

/** A finished page effect stays this long after its last change. */
const ENDED_SURFACE_EFFECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** One daily pass deletes at most this many effects of one Organisation. */
const ENDED_SURFACE_EFFECT_PAGE = 500;

/** The ended effects that no save names: ?1 the Organisation, ?2 the end. */
const ENDED_EFFECTS = `SELECT effect.effect_id FROM bakery_surface_effect_delivery AS effect
  WHERE effect.organisation_id = ?1 AND effect.updated_at < ?2
    AND (effect.state_kind <> 'dispatching' OR effect.deadline_at < ?2)
    AND NOT EXISTS (SELECT 1 FROM bakery_agent_run_save AS saved
                     WHERE saved.effect_id = effect.effect_id)
    AND NOT EXISTS (SELECT 1 FROM bakery_agent_scenario_save AS saved
                     WHERE saved.effect_id = effect.effect_id)
  ORDER BY effect.updated_at, effect.effect_id LIMIT ?3`;

/**
 * Deletes the page effects of the Organisation that ended more than 30 days
 * ago, with their timeline events, oldest first. An effect ends `settled` or
 * `indeterminate`; a reconciled one ends `settled`, and a quarantined one ends
 * `indeterminate` or stays `dispatching` after its deadline. An effect that a
 * saved run or a saved scenario names stays. The daily pass of the
 * Organisation calls it. With nothing that old, it reads an index and writes
 * nothing.
 */
export async function deleteEndedBakerySurfaceEffects(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: number;
  }>,
): Promise<void> {
  const bindings = [
    input.organisationId,
    input.now - ENDED_SURFACE_EFFECT_RETENTION_MS,
    ENDED_SURFACE_EFFECT_PAGE,
  ];
  // The events go first: each one names its effect.
  await input.db.batch([
    input.db
      .prepare(
        `DELETE FROM bakery_surface_timeline_event
          WHERE organisation_id = ?1 AND effect_id IN (${ENDED_EFFECTS})`,
      )
      .bind(...bindings),
    input.db
      .prepare(
        `DELETE FROM bakery_surface_effect_delivery
          WHERE effect_id IN (${ENDED_EFFECTS})`,
      )
      .bind(...bindings),
  ]);
}
