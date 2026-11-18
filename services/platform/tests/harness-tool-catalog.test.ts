import type { HarnessToolOutput } from "@seams/contracts";
import { describe, expect, it } from "vitest";
import type { AuthorizedHarnessToolResult } from "@seams/contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceGraphResponse,
} from "@seams/commerce-client";

import { catalogHarnessToolCatalogDigest } from "../src/agent-tools/catalog/selection";
import { createCatalogHarnessCodeMode, harnessCapabilitiesFromCapabilityKeys } from "../src/agent-tools/catalog/code-mode";
import { encodeFileCapabilityKey } from "../src/authorization/access-grants/capability-key";
import { requireIntegrationAccountId } from "./test-ids";

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
    "reads accepted attachment preparation through a direct tool",
    readsPreparedAttachment,
  );
  it(
    "searches a granted Gmail mailbox and creates an approval draft",
    executesEmailMailboxTools,
  );
  it(
    "accepts a discovery reference for a governed self-test proposal",
    executesEmailSelfTest,
  );
  it(
    "reads bounded active WhatsApp Cases from one granted phone-number account",
    executesWhatsAppSupportRead,
  );
  it(
    "sends one exact reply to a granted active WhatsApp Case",
    executesWhatsAppSupportReplySend,
  );
  it(
    "keeps internal direct capability failures out of model-visible output",
    screensDirectFailure,
  );
  it(
    "records one governed commerce proposal without provider dispatch",
    executesCommerceProposal,
  );
  it(
    "maps encoded current-message scopes into the governed catalog",
    selectsCurrentMessageCatalog,
  );
  it(
    "selects and executes both file tools from one exact file capability",
    executesFileTools,
  );
  it(
    "wires product description draft tools and preserves edit capability boundaries",
    executesProductDescriptionDraftTools,
  );
  it(
    "wires email draft reads and exact-passage edits through one scoped capability",
    executesEmailDraftTools,
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
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
    nowNs: monotonicClock(),
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
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
    nowNs: monotonicClock(),
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
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    executeBakerySurface: recordBakerySurfaceTool.bind(null, calls),
    nowNs: monotonicClock(),
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
  readonly receipt: import("@seams/bakery-model/bakery-surface").BakerySurfaceReceiptV1;
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
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    readAirtable: airtableReadFixture,
    writeAirtable: airtableWriteFixture,
    nowNs: monotonicClock(),
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

async function executesEmailSelfTest(): Promise<void> {
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    "provider:email.operational.propose:1:ia_gmail:operational",
  ]);
  if (!scopes.ok) throw new Error("Invalid capability fixture");
  const selection = { allowedCapabilities: scopes.value };
  const proposals: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest: await catalogHarnessToolCatalogDigest(selection),
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    proposeEmailOperational: recordSelfTestProposal.bind(null, proposals),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);
  const request = {
    accountRef: `integration_ref_${"a".repeat(64)}`,
    target: { kind: "self_test", address: "owner@example.com" },
    subject: "Satyr Gmail canary",
    body: "This is a synthetic test of Satyr's email drafting and approval workflow. No action is required.",
  };
  expect(
    await created.value.executeTool(
      "email_operational_propose",
      JSON.stringify(request),
      "self_test",
    ),
  ).toMatchObject({
    kind: "provider_effect",
    status: "succeeded",
    authority: { receiptId: "proposal_self_test" },
  });
  expect(proposals).toEqual([request]);
  const malformed = { ...request, accountRef: "integration_account_private" };
  expect(
    await created.value.executeTool(
      "email_operational_propose",
      JSON.stringify(malformed),
      "invalid_ref",
    ),
  ).toMatchObject({ status: "failed" });
  expect(proposals).toHaveLength(1);
}

function recordSelfTestProposal(
  proposals: unknown[],
  request: import("../src/agent-tools/catalog/types").HarnessEmailOperationalPropose,
): Promise<
  import("../src/agent-tools/catalog/types").HarnessEmailOperationalProposalReceipt
