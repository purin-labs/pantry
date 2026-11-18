// @ts-expect-error The portal owns its browser-only React runtime.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error The portal owns its browser-only React DOM runtime.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ControlApiError } from "../../../apps/portal/src/control-client";
import {
  parseAccessControlResponse,
  parseAccessExplanationResponse,
  parseAccessOptionsResponse,
} from "@seams/control-api/portal/access-boundary";
import { createAccessRouteTransport } from "../../../apps/portal/src/features/access/api";
import { parseDropboxResourcePage, parseGoogleDrivePickerConfig } from "@seams/control-api/portal/file-resources";
// @ts-expect-error Platform test TypeScript excludes portal JSX; the portal build validates it.
import { GrantAccessDialog } from "../../../apps/portal/src/features/access/grant-dialog";
import {
  grantTarget,
  loadAccessRouteContent,
  readInitialFileAccessProvider,
  // @ts-expect-error Platform test TypeScript excludes portal JSX; the portal build validates it.
} from "../../../apps/portal/src/features/access/route";
import { initialFileAccessPath } from "../../../apps/portal/src/route";
import { CAPABILITY_CATALOGUE } from "../src/authorization/capability-catalogue";

import {
  customOperationChoices,
  readCustomConnectorAccessHandoff,
  // @ts-expect-error Platform test TypeScript excludes portal JSX; the portal build validates it.
} from "../../../apps/portal/src/features/access/custom-operation-picker";
type CustomConnectorDetail = Parameters<typeof customOperationChoices>[0];
import type { AccessControlCapabilityView } from "@seams/control-api/portal/access-models";

const WORKSPACE_HANDLE = "cafe-central";
const ORGANISATION_HANDLE = "satyr-cafes";

describe("portal Plan 35 access route", () => {
  it(
    "grants only the selected approved custom operation and sends its exact revision binding",
    testCustomOperationGrant,
  );
  it(
    "parses the strict aggregate, options, and explanation boundaries",
    testBoundaries,
  );
  it(
    "keeps capabilities and existing conversation grants available when optional pickers fail",
    testDegradedOptions,
  );
  it(
    "keeps access transport, contract decode, and derived empty states distinct",
    testAccessLoadStates,
  );
  it(
    "starts connected file accounts in a focused read-only setup",
    testInitialFileAccessSetup,
  );
});

function testBoundaries(): void {
  const viewResult = parseAccessControlResponse(accessResponse());
  expect(viewResult.ok).toBe(true);
  if (!viewResult.ok) throw new Error("Access response fixture should decode");
  const view = viewResult.value;
  expect(view.organisation.actions.kind).toBe("manage");
  expect(view.grants.items[0]?.subject.subjectRefId).toMatch(
    /^subject_[a-f0-9]{32}$/u,
  );
  expect(JSON.stringify(view)).not.toContain("person_owner");
  const optionsResult = parseAccessOptionsResponse(optionsResponse());
  expect(optionsResult.ok).toBe(true);
  if (!optionsResult.ok)
    throw new Error("Access options fixture should decode");
  expect(optionsResult.value.items[0]).toEqual(
    expect.objectContaining({
      kind: "person",
      revision: 7,
    }),
  );
  const casesResult = parseAccessOptionsResponse(caseOptionsResponse());
  expect(casesResult.ok).toBe(true);
  if (!casesResult.ok) throw new Error("Case options fixture should decode");
  expect(casesResult.value.items[0]).toEqual(
    expect.objectContaining({
      kind: "case",
      refId: opaque("case", "6"),
      revision: 4,
    }),
  );
  const commerceTargetsResult = parseAccessOptionsResponse(
    commerceTargetOptionsResponse(),
  );
  expect(commerceTargetsResult.ok).toBe(true);
  if (!commerceTargetsResult.ok)
    throw new Error("Commerce target options fixture should decode");
  expect(commerceTargetsResult.value.items[0]).toEqual(
    expect.objectContaining({
      kind: "commerce_target",
      refId: opaque("target", "7"),
      revision: 2,
    }),
  );
  const explanationResult = parseAccessExplanationResponse({
    ok: true,
    explanation: {
      kind: "denied",
      stage: "flow_sink",
      reason: "The destination is outside the source audience.",
      remediation: "Choose a permitted conversation.",
    },
  });
  expect(explanationResult.ok).toBe(true);
  if (!explanationResult.ok)
    throw new Error("Access explanation fixture should decode");
  expect(explanationResult.value).toEqual(
    expect.objectContaining({ kind: "denied", stage: "flow_sink" }),
  );
  expect(
    parseDropboxResourcePage(dropboxResourceResponse()).entries[0],
  ).toEqual({
    kind: "dropbox_folder",
    providerFolderId: "id:recipes",
    name: "Recipes",
    pathDisplay: "/Recipes",
  });
  expect(parseGoogleDrivePickerConfig(googleDrivePickerResponse()).scope).toBe(
    "https://www.googleapis.com/auth/drive.file",
  );
  const malformedAccess = parseAccessControlResponse({
    ...accessResponse(),
    unexpected: true,
  });
  expect(malformedAccess.ok).toBe(false);
  if (malformedAccess.ok)
    throw new Error("Malformed access response should fail decoding");
  expect(malformedAccess.error).toEqual(
    expect.objectContaining({
      kind: "decode",
      boundary: "access_control",
    }),
  );
  expect(() =>
    parseDropboxResourcePage({
      ...dropboxResourceResponse(),
      unexpected: true,
    }),
  ).toThrow("Dropbox resource response is invalid");
}

