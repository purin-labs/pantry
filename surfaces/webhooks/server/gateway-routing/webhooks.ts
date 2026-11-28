import type { GatewayWebhookRoute } from "./domain";

export function matchWebhookRoute(
  pathname: string,
): GatewayWebhookRoute | null {
  // Pantry's own Stripe account bills the Organisations (Plan 95 step 6).
  // The webhooks of the providers of a shop are under /hook/.
  if (pathname === "/webhooks/stripe-billing") {
    return { kind: "stripeBillingWebhook" };
  }

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
