import { pantryCommerceAccess } from "../contract/client";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import {
  parseEntityPlanePublishedResourceMetadataRequest,
  parseCommerceGraphQuery,
  CommerceAdminClient,
  CommerceEntityPlaneClient,
  type CommerceCredential,
  type CommerceEntityPlaneFetch,
  type CommerceEntityPlanePublishedResourceMetadataResponse,
} from "@purin-labs/commerce-client";
import type { AccessTargetRef } from "@purin-labs/contracts";
import type {
  CommerceCursor,
  CommerceEntity,
  CommerceGraphQueryResult,
  CommerceList,
  CommerceListEntry,
  CommerceRelationshipRef,
} from "@purin-labs/commerce-contracts";
import { sameCommerceRelationshipRef } from "@purin-labs/commerce-contracts/commerce-relationship-references";

import type { AccessGrantTarget } from "../../authorization/access-grants/types";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type { AgentResponsibilityScope } from "../../data/agent-operations";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import { readOrganisationEnvironment } from "../../control/organisation-runtime";
import type { Env } from "../../env";
import type { IntegrationAccountId, OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { opaqueAccessTargetReference } from "../../access-control/references";
import type { PublishedCommerceTarget } from "../../access-control/commerce-access-targets";
import { commerceCanonicalResourceId } from "../contract/resource-ids";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";
import type { PublishedResourceBoundaryError } from "../contract/types";

export type { PublishedResourceBoundaryError };

type PublishedResourceEnumeration = Variant<
  CommerceEntityPlanePublishedResourceMetadataResponse,
  "enumerated"
>;

type PublishedResourceResolution = Variant<
  CommerceEntityPlanePublishedResourceMetadataResponse,
  "resolved"
>;

type PublishedResourceClientConfig = Readonly<{
  readonly baseUrl: string;
  readonly serviceToken: CommerceCredential;
  readonly fetch: CommerceEntityPlaneFetch;
}>;

type PublishedResourceClient = Pick<
  CommerceEntityPlaneClient,
  "publishedResourceMetadata"
>;

export function createPublishedResourceClient(
  config: PublishedResourceClientConfig,
): CommerceEntityPlaneClient | null {
  try {
    return new CommerceEntityPlaneClient(config);
  } catch {
    return null;
  }
}

type CommerceCommandTarget = Variant<AccessGrantTarget, "commerce_command">;
type CommerceProviderTarget = Variant<AccessGrantTarget, "provider_resource">;

type PublishedCommerceTargetError = "unavailable";

export async function listPublishedCommerceTargets(
  input: Readonly<{
    env: Env;
    organisationId: OrganisationId;
  }>,
): Promise<
  Result<
    readonly PublishedCommerceTarget[],
    PublishedCommerceTargetError
  >
> {
  try {
    const client = await publishedCommerceClient(input);
    if (!client.ok) return client;
    const snapshot = await client.value.adminClient.readSnapshot(
      client.value.merchantId,
    );
    if (!snapshot.ok || snapshot.value.merchantId !== client.value.merchantId)
      return unavailableCommerceTargets();
    const targets: PublishedCommerceTarget[] = [];
    for (const product of snapshot.value.resources.products) {
      const providerTarget = commerceProductActionProposeTarget(
        commerceCanonicalResourceId(client.value.merchantId, product.id),
        client.value.integrationAccountId,
      );
      targets.push({
        kind: "product",
        providerTarget,
        targetRef: {
          targetRefId: await opaqueAccessTargetReference(input.organisationId, providerTarget),
          revision: product.revision,
        },
        label: `Seams Checkout · ${product.title}`,
        detail: "Seams Checkout product",
      });
    }
    const metadata = await enumeratePublishedResources({
      client: client.value.client,
      organisationId: input.organisationId,
      merchantId: client.value.merchantId,
    });
    if (!metadata.ok) return unavailableCommerceTargets();
    for (const list of metadata.value.lists) {
      const pages = await readPublishedListPages(
        client.value.client,
        client.value.merchantId,
        list,
      );
      if (!pages.ok) return pages;
      for (const page of pages.value) {
        await appendPublishedListEntryTargets(
          targets,
          page,
          list,
          input.organisationId,
          client.value.integrationAccountId,
        );
      }
    }
    return { ok: true, value: targets };
  } catch {
    return unavailableCommerceTargets();
  }
}

export async function resolvePublishedCommerceTarget(
  input: Readonly<{
    env: Env;
    organisationId: OrganisationId;
    targetRef: AccessTargetRef;
  }>,
): Promise<
  Result<PublishedCommerceTarget, "unavailable" | "not_found">
> {
  const targets = await listPublishedCommerceTargets(input);
  if (!targets.ok) return targets;
  const match = targets.value.find(
    (candidate) =>
      candidate.targetRef.targetRefId === input.targetRef.targetRefId &&
      candidate.targetRef.revision === input.targetRef.revision,
  );
  return match === undefined
    ? { ok: false, error: "not_found" }
    : { ok: true, value: match };
}

async function publishedCommerceClient(
  input: Readonly<{
    env: Env;
    organisationId: OrganisationId;
  }>,
): Promise<
  Result<
    Readonly<{
      client: CommerceEntityPlaneClient;
      adminClient: CommerceAdminClient;
      integrationAccountId: IntegrationAccountId;
      merchantId: string;
    }>,
    PublishedCommerceTargetError
  >
> {
  const execution = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!execution.ok) return unavailableCommerceTargets();
  const environment = await readOrganisationEnvironment(
    execution.value.database,
    input.organisationId,
  );
  if (
    environment === null ||
    input.env.COMMERCE_BASE_URL === undefined ||
    input.env.COMMERCE_SERVICE_TOKEN === undefined
  ) {
    return unavailableCommerceTargets();
  }
  const authority = await resolveOrganisationCommerceSystemAuthority({
    db: execution.value.database,
    organisationId: input.organisationId,
  });
  if (!authority.ok || authority.value.provider !== "commerce")
    return unavailableCommerceTargets();
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: execution.value.database,
    organisationId: input.organisationId,
    environment,
  });
  if (
    !binding.ok ||
    binding.value.integrationAccountId !== authority.value.integrationAccountId
  ) {
    return unavailableCommerceTargets();
  }
  const client = createPublishedResourceClient({
    baseUrl: input.env.COMMERCE_BASE_URL,
    ...pantryCommerceAccess(
      input.env.COMMERCE_SERVICE_TOKEN,
      String(input.organisationId),
      input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
    ),
  });
  let adminClient: CommerceAdminClient;
  try {
    adminClient = new CommerceAdminClient({
      baseUrl: input.env.COMMERCE_BASE_URL,
      ...pantryCommerceAccess(
        input.env.COMMERCE_SERVICE_TOKEN,
        String(input.organisationId),
        input.env.COMMERCE.fetch.bind(input.env.COMMERCE),
      ),
    });
  } catch {
    return unavailableCommerceTargets();
  }
  return client === null
    ? unavailableCommerceTargets()
    : {
        ok: true,
        value: {
          client,
          adminClient,
          integrationAccountId: binding.value.integrationAccountId,
          merchantId: binding.value.merchantId,
        },
      };
}