async function testDegradedOptions(): Promise<void> {
  const viewResult = parseAccessControlResponse(accessResponse());
  if (!viewResult.ok) throw new Error("Access response fixture should decode");
  const view = viewResult.value;
  const grant = view.grants.items[0];
  if (grant === undefined) throw new Error("Access grant fixture is missing");
  const conversationView = {
    ...view,
    grants: {
      ...view.grants,
      items: [
        {
          ...grant,
          subject: {
            subjectRefId: opaque("subject", "2"),
            kind: "conversation" as const,
            label: "Connected Slack conversation",
            availability: "available" as const,
          },
        },
      ],
    },
  };
  const transport = {
    read: vi.fn().mockResolvedValue({ ok: true, value: conversationView }),
    readOptions: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        kind: "network",
        message: "picker unavailable",
      },
    }),
    mutate: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    explain: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        kind: "allowed",
        effectiveGrants: [],
        policyMode: "enabled",
        flowReaders: [],
      },
    }),
    discoverDropbox: vi.fn(),
    pickGoogleDrive: vi.fn(),
  };
  const capabilities = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "capabilities",
    transport,
  });
  if (!capabilities.ok)
    throw new Error("Capabilities route fixture should load");
  expect(capabilities.value.view).toBe(conversationView);
  expect(transport.readOptions).not.toHaveBeenCalled();

  const access = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "access",
    transport,
  });
  if (!access.ok) throw new Error("Access route fixture should load");
  expect(access.value.subjects).toEqual([
    {
      kind: "conversation",
      refId: opaque("subject", "2"),
      revision: 1,
      label: "Connected Slack conversation",
      detail: "Conversation",
      availability: "available",
    },
  ]);
  expect(access.value.integrations).toEqual([]);
}

