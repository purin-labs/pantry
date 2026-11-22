import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import type {
  EffectiveCapability,
  EffectiveGrantSet,
} from "../authorization/access-grants";
import { encodeCapabilityKey } from "../authorization/access-grants";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { digestCanonical } from "../policy/information-flow/digest";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CustomConnectorAuthentication,
  CustomConnectorDefinitionLimits,
  CustomConnectorObjectSchema,
  CustomConnectorOperation,
} from "./definition";
import {
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  type CustomConnectorDefinitionDigest,
  type CustomConnectorId,
  type CustomConnectorRevision,
} from "./identity";
import { CUSTOM_CONNECTOR_LIMITS } from "./limits";
import { resolveActiveCustomConnectorAccount } from "./accounts";
import { resolveCustomConnectorRevision } from "./revisions";
import type { Variant } from "@purin-labs/type-utils";

export type CustomConnectorCatalogEntry = Readonly<{
  readonly toolName: string;
  readonly description: string;
  readonly origin: string;
  readonly authentication: CustomConnectorAuthentication;
  readonly limits: CustomConnectorDefinitionLimits;
  readonly inputSchema: CustomConnectorObjectSchema;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectorId: CustomConnectorId;
  readonly definitionRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
  readonly operation: CustomConnectorOperation;
  readonly capabilityKey: string;
  readonly grantIds: readonly string[];
  readonly grantRevisions: readonly number[];
}>;

export type CustomConnectorReadCatalogEntry = CustomConnectorCatalogEntry &
  Readonly<{
    readonly operation: CustomConnectorOperation &
      Readonly<{ readonly effect: { readonly kind: "read" } }>;
  }>;

export type CustomConnectorWriteCatalogEntry = CustomConnectorCatalogEntry &
  Readonly<{
    readonly operation: CustomConnectorOperation &
      Readonly<{
        readonly effect:
          | Variant<
              CustomConnectorOperation["effect"],
              "external_record_create"
            >
          | Variant<
              CustomConnectorOperation["effect"],
              "external_record_update"
            >;
      }>;
  }>;

type CustomConnectorReadCatalogError =
  | { readonly code: "custom_connector_catalog_limit_exceeded" }
  | { readonly code: "custom_connector_catalog_collision" }
  | {
      readonly code: "custom_connector_catalog_entry_unavailable";
      readonly capabilityKey: string;
    };

export async function compileCustomConnectorReadCatalog(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly effectiveGrants: EffectiveGrantSet;
}): Promise<
  Result<
    readonly CustomConnectorReadCatalogEntry[],
    CustomConnectorReadCatalogError
  >
> {
  const customCapabilities = input.effectiveGrants.capabilities.filter(
    isCustomConnectorReadCapability,
  );
  if (customCapabilities.length > CUSTOM_CONNECTOR_LIMITS.catalogOperations) {
    return {
      ok: false,
      error: { code: "custom_connector_catalog_limit_exceeded" },
    };
  }

  const entries: CustomConnectorReadCatalogEntry[] = [];
  const toolNames = new Set<string>();
  for (const capability of customCapabilities) {
    const capabilityKey = encodeCapabilityKey(capability.definition);
    const entry = await compileCatalogEntry({
      db: input.db,
      organisationId: input.effectiveGrants.organisationId,
      capability,
      capabilityKey,
    });
    if (!entry.ok) return entry;
    const operation = entry.value.operation;
    if (!isReadOperation(operation)) {
      return unavailable(capabilityKey);
    }
    if (toolNames.has(entry.value.toolName)) {
      return {
        ok: false,
        error: { code: "custom_connector_catalog_collision" },
      };
    }
    toolNames.add(entry.value.toolName);
    entries.push({ ...entry.value, operation });
  }
  entries.sort(compareCatalogEntries);
  return { ok: true, value: Object.freeze(entries) };
}

export async function compileCustomConnectorWriteCatalog(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly effectiveGrants: EffectiveGrantSet;
}): Promise<
  Result<
    readonly CustomConnectorWriteCatalogEntry[],
    CustomConnectorReadCatalogError
  >
