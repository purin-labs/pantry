import type { OrganisationDatabaseSession } from "@purin-labs/kernel/database-handles";
import type { VaultHandle } from "@purin-labs/authority/credential-vault/index";
import type { ProviderCleanupByProvider } from "@purin-labs/area-integrations-contract/server/provider-adapter";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import { isRecord } from "@purin-labs/std";
import { readWhatsAppBusinessAccountId } from "@purin-labs/area-inbox-contract/server/account-erasure";

export type ProviderCleanupBaseInput<
  P extends keyof ProviderCleanupByProvider,
> = {
  readonly cleanupId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly provider: P;
  readonly environment: "development" | "production";
  readonly providerAccountId: string;
  readonly providerConnectionId: string;
  readonly credentialHandles: readonly VaultHandle[];
};

export async function readProviderOnlyCleanupContext<
  P extends Exclude<keyof ProviderCleanupByProvider, "whatsapp">,
>(provider: P): Promise<string> {
  return JSON.stringify({ provider });
}

export async function readWhatsAppCleanupContext(input: {
  readonly db: Pick<OrganisationDatabaseSession, "prepare">;
  readonly integrationAccountId: IntegrationAccountId;
  readonly removeApplicationSubscription: boolean;
}): Promise<string | null> {
  const wabaId = await readWhatsAppBusinessAccountId(
    input.db,
    input.integrationAccountId,
  );
  return wabaId !== null
    ? JSON.stringify({
        provider: "whatsapp",
        wabaId,
        removeApplicationSubscription: input.removeApplicationSubscription,
      })
    : null;
}

export function parseProviderOnlyCleanup<
  P extends Exclude<keyof ProviderCleanupByProvider, "whatsapp">,
>(
  provider: P,
  input: ProviderCleanupBaseInput<P>,
  rawContext: string,
): ProviderCleanupBaseInput<P> | null {
  const context = parseJsonObject(rawContext);
  return context?.provider === provider ? input : null;
}

export function parseWhatsAppCleanup(
  input: ProviderCleanupBaseInput<"whatsapp">,
  rawContext: string,
): ProviderCleanupByProvider["whatsapp"] | null {
  const context = parseJsonObject(rawContext);
  return context?.provider === "whatsapp" &&
    typeof context.wabaId === "string" &&
    context.wabaId.length > 0 &&
    typeof context.removeApplicationSubscription === "boolean"
    ? {
        cleanupId: input.cleanupId,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        provider: "whatsapp",
        environment: input.environment,
        providerAccountId: input.providerAccountId,
        providerConnectionId: input.providerConnectionId,
        credentialHandles: input.credentialHandles,
        wabaId: context.wabaId,
        removeApplicationSubscription: context.removeApplicationSubscription,
      }
    : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
