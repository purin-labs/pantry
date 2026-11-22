import type { JevFeatureCommand } from "@purin-labs/control-api/portal/jev-features";
import {
  beginProposalStaging,
  type StageConfigurationDraft,
} from "@purin-labs/agent/actors/session/proposal-staging";
import type { ToolTurnContext } from "@purin-labs/agent/actors/session/tool-wiring";
import { roleMayConfigure } from "@purin-labs/tenancy/data/control-plane";
import {
  withToolContext,
  type SessionToolContext,
} from "@purin-labs/agent/agent-tools/context";
import { ToolRequestError } from "@purin-labs/agent-tools/errors";
import { liveDeviceMember } from "@purin-labs/tool-handlers/agent-tools/session-support";
import { readJevFeaturesForEmbeddedHarness } from "./handlers";
import type { JevToolServices } from "./services";

/** What a turn gets for the Jev settings tools. */
export function jevToolServices(
  turn: ToolTurnContext,
  stageConfigurationDraft: StageConfigurationDraft,
): JevToolServices {
  return {
    readJevFeatures: withToolContext(turn)(readJevFeaturesForEmbeddedHarness),
    proposeJevFeature: proposeJevFeatureForEmbeddedHarness.bind(
      null,
      turn,
      stageConfigurationDraft,
    ),
  };
}

/**
 * Plan 88: stages a change to one Jev switch, for the admin who asked to
 * approve on a card. Turning a switch on sends new data to TypeSafe, so a
 * person approves each change, and only an admin may, as on Settings › Jev.
 */
async function proposeJevFeatureForEmbeddedHarness(
  context: SessionToolContext,
  stageConfigurationDraft: StageConfigurationDraft,
  request: JevFeatureCommand,
): Promise<unknown> {
  const member = await liveDeviceMember(
    context.execution.scope.database,
    context.execution.scope.organisationId,
    context.lease,
  );
  if (member === null || !roleMayConfigure(member.role))
    throw new ToolRequestError(
      "Only an owner or admin can change a Jev switch, and the person who asked cannot. Nothing changed. Tell the person to ask an owner or admin. Do not ask for a permission or retry.",
    );
  const staging = await beginProposalStaging(context, "Jev switch proposal", {
    portalChat: true,
  });
  return stageConfigurationDraft(
    staging,
    { family: "jev_feature", command: request },
    {},
  );
}
