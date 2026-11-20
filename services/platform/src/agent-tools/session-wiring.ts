import type { SessionOwnToolServices } from "../actors/session/own-tool-services";
import type { SessionToolWiring } from "../actors/session/tool-wiring";
import {
  presentConfigurationCommand,
  previewCode,
} from "../slack/configuration-presentation";
import { KITCHEN_PAGE_EFFECTS } from "./bakery/page-effects";
import { channelToolServices } from "./channels/turn-services";
import {
  bindAllowanceReference,
  commerceToolServices,
} from "./commerce/turn-services";
import { deviceToolServices } from "./devices/turn-services";
import { createMenuBoardDraftPreview } from "./drafts/board-draft-preview";
import { menuToolServices } from "./drafts/turn-services";
import {
  customConnectorTurnTools,
  integrationToolServices,
} from "./integrations/turn-services";
import { jevToolServices } from "./jev/turn-services";
import {
  kitchenToolServices,
  pageViewCommandExecutor,
} from "./kitchen/turn-services";
import { stageConfigurationDraft } from "./organisation/configuration-draft";
import { TOOL_REGISTRY, type ToolServices } from "./registry";
import {
  admitSlackSideCaseInformationFlow,
  SLACK_SIDE_CASE_HARNESS_INSTRUCTION,
} from "../slack/side-cases";
import { proposeSlackSideCaseForHarness } from "./slack/side-case-proposal";
import { proposeMemoryFromInstruction } from "../memory/access";
import { slackToolServices } from "./slack/turn-services";
import { sessionOwnToolServices } from "../actors/session/own-tool-services";
import {
  requestPermissionForHarness,
  turnMayRequestPermission,
} from "../actors/harness-follow-up";
import { settleToolEffect, type ToolEffect } from "./session-support";

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
  slackThreadSideCase: {
    harnessInstruction: SLACK_SIDE_CASE_HARNESS_INSTRUCTION,
    admit: admitSlackSideCaseInformationFlow,
    propose: proposeSlackSideCaseForHarness,
  },
  // Plan 40B phase 7: a board edit shows on the board while the model writes
  // it.
  argumentObserver: createMenuBoardDraftPreview,
};
