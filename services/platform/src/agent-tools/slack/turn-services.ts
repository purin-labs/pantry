import type { ToolTurnContext } from "../../actors/session/tool-wiring";
import { withToolContext } from "../context";
import { proposeSlackMessageForEmbeddedHarness } from "./handlers";
import type { SlackToolServices } from "./slack";

/** What Slack gives to one turn: the service of the Slack message tool. */
export function slackToolServices(turn: ToolTurnContext): SlackToolServices {
  return {
    proposeSlackMessage: withToolContext(turn)(
      proposeSlackMessageForEmbeddedHarness,
    ),
  };
}