> {
  const customCapabilities = input.effectiveGrants.capabilities.filter(
    isCustomConnectorWriteCapability,
  );
  if (customCapabilities.length > CUSTOM_CONNECTOR_LIMITS.catalogOperations) {
    return {
      ok: false,
      error: { code: "custom_connector_catalog_limit_exceeded" },
    };
  }
  const entries: CustomConnectorWriteCatalogEntry[] = [];
  const toolNames = new Set<string>();
  for (const capability of customCapabilities) {
    const capabilityKey = encodeCapabilityKey(capability.definition);
    const entry = await compileCatalogEntry({
      db: input.db,
      organisationId: input.effectiveGrants.organisationId,
      capability,
      capabilityKey,
    });
    if (!entry.ok) return entry;
    const operation = entry.value.operation;
    if (!isWriteOperation(operation)) {
      return unavailable(capabilityKey);
    }
    if (toolNames.has(entry.value.toolName)) {
      return {
        ok: false,
        error: { code: "custom_connector_catalog_collision" },
      };
    }
    toolNames.add(entry.value.toolName);
    entries.push({ ...entry.value, operation });
  }
  entries.sort(compareCatalogEntries);
  return { ok: true, value: Object.freeze(entries) };
}

export async function compileCustomConnectorCatalog(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly effectiveGrants: EffectiveGrantSet;
}): Promise<
  Result<
    readonly CustomConnectorCatalogEntry[],
    CustomConnectorReadCatalogError
  >
> {
  const reads = await compileCustomConnectorReadCatalog(input);
  if (!reads.ok) return reads;
  const writes = await compileCustomConnectorWriteCatalog(input);
  if (!writes.ok) return writes;
  const entries: CustomConnectorCatalogEntry[] = [...reads.value];
  const names = new Set(entries.map(readToolName));
  for (const entry of writes.value) {
    if (names.has(entry.toolName)) {
      return {
        ok: false,
        error: { code: "custom_connector_catalog_collision" },
      };
    }
    names.add(entry.toolName);
    entries.push(entry);
  }
  if (entries.length > CUSTOM_CONNECTOR_LIMITS.catalogOperations) {
    return {
      ok: false,
      error: { code: "custom_connector_catalog_limit_exceeded" },
    };
  }
  entries.sort(compareCatalogEntries);
  return { ok: true, value: Object.freeze(entries) };
}

function readToolName(entry: CustomConnectorCatalogEntry): string {
  return entry.toolName;
}

type CustomReadCapability = Omit<EffectiveCapability, "definition"> & {
  readonly definition: Variant<
    EffectiveCapability["definition"],
    "custom_connector_operation"
  >;
};

type CustomWriteCapability = CustomReadCapability;

function isCustomConnectorReadCapability(
  capability: EffectiveGrantSet["capabilities"][number],
): capability is CustomReadCapability {
  return (
    capability.definition.kind === "custom_connector_operation" &&
    capability.definition.capabilityId === "custom_connector.read" &&
    capability.definition.capabilityVersion === 1
  );
}

function isCustomConnectorWriteCapability(
  capability: EffectiveGrantSet["capabilities"][number],
): capability is CustomWriteCapability {
  return (
    capability.definition.kind === "custom_connector_operation" &&
    capability.definition.capabilityId === "custom_connector.write" &&
    capability.definition.capabilityVersion === 1
  );
}

function isReadOperation(
  operation: CustomConnectorOperation,
): operation is CustomConnectorReadCatalogEntry["operation"] {
  return operation.effect.kind === "read";
}

function isWriteOperation(
  operation: CustomConnectorOperation,
): operation is CustomConnectorWriteCatalogEntry["operation"] {
  return operation.effect.kind !== "read";
}

async function compileCatalogEntry(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly capability: CustomReadCapability;
  readonly capabilityKey: string;
}): Promise<
  Result<CustomConnectorCatalogEntry, CustomConnectorReadCatalogError>
