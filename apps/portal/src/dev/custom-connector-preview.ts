import type {
  CustomConnectorAccountView,
  CustomConnectorAction,
  CustomConnectorRevisionView,
  CustomConnectorSetupAttempt,
  CustomConnectorSummary,
} from "@purin-labs/control-api/portal/custom-connectors";
import { isRecord } from "@purin-labs/std";

/**
 * A stand-in for the custom connector routes, so the real drawer can be used
 * end to end without a control session. Each change answers as Pantry does,
 * and the state stays in this tab (sessionStorage) across a reload.
 *
 *   ?customConnector=new                    add a connector (Import JSON)
 *   ?customConnector=preview_connector      an approved connector with one account
 *     &connectorState=default               the same, from the start again
 *     &connectorState=review                a validated draft: one Approve press
 *     &connectorState=draft                 a draft that the press validates first
 *     &connectorState=approved              approved, no account: the key field
 *     &connectorState=uncertain|no-preview  with &customAction=preview_action
 *     &setupAttempt=preview_attempt         a setup that stopped
 *       (&connectorState=test: verified, failed: test failed)
 *
 * The key `wrong` fails the identity test.
 */
const NOW = Date.parse("2026-09-13T09:00:00Z");
const ROOT = "/v1/control/organisations/organisation_preview/custom-connectors";
const definition = {
  schemaVersion: 1,
  name: "Supplier inventory",
  description: "Read supplier stock and request a delivery.",
  origin: "https://inventory.example",
  authentication: { kind: "bearer" },
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
const KYOTO: CustomConnectorAccountView = {
  integrationAccountId: "preview_account",
  displayName: "Kyoto bakery",
  lifecycle: "active",
  acceptedRevision: 1,
  bindingRevision: 1,
  credentialGeneration: 1,
};

type ReviewState = CustomConnectorRevisionView["reviewState"];

type PreviewConnector = {
  connectorId: string;
  lifecycle: CustomConnectorSummary["lifecycle"];
  revision: number;
  reviewState: ReviewState;
  document: Readonly<Record<string, unknown>>;
  validationFailure: Readonly<Record<string, unknown>> | null;
  rejectionReason: string | null;
  acceptedRevision: number;
  accounts: CustomConnectorAccountView[];
  attempt: CustomConnectorSetupAttempt | null;
  /** The key of the open setup failed its identity test. */
  wrongKey: boolean;
  version: number;
  /** The connectorState that made this state. */
  scenario: string;
};

type Answer = Readonly<{ status: number; body: unknown }>;

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
  if (!url.pathname.startsWith(ROOT)) return fetchOriginal(input, init);
  const method = init?.method ?? "GET";
  const body = await readBody(init);
  const answer = route(
    method,
    url.pathname.slice(ROOT.length).split("/").filter(Boolean),
    body,
  );
  return Response.json(answer.body, { status: answer.status });
}

function route(
  method: string,
  segments: readonly string[],
  body: Readonly<Record<string, unknown>>,
): Answer {
  const scenario = readScenario();
  const [connectorId, part, partId, action] = segments.map(decodeURIComponent);
  if (connectorId === undefined) {
    if (method === "POST") return createConnector(body);
    return ok({
      kind: "custom_connector_catalog",
      items: scenario === "empty" ? [] : [summary(load("preview_connector"))],
    });
  }
  const state = load(connectorId);
  if (part === "actions")
    return method === "GET"
      ? ok({ ok: true, action: previewActionWire(scenario) })
      : refused("preview_write_decisions_not_saved");
  if (part === undefined) {
    if (method === "GET") return ok(detailWire(state));
    if (method === "DELETE") return save(state, { kind: "removed" });
    return refused("custom_connector_request_invalid");
  }
  if (part === "disable" || part === "resume") {
    state.lifecycle = part === "disable" ? "disabled" : "active";
    if (part === "disable") state.accounts = state.accounts.map(disableAccount);
    return save(state, { kind: `custom_connector_${part}d` });
  }
  if (part === "revisions" && partId === undefined)
    return newRevision(state, body);
  if (part === "revisions") return reviseRevision(state, action);
  if (part === "setup-attempts" && partId === undefined)
    return startSetup(state, body);
  if (part === "setup-attempts" && method === "GET") {
    const attempt = state.attempt ?? stoppedAttempt(scenario);
    return ok({ kind: "custom_connector_setup", attempt });
  }
  if (part === "setup-attempts") return advanceSetup(state, action, body);
  return refused("custom_connector_request_invalid");
}

