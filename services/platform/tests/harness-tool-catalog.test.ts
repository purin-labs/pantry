import type { HarnessToolOutput } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";
import type { AuthorizedHarnessToolResult } from "@purin-labs/contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceGraphResponse,
} from "@purin-labs/commerce-client";

import { catalogHarnessToolCatalogDigest } from "../src/agent-tools/catalog/selection";
import { createCatalogHarnessCodeMode, harnessCapabilitiesFromCapabilityKeys } from "../src/agent-tools/catalog/code-mode";
import {
  TOOL_REGISTRY,
  type PartialToolServices,
} from "../src/agent-tools/registry";
import { requireIntegrationAccountId } from "./test-ids";

/**
 * The services that each case gives, with the case's own services over them.
 * A fake only records or answers a call: the executor decides each outcome.
 */
function fixtureServices(
  services: PartialToolServices = {},
): PartialToolServices {
  return {
    ...services,
    integrations: { listIntegrations, ...services.integrations },
    commerce: {
      readEntityContext,
      readMerchantReport,
      readProductDescriptionDraft: rejectProductDescriptionDraftRead,
      editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
      ...services.commerce,
    },
    kitchen: {
      readWorkflowCanvas: rejectWorkflowCanvasTool,
      moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
      ...services.kitchen,
    },
    menu: { readMenuDraft: unavailableMenuDraft, ...services.menu },
    channels: {
      readEmailDraft: rejectEmailDraftRead,
      editEmailDraft: rejectEmailDraftEdit,
      ...services.channels,
    },
    files: { queryWorkspace, ...services.files },
  };
}

describe("Harness Code Mode authority", harnessCodeModeSuite);

function harnessCodeModeSuite(): void {
  it(
    "gates Airtable tools by base scopes and returns a write receipt",
    executesAirtableTools,
  );
  it("rejects a checkpoint bound to another catalog", rejectsCatalogMismatch);
  it(
    "lists governed integration metadata through a direct tool",
    executesIntegrationDiscovery,
  );
  it(
    "admits the message tools only under their own capabilities",
    gatesMessageToolsByCapability,
  );
  it(
    "sends one exact reply to a granted active WhatsApp Case and refuses a history scope",
    executesWhatsAppSupportReplySend,
  );
  it(
    "keeps internal direct capability failures out of model-visible output",
    screensDirectFailure,
  );
  it(
    "maps encoded current-message scopes into the governed catalog",
    selectsCurrentMessageCatalog,
  );
  it(
    "wires product description draft tools and preserves edit capability boundaries",
    executesProductDescriptionDraftTools,
  );
  it(
    "exposes only attached BakeryOS commands and returns surface authority",
    executesBakerySurfaceTool,
  );
  it(
    "passes one bounded rehearsal tray edit to the attached surface",
    executesRehearsalEditTool,
  );
  it(
    "passes production draft edits, previews and applies to the attached surface",
    executesProductionTools,
  );
}