> {
  proposals.push(request);
  return Promise.resolve({
    kind: "proposed",
    proposalId: "proposal_self_test",
    version: 1,
    snapshotDigest: "a".repeat(64),
  });
}

async function executesEmailMailboxTools(): Promise<void> {
  const integrationAccountId = requireIntegrationAccountId("ia_gmail");
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    `provider:email.mailbox.read:1:${integrationAccountId}:mailbox`,
    `provider:email.reply.propose:1:${integrationAccountId}:mailbox`,
  ]);
  expect(scopes).toEqual({
    ok: true,
    value: ["email.mailbox.read", "email.reply.propose"],
  });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const searches: unknown[] = [];
  const proposals: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    searchEmailMailbox: async (input) => {
      searches.push(input);
      return {
        integrationAccountId,
        messages: [
          {
            messageId: "m1",
            threadId: "t1",
            from: "supplier@example.com",
            subject: "Friday delivery",
            date: "Fri, 04 Sep 2026 09:00:00 +0000",
            bodyText: "Delivery is confirmed.",
            attachments: [],
          },
        ],
        truncated: false,
      };
    },
    proposeEmailReply: async (input) => {
      proposals.push(input);
      return {
        kind: "proposed",
        proposalId: "proposal_email_1",
        providerDraftId: "draft_1",
      };
    },
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  const searched = authorizedJson(
    await created.value.executeTool(
      "email_mailbox_search",
      JSON.stringify({
        integrationAccountId,
        query: "from:supplier@example.com",
        limit: 5,
      }),
      "email_search_direct",
    ),
  );
  const proposedResult = await created.value.executeTool(
    "email_reply_propose",
    JSON.stringify({
      integrationAccountId,
      messageId: "m1",
      threadId: "t1",
      body: "Thank you. We have noted the delivery date.",
      sources: null,
    }),
    "email_reply_direct",
  );
  expect(searched).toMatchObject({
    success: true,
    code_mode_value: {
      messages: [{ messageId: "m1", threadId: "t1" }],
    },
  });
  expect(proposedResult).toMatchObject({
    kind: "provider_effect",
    authority: { kind: "provider_effect", receiptId: "proposal_email_1" },
    status: "succeeded",
  });
  expect(searches).toEqual([
    { integrationAccountId, query: "from:supplier@example.com", limit: 5 },
  ]);
  expect(proposals).toEqual([
    {
      integrationAccountId,
      messageId: "m1",
      threadId: "t1",
      body: "Thank you. We have noted the delivery date.",
      citations: [],
      malformedCitations: 0,
    },
  ]);
  expect(claims).toEqual([
    "direct_tool:email.mailbox.read",
    "direct_tool:email.reply.propose",
  ]);
}

async function executesWhatsAppSupportRead(): Promise<void> {
  const integrationAccountId = requireIntegrationAccountId("ia_whatsapp");
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    `provider:whatsapp.support.read:1:${integrationAccountId}:active_cases`,
  ]);
  expect(scopes).toEqual({ ok: true, value: ["whatsapp.support.read"] });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const reads: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readWhatsAppSupport: recordWhatsAppSupportRead.bind(
      null,
      reads,
      integrationAccountId,
    ),
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  const direct = authorizedJson(
    await created.value.executeTool(
      "whatsapp_support_read",
      JSON.stringify({ limit: 5 }),
      "whatsapp_support_direct",
    ),
  );

  expect(created.value.definitions.map(readToolName)).toEqual([
    "whatsapp_support_read",
  ]);
  expect(reads).toEqual([{ limit: 5 }]);
  expect(direct).toMatchObject({
    success: true,
    code_mode_value: {
      scope: "active_cases",
      cases: [
        {
          integrationAccountId,
          customerWaId: "15555550123",
          messages: [{ direction: "inbound", text: "Is my order ready?" }],
        },
      ],
      truncated: false,
    },
  });
  expect(claims).toEqual(["direct_tool:whatsapp.support.read"]);

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