async function testAccessLoadStates(): Promise<void> {
  const malformed = createAccessRouteTransport(
    vi.fn().mockResolvedValue({ ...accessResponse(), unexpected: true }),
    vi.fn(),
    unusedGooglePickerConfig,
  );
  const malformedResult = await malformed.read("organisation_cafe", null, null);
  expect(malformedResult.ok).toBe(false);
  if (malformedResult.ok)
    throw new Error("Malformed access response should fail at the gateway");
  expect(malformedResult.error.kind).toBe("decode");

  const unavailable = createAccessRouteTransport(
    vi.fn().mockRejectedValue(new TypeError("offline")),
    vi.fn(),
    unusedGooglePickerConfig,
  );
  const unavailableResult = await unavailable.read(
    "organisation_cafe",
    null,
    null,
  );
  expect(unavailableResult.ok).toBe(false);
  if (unavailableResult.ok)
    throw new Error("Unavailable access transport should fail at the gateway");
  expect(unavailableResult.error.kind).toBe("network");

  const forbidden = createAccessRouteTransport(
    vi.fn().mockRejectedValue(new ControlApiError("forbidden", "forbidden")),
    vi.fn(),
    unusedGooglePickerConfig,
  );
  const forbiddenResult = await forbidden.read("organisation_cafe", null, null);
  expect(forbiddenResult).toEqual({
    ok: false,
    error: { kind: "control", controlKind: "forbidden", message: "forbidden" },
  });

  const viewResult = parseAccessControlResponse(accessResponse());
  if (!viewResult.ok) throw new Error("Access response fixture should decode");
  const controlFailure = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "access",
    transport: {
      read: vi.fn().mockResolvedValue({ ok: true, value: viewResult.value }),
      readOptions: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          kind: "control",
          controlKind: "forbidden",
          message: "You do not have permission to read access options.",
        },
      }),
      mutate: vi.fn(),
      explain: vi.fn(),
      discoverDropbox: vi.fn(),
      pickGoogleDrive: vi.fn(),
    },
  });
  expect(controlFailure.ok).toBe(false);
  if (controlFailure.ok)
    throw new Error("Control API option failure should not use the fallback");
  expect(controlFailure.error).toEqual(
    expect.objectContaining({
      kind: "control",
    }),
  );

  const internal = createAccessRouteTransport(
    vi
      .fn()
      .mockResolvedValueOnce(accessResponse())
      .mockRejectedValue(new Error("unexpected")),
    vi.fn(),
    unusedGooglePickerConfig,
  );
  const internalFailure = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "access",
    transport: internal,
  });
  expect(internalFailure.ok).toBe(false);
  if (internalFailure.ok)
    throw new Error("Internal option failure should not use the fallback");
  expect(internalFailure.error).toEqual(
    expect.objectContaining({
      kind: "internal",
    }),
  );

  const emptyView = {
    ...viewResult.value,
    capabilities: [],
    summary: {
      ...viewResult.value.summary,
      capabilities: 0,
      enabledCapabilities: 0,
    },
  };
  const emptyTransport = {
    read: vi.fn().mockResolvedValue({ ok: true, value: emptyView }),
    readOptions: vi.fn(),
    mutate: vi.fn(),
    explain: vi.fn(),
    discoverDropbox: vi.fn(),
    pickGoogleDrive: vi.fn(),
  };
  const empty = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "capabilities",
    transport: emptyTransport,
  });
  const decoded = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "capabilities",
    transport: {
      ...emptyTransport,
      read: vi.fn().mockResolvedValue({ ok: true, value: viewResult.value }),
    },
  });
  expect(decoded.ok).toBe(true);
  if (!decoded.ok)
    throw new Error("Populated capabilities fixture should load");
  expect(decoded.value.view.capabilities).toHaveLength(1);

  const optionDecodeFailure = await loadAccessRouteContent({
    organisationId: "organisation_cafe",
    subview: "access",
    transport: {
      ...emptyTransport,
      readOptions: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          kind: "decode",
          boundary: "access_options",
          field: "access option",
          code: "invalid_option",
          reason: "option is invalid",
          details: null,
        },
      }),
    },
  });
  expect(optionDecodeFailure.ok).toBe(false);
  if (optionDecodeFailure.ok)
    throw new Error("Malformed option response should fail loading");
  expect(optionDecodeFailure.error.kind).toBe("decode");

  expect(empty.ok).toBe(true);
  if (!empty.ok) throw new Error("Empty capabilities fixture should load");
  expect(empty.value.view.capabilities).toHaveLength(0);
}

