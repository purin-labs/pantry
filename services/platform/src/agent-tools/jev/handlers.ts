import type { JevFeaturesView } from "@purin-labs/control-api/portal/jev-features";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { SessionToolContext } from "../context";
import { readMemberRecord } from "../member-record-read";
import { JevFeatureRequestError } from "./services";

/**
 * The Jev settings for the agent (Plan 88 section 6): the view that Settings ›
 * Jev reads, so fields that a later phase adds reach the agent too. Every
 * member may read it. A mailbox name enters the turn only after the
 * information-flow boundary admits it.
 */
export function readJevFeaturesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<JevFeaturesView> {
  const { scope } = context.execution;
  return readMemberRecord(context, {
    source: "jev_settings",
    recordId: "jev-features",
    refusal: () =>
      new JevFeatureRequestError(
        "Only a member of this workspace can read its Jev settings. Nothing was read. Tell the person.",
      ),
    read: async () => {
      const organisation = await requireActiveOrganisationActor({
        env: context.env,
        organisationId: scope.organisationId,
        now: Date.now(),
      });
      const read = await organisation.readJevFeatures({
        organisationId: scope.organisationId,
      });
      if (!read.ok)
        throw new Error(`Jev settings read failed: ${read.error.code}`);
      return read.value;
    },
  });
}
