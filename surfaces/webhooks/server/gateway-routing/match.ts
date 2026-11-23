import { matchAcceptanceRoute } from "./acceptance";
import { matchAdminRoute } from "./admin";
import type { GatewayRoute } from "./domain";
import { matchIdentityRoute } from "./identity-and-installs";
import { matchSlackRoute } from "@purin-labs/surface-slack/server/gateway-routing/slack";
import { matchWebhookRoute } from "./webhooks";

export function matchGatewayRoute(pathname: string): GatewayRoute {
  if (pathname.startsWith("/v1/control/")) {
    return { kind: "control" };
  }

  if (pathname.startsWith("/v1/screens/")) {
    return { kind: "menuScreen" };
  }

  if (pathname.startsWith("/v1/voice-macs/")) {
    return { kind: "voiceMac" };
  }

  if (pathname.startsWith("/v1/device-gateways/")) {
    return { kind: "deviceGateway" };
  }

  if (pathname === "/health") {
    return { kind: "health" };
  }

  const slackRoute = matchSlackRoute(pathname);
  if (slackRoute !== null) {
    return slackRoute;
  }

  const webhookRoute = matchWebhookRoute(pathname);
  if (webhookRoute !== null) {
    return webhookRoute;
  }

  const adminRoute = matchAdminRoute(pathname);
  if (adminRoute !== null) {
    return adminRoute;
  }

  const identityRoute = matchIdentityRoute(pathname);
  if (identityRoute !== null) {
    return identityRoute;
  }

  const acceptanceRoute = matchAcceptanceRoute(pathname);
  if (acceptanceRoute !== null) {
    return acceptanceRoute;
  }

  return { kind: "notFound" };
}