function createConnector(body: Readonly<Record<string, unknown>>): Answer {
  const document = isRecord(body.document) ? body.document : {};
  const state: PreviewConnector = {
    ...initial("preview_new"),
    lifecycle: "draft",
    reviewState: "draft",
    document,
    accounts: [],
  };
  return save(state, {
    kind: "custom_connector_created",
    connectorId: state.connectorId,
    revision: revisionWire(state),
  });
}

function newRevision(
  state: PreviewConnector,
  body: Readonly<Record<string, unknown>>,
): Answer {
  state.revision += 1;
  state.reviewState = "draft";
  state.document = isRecord(body.document) ? body.document : state.document;
  state.validationFailure = null;
  state.rejectionReason = null;
  return save(state, {
    kind: "custom_connector_revision_created",
    revision: revisionWire(state),
  });
}

function reviseRevision(
  state: PreviewConnector,
  action: string | undefined,
): Answer {
  switch (action) {
    case "validate": {
      const failure = validationFailure(state.document);
      if (failure !== null) {
        state.validationFailure = failure;
        save(state, null);
        return refused("custom_connector_validation_failed");
      }
      state.reviewState = "validated";
      break;
    }
    case "approve":
      if (state.reviewState !== "validated")
        return refused("custom_connector_revision_conflict");
      state.reviewState = "approved";
      state.lifecycle = state.lifecycle === "disabled" ? "disabled" : "active";
      break;
    case "reject":
      state.reviewState = "rejected";
      state.rejectionReason = "Preview rejection";
      break;
    case "retire":
      state.reviewState = "retired";
      break;
    default:
      return refused("custom_connector_request_invalid");
  }
  return save(state, {
    kind: `custom_connector_revision_${action}d`,
    revision: revisionWire(state),
  });
}

function startSetup(
  state: PreviewConnector,
  body: Readonly<Record<string, unknown>>,
): Answer {
  if (state.reviewState !== "approved" && state.reviewState !== "validated")
    return refused("custom_connector_revision_not_available");
  const target = isRecord(body.target) ? body.target : {};
  state.attempt = {
    attemptId: `preview_attempt_${state.version}`,
    connectorId: state.connectorId,
    connectorRevision: state.revision,
    definitionDigest: `preview-definition-${state.revision}`,
    lifecycle: "awaiting_credential",
    attemptRevision: 1,
    expiresAt: NOW + 1_800_000,
    target:
      target.kind === "new_account"
        ? { kind: "new_account", environment: "production" }
        : {
            kind:
              target.kind === "resume_account" ||
              target.kind === "upgrade_account"
                ? target.kind
                : "rotate_account",
            integrationAccountId: String(target.integrationAccountId),
            expectedBindingRevision: Number(target.expectedBindingRevision),
          },
    verification: null,
  };
  state.wrongKey = false;
  return save(state, {
    kind: "custom_connector_setup_started",
    attempt: state.attempt,
  });
}

