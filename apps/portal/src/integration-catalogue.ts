import type { OnboardingProvider } from "@purin-labs/contracts";
import type { ProviderTileName } from "./page-components";

export type Provider = Extract<
  OnboardingProvider,
  | "airtable"
  | "dropbox"
  | "gmail"
  | "google_drive"
  | "notion"
  | "slack"
  | "stripe"
  | "square"
  | "shopify"
  | "whatsapp"
>;

type ProviderPresentation = {
  readonly label: string;
  readonly description: string;
  readonly searchAliases: readonly string[];
  readonly tile: ProviderTileName;
  readonly disconnectedConsequence: string;
};

export const PROVIDER_PRESENTATION = {
  airtable: {
    label: "Airtable",
    description: "Let agents read and update your tables.",
    searchAliases: ["records", "tables", "database"],
    tile: "airtable",
    disconnectedConsequence:
      "Agents can no longer read or update this Airtable connection.",
  },
  dropbox: {
    label: "Dropbox",
    description: "Share folders and files with your agents.",
    searchAliases: ["files", "folders", "documents", "storage"],
    tile: "dropbox",
    disconnectedConsequence:
      "Agents can no longer use the Dropbox folders and files you shared.",
  },
  gmail: {
    label: "Gmail",
    description: "Let an agent read a mailbox and answer new mail.",
    searchAliases: ["email", "mail", "mailbox", "support", "google"],
    tile: "gmail",
    disconnectedConsequence:
      "Purin Pantry has stopped reading new mail and preparing replies.",
  },
  google_drive: {
    label: "Google Drive",
    description: "Let agents use the files you pick.",
    searchAliases: ["drive", "google", "files", "documents", "storage"],
    tile: "google_drive",
    disconnectedConsequence:
      "Agents can no longer use the Google Drive files you picked.",
  },
  notion: {
    label: "Notion",
    description: "Let agents search your Notion pages.",
    searchAliases: ["wiki", "documents", "docs", "knowledge"],
    tile: "notion",
    disconnectedConsequence:
      "Purin Pantry can no longer search this source for operational context.",
  },
  shopify: {
    label: "Shopify",
    description: "Bring in products, stock and orders from your store.",
    searchAliases: ["store", "commerce", "products", "inventory", "orders"],
    tile: "shopify",
    disconnectedConsequence:
      "Products, inventory, and customer orders have stopped updating.",
  },
  slack: {
    label: "Slack",
    description: "Get alerts and talk to your agents in Slack.",
    searchAliases: ["messages", "communication", "alerts", "approvals"],
    tile: "slack",
    disconnectedConsequence:
      "Purin Pantry cannot post inventory alerts, action requests, or completion updates until it is reconnected.",
  },
  square: {
    label: "Square",
    description: "Take in-person payments with Square Terminal.",
    searchAliases: ["terminal", "payments", "refunds", "point of sale", "pos"],
    tile: "square",
    disconnectedConsequence:
      "Square Terminal payments are unavailable until the account is reconnected.",
  },
  stripe: {
    label: "Stripe",
    description: "Take card payments online.",
    searchAliases: ["payments", "refunds", "billing"],
    tile: "stripe",
    disconnectedConsequence: "Payments and refunds have stopped updating.",
  },
  whatsapp: {
    label: "WhatsApp",
    description: "Answer customer messages on your business number.",
    searchAliases: ["messages", "messaging", "support", "phone", "meta"],
    tile: "whatsapp",
    disconnectedConsequence:
      "Purin Pantry has stopped receiving customer messages and preparing replies.",
  },
} as const satisfies Record<Provider, ProviderPresentation>;

export function providerPresentation(
  provider: string,
): ProviderPresentation | null {
  return isProvider(provider) ? PROVIDER_PRESENTATION[provider] : null;
}

export function providerLabel(provider: string): string {
  return providerPresentation(provider)?.label ?? "Connected provider";
}

export function providerTile(provider: string): ProviderTileName {
  return providerPresentation(provider)?.tile ?? "generic";
}

export function providerSearchAliases(provider: string): readonly string[] {
  return providerPresentation(provider)?.searchAliases ?? [];
}

export function providerDisconnectedConsequence(provider: string): string {
  return (
    providerPresentation(provider)?.disconnectedConsequence ??
    "Purin Pantry has stopped exchanging data with this connection."
  );
}

function isProvider(value: string): value is Provider {
  return Object.hasOwn(PROVIDER_PRESENTATION, value);
}
