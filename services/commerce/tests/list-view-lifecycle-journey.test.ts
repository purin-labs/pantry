import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { URL as NodeUrl } from "node:url";
import {
  CommerceEntityPlaneClient,
  parseCommerceEntityPlaneCommand,
  parseCommerceGraphQuery,
  parseEntityPlaneCommand,
  parseEntityPlaneCommandResult,
  parseCommerceDelivery,
  commerceDeliverySignaturePayload,
  parseCommerceSnapshotRevision,
  parseEntityPlanePublishedResourceMetadataRequest,
  parseEntityPlaneSystemExtensionRequest,
  parseListEntryReadRequest,
} from "@seams/commerce-client";
import { parseCommerceEntityPlaneObservation } from "@seams/commerce-contracts/entity-plane-observations";
import type { CommerceDatabase } from "../src/database.ts";
import {
  BASE_URL,
  SERVICE_TOKEN,
  merchantId,
  organisationId,
  startBackend,
  JourneySigner,
  NOW,
  LOCATION,
} from "./journey-support.ts";

it(
  "preserves list edits, view revisions and replay through the HTTP boundary",
  { timeout: 60000 },
  listViewJourney,
);
async function listViewJourney(): Promise<void> {
  const backend = await startBackend();
  try {
    const client = new CommerceEntityPlaneClient({
      baseUrl: BASE_URL,
      serviceToken: SERVICE_TOKEN,
      fetch: backend.fetch,
    });
    await apply(client, "partner_type", {
      kind: "create_custom_entity_type",
      command: {
        draft: {
          typeId: "journey_partner",
          revision: 1,
          label: "Partner",
          description: "Partners used for list work",
          attributes: listAttributes().map(attributeDefinition),
        },
      },
    });
    await apply(client, "partner_type_publish", {
      kind: "publish_custom_entity_type",
      command: { target: { typeId: "journey_partner", revision: 1 } },
    });
    for (const id of ["partner_1", "partner_2"])
      await apply(client, `create_${id}`, {
        kind: "create_custom_entity",
        command: {
          entityId: id,
          typeId: "journey_partner",
          typeRevision: 1,
          displayName: id,
          sensitivity: "internal",
          attributes: values("pending", 3),
        },
      });
    await apply(client, "create_work_list", listCommand(1));
    const original = await apply(
      client,
      "add_first_entry",
      entryCommand("entry_1", "partner_1"),
    );
    await apply(
      client,
      "add_second_entry",
      entryCommand("entry_2", "partner_2"),
    );
    const first = await page(client, 1, null);
    expect(first.listEntries).toHaveLength(1);
    if (first.nextCursor === null) throw new Error("Missing list cursor");
    const second = await page(client, 1, first.nextCursor);
    expect(second.listEntries).toHaveLength(1);
    expect(second.listEntries[0]?.entryId).not.toBe(
      first.listEntries[0]?.entryId,
    );
    const lastByName = await pageByName(client, null);
    expect(lastByName.listEntries.map(entryId)).toEqual(["entry_2"]);
    if (lastByName.nextCursor === null)
      throw new Error("Missing name-sorted list cursor");
    const firstByName = await pageByName(client, lastByName.nextCursor);
    expect(firstByName.listEntries.map(entryId)).toEqual(["entry_1"]);
    const published = await apply(client, "publish_board", viewCommand(1));
    const board = await query(client, {
      kind: "saved_commerce_view",
      viewId: "partner_board",
      pagination: { limit: 10, cursor: null },
    });
    expect(board.listEntries).toHaveLength(2);
    const publishedResources = await checkPublishedResources(client);

    const patched = await apply(client, "ready_first_entry", {
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: { entryId: "entry_1", listId: "partner_work", revision: 1 },
          expectedRevision: 1,
        },
        expectedListRevision: 1,
        attributeValues: values("ready", 5),
      },
    });
    const afterPatch = await page(client, 10, null);
    const firstEntry = afterPatch.listEntries.find(isFirstEntry);
    expect(firstEntry?.revision).toBe(2);
    expect(firstEntry?.attributeValues).toContainEqual(
      expect.objectContaining({
        attributeId: "priority",
        value: { kind: "integer", value: 5n },
      }),
    );
    const aggregations = await checkAggregations(client);
    const foundEntry = await client.readListEntry(
      parseListEntryReadRequest({
        merchantId,
        listId: "partner_work",
        entryId: "entry_1",
      }),
    );
    expect(foundEntry).toMatchObject({
      ok: true,
      value: { kind: "found", listRevision: 1, entry: { revision: 2 } },
    });
    const stale = await commandRequest(client, "stale_first_entry", {
      kind: "patch_commerce_list_entry",
      command: {
        target: {
          entry: { entryId: "entry_1", listId: "partner_work", revision: 1 },
          expectedRevision: 1,
        },
        expectedListRevision: 1,
        attributeValues: values("pending", 1),
      },
    });
    const refused = await client.command(stale);
    expect(refused).toMatchObject({
      ok: true,
      value: { status: "rejected", error: { code: "revision_conflict" } },
    });
    expect(await page(client, 10, null)).toEqual(afterPatch);
    const oldPage = await client.query(
      merchantId,
      parseCommerceGraphQuery({
        kind: "commerce_list_page",
        listId: "partner_work",
        filter: { kind: "all" },
        sorts: [],
        pagination: { limit: 1, cursor: first.nextCursor },
      }),
    );
    expect(oldPage.ok).toBe(false);

    const updated = await apply(
      client,
      "publish_pending_board",
      viewCommand(2),
    );
    const pending = await query(client, {
      kind: "saved_commerce_view",
      viewId: "partner_board",
      pagination: { limit: 10, cursor: null },
    });
    expect(pending.listEntries.map(entryId)).toEqual(["entry_2"]);
    const staleSelector = await client.publishedResourceMetadata(
      selectorRequest(1),
    );
    expect(staleSelector).toMatchObject({
      ok: false,
      error: { kind: "http", status: 404 },
    });
    const removed = await apply(client, "remove_second_entry", {
      kind: "remove_commerce_list_entry",
      command: {
        target: {
          entry: { entryId: "entry_2", listId: "partner_work", revision: 1 },
          expectedRevision: 1,
        },
      },
    });
    const beforeReplay = await metadata(client);
    const deliveriesBeforeReplay = storedDeliveries(backend.database);
    const replayed = await client.command(removed.request);
    expect(replayed).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: removed.result.receipt.merchantRevision,
        },
      },
    });
    expect(await metadata(client)).toEqual(beforeReplay);
    expect(storedDeliveries(backend.database)).toEqual(deliveriesBeforeReplay);
    expect(
      (
        await query(client, {
          kind: "saved_commerce_view",
          viewId: "partner_board",
          pagination: { limit: 10, cursor: null },
        })
      ).listEntries,
    ).toHaveLength(0);

    const archived = await apply(client, "archive_board", {
      kind: "archive_saved_commerce_view",
      command: { target: { viewId: "partner_board", expectedRevision: 2 } },
    });
    const archivedMetadata = await metadata(client);
    expect(archivedMetadata.views.some(isPartnerBoard)).toBe(false);
    expect(await client.command(archived.request)).toMatchObject({
      ok: true,
      value: {
        status: "accepted",
        receipt: {
          outcome: "already_applied",
          merchantRevision: archived.result.receipt.merchantRevision,
        },
      },
    });
    expect(await metadata(client)).toEqual(archivedMetadata);
    const archivedRead = await client.query(
      merchantId,
      parseCommerceGraphQuery({
        kind: "saved_commerce_view",
        viewId: "partner_board",
        pagination: { limit: 10, cursor: null },
      }),
    );
    expect(archivedRead.ok).toBe(false);
    await apply(client, "publish_list_revision_two", listCommand(2));
    const final = await metadata(client);
    expect(final.lists.find(isWorkList)?.publishedRevision).toBe(2);
    const remaining = await page(client, 10, null);
    expect(remaining.listEntries.map(entryId)).toEqual(["entry_1"]);
    expect(remaining.listEntries[0]?.listRevision).toBe(1);
    const missingEntry = await client.readListEntry(
      parseListEntryReadRequest({
        merchantId,
        listId: "partner_work",
        entryId: "entry_2",
      }),
    );
    expect(missingEntry).toEqual({ ok: true, value: { kind: "missing" } });
    const extensions = await checkExtensionPublication(client);
    const changes = await checkChangeFeed(client);
    const signedDeliveries = await checkSignedDeliveries(backend);
    const { deliveryId, ...incompleteReceipt } = original.result.receipt;
    expect(deliveryId).not.toBeNull();
    expect(
      parseEntityPlaneCommandResult.bind(null, {
        status: "accepted",
        receipt: incompleteReceipt,
      }),
    ).toThrow();
    const directory = new NodeUrl("../output/plan-78/", import.meta.url);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      new NodeUrl("list-view-lifecycle-http.json", directory),
      JSON.stringify(
        {
          status: "passed",
          receipts: [
            original.result.receipt,
            published.result.receipt,
            patched.result.receipt,
            updated.result.receipt,
            removed.result.receipt,
            archived.result.receipt,
          ],
          boundaries: {
            distinctPages: true,
            integerDecoded: true,
            stalePatchRefused: true,
            oldCursorRefused: true,
            viewFilterUpdated: true,
            removedEntryAbsent: true,
            removeReplayPreserved: true,
            archiveReplayPreserved: true,
            archivedViewAbsent: true,
            historicalListRevisionPreserved: true,
            replayAddedNoDelivery: true,
            incompleteReceiptRefused: true,
            staleSelectorRefused: true,
          },
          remainingEntries: remaining.listEntries.map(entryId),
          listRevision: final.lists.find(isWorkList)?.publishedRevision,
          signedDeliveries,
          resourceEnvelopes: {
            publishedResources,
            foundEntry,
            missingEntry,
            extensions,
            changes,
            aggregations,
          },
        },
        evidenceInteger,
        2,
      ) + "\n",
    );
  } finally {
    backend.close();
  }
}