function advanceSetup(
  state: PreviewConnector,
  action: string | undefined,
  body: Readonly<Record<string, unknown>>,
): Answer {
  const attempt = state.attempt;
  if (attempt === null) return refused("custom_connector_setup_not_found");
  switch (action) {
    case "credential":
      state.wrongKey = body.credentialValue === "wrong";
      return moveSetup(state, attempt, "credential_stored", "attached");
    case "test":
      if (state.wrongKey) {
        moveSetup(state, attempt, "failed", "tested");
        return refused("custom_connector_identity_test_failed");
      }
      return moveSetup(state, attempt, "verified", "test_verified");
    case "commit":
      commitAccount(state, attempt);
      state.attempt = null;
      return save(state, { kind: "custom_connector_setup_committed" });
    case "cancel":
      return moveSetup(state, attempt, "cancelled", "cancelled");
    default:
      return refused("custom_connector_request_invalid");
  }
}

function moveSetup(
  state: PreviewConnector,
  attempt: CustomConnectorSetupAttempt,
  lifecycle: CustomConnectorSetupAttempt["lifecycle"],
  kind: string,
): Answer {
  state.attempt = {
    ...attempt,
    lifecycle,
    attemptRevision: attempt.attemptRevision + 1,
    verification:
      lifecycle === "verified"
        ? {
            providerAccountId: `provider-${state.accounts.length + 1}`,
            displayName: verifiedName(state, attempt),
            testedAt: Date.now(),
          }
        : attempt.verification,
  };
  return save(state, {
    kind: `custom_connector_${kind}`,
    attempt: state.attempt,
  });
}

function commitAccount(
  state: PreviewConnector,
  attempt: CustomConnectorSetupAttempt,
): void {
  const target = attempt.target;
  if (target.kind === "new_account") {
    state.accounts.push({
      integrationAccountId: `preview_account_${state.accounts.length + 1}`,
      displayName: verifiedName(state, attempt),
      lifecycle: "active",
      acceptedRevision: attempt.connectorRevision,
      bindingRevision: 1,
      credentialGeneration: 1,
    });
  } else {
    state.accounts = state.accounts.map((account) =>
      account.integrationAccountId === target.integrationAccountId
        ? {
            ...account,
            lifecycle: "active",
            acceptedRevision: attempt.connectorRevision,
            bindingRevision: account.bindingRevision + 1,
            credentialGeneration: account.credentialGeneration + 1,
          }
        : account,
    );
  }
  state.acceptedRevision = attempt.connectorRevision;
}

function verifiedName(
  state: PreviewConnector,
  attempt: CustomConnectorSetupAttempt,
): string {
  const target = attempt.target;
  if (target.kind !== "new_account") {
    const account = state.accounts.find(
      (item) => item.integrationAccountId === target.integrationAccountId,
    );
    if (account !== undefined) return account.displayName;
  }
  return state.accounts.length === 0 ? "Kyoto bakery" : "Osaka bakery";
}

function disableAccount(
  account: CustomConnectorAccountView,
): CustomConnectorAccountView {
  return { ...account, lifecycle: "disabled" };
}

function validationFailure(
  document: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  if (typeof document.origin !== "string")
    return { field: "origin", reason: "Add the HTTPS origin of the API." };
  if (!Array.isArray(document.operations) || document.operations.length === 0)
    return { field: "operations", reason: "Add at least one operation." };
  return null;
}

function initial(connectorId: string): PreviewConnector {
  const scenario = readScenario() ?? "default";
  const waiting = scenario === "review" || scenario === "draft";
  const reviewState: ReviewState =
    scenario === "review"
      ? "validated"
      : scenario === "draft"
        ? "draft"
        : "approved";
  return {
    connectorId,
    lifecycle: waiting ? "draft" : "active",
    revision: 1,
    reviewState,
    document: definition,
    validationFailure: null,
    rejectionReason: null,
    acceptedRevision: 1,
    accounts: waiting || scenario === "approved" ? [] : [KYOTO],
    attempt: null,
    wrongKey: false,
    version: 1,
    scenario,
  };
}

/**
 * The state of this tab. The drawer drops connectorState when it changes the
 * address, so the stored state goes on; a new connectorState starts again.
 */