async function executesProductionTools(): Promise<void> {
  const selection = {
    allowedCapabilities: [] as const,
    bakerySurfaceCommands: [
      "inspect_surface",
      "edit_production",
      "preview_production",
      "apply_production",
    ] as const,
  };
  const calls: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    services: fixtureServices({
      kitchen: {
        executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);
  expect(created.value.definitions.map(readSurfaceToolName)).toEqual([
    "bakery_surface_inspect",
    "bakery_surface_edit_production",
    "bakery_surface_preview_production",
    "bakery_surface_apply_production",
  ]);
  const manualTask = {
    kind: "set_manual_task",
    bakeryTaskId: "batch:B:process:stage",
    baker: null,
    dependsOn: ["batch:A:native:1"],
    earliestStartSeconds: 120,
  };
  for (const [name, input] of [
    ["bakery_surface_edit_production", { edit: manualTask }],
    ["bakery_surface_preview_production", {}],
    ["bakery_surface_apply_production", {}],
  ] as const)
    expect(
      (
        await created.value.executeTool(
          name,
          JSON.stringify(input),
          `surface_call_${name}`,
        )
      ).kind,
    ).toBe("surface_effect");
  for (const [name, input] of [
    [
      "bakery_surface_edit_production",
      { edit: { kind: "set_baker", batchId: "A", tray: 1, baker: 0 } },
    ],
    [
      "bakery_surface_edit_production",
      { edit: { kind: "set_variant", variant: "closed" } },
    ],
    [
      "bakery_surface_edit_production",
      {
        edit: {
          kind: "set_prerequisites",
          batchId: "A",
          tray: 1,
          dependsOn: ["x", "x"],
        },
      },
    ],
    ["bakery_surface_apply_production", { planFingerprint: "plan" }],
  ] as const)
    expect(
      await created.value.executeTool(
        name,
        JSON.stringify(input),
        "surface_call_invalid",
      ),
    ).toMatchObject({ status: "failed" });
  expect(calls).toEqual([
    {
      request: { kind: "edit_production", edit: manualTask },
      callId: "surface_call_bakery_surface_edit_production",
    },
    {
      request: { kind: "preview_production" },
      callId: "surface_call_bakery_surface_preview_production",
    },
    {
      request: { kind: "apply_production" },
      callId: "surface_call_bakery_surface_apply_production",
    },
  ]);
}

async function executesRehearsalEditTool(): Promise<void> {
  const selection = {
    allowedCapabilities: [] as const,
    bakerySurfaceCommands: ["inspect_surface", "edit_rehearsal"] as const,
  };
  const calls: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    services: fixtureServices({
      kitchen: {
        executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);
  expect(created.value.definitions.map(readSurfaceToolName)).toEqual([
    "bakery_surface_inspect",
    "bakery_surface_edit_rehearsal",
  ]);
  const edited = await created.value.executeTool(
    "bakery_surface_edit_rehearsal",
    JSON.stringify({
      edit: {
        kind: "set_prerequisites",
        batchId: "B",
        dependsOn: ["batch:A:native:1"],
      },
    }),
    "surface_call_edit",
  );
  expect(edited.kind).toBe("surface_effect");
  for (const edit of [
    { kind: "set_baker", batchId: "B", baker: 0 },
    { kind: "remove", batchId: "B" },
    { kind: "set_prerequisites", batchId: "B", dependsOn: ["x", "x"] },
  ])
    expect(
      await created.value.executeTool(
        "bakery_surface_edit_rehearsal",
        JSON.stringify({ edit }),
        "surface_call_invalid",
      ),
    ).toMatchObject({ status: "failed" });
  expect(calls).toEqual([
    {
      request: {
        kind: "edit_rehearsal",
        edit: {
          kind: "set_prerequisites",
          batchId: "B",
          dependsOn: ["batch:A:native:1"],
        },
      },
      callId: "surface_call_edit",
    },
  ]);
}

async function executesBakerySurfaceTool(): Promise<void> {
  const selection = {
    allowedCapabilities: [] as const,
    bakerySurfaceCommands: [
      "inspect_surface",
      "read_draft",
      "query_tasks",
      "prepare_edit",
    ] as const,
  };
  const calls: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    services: fixtureServices({
      kitchen: {
        executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);
  expect(created.value.definitions.map(readSurfaceToolName)).toEqual([
    "bakery_surface_inspect",
    "bakery_surface_read_draft",
    "bakery_surface_query_tasks",
    "bakery_surface_prepare_edit",
  ]);
  const result = await created.value.executeTool(
    "bakery_surface_inspect",
    "{}",
    "surface_call_1",
  );
  expect(result.kind).toBe("surface_effect");
  expect(result.status).toBe("succeeded");
  await created.value.executeTool(
    "bakery_surface_read_draft",
    "{}",
    "surface_call_read",
  );
  await created.value.executeTool(
    "bakery_surface_query_tasks",
    JSON.stringify({ text: "bake", limit: 2 }),
    "surface_call_query",
  );
  const proposed = await created.value.executeTool(
    "bakery_surface_prepare_edit",
    JSON.stringify({
      baseDraft: { revision: 2, digest: "d".repeat(64) },
      edits: [{ kind: "set_assumption", field: "workerCount", value: 2 }],
    }),
    "surface_call_2",
  );
  expect(proposed.kind).toBe("surface_effect");
  expect(calls).toEqual([
    { request: { kind: "inspect_surface" }, callId: "surface_call_1" },
    { request: { kind: "read_draft" }, callId: "surface_call_read" },
    {
      request: { kind: "query_tasks", text: "bake", limit: 2 },
      callId: "surface_call_query",
    },
    {
      request: {
        kind: "prepare_edit",
        baseDraft: { revision: 2, digest: "d".repeat(64) },
        edits: [{ kind: "set_assumption", field: "workerCount", value: 2 }],
      },
      callId: "surface_call_2",
    },
  ]);
}

function readSurfaceToolName(input: { readonly name: string }): string {
  return input.name;
}

function recordBakerySurfaceTool(
  calls: unknown[],
  request: unknown,
  callId: string,
): Promise<{
  readonly receiptId: string;
  readonly receipt: import("@purin-labs/bakery-model/bakery-surface").BakerySurfaceReceiptV1;
  readonly saveVerification: { readonly kind: "none" };
  readonly scenarioSaveResult: { readonly kind: "none" };
}> {
  calls.push({ request, callId });
  return Promise.resolve({
    receiptId: "surface_receipt_fixture",
    saveVerification: { kind: "none" },
    scenarioSaveResult: { kind: "none" },
    receipt: {
      schemaVersion: 1,
      kind: "bakery-surface-receipt",
      effectId: "surface_effect_fixture",
      dispatchId: "surface_dispatch_fixture",
      commandDigest: "a".repeat(64),
      resultDigest: "b".repeat(64),
      outcome: {
        kind: "completed",
        result: {
          kind: "succeeded",
          command: "inspect_surface",
          surface: {
            kind: "bakery-surface-context",
            digest: "c".repeat(64),
            context: {
              schemaVersion: 1,
              kind: "bakery-workspace",
              runOpenReview: null,
              surfaceSessionId: "surface_fixture",
              surfaceEpoch: 1,
              capturedAt: 1,
              comparison: null,
              simulation: null,
              supportedCommands: ["inspect_surface"],
              active: {
                kind: "production",
                view: { camera: "perspective" },
                pendingOperation: null,
                panel: "workflow",
                readiness: "loading",
                planFingerprint: null,
                variant: null,
                operationCount: 0,
                operations: [],
                selection: null,
                playback: null,
                candidate: null,
                scenarioSaveProposal: null,
                draft: null,
              },
            },
          },
          output: { kind: "surface" },
        },
      },
    },
  });
}

async function executesAirtableTools(): Promise<void> {
  const integrationAccountId = requireIntegrationAccountId("ia_airtable");
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    `provider:airtable.api.read:1:${integrationAccountId}:base:appBase12345`,
    `provider:airtable.api.write:1:${integrationAccountId}:base:appBase12345`,
  ]);
  expect(scopes).toEqual({
    ok: true,
    value: ["airtable.api.read", "airtable.api.write"],
  });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices({
      integrations: {
        readAirtable: airtableReadFixture,
        writeAirtable: airtableWriteFixture,
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);
  const read = await created.value.executeTool(
    "airtable_api_read",
    JSON.stringify({
      requestJson: JSON.stringify({
        kind: "request",
        integrationAccountId,
        method: "GET",
        path: "/v0/meta/bases/appBase12345/tables",
        body: null,
      }),
    }),
    "airtable_read",
  );
  expect(authorizedJson(read)).toMatchObject({ success: true });
  const write = await created.value.executeTool(
    "airtable_api_write",
    JSON.stringify({
      requestJson: JSON.stringify({
        kind: "request",
        integrationAccountId,
        method: "POST",
        path: "/v0/meta/bases/appBase12345/tables",
        body: {
          name: "Test",
          fields: [{ name: "Name", type: "singleLineText" }],
        },
      }),
    }),
    "airtable_write",
  );
  expect(write).toMatchObject({
    kind: "provider_effect",
    authority: { receiptId: "airtable_write_test" },
    status: "succeeded",
  });
  expect(claims).toEqual([
    "direct_tool:airtable.api.read",
    "direct_tool:airtable.api.write",
  ]);
}

async function airtableReadFixture(input: unknown): Promise<unknown> {
  expect(input).toMatchObject({
    integrationAccountId: "ia_airtable",
    request: { method: "GET", baseId: "appBase12345" },
  });
  return { records: [] };
}

async function airtableWriteFixture(input: unknown): Promise<unknown> {
  expect(input).toMatchObject({
    integrationAccountId: "ia_airtable",
    request: { method: "POST", baseId: "appBase12345" },
  });
  return { receiptId: "airtable_write_test", record: { id: "recRecord12345" } };
}

async function executesWhatsAppSupportReplySend(): Promise<void> {
  const integrationAccountId = requireIntegrationAccountId("ia_whatsapp");
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    `provider:whatsapp.support.reply.send:1:${integrationAccountId}:active_cases`,
  ]);
  expect(scopes).toEqual({ ok: true, value: ["whatsapp.support.reply.send"] });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection);
  const claims: string[] = [];
  const sends: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices({
      channels: {
        sendWhatsAppSupportReply: recordWhatsAppSupportReplySend.bind(null, sends),
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);

  const directResult = await created.value.executeTool(
    "whatsapp_support_reply_send",
    JSON.stringify({
      caseId: "case_whatsapp_1",
      body: "It is all coming and in progress.",
    }),
    "whatsapp_support_send_direct",
  );
  const direct = authorizedJson(directResult);

  expect(created.value.definitions.map(readToolName)).toEqual([
    "whatsapp_support_reply_send",
  ]);
  expect(sends).toEqual([
    {
      caseId: "case_whatsapp_1",
      body: "It is all coming and in progress.",
    },
  ]);
  expect(directResult).toMatchObject({
    kind: "provider_effect",
    authority: { kind: "provider_effect", receiptId: "wamid.reply_1" },
    status: "succeeded",
  });
  expect(direct).toMatchObject({
    success: true,
    code_mode_value: {
      kind: "sent",
      caseId: "case_whatsapp_1",
      receiptId: "wamid.reply_1",
    },
  });
  expect(claims).toEqual(["direct_tool:whatsapp.support.reply.send"]);

  expect(
    harnessCapabilitiesFromCapabilityKeys([
      `provider:whatsapp.support.read:1:${integrationAccountId}:history`,
    ]),
  ).toEqual({
    ok: false,
    error: {
      code: "embedded_harness_resource_scope_invalid",
      scope: `provider:whatsapp.support.read:1:${integrationAccountId}:history`,
    },
  });
}

function inlineToolOutput(text: string): HarnessToolOutput {
  return {
    kind: "inline",
    content: [{ kind: "text", text }],
    digest: "a".repeat(64),
  } as HarnessToolOutput;
}

async function gatesMessageToolsByCapability(): Promise<void> {
  // Neither tool appears in a catalog that was not granted its capability.
  const withoutMessageTools = {
    allowedCapabilities: ["integration.discovery.read"] as const,
  };
  const withoutDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, withoutMessageTools);
  const absent = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: withoutDigest,
    catalogSelection: withoutMessageTools,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    services: fixtureServices(),
  });
  if (!absent.ok) throw new Error(absent.error.code);

  expect(absent.value.definitions.map(readToolName)).not.toContain(
    "read_message_link",
  );
  expect(absent.value.definitions.map(readToolName)).not.toContain(
    "inspect_message_attachment",
  );

  // Granting the capabilities admits exactly those two tools, and each call
  // claims its own capability rather than borrowing another's.
  const selection = {
    allowedCapabilities: [
      "message.attachment.inspect",
      "message.link.read",
    ] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices({
      messages: {
        inspectMessageAttachment: async function inspect(input) {
          return inlineToolOutput(`inspected:${input.attachmentId}`);
        },
        readMessageLink: async function read(input) {
          return inlineToolOutput(`read:${input.url}`);
        },
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);

  expect(created.value.definitions.map(readToolName).sort()).toEqual([
    "inspect_message_attachment",
    "read_message_link",
  ]);

  await created.value.executeTool(
    "inspect_message_attachment",
    JSON.stringify({ attachmentId: `att_${"a".repeat(32)}` }),
    "inspect_direct",
  );
  await created.value.executeTool(
    "read_message_link",
    JSON.stringify({ url: "https://example.com/spec" }),
    "link_direct",
  );

  expect(claims).toEqual([
    "direct_tool:message.attachment.inspect",
    "direct_tool:message.link.read",
  ]);

  // A non-HTTP scheme is refused at the argument boundary, before the reader
  // runs and before any capability is claimed for it.
  const refused = await created.value.executeTool(
    "read_message_link",
    JSON.stringify({ url: "file:///etc/passwd" }),
    "link_rejected",
  );

  expect(refused.authority.kind).toBe("read");
  expect(JSON.stringify(refused)).not.toContain("/etc/passwd");
  expect(claims).toEqual([
    "direct_tool:message.attachment.inspect",
    "direct_tool:message.link.read",
  ]);
}

async function executesIntegrationDiscovery(): Promise<void> {
  const selection = {
    allowedCapabilities: ["integration.discovery.read"] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices(),
  });
  if (!created.ok) throw new Error(created.error.code);

  const direct = authorizedJson(
    await created.value.executeTool(
      "integration_list",
      "{}",
      "integration_list_direct",
    ),
  );

  expect(created.value.definitions.map(readToolName)).toEqual([
    "integration_list",
  ]);
  expect(direct).toMatchObject({
    success: true,
    code_mode_value: {
      accounts: [{ provider: "stripe", readableDataClasses: [] }],
    },
  });
  expect(claims).toEqual(["direct_tool:integration.discovery.read"]);
}

async function executesProductDescriptionDraftTools(): Promise<void> {
  const selection = {
    allowedCapabilities: [
      "commerce.entity_plane.context",
      "commerce.product_description_draft.edit",
    ] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection);
  const claims: string[] = [];
  const reads: unknown[] = [];
  const edits: Array<{
    readonly request: unknown;
    readonly operationId: string;
  }> = [];
  const snapshot = {
    product: {
      productId: "product_fixture",
      title: "Fixture",
      description: "old",
      revision: 3,
    },
    draft: {
      kind: "active" as const,
      description: "new",
      initializedFromProductRevision: 3,
    },
  };
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices({
      commerce: {
        readProductDescriptionDraft: async (request) => {
          reads.push(request);
          return snapshot;
        },
        editProductDescriptionDraft: async (request, operationId) => {
          edits.push({ request, operationId });
          return snapshot;
        },
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);

  const direct = await created.value.executeTool(
    "product_description_draft_edit",
    JSON.stringify({
      productId: "product_fixture",
      oldText: "old",
      newText: "new",
    }),
    "draft_code:2",
  );

  expect(authorizedJson(direct)).toMatchObject({
    success: true,
    code_mode_value: snapshot,
  });
  expect(edits).toEqual([
    {
      request: { productId: "product_fixture", oldText: "old", newText: "new" },
      operationId: JSON.stringify(["direct_tool", "draft_code:2"]),
    },
  ]);
  expect(claims).toEqual([
    "direct_tool:commerce.product_description_draft.edit",
  ]);

  const readOnlySelection = {
    allowedCapabilities: ["commerce.entity_plane.context"] as const,
  };
  const readOnly = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest:
      await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, readOnlySelection),
    catalogSelection: readOnlySelection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    services: fixtureServices({
      commerce: {
        readProductDescriptionDraft: async () => snapshot,
        editProductDescriptionDraft: async () => snapshot,
      },
    }),
  });
  if (!readOnly.ok) throw new Error(readOnly.error.code);
  const denied = await readOnly.value.executeTool(
    "product_description_draft_edit",
    JSON.stringify({
      productId: "product_fixture",
      oldText: "old",
      newText: "new",
    }),
    "draft_denied",
  );
  expect(denied.status).toBe("failed");
  expect(denied.authority.kind).toBe("read");
}

async function screensDirectFailure(): Promise<void> {
  const expectedCatalogDigest = await catalogHarnessToolCatalogDigest(TOOL_REGISTRY);
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    admission: permissiveAdmission(),
    claimCapability: acceptFixtureCapabilityClaim,
    services: fixtureServices({
      commerce: {
        readEntityContext: rejectInternalEntityContext,
        readMerchantReport: rejectMerchantReport,
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);

  const result: unknown = authorizedJson(
    await created.value.executeTool(
      "commerce_entity_context",
      JSON.stringify({ request: fixtureContextRequest() }),
      "call_internal_failure",
    ),
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "read_failed",
      message:
        "The capability could not complete this request. " +
        "Authoritative data is unavailable; retry once without inferring a broader outage.",
    },
  });
  expect(JSON.stringify(result)).not.toContain(
    "session_information_flow_stale",
  );
}

async function selectsCurrentMessageCatalog(): Promise<void> {
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    "platform:message.attachment.inspect:1",
    "platform:message.link.read:1",
  ]);
  expect(scopes).toEqual({
    ok: true,
    value: ["message.attachment.inspect", "message.link.read"],
  });
  if (!scopes.ok) throw new Error(scopes.error.code);

  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(TOOL_REGISTRY, selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    services: fixtureServices({
      messages: {
        inspectMessageAttachment: async (input) => ({
          outcome: "inspected",
          attachmentId: input.attachmentId,
        }),
        readMessageLink: async (input) => ({
          outcome: "read",
          url: input.url,
        }),
      },
    }),
  });
  if (!created.ok) throw new Error(created.error.code);

  expect(created.value.definitions.map(readToolName)).toEqual([
    "inspect_message_attachment",
    "read_message_link",
  ]);
}

