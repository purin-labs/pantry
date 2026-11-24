import type { OrganisationDailyStep } from "@purin-labs/conversation/messages/attachment-collection";
import { requireActiveOrganisationActorAtPlacement } from "@purin-labs/actor-runtime/actors/actor-router";
import { deleteEndedBakerySurfaceEffects } from "@purin-labs/area-kitchen/server/data/bakery-surface-retention";

/**
 * The daily work of each Organisation that runs in its daily pass, after the
 * attachment collection: the retention of the page effects and of the
 * relevance records.
 */
export const ORGANISATION_DAILY_STEPS: readonly OrganisationDailyStep[] = [
  async function deletePageEffects(_env, scope, now) {
    await deleteEndedBakerySurfaceEffects({
      db: scope.database,
      organisationId: scope.organisationId,
      now,
    });
  },
  async function deleteRelevanceRecords(env, scope, now) {
    const organisation = await requireActiveOrganisationActorAtPlacement({
      env,
      organisationId: scope.organisationId,
      placement: scope.placement,
      now,
    });
    await organisation.deleteOldScreenRelevanceRecords({
      organisationId: scope.organisationId,
      now,
    });
  },
];