> {
  const target = input.capability.definition;
  const accountId = parseIntegrationAccountId(target.integrationAccountId);
  const connectorId = parseCustomConnectorId(target.connectorId);
  const revision = parseCustomConnectorRevision(target.definitionRevision);
  const digest = parseCustomConnectorDefinitionDigest(target.definitionDigest);
  if (!accountId.ok || !connectorId.ok || !revision.ok || !digest.ok) {
    return unavailable(input.capabilityKey);
  }
  const account = await resolveActiveCustomConnectorAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: accountId.value,
  });
  if (
    !account.ok ||
    account.value.source.connectorId !== connectorId.value ||
    account.value.binding.acceptedRevision !== revision.value ||
    account.value.binding.definitionDigest !== digest.value
  ) {
    return unavailable(input.capabilityKey);
  }
  const definition = await resolveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: connectorId.value,
    revision: revision.value,
  });
  if (
    !definition.ok ||
    definition.value.reviewState !== "approved" ||
    definition.value.definitionDigest !== digest.value
  ) {
    return unavailable(input.capabilityKey);
  }
  const operation = findOperation(
    definition.value.definition.operations,
    target.operationId,
  );
  if (
    operation === null ||
    (target.capabilityId === "custom_connector.read" &&
      operation.effect.kind !== "read") ||
    (target.capabilityId === "custom_connector.write" &&
      operation.effect.kind === "read")
  ) {
    return unavailable(input.capabilityKey);
  }
  const credentialIsHealthy = await hasHealthyCredential({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: accountId.value,
    connectorId: connectorId.value,
    bindingRevision: account.value.binding.bindingRevision,
    credentialGeneration: account.value.binding.credentialGeneration,
  });
  if (!credentialIsHealthy) return unavailable(input.capabilityKey);
  const toolName = await customConnectorToolName(input.capabilityKey);
  return {
    ok: true,
    value: {
      toolName,
      description: operation.description,
      origin: definition.value.definition.origin,
      authentication: definition.value.definition.authentication,
      limits: definition.value.definition.limits,
      inputSchema: operation.inputSchema,
      organisationId: input.organisationId,
      integrationAccountId: accountId.value,
      connectorId: connectorId.value,
      definitionRevision: revision.value,
      definitionDigest: digest.value,
      bindingRevision: account.value.binding.bindingRevision,
      credentialGeneration: account.value.binding.credentialGeneration,
      operation,
      capabilityKey: input.capabilityKey,
      grantIds: input.capability.grantIds,
      grantRevisions: input.capability.grantRevisions,
    },
  };
}

async function hasHealthyCredential(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectorId: CustomConnectorId;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
}): Promise<boolean> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS present
       FROM custom_connector_account_binding AS binding
       JOIN integration_account AS account
         ON account.organisation_id = binding.organisation_id
        AND account.integration_account_id = binding.integration_account_id
        AND account.source_kind = 'custom_api'
        AND account.custom_connector_id = binding.connector_id
        AND account.lifecycle = 'active'
       JOIN provider_connection AS connection
         ON connection.organisation_id = account.organisation_id
        AND connection.provider_connection_id = account.provider_connection_id
        AND connection.source_kind = 'custom_api'
        AND connection.custom_connector_id = binding.connector_id
        AND connection.lifecycle = 'active'
        AND connection.credential_generation = binding.credential_generation
       JOIN provider_credential_generation AS generation
         ON generation.organisation_id = connection.organisation_id
        AND generation.provider_connection_id = connection.provider_connection_id
        AND generation.credential_generation = connection.credential_generation
        AND generation.credential_ref = connection.credential_ref
        AND generation.lifecycle = 'active'
       JOIN vault_secret AS secret
         ON secret.organisation_id = generation.organisation_id
        AND secret.vault_handle = generation.credential_ref
        AND secret.revoked_at IS NULL
       JOIN custom_connector AS connector
         ON connector.organisation_id = binding.organisation_id
        AND connector.connector_id = binding.connector_id
        AND connector.lifecycle = 'active'
       WHERE binding.organisation_id = ? AND binding.integration_account_id = ?
         AND binding.connector_id = ? AND binding.binding_revision = ?
         AND binding.credential_generation = ? AND binding.lifecycle = 'active'
       LIMIT 1`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.connectorId,
      input.bindingRevision,
      input.credentialGeneration,
    )
    .first<{ present: unknown }>();
  return row?.present === 1;
}

function findOperation(
  operations: readonly CustomConnectorOperation[],
  operationId: string,
): CustomConnectorOperation | null {
  for (const operation of operations) {
    if (operation.id === operationId) return operation;
  }
  return null;
}

async function customConnectorToolName(capabilityKey: string): Promise<string> {
  const digest = await digestCanonical({ capabilityKey });
  return `cc_${digest.slice(0, 60)}`;
}

function compareCatalogEntries(
  left: CustomConnectorCatalogEntry,
  right: CustomConnectorCatalogEntry,
): number {
  return left.toolName.localeCompare(right.toolName);
}

function unavailable(
  capabilityKey: string,
): Result<never, CustomConnectorReadCatalogError> {
  return {
    ok: false,
    error: {
      code: "custom_connector_catalog_entry_unavailable",
      capabilityKey,
    },
  };
}