async function rejectsCatalogMismatch(): Promise<void> {
  const created = await createCatalogHarnessCodeMode({
    registry: TOOL_REGISTRY,
    expectedCatalogDigest: "0".repeat(64),
    admission: permissiveAdmission(),
    claimCapability: acceptFixtureCapabilityClaim,
    services: fixtureServices(),
  });

  expect(created).toEqual({
    ok: false,
    error: { code: "embedded_harness_tool_catalog_digest_mismatch" },
  });
}

function fixtureContextRequest(): import("@purin-labs/commerce-contracts").CommerceContextRequest {
  const parsed = parseCommerceGraphQuery({
    kind: "underclerk_context",
    selection: {
      kind: "entity_seeds",
      seeds: [{ origin: "system", typeId: "order", entityId: "order_fixture" }],
    },
    traversal: { maxDepth: 1, resultLimit: 10 },
    allowedSensitivity: "public",
    allowedAttributeIds: [],
    freshnessRequirement: "any",
  });
  if (parsed.kind !== "underclerk_context")
    throw new Error("fixture context query kind changed");
  const { kind: _kind, ...request } = parsed;
  return request;
}

/** No catalog test exercises the report tool; calling it is a test defect. */
function rejectMerchantReport(): Promise<never> {
  return Promise.reject(
    new Error("merchant report is not part of this fixture"),
  );
}