async function readPublishedListPages(
  client: CommerceEntityPlaneClient,
  merchantId: string,
  list: CommerceList,
): Promise<Result<readonly CommerceListPage[], PublishedCommerceTargetError>> {
  const pages: CommerceListPage[] = [];
  let cursor: CommerceCursor | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const query = parseCommerceGraphQuery({
      kind: "commerce_list_page",
      listId: list.listId,
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 500, cursor },
    });
    const response = await client.query(merchantId, query);
    if (!response.ok) return unavailableCommerceTargets();
    pages.push({
      entities: response.value.entities,
      listEntries: response.value.listEntries,
    });
    if (response.value.nextCursor === null) return { ok: true, value: pages };
    cursor = response.value.nextCursor;
  }
  return unavailableCommerceTargets();
}

type CommerceListPage = Readonly<
  Pick<CommerceGraphQueryResult, "entities" | "listEntries">
>;

async function appendPublishedListEntryTargets(
  targets: PublishedCommerceTarget[],
  page: CommerceListPage,
  list: CommerceList,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<void> {
  for (const entry of page.listEntries) {
    if (
      String(entry.listId) !== String(list.listId) ||
      Number(entry.listRevision) !== Number(list.publishedRevision)
    )
      continue;
    const target = commerceListEntryPatchTarget(entry);
    const providerTarget = commerceActionProposeTarget(
      entry,
      integrationAccountId,
    );
    targets.push({
      kind: "list_entry",
      target,
      providerTarget,
      targetRef: {
        targetRefId: await opaqueAccessTargetReference(organisationId, target),
        revision: Number(entry.revision),
      },
      label: targetLabel(list, page.entities, entry),
      detail: "Published commerce list entry",
    });
  }
}

function commerceListEntryPatchTarget(
  entry: CommerceListEntry,
): CommerceCommandTarget {
  const entryRef = {
    entryId: entry.entryId,
    listId: entry.listId,
    revision: entry.revision,
  };
  return {
    kind: "commerce_command",
    capabilityId: CAPABILITY_KEYS.commerceListEntryPatch,
    capabilityVersion: 1,
    scope: { kind: "commerce_list_entry", entry: entryRef },
    target: {
      kind: "commerce_list_entry",
      entry: entryRef,
      revision: entry.revision,
    },
  };
}

function commerceActionProposeTarget(
  entry: CommerceListEntry,
  integrationAccountId: IntegrationAccountId,
): CommerceProviderTarget {
  return {
    kind: "provider_resource",
    capabilityId: CAPABILITY_KEYS.commerceActionPropose,
    capabilityVersion: 1,
    integrationAccountId,
    resourceScope: `commerce:list_entry:${String(entry.listId)}:${String(entry.entryId)}:${Number(entry.revision)}`,
  };
}

function commerceProductActionProposeTarget(
  productId: string,
  integrationAccountId: IntegrationAccountId,
): CommerceProviderTarget {
  return {
    kind: "provider_resource",
    capabilityId: CAPABILITY_KEYS.commerceActionPropose,
    capabilityVersion: 1,
    integrationAccountId,
    resourceScope: `commerce:update_product_description:${productId}`,
  };
}

function entryLabel(
  entities: readonly CommerceEntity[],
  entry: CommerceListEntry,
): string {
  const entity = entities.find((candidate) =>
    sameEntityReference(candidate, entry),
  );
  return entity?.displayName ?? "List entry";
}

function targetLabel(
  list: CommerceList,
  entities: readonly CommerceEntity[],
  entry: CommerceListEntry,
): string {
  const label = `${String(list.name)} · ${entryLabel(entities, entry)}`.trim();
  return label.length <= 200 ? label : `${label.slice(0, 199)}…`;
}

function sameEntityReference(
  entity: CommerceEntity,
  entry: CommerceListEntry,
): boolean {
  return (
    entity.reference.origin === entry.entityRef.origin &&
    entity.reference.typeId === entry.entityRef.typeId &&
    entity.reference.entityId === entry.entityRef.entityId
  );
}

function unavailableCommerceTargets(): { ok: false; error: "unavailable" } {
  return { ok: false, error: "unavailable" };
}

export async function enumeratePublishedResources(
  input: Readonly<{
    readonly client: PublishedResourceClient;
    readonly organisationId: string;
    readonly merchantId: string;
  }>,
): Promise<
  Result<PublishedResourceEnumeration, PublishedResourceBoundaryError>
> {
  let response: Awaited<
    ReturnType<CommerceEntityPlaneClient["publishedResourceMetadata"]>
  >;
  try {
    response = await input.client.publishedResourceMetadata({
      kind: "enumerate",
      organisationId: input.organisationId,
      merchantId: input.merchantId,
    });
  } catch {
    return unavailable();
  }
  if (!response.ok)
    return clientError(
      response.error.kind === "http" ? response.error.status : null,
    );
  if (response.value.organisationId !== input.organisationId) return organisationMismatch();
  if (response.value.merchantId !== input.merchantId) return merchantMismatch();
  return response.value.kind === "enumerated"
    ? { ok: true, value: response.value }
    : unavailable();
}

export async function resolvePublishedResponsibilityScope(
  input: Readonly<{
    readonly client: PublishedResourceClient;
    readonly organisationId: string;
    readonly merchantId: string;
    readonly scope: AgentResponsibilityScope;
  }>,
): Promise<
  Result<PublishedResourceResolution, PublishedResourceBoundaryError>
> {
  const request = resolveRequest(input);
  if (request === null) return invalidReference();

  let response: Awaited<
    ReturnType<CommerceEntityPlaneClient["publishedResourceMetadata"]>
  >;
  try {
    response = await input.client.publishedResourceMetadata(request);
  } catch {
    return unavailable();
  }
  if (!response.ok)
    return clientError(
      response.error.kind === "http" ? response.error.status : null,
    );
  if (response.value.organisationId !== input.organisationId) return organisationMismatch();
  if (response.value.merchantId !== input.merchantId) return merchantMismatch();
  if (response.value.kind !== "resolved") return unavailable();
  if (publishedResourceEvidenceMatchesScope(input.scope, response.value)) {
    return { ok: true, value: response.value };
  }
  const conflict = listEntryRevisionConflict(input.scope, response.value);
  return conflict === null ? notPublished() : { ok: false, error: conflict };
}

function listEntryRevisionConflict(
  scope: AgentResponsibilityScope,
  response: PublishedResourceResolution,
): VariantBy<
  PublishedResourceBoundaryError,
  "code",
  "revision_conflict"
> | null {
  if (
    scope.kind !== "commerce_list_entry" ||
    response.resource.kind !== "commerce_list_entry" ||
    scope.entry.entryId !== response.resource.entry.entryId ||
    scope.entry.listId !== response.resource.entry.listId ||
    scope.entry.revision === response.resource.entry.revision
  ) {
    return null;
  }
  return {
    code: "revision_conflict",
    expected: Number(response.resource.entry.revision),
    actual: Number(scope.entry.revision),
  };
}

function resolveRequest(
  input: Readonly<{
    readonly organisationId: string;
    readonly merchantId: string;
    readonly scope: AgentResponsibilityScope;
  }>,
): Variant<
  Parameters<CommerceEntityPlaneClient["publishedResourceMetadata"]>[0],
  "resolve"
> | null {
  try {
    const parsed = parseEntityPlanePublishedResourceMetadataRequest({
      kind: "resolve",
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      resource: scopeReference(input.scope),
    });
    return parsed.kind === "resolve" ? parsed : null;
  } catch {
    return null;
  }
}

function scopeReference(
  scope: AgentResponsibilityScope,
): Readonly<Record<string, unknown>> {
  switch (scope.kind) {
    case "entity_type":
      return { kind: scope.kind, entityTypeId: scope.entityTypeId };
    case "relationship":
      return { kind: scope.kind, relationship: scope.relationship };
    case "commerce_list":
      return { kind: scope.kind, listId: scope.listId };
    case "commerce_list_entry":
      return { kind: scope.kind, entry: scope.entry };
    case "saved_selector":
      return { kind: scope.kind, selector: scope.selector };
    default:
      return assertNever(scope, "Unknown published resource branch");
  }
}

export function publishedResourceEvidenceMatchesScope(
  scope: AgentResponsibilityScope,
  response: PublishedResourceResolution,
): boolean {
  switch (scope.kind) {
    case "entity_type":
      return (
        response.resource.kind === "entity_type" &&
        scope.entityTypeId.origin === response.resource.entityType.origin &&
        scope.entityTypeId.typeId === response.resource.entityType.typeId
      );
    case "relationship":
      return (
        response.resource.kind === "relationship" &&
        sameCommerceRelationshipRef(
          scope.relationship,
          relationshipReference(response.resource.relationship),
        )
      );
    case "commerce_list":
      return (
        response.resource.kind === "commerce_list" &&
        String(response.resource.list.listId) === scope.listId
      );
    case "commerce_list_entry":
      return (
        response.resource.kind === "commerce_list_entry" &&
        scope.entry.entryId === response.resource.entry.entryId &&
        scope.entry.listId === response.resource.entry.listId &&
        Number(scope.entry.revision) ===
          Number(response.resource.entry.revision)
      );
    case "saved_selector":
      return (
        response.resource.kind === "saved_selector" &&
        scope.selector.selectorId === response.resource.selector.selectorId &&
        scope.selector.revision ===
          Number(response.resource.selector.revision) &&
        JSON.stringify(scope.selector.query) ===
          JSON.stringify(response.resource.selector.query) &&
        response.resource.selector.query.kind === "saved_commerce_view" &&
        String(response.resource.selector.query.viewId) ===
          scope.selector.selectorId &&
        String(response.resource.view.viewId) === scope.selector.selectorId &&
        Number(response.resource.view.revision) === scope.selector.revision
      );
    default:
      return assertNever(scope, "Unknown published resource branch");
  }
}

function relationshipReference(
  relationship: Variant<
    PublishedResourceResolution["resource"],
    "relationship"
  >["relationship"],
): CommerceRelationshipRef {
  if (relationship.origin === "system") {
    return {
      origin: relationship.origin,
      relationshipId: relationship.relationshipId,
      definition: relationship.definition,
      revision: relationship.revision,
    };
  }
  return {
    origin: relationship.origin,
    relationshipId: relationship.relationshipId,
    definition: relationship.definition,
    revision: relationship.revision,
  };
}

function clientError(status: number | null): {
  ok: false;
  error: PublishedResourceBoundaryError;
} {
  if (status === 403) return organisationMismatch();
  if (status === 404) return notPublished();
  return unavailable();
}

function invalidReference(): {
  ok: false;
  error: PublishedResourceBoundaryError;
} {
  return { ok: false, error: { code: "invalid_reference" } };
}

function notPublished(): { ok: false; error: PublishedResourceBoundaryError } {
  return { ok: false, error: { code: "not_published" } };
}

function organisationMismatch(): {
  ok: false;
  error: PublishedResourceBoundaryError;
} {
  return { ok: false, error: { code: "organisation_mismatch" } };
}

function merchantMismatch(): {
  ok: false;
  error: PublishedResourceBoundaryError;
} {
  return { ok: false, error: { code: "merchant_mismatch" } };
}

function unavailable(): { ok: false; error: PublishedResourceBoundaryError } {
  return { ok: false, error: { code: "unavailable" } };
}
