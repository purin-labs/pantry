import type { GatewayWebhookRoute } from "./domain";

export function matchWebhookRoute(
  pathname: string,
): GatewayWebhookRoute | null {
  const segments = pathname.split("/");
  if (segments[0] !== "" || segments[1] !== "hook") {
    return null;
  }

  if (segments.length === 3) {
    return matchStaticWebhook(segments[2]);
  }

  if (segments.length !== 4) {
    return null;
  }

  const provider = segments[2];
  const parameter = segments[3];
  if (provider === undefined || parameter === undefined) {
    return null;
  }

  switch (provider) {
    case "stripe":
      if (parameter === "connect") {
        return { kind: "stripeConnectWebhook" };
      }
      return { kind: "stripeWebhook", organisationIdRaw: parameter };
    case "shopify":
      return { kind: "shopifyWebhook", organisationIdRaw: parameter };
    case "commerce":
      return { kind: "commerceWebhook", organisationIdRaw: parameter };
    case "discord":
      return { kind: "discordInteraction", organisationIdRaw: parameter };
    case "email":
      if (parameter === "google") {
        return { kind: "emailGoogleWebhook" };
      }
      return null;
    default:
      return null;
  }
}

function matchStaticWebhook(
  provider: string | undefined,
): GatewayWebhookRoute | null {
  switch (provider) {
    case "dropbox":
      return { kind: "dropboxWebhook" };
    case "whatsapp":
      return { kind: "whatsappWebhook" };
    default:
      return null;
  }
}