const readMerchantReport = rejectMerchantReport;

function rejectProductDescriptionDraftRead(): Promise<never> {
  return Promise.reject(
    new Error("product description draft read is not part of this fixture"),
  );
}

function rejectProductDescriptionDraftEdit(): Promise<never> {
  return Promise.reject(
    new Error("product description draft edit is not part of this fixture"),
  );
}

function rejectEmailDraftRead(): Promise<never> {
  return Promise.reject(
    new Error("email draft read is not part of this fixture"),
  );
}

function rejectEmailDraftEdit(): Promise<never> {
  return Promise.reject(
    new Error("email draft edit is not part of this fixture"),
  );
}

function rejectInternalEntityContext(): Promise<never> {
  return Promise.reject(new Error("session_information_flow_stale"));
}

function readEntityContext(
  _request: unknown,
): Promise<import("@purin-labs/commerce-contracts").CommerceGraphQueryResult> {
  return Promise.resolve(
    parseCommerceGraphResponse({
      merchantRevision: 1,
      entities: [],
      relationships: [],
      listEntries: [],
      aggregations: [],
      nextCursor: null,
      provenance: [],
      freshness: [],
    }),
  );
}

function listIntegrations(
  request: import("../src/agent-tools/integrations/services").HarnessIntegrationListRequest,
): Promise<import("@purin-labs/contracts").IntegrationDiscoveryView> {
  if (request.kind !== "list")
    throw new Error("integration list request invalid");
  return Promise.resolve({
    observedAt: 1,
    accounts: [
      {
        accountRef: `integration_ref_${"a".repeat(64)}`,
        provider: "stripe",
        displayName: "Cafe Stripe",
        connection: "available",
        configuredDataClasses: ["payments"],
        readableDataClasses: [],
      },
    ],
    truncated: false,
  });
}