function testInitialFileAccessSetup(): void {
  const definition = CAPABILITY_CATALOGUE.find(
    (item) => item.capabilityId === "file.read",
  );
  if (definition === undefined)
    throw new Error("File capability fixture is missing");
  const markup = renderToStaticMarkup(
    React.createElement(GrantAccessDialog, {
      organisationId: "organisation_cafe",
      initialCustomConnector: null,
      problem: null,
      open: true,
      busy: false,
      initialFileProvider: "google_drive",
      initialSubjectRef: "conversation_cafe_ops",
      scopeLabel: null,
      capabilities: [
        {
          definition,
          mode: "enabled",
          provenance: {
            kind: "baseline",
            profile: "read_and_propose",
            profileVersion: 1,
            materializationReceiptId: "receipt_defaults",
          },
          revision: 1,
          changedAt: 100,
          availability: "available",
          activeGrantCount: 0,
          actions: { kind: "change_capability_mode" },
        },
      ],
      subjects: [
        {
          kind: "conversation",
          refId: "conversation_cafe_ops",
          revision: 3,
          label: "#cafe-ops",
          detail: "Nuki Slack",
          availability: "available",
        },
      ],
      integrations: [],
      integrationProviders: new Map<string, string>(),
      integrationsPath: "/portal/satyr-cafes/cafe-central/integrations",
      resources: [],
      fileAccounts: [
        {
          integrationAccountId: "ia_google_drive",
          provider: "google_drive",
          displayName: "Google Drive",
        },
      ],
      filePicker: {
        discoverDropbox: unusedDropboxDiscovery,
        pickGoogleDrive: unusedDrivePicker,
      },
      close: ignore,
      chooseCapability: ignore,
      chooseIntegration: ignore,
      submit: ignore,
    }),
  );
  expect(
    initialFileAccessPath(
      ORGANISATION_HANDLE,
      WORKSPACE_HANDLE,
      "google_drive",
    ),
  ).toBe(
    "/portal/satyr-cafes/cafe-central/access?setup=files&provider=google_drive",
  );
  expect(
    readInitialFileAccessProvider("?setup=files&provider=google_drive"),
  ).toBe("google_drive");
  expect(
    readInitialFileAccessProvider("?setup=files&provider=slack"),
  ).toBeNull();
  expect(markup).toContain("Choose files for Seams Pantry");
  expect(markup).toContain("Access is read-only");
  expect(markup).toContain("#cafe-ops");
  expect(markup).toContain("Add files to Pantry");
  expect(markup).not.toContain("Select a capability");
}

function accessResponse(): Record<string, unknown> {
  const definition = CAPABILITY_CATALOGUE.find(
    (item) => item.capabilityId === "context.case.read",
  );
  if (definition === undefined)
    throw new Error("Context capability fixture is missing");
  const subject = {
    subjectRefId: opaque("subject", "2"),
    kind: "person",
    label: "Pta",
    availability: "available",
  };
  return {
    ok: true,
    accessControl: {
      organisation: {
        organisationId: "organisation_cafe",
        name: "Cafe Central",
        lifecycle: "active",
        configurationVersion: 3,
        requesterRole: "owner",
        actions: { kind: "manage", createGrant: true, applyDefaults: true },
      },
      revision: 7,
      summary: {
        capabilities: 1,
        enabledCapabilities: 1,
        approvalRequiredCapabilities: 0,
        integrations: 1,
        activeGrants: 1,
        sourcePolicies: 1,
      },
      capabilities: [
        {
          definition,
          mode: "enabled",
          provenance: {
            kind: "baseline",
            profile: "read_and_propose",
            profileVersion: 1,
            materializationReceiptId: "receipt_defaults",
          },
          revision: 2,
          changedAt: 100,
          availability: "available",
          activeGrantCount: 1,
          actions: { kind: "change_capability_mode" },
        },
      ],
      integrationResources: [
        {
          integrationAccountId: "integration_slack",
          provider: "slack",
          displayName: "Cafe Slack",
          availability: "available",
          updatedAt: 100,
          actions: { kind: "none" },
        },
      ],
      grants: {
        items: [
          {
            grantId: "grant_context",
            revision: 2,
            subject,
            capability: {
              capabilityId: definition.capabilityId,
              capabilityVersion: definition.capabilityVersion,
              label: definition.label,
              risk: definition.risk,
            },
            resource: {
              targetRefId: opaque("target", "3"),
              kind: "platform",
              label: "CafeOS",
              integrationAccountId: null,
              revision: 1,
            },
            provenance: { kind: "operator", label: "Granted by an operator" },
            lifecycle: { kind: "active", revision: 2, activatedAt: 100 },
            actions: { kind: "revoke_grant" },
          },
        ],
        nextCursor: null,
      },
      sourceFlowPolicies: {
        items: [
          {
            sourceRefId: opaque("source", "4"),
            revision: 3,
            capability: {
              capabilityId: definition.capabilityId,
              capabilityVersion: definition.capabilityVersion,
              label: definition.label,
            },
            owner: {
              integrationAccountId: "integration_slack",
              label: "Cafe Slack",
            },
            resourceLabel: "Private Case context",
            readers: [subject],
            availability: { kind: "available" },
            actions: { kind: "check_destination" },
          },
        ],
        nextCursor: null,
      },
    },
  };
}

