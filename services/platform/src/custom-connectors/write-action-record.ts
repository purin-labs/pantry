import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { ActionLedgerEntry } from "@purin-labs/authority/actors/action-ledger";
import { resolveCustomConnectorWritePreview } from ".";
import type { AuthorizedOrganisationRequest } from "../control/authorization";

export function customActionMatchesConnector(
  entry: ActionLedgerEntry,
  connectorId: string,
): boolean {
  return (
    entry.action.authority.kind === "custom_connector" &&
    entry.action.authority.connectorId === connectorId
  );
}

export async function customConnectorActionRecord(
  database: OrganisationDatabase,
  entry: ActionLedgerEntry,
  role: AuthorizedOrganisationRequest["membership"]["role"],
): Promise<Readonly<Record<string, unknown>>> {
  if (entry.action.authority.kind !== "custom_connector") {
    throw new Error("custom connector action authority invariant failed");
  }
  const authority = entry.action.authority;
  return {
    nonce: entry.action.nonce.value,
    state: entry.state,
    connectorId: authority.connectorId,
    integrationAccountId: entry.action.integrationAccountId,
    operationId: authority.operationId,
    effect: authority.effect,
    retryPolicy: authority.retryPolicy,
    providerEffectId: authority.providerEffectId,
    definitionRevision: authority.definitionRevision,
    definitionDigest: authority.definitionDigest,
    bindingRevision: authority.bindingRevision,
    credentialGeneration: authority.credentialGeneration,
    resourceIdentity: authority.resourceIdentity,
    canonicalInputDigest: authority.canonicalInputDigest,
    preview:
      role === "owner" || role === "admin"
        ? await resolveCustomConnectorWritePreview({
            db: database,
            organisationId: entry.action.organisationId,
            integrationAccountId: entry.action.integrationAccountId,
            authority,
          })
        : { kind: "unavailable", reason: "permission_required" },
    proposedAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    providerResult:
      entry.state === "confirmed" || entry.state === "failed"
        ? parseProviderResult(entry.providerResult)
        : null,
  };
}

function parseProviderResult(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { kind: "unparseable_provider_result" };
  }
}
