import type { SessionOwnToolServices } from "@purin-labs/tool-handlers/actors/session/own-tool-services";
import type { SessionToolWiring } from "@purin-labs/agent/actors/session/tool-wiring";
import {
  presentConfigurationCommand,
  previewCode,
} from "@purin-labs/surface-slack/server/configuration-presentation";
import { KITCHEN_PAGE_EFFECTS } from "@purin-labs/area-kitchen/server/agent-tools/bakery/page-effects";
import { channelToolServices } from "@purin-labs/area-inbox/server/agent-tools/channels/turn-services";
import {
  bindAllowanceReference,
  commerceToolServices,
} from "@purin-labs/area-commerce/server/agent-tools/commerce/turn-services";
import { deviceToolServices } from "@purin-labs/area-devices/server/agent-tools/devices/turn-services";
import { createMenuBoardDraftPreview } from "@purin-labs/area-cafe/server/agent-tools/drafts/board-draft-preview";
import { menuToolServices } from "@purin-labs/area-cafe/server/agent-tools/drafts/turn-services";
import {
  customConnectorTurnTools,
  integrationToolServices,
} from "@purin-labs/area-integrations/server/agent-tools/integrations/turn-services";
import { jevToolServices } from "@purin-labs/area-integrations/server/agent-tools/jev/turn-services";
import {
  kitchenToolServices,
  pageViewCommandExecutor,
} from "@purin-labs/area-kitchen/server/agent-tools/kitchen/turn-services";
import { stageConfigurationDraft } from "@purin-labs/area-organisation/server/agent-tools/organisation/configuration-draft";
import { TOOL_REGISTRY, type ToolServices } from "./registry";
import { slackThreadSideCase } from "@purin-labs/surface-slack/server/side-cases";
import { sessionConversation } from "@purin-labs/conversation/chat/session-conversation";
import { proposeSlackSideCaseForHarness } from "@purin-labs/surface-slack/server/agent-tools/slack/side-case-proposal";
import { proposeMemoryFromInstruction } from "@purin-labs/area-brain/server/memory/access";
import { slackToolServices } from "@purin-labs/surface-slack/server/agent-tools/slack/turn-services";
import { sessionOwnToolServices } from "@purin-labs/tool-handlers/actors/session/own-tool-services";
import {
  requestPermissionForHarness,
  turnMayRequestPermission,
} from "@purin-labs/tool-handlers/actors/harness-follow-up";
import {
  settleToolEffect,
  type ToolEffect,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import { readPendingDecisionsForEmbeddedHarness } from "@purin-labs/tool-handlers/agent-tools/pending-decisions";
import { withToolContext } from "@purin-labs/agent/agent-tools/context";
import { pendingDecisionSources } from "../control/pending-decision-parts";

/**
 * The services of the families that an area owns. With the families of the
 * Session it is the whole set, so a tool that the model sees has a handler.
 */
type AreaToolServices = Omit<ToolServices, keyof SessionOwnToolServices>;

/**
 * The Worker gives this value to the Session: the one list of the agent
 * tools, and for each turn the part of each area. Each area builds its own
 * services. This file only joins them, and it gives one area the part of
 * another area that it needs.
 */
export const SESSION_TOOL_WIRING: SessionToolWiring = {
  registry: TOOL_REGISTRY,
  turnTools: customConnectorTurnTools,
  areaServices(turn): AreaToolServices {
    // The Organisation area stages a configuration draft. Commerce gives the
    // price reference of an allowance, and Slack gives the words.
    const stage = stageConfigurationDraft.bind(null, turn, {
      bindReference: bindAllowanceReference.bind(null, turn),
      present: presentConfigurationCommand,
      previewCode,
    });
    const commerce = commerceToolServices(turn, stage);
    // One executor runs the view commands of each page (Plan 87): Costs &
    // margins, the Pastry Bench and Café › Register.
    const executePageViewCommand = pageViewCommandExecutor(turn);
    return {
      integrations: integrationToolServices(turn),
      channels: channelToolServices(turn),
      commerce: commerce.commerce,
      cafe: {
        ...commerce.orderQueue,
        executeRegisterViewCommand: executePageViewCommand,
      },
      slack: slackToolServices(turn),
      kitchen: kitchenToolServices(
        turn,
        stage,
        executePageViewCommand,
        commerce.costs,
      ),
      devices: deviceToolServices(turn, stage),
      jev: jevToolServices(turn, stage),
      menu: {
        ...menuToolServices(turn),
        proposeMenuPrice: commerce.proposeMenuPrice,
      },
      // The decisions that wait for the person, through the Portal's one
      // read with the stores of this Worker.
      decisions: {
        readPendingDecisions: withToolContext(turn)(
          readPendingDecisionsForEmbeddedHarness.bind(
            null,
            pendingDecisionSources(turn.env),
          ),
        ),
      },
    };
  },
  proposeMemory: proposeMemoryFromInstruction,
  ownServices: sessionOwnToolServices,
  // An effect of a registered tool is a `ToolEffect`: its family defined it.
  settleEffect: (context, effect) =>
    settleToolEffect(context, effect as ToolEffect),
  mayRequestPermission: turnMayRequestPermission,
  requestPermission: requestPermissionForHarness,
  pageEffects: KITCHEN_PAGE_EFFECTS,
  slackThreadSideCase: { propose: proposeSlackSideCaseForHarness },
  conversation: sessionConversation(slackThreadSideCase),
  // Plan 40B phase 7: a board edit shows on the board while the model writes
  // it.
  argumentObserver: createMenuBoardDraftPreview,
};