function recordWhatsAppSupportReplySend(
  sends: unknown[],
  request: import("../src/agent-tools/channels/services").HarnessWhatsAppSupportReplySend,
): Promise<
  import("../src/agent-tools/channels/services").HarnessWhatsAppSupportReplyReceipt
> {
  sends.push(request);
  return Promise.resolve({
    kind: "sent",
    caseId: request.caseId,
    receiptId: "wamid.reply_1",
  });
}

function queryWorkspace(
  input: import("../src/agent-tools/catalog/types").HarnessWorkspaceQuery,
): Promise<
  import("../src/agent-tools/catalog/types").HarnessWorkspaceQueryResult
> {
  const path = input.kind === "read" ? input.path : "search";
  return Promise.resolve({
    kind: "file",
    revision: "workspace-revision:v1:test",
    path,
    mediaType: "text/markdown",
    sha256: "a".repeat(64),
    content: "# Shoe",
  });
}


function authorizedJson(result: AuthorizedHarnessToolResult): unknown {
  if (
    result.output.kind !== "inline" ||
    result.output.content.length !== 1 ||
    result.output.content[0]?.kind !== "text"
  ) {
    throw new Error("expected one inline text result");
  }
  return JSON.parse(result.output.content[0].text);
}

function permissiveAdmission(): import("../src/agent-tools/catalog/types").HarnessCodeModeAdmission {
  return {
    begin: beginFixtureExecution,
    claim: acceptFixtureCapability,
    complete: acceptFixtureCapability,
    abandon: acceptFixtureCapability,
    settle: settleFixtureExecution,
  };
}

