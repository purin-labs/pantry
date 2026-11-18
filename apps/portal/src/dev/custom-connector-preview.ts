import type { CustomConnectorAction, CustomConnectorRevisionView, CustomConnectorSetupAttempt } from "@seams/control-api/portal/custom-connectors";
import type { CustomConnectorDetail } from "../features/integrations/custom-connector-api";

const NOW = Date.parse("2026-09-13T09:00:00Z");
const definition = {
  schemaVersion: 1,
  name: "Supplier inventory",
  description: "Read supplier stock and request a delivery.",
  origin: "https://inventory.example",
  operations: [
    {
      id: "find_products",
      description: "Find products",
      effect: { kind: "read" },
    },
    {
      id: "create_stock_request",
      description: "Create a stock request",
      effect: { kind: "external_record_create" },
    },
  ],
};
const revision: CustomConnectorRevisionView = {
  revision: 1,
  reviewState: "approved",
  authoringDigest: "preview-authoring",
  authoringDocument: definition,
  definitionDigest: "preview-definition",
  definition,
  validationFailure: null,
  rejectionReason: null,
};
const detail: CustomConnectorDetail = {
  summary: {
    connectorId: "preview_connector",
    lifecycle: "active",
    headRevision: 1,
    name: "Supplier inventory",
    description: "Read supplier stock and request a delivery.",
    origin: "https://inventory.example",
    reviewState: "approved",
    accountCount: 1,
    accounts: [
      {
        integrationAccountId: "preview_account",
        displayName: "Kyoto bakery",
        lifecycle: "active",
        acceptedRevision: 1,
        bindingRevision: 1,
        credentialGeneration: 1,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  },
  revisions: [revision],
  accounts: [
    {
      integrationAccountId: "preview_account",
      displayName: "Kyoto bakery",
      lifecycle: "active",
      acceptedRevision: 1,
      bindingRevision: 1,
      credentialGeneration: 1,
    },
  ],
};

// Preview-only responses keep the real screens reviewable without a control session.
export function installCustomConnectorPreview(): void {
  window.fetch = previewFetch.bind(null, window.fetch.bind(window));
}

async function previewFetch(
  fetchOriginal: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  if (
    !url.pathname.startsWith(
      "/v1/control/organisations/organisation_preview/custom-connectors",
    )
  )
    return fetchOriginal(input, init);
  if ((init?.method ?? "GET") !== "GET")
    return Response.json(
      { error: "Preview only: changes are not saved." },
      { status: 409 },
    );
  const scenario = new URLSearchParams(window.location.search).get(
    "connectorState",
  );
  if (url.pathname.includes("/actions/"))
    return Response.json({ ok: true, action: previewActionWire(scenario) });
  if (url.pathname.includes("/setup-attempts/"))
    return Response.json({
      kind: "custom_connector_setup",
      attempt: previewAttempt(scenario),
    });
  if (url.pathname.endsWith("/preview_connector"))
    return Response.json({
      kind: "custom_connector_detail",
      ...previewDetail(scenario),
    });
  return Response.json({
    kind: "custom_connector_catalog",
    items:
      new URLSearchParams(window.location.search).get("scenario") === "empty"
        ? []
        : [detail.summary],
  });
}

function previewDetail(scenario: string | null): CustomConnectorDetail {
  if (scenario !== "review") return detail;
  return {
    summary: {
      connectorId: detail.summary.connectorId,
      lifecycle: "draft",
      headRevision: 1,
      name: detail.summary.name,
      description: detail.summary.description,
      origin: detail.summary.origin,
      reviewState: "validated",
      accountCount: 0,
      accounts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
    revisions: [
      {
        revision: 1,
        reviewState: "validated",
        authoringDigest: revision.authoringDigest,
        authoringDocument: definition,
        definitionDigest: revision.definitionDigest,
        definition,
        validationFailure: null,
        rejectionReason: null,
      },
    ],
    accounts: [],
  };
}

function previewAttempt(scenario: string | null): CustomConnectorSetupAttempt {
  return {
    attemptId: "preview_attempt",
    connectorId: "preview_connector",
    connectorRevision: 1,
    definitionDigest: "preview-definition",
    lifecycle: previewSetupLifecycle(scenario),
    attemptRevision: 1,
    expiresAt: NOW + 3600000,
    target: { kind: "new_account", environment: "production" },
    verification:
      scenario === "test"
        ? {
            providerAccountId: "kyoto",
            displayName: "Kyoto bakery",
            testedAt: NOW,
          }
        : null,
  };
}

/** The action as Pantry sends it: the policy instead of its parsed header. */
function previewActionWire(scenario: string | null) {
  const { idempotencyHeader, ...action } = previewAction(scenario);
  return {
    ...action,
    retryPolicy:
      idempotencyHeader === null
        ? { kind: "single_attempt" }
        : { kind: "provider_idempotent", header: idempotencyHeader },
  };
}

function previewAction(scenario: string | null): CustomConnectorAction {
  return {
    nonce: "preview_action",
    state: scenario === "uncertain" ? "indeterminate" : "proposed",
    connectorId: "preview_connector",
    integrationAccountId: "preview_account",
    operationId: "create_stock_request",
    effect: "external_record_create",
    idempotencyHeader: scenario === "uncertain" ? "idempotency-key" : null,
    providerEffectId: "request-042",
    definitionRevision: 1,
    definitionDigest: "preview-definition",
    bindingRevision: 1,
    credentialGeneration: 1,
    resourceIdentity: { kind: "new_record" },
    canonicalInputDigest: "preview-input",
    proposedAt: NOW,
    updatedAt: NOW,
    providerResult: null,
    preview: {
      kind: "available",
      accountDisplayName: "Kyoto bakery",
      operationLabel: "Create a stock request",
      origin: "https://inventory.example",
      method: "POST",
      path: "/requests",
      fields: [
        { path: "body.product", value: "Bread flour" },
        { path: "body.quantity", value: 20 },
        {
          path: "body.delivery",
          value: { date: "2026-09-15", note: "Before 8 am" },
        },
      ],
    },
  };
}

function previewSetupLifecycle(
  scenario: string | null,
): CustomConnectorSetupAttempt["lifecycle"] {
  switch (scenario) {
    case "test":
      return "verified";
    case "failed":
      return "failed";
    default:
      return "awaiting_credential";
  }
}
