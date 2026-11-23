import type { GatewaySlackRoute } from "../../../../services/platform/src/gateway-routing/domain";

export const SLACK_INSTALL_REDIRECT_PATH = "/slack/install";

const SLACK_INSTALL_START_PATH = "/slack/install/start";

/** Slack sends the clicks on Pantry's message buttons here (Plan 74). */
export const SLACK_INTERACTIONS_PATH = "/slack/interactions";

export function matchSlackRoute(pathname: string): GatewaySlackRoute | null {
  switch (pathname) {
    case "/slack/events":
      return { kind: "slackEvents" };
    case SLACK_INTERACTIONS_PATH:
      return { kind: "slackInteractions" };
    case SLACK_INSTALL_START_PATH:
      return { kind: "slackInstallStart" };
    case SLACK_INSTALL_REDIRECT_PATH:
      return { kind: "slackInstall" };
    case "/v1/debug/slack/install-liveness":
      return { kind: "slackInstallLiveness" };
    default:
      return null;
  }
}