function beginFixtureExecution(): Promise<
  import("../src/agent-tools/catalog/types").HarnessCodeModeAdmittedExecution
> {
  return Promise.resolve({
    executionId: "cmx-fixture",
    leaseId: "lease-fixture",
    executionDeadlineAt: Date.now() + 30_000,
    runnable: true,
  });
}

function acceptFixtureCapability(): Promise<void> {
  return Promise.resolve();
}

function settleFixtureExecution(): Promise<void> {
  return Promise.resolve();
}

function acceptFixtureCapabilityClaim(): Promise<{
  readonly ok: true;
  readonly value: null;
}> {
  return Promise.resolve({ ok: true, value: null });
}

function recordAcceptedCapabilityClaim(
  claims: string[],
  input: import("../src/agent-tools/catalog/types").HarnessCapabilityClaimInput,
): Promise<{ readonly ok: true; readonly value: null }> {
  claims.push(`${input.boundary}:${input.capability}`);
  return Promise.resolve({ ok: true, value: null });
}

function readToolName(
  definition: import("../src/agent-tools/catalog/types").HarnessToolDefinition,
): string {
  return definition.name;
}

function unavailableMenuDraft(): Promise<never> {
  throw new Error("Menu draft read is unavailable in this fixture");
}

function rejectWorkflowCanvasTool(): Promise<never> {
  return Promise.reject(new Error("Workflow canvas is outside this fixture"));
}