function listCommand(revision: number) {
  return {
    kind: "create_commerce_list",
    command: {
      listId: "partner_work",
      entityTypeId: { origin: "custom", typeId: "journey_partner" },
      name: `Partner work ${revision}`,
      publishedRevision: revision,
      membership: "unique_entity",
      entryAttributeDefinitions: listAttributes(),
    },
  };
}
function listAttributes() {
  return [
    definition("stage", {
      kind: "status",
      options: [
        { id: "pending", label: "Pending" },
        { id: "ready", label: "Ready" },
      ],
    }),
    definition("priority", { kind: "integer", minimum: 1, maximum: 5 }),
  ];
}
function attributeDefinition(value: ReturnType<typeof definition>) {
  return value.definition;
}
function definition(id: string, kind: unknown) {
  return {
    attributeId: id,
    definition: {
      id,
      scope: {
        kind: "custom",
        entityTypeId: "journey_partner",
        typeRevision: 1,
      },
      label: id,
      helpText: null,
      required: true,
      sensitivity: "internal",
      kind,
      revision: 1,
    },
  };
}
function values(stage: string, priority: number) {
  const scope = {
    kind: "custom",
    entityTypeId: "journey_partner",
    typeRevision: 1,
  };
  return [
    {
      attributeId: "stage",
      scope,
      definitionRevision: 1,
      sensitivity: "internal",
      value: { kind: "status", value: stage },
    },
    {
      attributeId: "priority",
      scope,
      definitionRevision: 1,
      sensitivity: "internal",
      value: { kind: "integer", value: priority },
    },
  ];
}
function entryCommand(entryId: string, entityId: string) {
  return {
    kind: "add_commerce_list_entry",
    command: {
      entryId,
      listId: "partner_work",
      expectedListRevision: 1,
      entityRef: { origin: "custom", typeId: "journey_partner", entityId },
      attributeValues: values("pending", 3),
      revision: 1,
    },
  };
}
function viewCommand(revision: number) {
  const filter =
    revision === 1
      ? {
          kind: "all",
        }
      : {
          kind: "entity",
          reference: {
            origin: "custom",
            typeId: "journey_partner",
            entityId: "partner_2",
          },
        };
  return {
    kind: "publish_saved_commerce_view",
    command: {
      view: {
        viewId: "partner_board",
        name: "Partner board",
        source: { kind: "commerce_list", listId: "partner_work" },
        filter,
        sorts: [],
        visibleAttributeIds: ["stage", "priority"],
        relationshipColumns: [],
        grouping: { attributeId: "stage", descending: false },
        presentation: {
          kind: "board",
          configuration: {
            laneAttributeId: "stage",
            cardAttributeIds: ["stage", "priority"],
          },
        },
        revision,
      },
    },
  };
}
async function commandRequest(
  client: CommerceEntityPlaneClient,
  commandId: string,
  raw: unknown,
) {
  const command = parseCommerceEntityPlaneCommand(raw);
  const current = await metadata(client);
  const context = {
    organisationId,
    merchantId,
    principalId: "operator",
    sensitivityCeiling: "restricted",
    expiresAt: "2099-01-01T00:00:00Z",
    causation: { kind: "command", commandId },
  };
  let authority;
  switch (command.kind) {
    case "create_system_entity_extension_schema":
      authority = {
        kind: "system_entity_extension_schema_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: {
            origin: "system",
            typeId: command.command.draft.entityTypeId,
          },
        },
        target: { entityTypeId: command.command.draft.entityTypeId },
      };
      break;
    case "publish_system_entity_extension_schema":
      authority = {
        kind: "system_entity_extension_schema_publish",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: {
            origin: "system",
            typeId: command.command.target.entityTypeId,
          },
        },
        target: command.command.target,
      };
      break;
    case "create_custom_entity_type":
      authority = {
        kind: "custom_entity_type_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: {
            origin: "custom",
            typeId: command.command.draft.typeId,
          },
        },
        target: { typeId: command.command.draft.typeId },
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
            typeId: command.command.target.typeId,
          },
        },
        target: command.command.target,
      };
      break;
    case "create_custom_entity":
      authority = {
        kind: "entity_create",
        context,
        scope: {
          kind: "entity_type",
          entityTypeId: { origin: "custom", typeId: command.command.typeId },
        },
        target: {
          entityId: command.command.entityId,
          typeId: command.command.typeId,
        },
      };
      break;
    case "create_commerce_list": {
      const value = command.command;
      authority =
        value.publishedRevision === 1
          ? {
              kind: "commerce_list_create",
              context,
              scope: { kind: "commerce_list", listId: value.listId },
              target: {
                listId: value.listId,
                entityTypeId: value.entityTypeId,
              },
            }
          : {
              kind: "commerce_list_command",
              context,
              scope: { kind: "commerce_list", listId: value.listId },
              target: {
                listId: value.listId,
                expectedRevision: value.publishedRevision,
              },
            };
      break;
    }
    case "add_commerce_list_entry": {
      const value = command.command;
      authority = {
        kind: "commerce_list_entry_create",
        context,
        scope: { kind: "commerce_list", listId: value.listId },
        target: {
          entry: {
            entryId: value.entryId,
            listId: value.listId,
            revision: value.revision,
          },
          listRevision: value.expectedListRevision,
          entityTypeId: { origin: "custom", typeId: "journey_partner" },
          entityRef: value.entityRef,
        },
      };
      break;
    }
    case "patch_commerce_list_entry":
    case "remove_commerce_list_entry":
      authority = {
        kind: "commerce_list_entry_command",
        context,
        scope: {
          kind: "commerce_list_entry",
          entry: command.command.target.entry,
        },
        target: command.command.target,
      };
      break;
    case "publish_saved_commerce_view": {
      const value = command.command.view;
      authority =
        value.revision === 1
          ? {
              kind: "saved_view_create",
              context,
              scope: { kind: "saved_view", viewId: value.viewId },
              target: { viewId: value.viewId },
            }
          : {
              kind: "saved_view_administration",
              context,
              scope: { kind: "saved_view", viewId: value.viewId },
              target: {
                viewId: value.viewId,
                expectedRevision: Number(value.revision) - 1,
              },
            };
      break;
    }
    case "archive_saved_commerce_view":
      authority = {
        kind: "saved_view_administration",
        context,
        scope: { kind: "saved_view", viewId: command.command.target.viewId },
        target: command.command.target,
      };
      break;
    default:
      throw new Error("Unexpected list/view journey command");
  }
  return parseEntityPlaneCommand({
    organisationId,
    merchantId,
    commandId,
    expectedMerchantRevision: current.merchantRevision,
    authority,
    command,
  });
}
async function apply(
  client: CommerceEntityPlaneClient,
  commandId: string,
  command: unknown,
) {
  const request = await commandRequest(client, commandId, command);
  const result = await client.command(request);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.status !== "accepted")
    throw new Error(`${commandId} refused: ${result.value.error.code}`);
  return { request, result: result.value };
}
async function metadata(client: CommerceEntityPlaneClient) {
  const result = await client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId,
    merchantId,
  });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.kind !== "enumerated")
    throw new Error("Expected enumerated metadata");
  return result.value;
}
async function page(
  client: CommerceEntityPlaneClient,
  limit: number,
  cursor: string | null,
) {
  return query(client, {
    kind: "commerce_list_page",
    listId: "partner_work",
    filter: { kind: "all" },
    sorts: [],
    pagination: { limit, cursor },
  });
}
async function pageByName(
  client: CommerceEntityPlaneClient,
  cursor: string | null,
) {
  return query(client, {
    kind: "commerce_list_page",
    listId: "partner_work",
    filter: { kind: "all" },
    sorts: [{ field: { kind: "display_name" }, direction: "descending" }],
    pagination: { limit: 1, cursor },
  });
}
async function query(client: CommerceEntityPlaneClient, input: unknown) {
  const result = await client.query({
    merchantId,
    query: parseCommerceGraphQuery(input),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function isFirstEntry(entry: { entryId: string }): boolean {
  return entry.entryId === "entry_1";
}
function entryId(entry: { entryId: string }): string {
  return entry.entryId;
}
function isPartnerBoard(view: { viewId: string }): boolean {
  return view.viewId === "partner_board";
}
function isWorkList(list: { listId: string }): boolean {
  return list.listId === "partner_work";
}
async function checkPublishedResources(client: CommerceEntityPlaneClient) {
  const resources = [];
  for (const resource of [
    {
      kind: "entity_type",
      entityTypeId: { origin: "custom", typeId: "journey_partner" },
    },
    { kind: "commerce_list", listId: "partner_work" },
    {
      kind: "commerce_list_entry",
      entry: { entryId: "entry_1", listId: "partner_work", revision: 1 },
    },
  ]) {
    const result = await client.publishedResourceMetadata(
      parseEntityPlanePublishedResourceMetadataRequest({
        kind: "resolve",
        organisationId,
        merchantId,
        resource,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    if (result.value.kind !== "resolved")
      throw new Error("Expected a resolved resource");
    expect(result.value.resource.kind).toBe(resource.kind);
    resources.push(result.value.resource);
  }
  const selector = await client.publishedResourceMetadata(selectorRequest(1));
  expect(selector).toMatchObject({
    ok: true,
    value: {
      kind: "resolved",
      resource: { kind: "saved_selector", view: { revision: 1 } },
    },
  });
  if (!selector.ok || selector.value.kind !== "resolved")
    throw new Error("Missing published selector");
  resources.push(selector.value.resource);
  return resources;
}
function selectorRequest(revision: number) {
  return parseEntityPlanePublishedResourceMetadataRequest({
    kind: "resolve",
    organisationId,
    merchantId,
    resource: {
      kind: "saved_selector",
      selector: {
        selectorId: "partner_board",
        revision,
        query: {
          kind: "saved_commerce_view",
          viewId: "partner_board",
          pagination: { limit: 10, cursor: null },
        },
      },
    },
  });
}
async function checkExtensionPublication(client: CommerceEntityPlaneClient) {
  const request = parseEntityPlaneSystemExtensionRequest({
    organisationId,
    merchantId,
    entityRefs: [{ origin: "system", typeId: "location", entityId: LOCATION }],
  });
  const before = await client.readSystemExtensionSidecars(request);
  expect(before).toMatchObject({
    ok: true,
    value: { sidecars: [{ extension: { state: "absent" }, attributes: [] }] },
  });
  await apply(client, "create_location_extension", {
    kind: "create_system_entity_extension_schema",
    command: {
      draft: { entityTypeId: "location", schemaRevision: 1, attributes: [] },
    },
  });
  await apply(client, "publish_location_extension", {
    kind: "publish_system_entity_extension_schema",
    command: { target: { entityTypeId: "location", revision: 1 } },
  });
  const after = await client.readSystemExtensionSidecars(request);
  expect(after).toMatchObject({
    ok: true,
    value: {
      sidecars: [
        { extension: { state: "published", revision: 1 }, attributes: [] },
      ],
    },
  });
  return { before, after };
}
async function checkChangeFeed(client: CommerceEntityPlaneClient) {
  let after = parseCommerceSnapshotRevision(0);
  const ids = new Set<string>();
  const changes = [];
  let pages = 0;
  while (true) {
    const response = await client.changes(merchantId, after, 2);
    if (!response.ok) throw new Error(response.error.message);
    const page = response.value;
    pages += 1;
    for (const change of page.changes) {
      expect(ids.has(change.changeId)).toBe(false);
      expect(Number(change.merchantRevision)).toBeGreaterThan(Number(after));
      ids.add(change.changeId);
      changes.push(change);
    }
    if (!page.hasMore) break;
    expect(Number(page.nextAfterMerchantRevision)).toBeGreaterThan(
      Number(after),
    );
    after = page.nextAfterMerchantRevision;
  }
  expect(pages).toBeGreaterThan(1);
  expect(ids.has(`${merchantId}:ready_first_entry`)).toBe(true);
  expect(ids.has(`${merchantId}:publish_location_extension`)).toBe(true);
  expect(ids.has(`${merchantId}:stale_first_entry`)).toBe(false);
  return { pages, changes };
}
function evidenceInteger(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
async function checkAggregations(client: CommerceEntityPlaneClient) {
  const counts = await query(client, {
    kind: "aggregation",
    source: { kind: "commerce_list", listId: "partner_work" },
    filter: { kind: "all" },
    aggregation: { kind: "count" },
  });
  expect(counts.aggregations).toEqual([{ kind: "count", value: 2n }]);
  const beforeRefusals = await page(client, 10, null);
  const refused = [];
  for (const kind of ["grouped_count", "sum", "minimum", "maximum"] as const) {
    const result = await client.query({
      merchantId,
      query: parseCommerceGraphQuery({
        kind: "aggregation",
        source: { kind: "commerce_list", listId: "partner_work" },
        filter: { kind: "all" },
        aggregation: {
          kind,
          attributeId: kind === "grouped_count" ? "stage" : "priority",
        },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "http",
        message: expect.stringContaining("source_mapping"),
      },
    });
    refused.push({ operation: kind, result });
  }
  expect(await page(client, 10, null)).toEqual(beforeRefusals);
  return {
    counts: counts.aggregations,
    refused,
  };
}
function storedDeliveries(database: CommerceDatabase) {
  return database
    .prepare(
      `SELECT delivery_json AS deliveryJson FROM observation_outbox
       WHERE merchant_id = ? AND delivery_id LIKE 'entity_plane:%'
       ORDER BY merchant_revision, delivery_id`,
    )
    .all<{ deliveryJson: string }>(merchantId);
}
async function checkSignedDeliveries(
  backend: Awaited<ReturnType<typeof startBackend>>,
) {
  const publicKeyB64 = new JourneySigner().publicKeyB64;
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 },
    format: "jwk",
  });
  const evidence = [];
  const rows = storedDeliveries(backend.database);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const raw: unknown = JSON.parse(row.deliveryJson);
    const delivery = parseCommerceDelivery(raw);
    const typescript = {
      ...delivery,
      observations: delivery.observations.map(parseTypeScriptObservation),
    };
    const originalBytes = commerceDeliverySignaturePayload(delivery);
    const typescriptBytes = commerceDeliverySignaturePayload(typescript);
    expect(typescriptBytes).toEqual(originalBytes);
    const signature = Buffer.from(delivery.signer.signature, "base64url");
    expect(verify(null, originalBytes, publicKey, signature)).toBe(true);
    expect(verify(null, typescriptBytes, publicKey, signature)).toBe(true);
    const changedBytes = commerceDeliverySignaturePayload({
      ...typescript,
      merchantRevision: typescript.merchantRevision + 1,
    });
    expect(verify(null, changedBytes, publicKey, signature)).toBe(false);
    evidence.push({
      delivery: typescript,
      observationKinds: delivery.observations.map(observationKind),
      payloadSha256: createHash("sha256").update(typescriptBytes).digest("hex"),
      originalSignatureValid: true,
      typescriptSignatureValid: true,
      changedRevisionRefused: true,
    });
  }
  const firstRow = rows[0];
  if (firstRow === undefined) throw new Error("Missing signed delivery");
  const delivery = parseCommerceDelivery(JSON.parse(firstRow.deliveryJson));
  const observation = delivery.observations[0];
  if (observation === undefined)
    throw new Error("Missing delivery observation");
  expect(
    parseCommerceDelivery.bind(null, {
      ...delivery,
      observations: [{ ...observation, revision: 0 }],
    }),
  ).toThrow();
  const acknowledgement = {
    schemaVersion: "underclerk.acknowledge-commerce-delivery.v2",
    organisationId,
    merchantId,
    deliveryId: delivery.deliveryId,
    acknowledgedAt: NOW,
  } as const;
  expect(
    await backend.admin.acknowledgeDelivery(acknowledgement),
  ).toMatchObject({
    ok: true,
    value: { outcome: "acknowledged", deliveryId: delivery.deliveryId },
  });
  expect(
    await backend.admin.acknowledgeDelivery(acknowledgement),
  ).toMatchObject({
    ok: true,
    value: { outcome: "already_acknowledged", deliveryId: delivery.deliveryId },
  });
  return {
    publicKeyB64,
    deliveries: evidence,
    invalidObservationRefused: true,
    acknowledgementReplayPreserved: true,
  };
}
function parseTypeScriptObservation(input: unknown) {
  const parsed = parseCommerceEntityPlaneObservation(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
function observationKind(observation: { kind: string }): string {
  return observation.kind;
}
