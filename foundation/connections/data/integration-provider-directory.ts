import type { IntegrationDiscoveryDataClass } from "@purin-labs/contracts";
import type { IntegrationProvider } from "./integration-account";

/**
 * The directory of the providers that an Organisation can connect: their
 * names and the data classes of each one. It holds data only. The provider
 * catalogue of the integrations area adds the adapter code of each provider,
 * so access-control code reads the directory with no import of an adapter
 * (Refactor 17, step A1.8).
 */

export type ActiveIntegrationProvider = Extract<
  IntegrationProvider,
  | "airtable"
  | "dropbox"
  | "gmail"
  | "google_drive"
  | "notion"
  | "shopify"
  | "slack"
  | "square"
  | "stripe"
  | "whatsapp"
>;

export function parseActiveIntegrationProvider(
  value: unknown,
): ActiveIntegrationProvider | null {
  switch (value) {
    case "airtable":
    case "dropbox":
    case "gmail":
    case "google_drive":
    case "notion":
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

/** The data classes that a connection of each provider can hold. */
export const PROVIDER_DATA_CLASSES = {
  airtable: ["records"],
  dropbox: ["files"],
  gmail: ["mail"],
  google_drive: ["files"],
  notion: ["records"],
  shopify: ["commerce"],
  slack: ["messaging"],
  square: ["payments"],
  stripe: ["payments"],
  whatsapp: ["messaging"],
} as const satisfies {
  readonly [
    P in ActiveIntegrationProvider
  ]: readonly IntegrationDiscoveryDataClass[];
};