function load(connectorId: string): PreviewConnector {
  const scenario = readScenario();
  try {
    const raw = sessionStorage.getItem(storageKey(connectorId));
    const stored = raw === null ? null : (JSON.parse(raw) as PreviewConnector);
    if (stored !== null && (scenario === null || stored.scenario === scenario))
      return stored;
  } catch {
    // A new state follows.
  }
  return initial(connectorId);
}

function save(
  state: PreviewConnector,
  body: Record<string, unknown> | null,
): Answer {
  state.version += 1;
  try {
    sessionStorage.setItem(
      storageKey(state.connectorId),
      JSON.stringify(state),
    );
  } catch {
    // The preview still answers without storage.
  }
  return ok({ ...body, configurationVersion: state.version });
}

function storageKey(connectorId: string): string {
  return `custom-connector-preview:${connectorId}`;
}

function readScenario(): string | null {
  return new URLSearchParams(window.location.search).get("connectorState");
}

function summary(state: PreviewConnector): CustomConnectorSummary {
  const document = state.document;
  return {
    connectorId: state.connectorId,
    lifecycle: state.lifecycle,
    headRevision: state.revision,
    name: typeof document.name === "string" ? document.name : null,
    description:
      typeof document.description === "string" ? document.description : null,
    origin:
      state.reviewState === "draft" || typeof document.origin !== "string"
        ? null
        : document.origin,
    reviewState: state.reviewState,
    accountCount: state.accounts.length,
    accounts: state.accounts,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function revisionWire(state: PreviewConnector) {
  const validated = state.reviewState !== "draft";
  return {
    revision: state.revision,
    reviewState: state.reviewState,
    authoringDigest: `preview-authoring-${state.revision}`,
    authoringDocument: state.document,
    definitionDigest: validated ? `preview-definition-${state.revision}` : null,
    definition: validated ? state.document : null,
    validationFailure: state.validationFailure,
    rejection:
      state.rejectionReason === null ? null : { reason: state.rejectionReason },
  };
}

function detailWire(state: PreviewConnector) {
  const revisions = [revisionWire(state)];
  if (state.revision > 1 && state.acceptedRevision < state.revision)
    revisions.push({
      ...revisionWire({ ...state, revision: state.acceptedRevision }),
      reviewState: "approved",
      definitionDigest: `preview-definition-${state.acceptedRevision}`,
      definition,
      authoringDocument: definition,
    });
  return {
    kind: "custom_connector_detail",
    summary: summary(state),
    revisions,
    accounts: state.accounts,
  };
}

function stoppedAttempt(scenario: string | null): CustomConnectorSetupAttempt {
  return {
    attemptId: "preview_attempt",
    connectorId: "preview_connector",
    connectorRevision: 1,
    definitionDigest: "preview-definition-1",
    lifecycle:
      scenario === "test"
        ? "verified"
        : scenario === "failed"
          ? "failed"
          : "awaiting_credential",
    attemptRevision: 1,
    expiresAt: NOW + 1_800_000,
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
    definitionDigest: "preview-definition-1",
    bindingRevision: 1,
    credentialGeneration: 1,
    resourceIdentity: { kind: "new_record" },
    canonicalInputDigest: "preview-input",
    proposedAt: NOW,
    updatedAt: NOW,
    providerResult: null,
    preview:
      scenario === "no-preview"
        ? { kind: "unavailable", reason: "definition_unavailable" }
        : availablePreview,
  };
}

/** The review of a write; `connectorState=no-preview` shows a write with none. */
const availablePreview: CustomConnectorAction["preview"] = {
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
};

async function readBody(
  init: RequestInit | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  if (typeof init?.body !== "string") return {};
  try {
    const value: unknown = JSON.parse(init.body);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function ok(body: unknown): Answer {
  return { status: 200, body };
}

function refused(error: string): Answer {
  return { status: error.endsWith("not_found") ? 404 : 409, body: { error } };
}
