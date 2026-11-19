import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  CommerceEntityPlaneClient,
  parseCommerceGraphQuery,
  parseCommerceEntityPlaneCommand,
  parseEntityPlaneCommand,
  parseCommerceGraphQueryPlanRequest,
  parseEntityPlaneRelationshipTraversalStepRequest,
} from "@purin-labs/commerce-client";
import {
  BASE_URL,
  SERVICE_TOKEN,
  Buyer,
  StaffDesk,
  catalogLine,
  merchantId,
  organisationId,
  startBackend,
} from "./journey-support.ts";

it(
  "creates, replaces and deletes an authorized relationship without duplicate replay effects",
  { timeout: 60000 },
  lifecycleJourney,
);
async function lifecycleJourney(): Promise<void> {
  const backend = await startBackend();
  try {
    await new StaffDesk(backend.admin, "relationship_lifecycle").createTea();
    const orders: string[] = [];
    for (let index = 0; index < 2; index++) {
      const buyer = await Buyer.start(backend.buyer, `linked_orders_${index}`);
      orders.push(
        await buyer.buyLines([catalogLine("variant_tea_small_sencha")]),
      );
    }
    const originalOrderId = orders[0];
    const nextId = orders[1];
    if (
      originalOrderId === undefined ||
      originalOrderId === undefined ||
      nextId === undefined
    )
      throw new Error("Missing orders");
    const client = new CommerceEntityPlaneClient({
      baseUrl: BASE_URL,
      serviceToken: SERVICE_TOKEN,
      fetch: backend.fetch,
    });
    await apply(client, originalOrderId, "type_create", {
      kind: "create_custom_entity_type",
      command: {
        draft: {
          typeId: "partner",
          label: "Partner",
          description: "Order partner",
          revision: 1,
          attributes: [],
        },
      },
    });
    await apply(client, originalOrderId, "type_publish", {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: "partner", revision: 1 } },
    });
    await apply(client, originalOrderId, "partner_create", {
      kind: "create_custom_entity",
      command: {
        entityId: "partner_1",
        typeId: "partner",
        typeRevision: 1,
        displayName: "Partner",
        sensitivity: "internal",
        attributes: [],
      },
    });
    const definition = {
      origin: "custom",
      definitionId: "related_orders",
      sourceType: { origin: "custom", typeId: "partner" },
      targetType: { origin: "system", typeId: "order" },
      sourceLabel: "Related order",
      inverseLabel: "Original order",
      cardinality: "many_to_one",
      deletionBehavior: "detach",
      sensitivity: "internal",
      revision: 1,
    };
    await apply(client, originalOrderId, "definition_create", {
      kind: "create_custom_relationship_definition",
      command: { draft: definition },
    });
    const stalePublication = await client.command(
      await request(client, originalOrderId, "definition_publish_stale", {
        kind: "publish_custom_relationship_definition",
        command: { target: { definitionId: "related_orders", revision: 2 } },
      }),
    );
    expect(stalePublication.ok).toBe(true);
    if (!stalePublication.ok) throw new Error(stalePublication.error.message);
    expect(stalePublication.value.status).toBe("rejected");
    const publishRequest = await request(
      client,
      originalOrderId,
      "definition_publish",
      {
        kind: "publish_custom_relationship_definition",
        command: { target: { definitionId: "related_orders", revision: 1 } },
      },
    );
    const published = await client.command(publishRequest);
    expect(published.ok).toBe(true);
    if (!published.ok || published.value.status !== "accepted")
      throw new Error("Definition publication failed");
    expect(await client.command(publishRequest)).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: published.value.receipt.merchantRevision,
          target: published.value.receipt.target,
        },
      },
    });
    const definitionRef = {
      origin: "custom",
      definitionId: "related_orders",
      revision: 1,
    };
    const target = {
      relationshipId: "related_orders_link",
      definition: definitionRef,
      source: { origin: "custom", typeId: "partner", entityId: "partner_1" },
      target: { origin: "system", typeId: "order", entityId: originalOrderId },
    };
    const createRequest = await request(
      client,
      originalOrderId,
      "link_create",
      {
        kind: "create_custom_relationship",
        command: { target },
      },
    );
    const created = await client.command(createRequest);
    expect(created.ok).toBe(true);
    if (!created.ok || created.value.status !== "accepted")
      throw new Error(JSON.stringify(created, bigintToNumber));
    expect(await client.command(createRequest)).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: created.value.receipt.merchantRevision,
          target: created.value.receipt.target,
          deliveryId: created.value.receipt.deliveryId,
        },
      },
    });
    const first = await links(client);
    expect(first).toHaveLength(1);
    expect(first[0]?.target.entityId).toBe(originalOrderId);
    const plannedTraversal = await checkPlannedTraversal(
      client,
      originalOrderId,
    );
    const reference = {
      origin: "custom",
      relationshipId: "related_orders_link",
      definition: definitionRef,
      revision: 1,
    };
    const replacement = await apply(client, originalOrderId, "link_replace", {
      kind: "replace_custom_relationship",
      command: {
        target: {
          relationship: reference,
          replacementTarget: {
            origin: "system",
            typeId: "order",
            entityId: nextId,
          },
        },
      },
    });
    const replaced = await links(client);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.target.entityId).toBe(nextId);
    expect(replaced[0]?.revision).toBe(2);
    const stale = await client.command(
      await request(client, originalOrderId, "stale_delete", {
        kind: "delete_custom_relationship",
        command: { target: { relationship: reference } },
      }),
    );
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error(stale.error.message);
    expect(stale.value.status).toBe("rejected");
    expect(await links(client)).toEqual(replaced);
    const deleteRequest = await request(
      client,
      originalOrderId,
      "link_delete",
      {
        kind: "delete_custom_relationship",
        command: { target: { relationship: { ...reference, revision: 2 } } },
      },
    );
    const removed = await client.command(deleteRequest);
    expect(removed.ok).toBe(true);
    if (!removed.ok || removed.value.status !== "accepted")
      throw new Error("Relationship deletion failed");
    expect(await client.command(deleteRequest)).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: removed.value.receipt.merchantRevision,
          target: removed.value.receipt.target,
          deliveryId: removed.value.receipt.deliveryId,
        },
      },
    });
    expect(await links(client)).toEqual([]);
    const partnerRef = {
      origin: "custom",
      typeId: "partner",
      entityId: "partner_1",
    };
    await apply(client, originalOrderId, "partner_patch", {
      kind: "patch_custom_entity",
      command: {
        entityRef: partnerRef,
        typeRevision: 1,
        expectedRevision: 1,
        attributes: [],
        displayName: "Updated partner",
      },
    });
    const partnerQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: partnerRef,
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    const patched = await client.query(merchantId, partnerQuery);
    expect(patched.ok).toBe(true);
    if (!patched.ok) throw new Error(patched.error.message);
    expect(patched.value.entities[0]?.displayName).toBe("Updated partner");
    const stalePatch = await client.command(
      await request(client, originalOrderId, "partner_stale_patch", {
        kind: "patch_custom_entity",
        command: {
          entityRef: partnerRef,
          typeRevision: 1,
          expectedRevision: 1,
          attributes: [],
          displayName: "Stale name",
        },
      }),
    );
    expect(stalePatch.ok).toBe(true);
    if (!stalePatch.ok) throw new Error(stalePatch.error.message);
    expect(stalePatch.value.status).toBe("rejected");
    expect(await client.query(merchantId, partnerQuery)).toEqual(patched);
    const archiveRequest = await request(
      client,
      originalOrderId,
      "partner_archive",
      {
        kind: "archive_custom_entity",
        command: {
          entityRef: partnerRef,
          expectedRevision: 2,
          archivedAt: "2026-10-24T00:00:00Z",
        },
      },
    );
    const archived = await client.command(archiveRequest);
    expect(archived.ok).toBe(true);
    if (!archived.ok || archived.value.status !== "accepted")
      throw new Error("Archive failed");
    expect(await client.command(archiveRequest)).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: archived.value.receipt.merchantRevision,
        },
      },
    });
    const afterArchive = await client.query(merchantId, partnerQuery);
    expect(afterArchive.ok).toBe(true);
    if (!afterArchive.ok) throw new Error(afterArchive.error.message);
    expect(afterArchive.value.entities).toEqual([]);
    const directory = new URL("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new URL("relationship-lifecycle-http.json", directory),
      JSON.stringify(
        {
          status: "passed",
          orders,
          created: created.value,
          replacement,
          removed: removed.value,
          definitionRevisionRefused: true,
          definitionPublicationReplayPreserved: true,
          replayPreserved: true,
          staleDeleteRefused: true,
          deletedLinkAbsent: true,
          staleEntityPatchRefused: true,
          archiveReplayPreserved: true,
          archivedEntityAbsent: true,
          plannedTraversal,
        },
        bigintToNumber,
        2,
      ) + "\n",
    );
  } finally {
    backend.close();
  }
}
function bigintToNumber(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
async function request(
  client: CommerceEntityPlaneClient,
  originalOrderId: string,
  commandId: string,
  command: unknown,
) {
  const metadata = await client.capabilityMetadata({
    organisationId,
    merchantId,
    query: parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "system",
        typeId: "order",
        entityId: originalOrderId,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
  });
  if (!metadata.ok) throw new Error(metadata.error.message);
  const parsed = parseCommerceEntityPlaneCommand(command);
  const context = {
    organisationId,
    merchantId,
    principalId: "relationship_operator",
    sensitivityCeiling: "restricted",
    expiresAt: "2030-01-01T00:00:00Z",
    causation: { kind: "command", commandId },
  };
  let authority: unknown;
  switch (parsed.kind) {
    case "create_custom_entity_type":
      authority = {
        kind: "custom_entity_type_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: {
            origin: "custom",
            typeId: parsed.command.draft.typeId,
          },
        },
        target: { typeId: parsed.command.draft.typeId },
      };
      break;
    case "publish_custom_entity_type":
      authority = {
        kind: "custom_entity_type_publish",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: {
            origin: "custom",
            typeId: parsed.command.target.typeId,
          },
        },
        target: parsed.command.target,
      };
      break;
    case "create_custom_entity":
      authority = {
        kind: "entity_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: parsed.command.typeId },
        },
        target: {
          entityId: parsed.command.entityId,
          typeId: parsed.command.typeId,
        },
      };
      break;

    case "patch_custom_entity":
    case "archive_custom_entity":
      authority = {
        kind: "entity_command",
        context,
        scope: { kind: "entity", entityRef: parsed.command.entityRef },
        target: {
          entityRef: parsed.command.entityRef,
          expectedRevision: parsed.command.expectedRevision,
        },
      };
      break;
    case "create_custom_relationship_definition":
      authority = {
        kind: "custom_relationship_definition_create",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: {
            origin: "custom",
            definitionId: parsed.command.draft.definitionId,
            revision: parsed.command.draft.revision,
          },
        },
        target: { definitionId: parsed.command.draft.definitionId },
      };
      break;
    case "publish_custom_relationship_definition":
      authority = {
        kind: "custom_relationship_definition_publish",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: {
            origin: "custom",
            definitionId: parsed.command.target.definitionId,
            revision: parsed.command.target.revision,
          },
        },
        target: parsed.command.target,
      };
      break;
    case "create_custom_relationship":
      authority = {
        kind: "relationship_create",
        context,
        scope: {
          kind: "relationship_definition",
          relationshipDefinition: parsed.command.target.definition,
        },
        target: parsed.command.target,
      };
      break;
    case "replace_custom_relationship":
      authority = {
        kind: "relationship_replacement",
        context,
        scope: {
          kind: "relationship",
          relationship: parsed.command.target.relationship,
        },
        target: parsed.command.target,
      };
      break;
    case "delete_custom_relationship":
      authority = {
        kind: "relationship_command",
        context,
        scope: {
          kind: "relationship",
          relationship: parsed.command.target.relationship,
        },
        target: parsed.command.target,
      };
      break;
    default:
      throw new Error("Unexpected relationship journey command");
  }
  return parseEntityPlaneCommand({
    organisationId,
    merchantId,
    commandId,
    expectedMerchantRevision: metadata.value.merchantRevision,
    authority,
    command: parsed,
  });
}
async function apply(
  client: CommerceEntityPlaneClient,
  originalOrderId: string,
  commandId: string,
  command: unknown,
) {
  const result = await client.command(
    await request(client, originalOrderId, commandId, command),
  );
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.status).toBe("accepted");
  return result.value;
}
async function links(client: CommerceEntityPlaneClient) {
  const result = await client.query({
    merchantId,
    query: parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [{ origin: "custom", typeId: "partner", entityId: "partner_1" }],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "related_orders",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 10 },
      filter: null,
    }),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.relationships;
}
async function checkPlannedTraversal(
  client: CommerceEntityPlaneClient,
  originalOrderId: string,
) {
  const query = parseCommerceGraphQuery({
    kind: "relationship_traversal",
    seeds: [{ origin: "custom", typeId: "partner", entityId: "partner_1" }],
    relationshipDefinition: {
      origin: "custom",
      definitionId: "related_orders",
      revision: 1,
    },
    traversal: { maxDepth: 1, resultLimit: 10 },
    filter: null,
  });
  const metadata = await client.capabilityMetadata({
    organisationId,
    merchantId,
    query,
  });
  if (!metadata.ok) throw new Error(metadata.error.message);
  const planRequest = parseCommerceGraphQueryPlanRequest({
    organisationId,
    merchantId,
    query,
    semantics: {
      semanticsVersion: "v1",
      orderingVersion: "v1",
      textNormalization: "commerce_unicode_v1",
      nullPlacement: "last",
    },
    projection: metadata.value.projection,
    watermark: metadata.value.watermark,
    capabilities: metadata.value.capabilities,
  });
  const planned = await client.queryPlan(planRequest);
  if (!planned.ok) throw new Error(planned.error.message);
  if (planned.value.kind !== "planned")
    throw new Error("Traversal was not planned");
  const request = parseEntityPlaneRelationshipTraversalStepRequest({
    organisationId,
    merchantId,
    planRequest,
    plan: planned.value.plan,
    frontier: [{ origin: "custom", typeId: "partner", entityId: "partner_1" }],
    remaining: 10,
  });
  const result = await client.readRelationshipTraversalStep(request);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.kind !== "planned")
    throw new Error("Traversal step was refused");
  expect(result.value.hasMore).toBe(false);
  expect(result.value.result.relationships).toHaveLength(1);
  expect(result.value.result.relationships[0]?.target.entityId).toBe(
    originalOrderId,
  );
  expect(await client.readRelationshipTraversalStep(request)).toEqual(result);
  expect(result.value.merchantRevision).toBe(planned.value.merchantRevision);
  return { response: result.value, replayPreserved: true };
}