function optionsResponse(): Record<string, unknown> {
  return {
    ok: true,
    options: {
      items: [
        {
          kind: "person",
          refId: opaque("subject", "2"),
          revision: 7,
          label: "Pta",
          detail: "Workspace member",
          availability: "available",
        },
      ],
      nextCursor: null,
    },
  };
}

function caseOptionsResponse(): Record<string, unknown> {
  return {
    ok: true,
    options: {
      items: [
        {
          kind: "case",
          refId: opaque("case", "6"),
          revision: 4,
          label: "Resolve wholesale order",
          detail: "Current Case · open",
          availability: "available",
        },
      ],
      nextCursor: null,
    },
  };
}

function commerceTargetOptionsResponse(): Record<string, unknown> {
  return {
    ok: true,
    options: {
      items: [
        {
          kind: "commerce_target",
          refId: opaque("target", "7"),
          revision: 2,
          label: "Export coordination · Shipment 1",
          detail: "Published commerce list entry",
          availability: "available",
        },
      ],
      nextCursor: null,
    },
  };
}

function dropboxResourceResponse(): Record<string, unknown> {
  return {
    ok: true,
    page: {
      provider: "dropbox",
      entries: [
        {
          kind: "dropbox_folder",
          providerFolderId: "id:recipes",
          name: "Recipes",
          pathDisplay: "/Recipes",
        },
      ],
      nextCursor: null,
    },
  };
}

function googleDrivePickerResponse(): Record<string, unknown> {
  return {
    ok: true,
    config: {
      clientId: "client.apps.googleusercontent.com",
      apiKey: "picker-key",
      appId: "picker-app",
      expectedPermissionId: "permission-id",
      scope: "https://www.googleapis.com/auth/drive.file",
    },
  };
}

function opaque(
  prefix: "subject" | "source" | "target" | "case",
  digit: string,
): string {
  return `${prefix}_${digit.repeat(32)}`;
}

function ignore(): void {}
async function unusedDropboxDiscovery(): Promise<never> {
  throw new Error("Dropbox discovery is not called during static rendering");
}
async function unusedDrivePicker(): Promise<never> {
  throw new Error("Google Drive Picker is not called during static rendering");
}
async function unusedGooglePickerConfig(): Promise<never> {
  throw new Error(
    "Google Drive Picker is not called during transport routing verification",
  );
}

