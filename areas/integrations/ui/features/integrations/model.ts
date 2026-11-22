export type IntegrationRouteId =
  | "airtable"
  | "codex"
  | "commerce"
  | "dropbox"
  | "gmail"
  | "typesafe"
  | "google_drive"
  | "notion"
  | "onepassword"
  | "shopify"
  | "slack"
  | "square"
  | "stripe"
  | "whatsapp";

export type IntegrationRouteSelection =
  | {
      readonly kind: "overview";
      readonly query: string;
      readonly focusId: string | null;
      readonly integrationId?: never;
      readonly accountId?: never;
    }
  | {
      readonly kind: "detail";
      readonly integrationId: IntegrationRouteId;
      readonly accountId: string | null;
      readonly query: string;
      readonly focusId?: never;
    };

export function parseIntegrationRouteSelection(
  search: string,
): IntegrationRouteSelection {
  const parameters = new URLSearchParams(search);
  const integrationId = parseIntegrationRouteId(parameters.get("integration"));
  const query = parameters.get("q") ?? "";
  if (integrationId === null) {
    return { kind: "overview", query, focusId: parameters.get("focus") };
  }
  return {
    kind: "detail",
    integrationId,
    accountId: parameters.get("account"),
    query,
  };
}

function parseIntegrationRouteId(
  value: string | null,
): IntegrationRouteId | null {
  switch (value) {
    case "airtable":
    case "codex":
    case "commerce":
    case "dropbox":
    case "gmail":
    case "typesafe":
    case "google_drive":
    case "notion":
    case "onepassword":
    case "shopify":
    case "slack":
    case "square":
    case "stripe":
    case "whatsapp":
      return value;
    default:
      return null;
  }
}