async function executesWhatsAppSupportReplySend(): Promise<void> {
  const integrationAccountId = requireIntegrationAccountId("ia_whatsapp");
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    `provider:whatsapp.support.reply.send:1:${integrationAccountId}:active_cases`,
  ]);
  expect(scopes).toEqual({ ok: true, value: ["whatsapp.support.reply.send"] });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const sends: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    sendWhatsAppSupportReply: recordWhatsAppSupportReplySend.bind(null, sends),
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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
}

function inlineToolOutput(text: string): HarnessToolOutput {
  return {
    kind: "inline",
    content: [{ kind: "text", text }],
    digest: "a".repeat(64),
  } as HarnessToolOutput;
}

async function readsPreparedAttachment(): Promise<void> {
  const selection = {
    allowedCapabilities: [
      "message.attachment.inspect",
      "message.link.read",
    ] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const inspected: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    inspectMessageAttachment: recordPreparedInspection.bind(null, inspected),
    readMessageLink: async function read(input) {
      return { outcome: "read", url: input.url };
    },
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  await created.value.executeTool(
    "inspect_message_attachment",
    JSON.stringify({ attachmentId: "att_1" }),
    "direct",
  );
  expect(inspected).toEqual(["att_1"]);
  expect(claims).toEqual(["direct_tool:message.attachment.inspect"]);
}

async function recordPreparedInspection(
  inspected: string[],
  input: { readonly attachmentId: string },
): Promise<Readonly<Record<string, unknown>>> {
  inspected.push(input.attachmentId);
  return { outcome: "inspected", attachmentId: input.attachmentId };
}

async function gatesMessageToolsByCapability(): Promise<void> {
  // Neither tool appears in a catalog that was not granted its capability.
  const withoutMessageTools = {
    allowedCapabilities: ["integration.discovery.read"] as const,
  };
  const withoutDigest =
    await catalogHarnessToolCatalogDigest(withoutMessageTools);
  const absent = await createCatalogHarnessCodeMode({
    expectedCatalogDigest: withoutDigest,
    catalogSelection: withoutMessageTools,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    inspectMessageAttachment: async function inspect(input) {
      return inlineToolOutput(`inspected:${input.attachmentId}`);
    },
    readMessageLink: async function read(input) {
      return inlineToolOutput(`read:${input.url}`);
    },
    nowNs: monotonicClock(),
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
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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

async function executesFileTools(): Promise<void> {
  const scopes = harnessCapabilitiesFromCapabilityKeys([
    encodeFileCapabilityKey({
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: requireIntegrationAccountId("ia_files"),
      scope: {
        kind: "dropbox_file",
        providerFileId: "id:file",
        pathDisplay: "/Recipes/Recipe.md",
      },
    }),
  ]);
  expect(scopes).toEqual({ ok: true, value: ["file.read"] });
  if (!scopes.ok) return;
  const selection = { allowedCapabilities: scopes.value };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    searchFiles: async () => [
      {
        reference: {
          integrationAccountId: requireIntegrationAccountId("ia_files"),
          provider: "dropbox",
          providerFileId: "id:file",
        },
        segmentIndex: 0,
        sourceRevision: 1,
        title: "Recipe.md",
        displayPath: "/Recipes/Recipe.md",
        deepLink: "https://www.dropbox.com/home/Recipes/Recipe.md",
        excerpt: "mix flour",
        metadataOnlyReason: null,
      },
    ],
    readFile: async (input) => ({
      kind: "content",
      reference: input.reference,
      title: "Recipe.md",
      displayPath: "/Recipes/Recipe.md",
      deepLink: "https://www.dropbox.com/home/Recipes/Recipe.md",
      startSegment: input.startSegment,
      segments: ["mix flour"],
      continuation: { kind: "complete" },
    }),
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  expect(created.value.definitions.map(readToolName)).toEqual([
    "file_search",
    "file_read",
  ]);
  const search = authorizedJson(
    await created.value.executeTool(
      "file_search",
      JSON.stringify({ query: "recipe", limit: 5 }),
      "file_search_call",
    ),
  );
  const read = authorizedJson(
    await created.value.executeTool(
      "file_read",
      JSON.stringify({
        reference: {
          integrationAccountId: "ia_files",
          provider: "dropbox",
          providerFileId: "id:file",
        },
        startSegment: 0,
      }),
      "file_read_call",
    ),
  );
  expect(search).toMatchObject({ success: true });
  expect(read).toMatchObject({ success: true });
  expect(claims).toEqual(["direct_tool:file.read", "direct_tool:file.read"]);
}

async function executesProductDescriptionDraftTools(): Promise<void> {
  const selection = {
    allowedCapabilities: [
      "commerce.entity_plane.context",
      "commerce.product_description_draft.edit",
    ] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
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
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: async (request) => {
      reads.push(request);
      return snapshot;
    },
    editProductDescriptionDraft: async (request, operationId) => {
      edits.push({ request, operationId });
      return snapshot;
    },
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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
    expectedCatalogDigest:
      await catalogHarnessToolCatalogDigest(readOnlySelection),
    catalogSelection: readOnlySelection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, []),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: async () => snapshot,
    editProductDescriptionDraft: async () => snapshot,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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

async function executesEmailDraftTools(): Promise<void> {
  const selection = {
    allowedCapabilities: ["marketing.email_draft.edit"] as const,
  };
  const expectedCatalogDigest =
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const reads: unknown[] = [];
  const edits: Array<{
    readonly request: unknown;
    readonly operationId: string;
  }> = [];
  const snapshot = {
    kind: "active" as const,
    documentId: "active" as const,
    revision: 4,
    observedAt: 10,
    draft: {
      subject: "Friday menu",
      preview: "Fresh from the oven",
      body: "See this week's menu.",
    },
  };
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: async () => {
      reads.push({});
      return snapshot;
    },
    editEmailDraft: async (request, operationId) => {
      edits.push({ request, operationId });
      return snapshot;
    },
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  const directRead = authorizedJson(
    await created.value.executeTool("email_draft_read", "{}", "email_read"),
  );
  const directEdit = authorizedJson(
    await created.value.executeTool(
      "email_draft_edit",
      JSON.stringify({
        field: "subject",
        oldText: "Friday",
        newText: "Weekend",
        expectedRevision: 4,
      }),
      "email_edit",
    ),
  );

  expect(directRead).toMatchObject({
    success: true,
    code_mode_value: snapshot,
  });
  expect(directEdit).toMatchObject({
    success: true,
    code_mode_value: snapshot,
  });
  expect(reads).toEqual([{}]);
  expect(edits).toEqual([
    {
      request: {
        field: "subject",
        oldText: "Friday",
        newText: "Weekend",
        expectedRevision: 4,
      },
      operationId: JSON.stringify(["direct_tool", "email_edit"]),
    },
  ]);
  expect(claims).toEqual([
    "direct_tool:marketing.email_draft.edit",
    "direct_tool:marketing.email_draft.edit",
  ]);
}

async function screensDirectFailure(): Promise<void> {
  const expectedCatalogDigest = await catalogHarnessToolCatalogDigest();
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    admission: permissiveAdmission(),
    claimCapability: acceptFixtureCapabilityClaim,
    listIntegrations,
    readEntityContext: rejectInternalEntityContext,
    readMerchantReport: rejectMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
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
    await catalogHarnessToolCatalogDigest(selection);
  const claims: string[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    catalogSelection: selection,
    admission: permissiveAdmission(),
    claimCapability: recordAcceptedCapabilityClaim.bind(null, claims),
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    inspectMessageAttachment: async (input) => ({
      outcome: "inspected",
      attachmentId: input.attachmentId,
    }),
    readMessageLink: async (input) => ({
      outcome: "read",
      url: input.url,
    }),
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  expect(created.value.definitions.map(readToolName)).toEqual([
    "inspect_message_attachment",
    "read_message_link",
  ]);
}

async function rejectsCatalogMismatch(): Promise<void> {
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest: "0".repeat(64),
    admission: permissiveAdmission(),
    claimCapability: acceptFixtureCapabilityClaim,
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    queryWorkspace,
    nowNs: monotonicClock(),
  });

  expect(created).toEqual({
    ok: false,
    error: { code: "embedded_harness_tool_catalog_digest_mismatch" },
  });
}

async function executesCommerceProposal(): Promise<void> {
  const expectedCatalogDigest = await catalogHarnessToolCatalogDigest();
  const proposals: unknown[] = [];
  const created = await createCatalogHarnessCodeMode({
    expectedCatalogDigest,
    admission: permissiveAdmission(),
    claimCapability: acceptFixtureCapabilityClaim,
    listIntegrations,
    readEntityContext,
    readMerchantReport,
    readWorkflowCanvas: rejectWorkflowCanvasTool,
    moveWorkflowCanvasObject: rejectWorkflowCanvasTool,
    readProductDescriptionDraft: rejectProductDescriptionDraftRead,
    editProductDescriptionDraft: rejectProductDescriptionDraftEdit,
    readMenuDraft: unavailableMenuDraft,
    readEmailDraft: rejectEmailDraftRead,
    editEmailDraft: rejectEmailDraftEdit,
    proposeCommerceAction: async (request) => {
      proposals.push(request);
      return {
        kind: "commerce_action_proposed",
        proposalId: "proposal_fixture",
      };
    },
    queryWorkspace,
    nowNs: monotonicClock(),
  });
  if (!created.ok) throw new Error(created.error.code);

  const definition = created.value.definitions.find(
    (item) => item.name === "commerce_propose_action",
  );
  expect(definition).toBeDefined();
  expect(JSON.stringify(definition?.parameters)).not.toContain("oneOf");
  expect(JSON.stringify(definition?.parameters)).not.toContain(
    "adjust_inventory",
  );
  expect(JSON.stringify(definition?.parameters)).not.toContain(
    "targetAvailable",
  );

  const request = {
    kind: "cancel_order",
    resourceId: "order_1",
    expectedRevision: 3,
    reason: "customer_requested",
    refund: "none",
    restock: false,
    notifyCustomer: true,
    note: null,
  } as const;
  const result: unknown = authorizedJson(
    await created.value.executeTool(
      "commerce_propose_action",
      JSON.stringify({ request }),
      "call_proposal",
    ),
  );

  expect(proposals).toEqual([request]);
  expect(result).toMatchObject({
    success: true,
    code_mode_value: {
      kind: "commerce_action_proposed",
      proposalId: "proposal_fixture",
    },
  });
}

function fixtureContextRequest(): import("@seams/contracts").CommerceContextRequest {
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
): Promise<import("@seams/contracts").CommerceGraphQueryResult> {
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
  request: import("../src/agent-tools/catalog/types").HarnessIntegrationListRequest,
): Promise<import("@seams/contracts").IntegrationDiscoveryView> {
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

function recordWhatsAppSupportRead(
  reads: unknown[],
  integrationAccountId: string,
  request: import("../src/agent-tools/catalog/types").HarnessWhatsAppSupportRead,
): Promise<
  import("../src/agent-tools/catalog/types").HarnessWhatsAppSupportInbox
> {
  reads.push(request);
  return Promise.resolve({
    scope: "active_cases",
    cases: [
      {
        integrationAccountId,
        caseId: "case_whatsapp_1",
        customerWaId: "15555550123",
        openedAt: 1_000,
        serviceWindowExpiresAt: 86_401_000,
        ownership: "agent_active",
        messages: [
          {
            direction: "inbound",
            occurredAt: 1_000,
            text: "Is my order ready?",
          },
        ],
      },
    ],
    truncated: false,
  });
}

function recordWhatsAppSupportReplySend(
  sends: unknown[],
  request: import("../src/agent-tools/catalog/types").HarnessWhatsAppSupportReplySend,
): Promise<
  import("../src/agent-tools/catalog/types").HarnessWhatsAppSupportReplyReceipt
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

function monotonicClock(): () => number {
  let value = 0;
  return nextClockValue.bind(null, { value });
}

function nextClockValue(clock: { value: number }): number {
  clock.value += 10;
  return clock.value;
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