async function testCustomOperationGrant(): Promise<void> {
  const account = {
    integrationAccountId: "integration_inventory",
    displayName: "Main inventory",
    lifecycle: "active" as const,
    acceptedRevision: 2,
    bindingRevision: 3,
    credentialGeneration: 2,
  };
  const detail: CustomConnectorDetail = {
    summary: {
      connectorId: "custom_connector_inventory",
      lifecycle: "active",
      headRevision: 3,
      name: "Inventory",
      description: "Inventory operations",
      origin: "https://api.inventory.example",
      reviewState: "draft",
      accountCount: 1,
      accounts: [account],
      createdAt: 1,
      updatedAt: 10,
    },
    accounts: [account],
    revisions: [
      {
        revision: 3,
        reviewState: "draft",
        authoringDigest: "b".repeat(64),
        authoringDocument: {},
        definitionDigest: null,
        definition: null,
        validationFailure: null,
      },
      {
        revision: 2,
        reviewState: "approved",
        authoringDigest: "a".repeat(64),
        authoringDocument: {},
        definitionDigest: "c".repeat(64),
        definition: {
          operations: [
            {
              id: "list_products",
              description: "List products",
              effect: { kind: "read" },
            },
            {
              id: "create_product",
              description: "Create a product",
              effect: { kind: "external_record_create" },
            },
          ],
        },
        validationFailure: null,
      },
    ],
  };
  const reads = customOperationChoices(
    detail,
    account.integrationAccountId,
    "custom_connector.read",
  );
  const writes = customOperationChoices(
    detail,
    account.integrationAccountId,
    "custom_connector.write",
  );
  expect(reads.map(operationId)).toEqual(["list_products"]);
  expect(writes.map(operationId)).toEqual(["create_product"]);
  expect(
    customOperationChoices(
      detail,
      "integration_other",
      "custom_connector.write",
    ),
  ).toEqual([]);
  const disabled: CustomConnectorDetail = {
    ...detail,
    accounts: [{ ...account, lifecycle: "disabled" }],
  };
  expect(
    customOperationChoices(
      disabled,
      account.integrationAccountId,
      "custom_connector.write",
    ),
  ).toEqual([]);
  const stale: CustomConnectorDetail = {
    ...detail,
    accounts: [{ ...account, acceptedRevision: 3 }],
  };
  expect(
    customOperationChoices(
      stale,
      account.integrationAccountId,
      "custom_connector.write",
    ),
  ).toEqual([]);
  const selection = writes[0];
  const definition = CAPABILITY_CATALOGUE.find(isCustomWriteCapability);
  if (selection === undefined || definition === undefined)
    throw new Error("custom operation fixture missing");
  const capability: AccessControlCapabilityView = {
    definition,
    mode: "approval_required",
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_defaults",
    },
    revision: 1,
    changedAt: 1,
    availability: "available",
    activeGrantCount: 0,
    actions: { kind: "change_capability_mode" },
  };
  const target = grantTarget({
    kind: "custom_connector_operation",
    capability,
    selection,
    subject: {
      kind: "conversation",
      refId: "conversation_cafe",
      revision: 1,
      label: "#cafe",
      detail: "Slack",
      availability: "available",
    },
  });
  expect(target).toEqual({
    ok: true,
    value: {
      kind: "custom_connector_operation",
      capabilityRef: {
        capabilityId: "custom_connector.write",
        capabilityVersion: 1,
      },
      integrationRef: "integration:integration_inventory",
      connectorId: "custom_connector_inventory",
      definitionRevision: 2,
      definitionDigest: "c".repeat(64),
      operationId: "create_product",
    },
  });
  if (!target.ok) throw new Error(target.message);
  const mutate = vi.fn().mockResolvedValue({ ok: true });
  const transport = createAccessRouteTransport(
    vi.fn(),
    mutate,
    unusedGooglePickerConfig,
  );
  await transport.mutate("organisation_cafe", {
    kind: "create_grant",
    expectedRevision: 7,
    subjectRef: { subjectRefId: opaque("subject", "2"), revision: 1 },
    target: target.value,
  });
  expect(mutate).toHaveBeenCalledWith(
    "/v1/control/organisations/organisation_cafe/access-control/grants",
    "POST",
    expect.objectContaining({ expectedRevision: 7, target: target.value }),
  );
  expect(
    readCustomConnectorAccessHandoff(
      "?customConnector=custom_connector_inventory&integrationAccount=integration_inventory&operationId=create_product",
    ),
  ).toEqual({
    connectorId: "custom_connector_inventory",
    integrationAccountId: "integration_inventory",
    operationId: "create_product",
  });
  expect(
    readCustomConnectorAccessHandoff(
      "?customConnector=custom_connector_inventory",
    ),
  ).toBeNull();
}
function operationId(operation: { operationId: string }): string {
  return operation.operationId;
}
function isCustomWriteCapability(definition: {
  capabilityId: string;
}): boolean {
  return definition.capabilityId === "custom_connector.write";
}
