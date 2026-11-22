import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseTerminalAssignment,
  type PointOfSaleConfiguration,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";

import type { Env } from "@purin-labs/kernel/env";
import { admitUserMutation } from "@purin-labs/control/worker/admission/control-mutation";
import { authorizeOrganisationRequest } from "@purin-labs/control/worker/authorization";
import {
  controlError,
  controlJson,
  readJsonRecord,
} from "@purin-labs/control/worker/http";
import type { ControlMutationReceiptScope } from "@purin-labs/tenancy/data/control-mutation";
import { recordCommerceMutationReceipt } from "@purin-labs/control/worker/mutation-receipt";
import { resolveUser } from "@purin-labs/tenancy/data/control-plane";
import {
  listIntegrationAccounts,
  type IntegrationAccount,
} from "@purin-labs/connections/data/integration-account";
import { listProviderResourcePage } from "@purin-labs/connections/data/provider-resource";
import {
  activateTerminalAssignment,
  readActiveTerminalAssignment,
  retireTerminalAssignment,
} from "../../data/terminal-assignment-store";
import { readTerminalOperations } from "../../data/terminal-operations-readback";
import { resolveOrganisationCommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import {
  parseIntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { createCommerceClient } from "../../commerce/contract/client";
import { readOrganisationEnvironment } from "../organisation-runtime";
import {
  resolveCommerceMerchant,
  type CommerceMerchant,
} from "../../commerce/contract/square-link";
import type {
  CommerceClientError,
  CommerceSquareDeviceCodeV1,
} from "@purin-labs/commerce-client";
import type { Variant } from "@purin-labs/type-utils";
import type {
  TerminalConfigurationRequest,
  TerminalPairingReadback,
  TerminalPairingRequest,
} from "@purin-labs/control-api";

/** The adapter version that a Square Terminal assignment records. */
const SQUARE_TERMINAL_ADAPTER_VERSION = "square_terminal@2026-08-19";
/** The Point of Sale API version that the Register's handoff link names. */
const SQUARE_POS_APP_ADAPTER_VERSION = "square_pos_app@1.3";

/**
 * The operator's view of card-present counters. Development organisations can bind a
 * Square Sandbox test scenario here. A production organisation pairs a
 * physical Square Terminal with a code (Plan 77 step 8): Pantry asks Square
 * for the code, the owner types it on the Terminal, and once Square names
 * the device the counter's assignment takes it. Square's device code is the
 * record of the ceremony; Pantry keeps no copy, and Square marks a code
 * expired after about five minutes.
 */
export type TerminalOperationsControlRoute =
  | Readonly<{ kind: "terminalOperations"; organisationIdRaw: string }>
  | Readonly<{ kind: "terminalPairings"; organisationIdRaw: string }>
  | Readonly<{
      kind: "terminalPairing";
      organisationIdRaw: string;
      deviceCodeIdRaw: string;
    }>
  | Readonly<{
      kind: "terminalPairingActivation";
      organisationIdRaw: string;
      deviceCodeIdRaw: string;
    }>
  | Readonly<{
      kind: "terminalRetirement";
      organisationIdRaw: string;
      pantryLocationIdRaw: string;
    }>
  | Readonly<{ kind: "terminalSquarePosApp"; organisationIdRaw: string }>;

export function matchTerminalOperationsControlRoute(
  pathname: string,
): TerminalOperationsControlRoute | null {
  const pairings = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/terminal-operations\/pairings$/u,
  );
  if (pairings !== null) {
    return {
      kind: "terminalPairings",
      organisationIdRaw: decode(pairings[0]),
    };
  }
  const pairing = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/terminal-operations\/pairings\/([^/]+)(\/activation)?$/u,
  );
  if (pairing !== null) {
    return {
      kind:
        pairing[2] === undefined
          ? "terminalPairing"
          : "terminalPairingActivation",
      organisationIdRaw: decode(pairing[0]),
      deviceCodeIdRaw: decode(pairing[1]),
    };
  }
  const squarePosApp = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/terminal-operations\/square-pos-app$/u,
  );
  if (squarePosApp !== null) {
    return {
      kind: "terminalSquarePosApp",
      organisationIdRaw: decode(squarePosApp[0]),
    };
  }
  const retirement = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/terminal-operations\/([^/]+)\/retirement$/u,
  );
  if (retirement !== null) {
    return {
      kind: "terminalRetirement",
      organisationIdRaw: decode(retirement[0]),
      pantryLocationIdRaw: decode(retirement[1]),
    };
  }
  const operations = match(
    pathname,
    /^\/v1\/control\/organisations\/([^/]+)\/commerce\/terminal-operations$/u,
  );
  return operations === null
    ? null
    : { kind: "terminalOperations", organisationIdRaw: decode(operations[0]) };
}

export function handleTerminalOperationsControlRoute(
  request: Request,
  env: Env,
  route: TerminalOperationsControlRoute,
): Promise<Response> {
  switch (route.kind) {
    case "terminalOperations":
      return handleTerminalOperationsRead(
        request,
        env,
        route.organisationIdRaw,
      );
    case "terminalRetirement":
      return handleTerminalRetirement(request, env, route);
    case "terminalPairings":
      return handleTerminalPairingStart(request, env, route.organisationIdRaw);
    case "terminalPairing":
      return handleTerminalPairingRead(request, env, route);
    case "terminalPairingActivation":
      return handleTerminalPairingActivation(request, env, route);
    case "terminalSquarePosApp":
      return handleSquarePosAppAssignment(
        request,
        env,
        route.organisationIdRaw,
      );
  }
}

/** The counters, with the Square locations that Commerce has linked. */
async function readTerminalOperationsOf(
  env: Env,
  authorized: AuthorizedRequest,
  now: number,
) {
  const merchant = await resolveCommerceMerchant(
    env,
    authorized.executionScope,
    authorized.organisationId,
  );
  const accounts =
    merchant === null
      ? null
      : await merchant.client.listPaymentAccounts(merchant.merchantId);
  const linkedLocationIds = new Set<string>();
  if (accounts?.ok === true)
    for (const account of accounts.value.accounts)
      if (account.provider === "square")
        linkedLocationIds.add(account.locationId);
  return readTerminalOperations({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    now,
    linkedLocationIds,
  });
}

async function handleTerminalOperationsRead(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method === "POST") {
    return handleTerminalSandboxConfiguration(request, env, organisationIdRaw);
  }
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const operations = await readTerminalOperationsOf(
    env,
    authorized,
    Date.now(),
  );
  const configuration = await readTerminalConfiguration(
    env,
    authorized.executionScope,
  );
  return configuration.kind === "error"
    ? configuration.response
    : controlJson({ ok: true, terminalOperations: operations, configuration });
}

type TerminalConfiguration =
  | Readonly<{ kind: "blocked"; reason: "commerce_system_missing" }>
  | Readonly<{
      kind: "ready";
      merchantId: string;
      /**
       * A development organisation binds Sandbox test devices; a production
       * one pairs physical Terminals.
       */
      environment: "development" | "production";
      pantryLocations: readonly PantryLocationChoice[];
      squareAccounts: readonly SquareAccountChoice[];
      testDevices: readonly SandboxTestDevice[];
    }>
  | Readonly<{ kind: "error"; response: Response }>;

type SquareAccountChoice = Readonly<{
  integrationAccountId: string;
  providerAccountId: string;
  displayName: string;
  locations: readonly SquareLocationChoice[];
}>;

type PantryLocationChoice = Readonly<{
  pantryLocationId: string;
  currency: string;
  supportedItems: readonly Readonly<{
    variantId: string;
    maxQuantityPerLine: number;
  }>[];
}>;

type SquareLocationChoice = Readonly<{
  providerLocationId: string;
  displayName: string;
  country: string;
  currency: string;
}>;

type SandboxTestDevice = Readonly<{
  testDeviceId: string;
  label: string;
  expectedOutcome: "success" | "buyer_cancel" | "timeout";
}>;

const SQUARE_SANDBOX_TEST_DEVICES: readonly SandboxTestDevice[] = [
  {
    testDeviceId: "9fa747a2-25ff-48ee-b078-04381f7c828f",
    label: "Successful payment",
    expectedOutcome: "success",
  },
  {
    testDeviceId: "841100b9-ee60-4537-9bcf-e30b2ba5e215",
    label: "Buyer cancels",
    expectedOutcome: "buyer_cancel",
  },
  {
    testDeviceId: "0a956d49-619a-4530-8e5e-8eac603ffc5e",
    label: "Checkout times out",
    expectedOutcome: "timeout",
  },
];

async function readTerminalConfiguration(
  env: Env,
  scope: OrganisationExecutionScope,
): Promise<TerminalConfiguration> {
  const organisationId = scope.organisationId;
  const environment = await readOrganisationEnvironment(
    scope.database,
    organisationId,
  );
  if (environment === null)
    return { kind: "blocked", reason: "commerce_system_missing" };
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db: scope.database,
    organisationId,
    environment,
  });
  if (!binding.ok)
    return { kind: "blocked", reason: "commerce_system_missing" };
  const client = createCommerceClient(env, undefined, {
    kind: "organisation",
    organisationId: String(organisationId),
  });
  if (client === null) {
    return {
      kind: "error",
      response: controlError("commerce_unavailable", 503),
    };
  }
  const policies = await client.listPointOfSaleConfigurations(
    binding.value.merchantId,
  );
  if (!policies.ok) {
    return {
      kind: "error",
      response: controlError("commerce_unavailable", 503),
    };
  }
  const accounts = await listIntegrationAccounts({
    db: scope.database,
    organisationId,
  });
  return {
    kind: "ready",
    merchantId: binding.value.merchantId,
    environment,
    pantryLocations: policies.value.map(pointOfSaleLocation),
    squareAccounts: await readSquareAccountChoices(
      scope.database,
      organisationId,
      accounts,
      environment,
    ),
    testDevices:
      environment === "development" ? SQUARE_SANDBOX_TEST_DEVICES : [],
  };
}

function pointOfSaleLocation(
  policy: PointOfSaleConfiguration,
): PantryLocationChoice {
  return {
    pantryLocationId: policy.pantryLocationId,
    currency: policy.currency,
    supportedItems: policy.supportedItems,
  };
}

async function readSquareAccountChoices(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  accounts: readonly IntegrationAccount[],
  environment: "development" | "production",
): Promise<readonly SquareAccountChoice[]> {
  const choices: SquareAccountChoice[] = [];
  for (const account of accounts) {
    if (
      account.provider !== "square" ||
      account.environment !== environment ||
      account.lifecycle.kind !== "active"
    )
      continue;
    const page = await listProviderResourcePage({
      db,
      organisationId,
      integrationAccountId: account.integrationAccountId,
      query: "",
      cursor: null,
      now: Date.now(),
    });
    const locations: SquareLocationChoice[] = [];
    if (page.ok) {
      for (const resource of page.value.resources) {
        const location = squareLocationChoice(resource);
        if (location !== null) locations.push(location);
      }
    }
    choices.push({
      integrationAccountId: account.integrationAccountId,
      providerAccountId: account.providerAccountId,
      displayName: account.displayName,
      locations,
    });
  }
  return choices;
}

function squareLocationChoice(
  resource: Readonly<{
    provider_resource_id: string;
    display_label: string;
    access_state: "accessible" | "inaccessible";
    provider_revision: string;
    resource_kind: string;
  }>,
): SquareLocationChoice | null {
  if (
    resource.resource_kind !== "payment_location" ||
    resource.access_state !== "accessible"
  ) {
    return null;
  }
  const match =
    /^square-location:[^:]+:([A-Z]{2}):([A-Z]{3}):payments-enabled$/u.exec(
      resource.provider_revision,
    );
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : {
        providerLocationId: resource.provider_resource_id,
        displayName: resource.display_label,
        country: match[1],
        currency: match[2],
      };
}

async function handleTerminalSandboxConfiguration(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("terminal_configuration_invalid", 422);
  const selection = parseTerminalConfigurationRequest(body.value);
  if (selection === null)
    return controlError("terminal_configuration_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/terminal-operations`,
    operation: "terminal.assignment.configure_sandbox",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;
  const configuration = await readTerminalConfiguration(
    env,
    authorized.executionScope,
  );
  if (configuration.kind === "error") return configuration.response;
  if (configuration.kind === "blocked") {
    return controlError(configuration.reason, 409);
  }
  if (configuration.environment !== "development")
    return controlError("development_organisation_required", 409);
  const account = findSquareAccount(
    configuration.squareAccounts,
    selection.integrationAccountId,
  );
  const location =
    account === null
      ? null
      : findSquareLocation(account.locations, selection.providerLocationId);
  if (
    account === null ||
    location === null ||
    !hasPantryLocation(
      configuration,
      selection.pantryLocationId,
      location.currency,
    ) ||
    !hasSandboxTestDevice(selection.testDeviceId)
  ) {
    return controlError("terminal_configuration_invalid", 422);
  }
  const integrationAccountId = parseIntegrationAccountId(
    account.integrationAccountId,
  );
  if (!integrationAccountId.ok)
    return controlError("integration_account_not_found", 404);
  const sourceAccount = findIntegrationAccount(
    await listIntegrationAccounts({
      db: authorized.executionScope.database,
      organisationId: authorized.organisationId,
    }),
    integrationAccountId.value,
    "development",
  );
  if (sourceAccount === null)
    return controlError("integration_account_not_found", 404);
  const current = await readActiveTerminalAssignment(
    authorized.executionScope.database,
    authorized.organisationId,
    selection.pantryLocationId,
  );
  if (!current.ok && current.error.code === "terminal_assignment_corrupt") {
    return controlError("terminal_assignment_corrupt", 409);
  }
  if (
    current.ok &&
    terminalSelectionMatches(
      current.value,
      configuration,
      selection,
      sourceAccount,
      location,
    )
  ) {
    const now = Date.now();
    const responseBody = {
      ok: true,
      terminalOperations: await readTerminalOperationsOf(env, authorized, now),
      configuration,
    };
    const recordedMutationReceipt = await recordCommerceMutationReceipt({
      authorized,
      identity,
      scope,
      boundary,
      request,
      responseBody,
      now,
    });
    if (!recordedMutationReceipt.ok)
      return controlError(recordedMutationReceipt.error.code, 409);
    return controlJson(responseBody);
  }
  const now = Date.now();
  const assignment = buildSandboxAssignment({
    organisationId: authorized.organisationId,
    merchantId: configuration.merchantId,
    selection,
    sourceAccount,
    location,
    revision: current.ok ? current.value.revision + 1 : 1,
  });
  if (assignment === null)
    return controlError("terminal_configuration_invalid", 422);
  const activated = await activateTerminalAssignment({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    assignment,
    now,
  });
  if (!activated.ok) return controlError(activated.error.code, 409);
  const responseBody = {
    ok: true,
    terminalOperations: await readTerminalOperationsOf(env, authorized, now),
    configuration,
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function parseTerminalConfigurationRequest(
  body: Readonly<Record<string, unknown>>,
): TerminalConfigurationRequest | null {
  const keys = Object.keys(body);
  if (
    keys.length !== 4 ||
    !keys.includes("pantryLocationId") ||
    !keys.includes("integrationAccountId") ||
    !keys.includes("providerLocationId") ||
    !keys.includes("testDeviceId")
  )
    return null;
  return typeof body.pantryLocationId === "string" &&
    body.pantryLocationId.length > 0 &&
    typeof body.integrationAccountId === "string" &&
    body.integrationAccountId.length > 0 &&
    typeof body.providerLocationId === "string" &&
    body.providerLocationId.length > 0 &&
    typeof body.testDeviceId === "string" &&
    body.testDeviceId.length > 0
    ? {
        pantryLocationId: body.pantryLocationId,
        integrationAccountId: body.integrationAccountId,
        providerLocationId: body.providerLocationId,
        testDeviceId: body.testDeviceId,
      }
    : null;
}

function findSquareAccount(
  accounts: readonly SquareAccountChoice[],
  integrationAccountId: string,
): SquareAccountChoice | null {
  for (const account of accounts) {
    if (account.integrationAccountId === integrationAccountId) return account;
  }
  return null;
}

function findSquareLocation(
  locations: readonly SquareLocationChoice[],
  providerLocationId: string,
): SquareLocationChoice | null {
  for (const location of locations) {
    if (location.providerLocationId === providerLocationId) return location;
  }
  return null;
}

function hasPantryLocation(
  configuration: Variant<TerminalConfiguration, "ready">,
  pantryLocationId: string,
  currency: string,
): boolean {
  for (const location of configuration.pantryLocations) {
    if (
      location.pantryLocationId === pantryLocationId &&
      location.currency === currency
    )
      return true;
  }
  return false;
}

function hasSandboxTestDevice(testDeviceId: string): boolean {
  for (const device of SQUARE_SANDBOX_TEST_DEVICES) {
    if (device.testDeviceId === testDeviceId) return true;
  }
  return false;
}

function terminalSelectionMatches(
  assignment: TerminalAssignment,
  configuration: Variant<TerminalConfiguration, "ready">,
  selection: TerminalConfigurationRequest,
  account: IntegrationAccount,
  location: SquareLocationChoice,
): boolean {
  return (
    assignment.state.kind === "active" &&
    assignment.merchantId === configuration.merchantId &&
    assignment.pantryLocationId === selection.pantryLocationId &&
    assignment.account.integrationAccountId === account.integrationAccountId &&
    assignment.account.providerAccountId === account.providerAccountId &&
    assignment.account.environment === account.environment &&
    assignment.account.capabilityRevision === Math.max(1, account.updatedAt) &&
    assignment.providerLocationId === location.providerLocationId &&
    assignment.account.country === location.country &&
    assignment.account.currency === location.currency &&
    assignment.target.kind === "sandbox_simulated" &&
    assignment.target.testDeviceId === selection.testDeviceId &&
    assignment.transport === "server_terminal" &&
    assignment.adapterVersion === SQUARE_TERMINAL_ADAPTER_VERSION
  );
}

function findIntegrationAccount(
  accounts: readonly IntegrationAccount[],
  integrationAccountId: IntegrationAccount["integrationAccountId"],
  environment: "development" | "production",
): IntegrationAccount | null {
  for (const account of accounts) {
    if (
      account.integrationAccountId === integrationAccountId &&
      account.provider === "square" &&
      account.environment === environment &&
      account.lifecycle.kind === "active"
    )
      return account;
  }
  return null;
}

function buildSandboxAssignment(
  input: Readonly<{
    organisationId: OrganisationId;
    merchantId: string;
    selection: TerminalConfigurationRequest;
    sourceAccount: IntegrationAccount;
    location: SquareLocationChoice;
    revision: number;
  }>,
): TerminalAssignment | null {
  const parsed = parseTerminalAssignment({
    assignmentId: `terminal_assignment_${crypto.randomUUID()}`,
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    pantryLocationId: input.selection.pantryLocationId,
    account: {
      integrationAccountId: input.sourceAccount.integrationAccountId,
      providerAccountId: input.sourceAccount.providerAccountId,
      environment: input.sourceAccount.environment,
      capabilityRevision: Math.max(1, input.sourceAccount.updatedAt),
      country: input.location.country,
      currency: input.location.currency,
    },
    providerLocationId: input.location.providerLocationId,
    target: {
      kind: "sandbox_simulated",
      testDeviceId: input.selection.testDeviceId,
    },
    transport: "server_terminal",
    adapterVersion: SQUARE_TERMINAL_ADAPTER_VERSION,
    revision: input.revision,
    state: { kind: "active" },
  });
  return parsed.ok ? parsed.value : null;
}

type AuthorizedRequest = Extract<
  Awaited<ReturnType<typeof authorizeOrganisationRequest>>,
  { ok: true }
>;

type PairingContext = Readonly<{
  configuration: Variant<TerminalConfiguration, "ready">;
  account: SquareAccountChoice;
  sourceAccount: IntegrationAccount;
  /** Commerce holds the Square connection and asks Square (Plan 80 step 4). */
  square: CommerceMerchant;
}>;

/** A Square device code as Commerce reads it. */
type PairingCode = Readonly<{
  id: string;
  code: string;
  locationId: string;
  pairBy: string | null;
  status: string;
  deviceId: string | null;
}>;

/** POST …/terminal-operations/pairings: asks Square for a pairing code. */
async function handleTerminalPairingStart(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const change = await beginSquareCounterChange(
    request,
    env,
    organisationIdRaw,
    {
      parse: parseTerminalPairingRequest,
      invalid: "terminal_pairing_invalid",
      operation: "terminal.pairing.start",
      suffix: "/pairings",
    },
  );
  if (change instanceof Response) return change;
  const { authorized, mutation, context, selection } = change;
  const location = counterLocation(
    context,
    selection.pantryLocationId,
    selection.providerLocationId,
  );
  if (location === null) return controlError("terminal_pairing_invalid", 422);
  const created = await context.square.client.createSquareDeviceCode(
    context.square.merchantId,
    {
      locationId: location.providerLocationId,
      name: selection.deviceName,
      idempotencyKey: mutation.boundary.idempotencyKey,
    },
  );
  if (!created.ok) return pairingProviderError(created.error);
  const responseBody = {
    ok: true,
    pairing: pairingReadback(pairingCode(created.value), Date.now()),
  };
  return finishCounterMutation(request, authorized, mutation, responseBody);
}

/**
 * GET …/terminal-operations/pairings/:deviceCodeId?integrationAccountId=…:
 * the code as Square has it now.
 */
async function handleTerminalPairingRead(
  request: Request,
  env: Env,
  route: Variant<TerminalOperationsControlRoute, "terminalPairing">,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "admin",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const integrationAccountId =
    new URL(request.url).searchParams.get("integrationAccountId") ?? "";
  const context = await pairingContext(env, authorized, integrationAccountId);
  if (context instanceof Response) return context;
  const read = await readPairingCode(context, route.deviceCodeIdRaw);
  if (read instanceof Response) return read;
  return controlJson({
    ok: true,
    pairing: pairingReadback(read.code, Date.now()),
  });
}

/**
 * POST …/terminal-operations/pairings/:deviceCodeId/activation: once Square
 * names the paired device, the counter's assignment takes it, and the
 * merchant's in-person payment authority follows.
 */
async function handleTerminalPairingActivation(
  request: Request,
  env: Env,
  route: Variant<TerminalOperationsControlRoute, "terminalPairingActivation">,
): Promise<Response> {
  const change = await beginSquareCounterChange(
    request,
    env,
    route.organisationIdRaw,
    {
      parse: parseTerminalPairingActivation,
      invalid: "terminal_pairing_invalid",
      operation: "terminal.pairing.activate",
      suffix: `/pairings/${route.deviceCodeIdRaw}/activation`,
    },
  );
  if (change instanceof Response) return change;
  const read = await readPairingCode(change.context, route.deviceCodeIdRaw);
  if (read instanceof Response) return read;
  const state = pairingReadback(read.code, Date.now()).status;
  if (state !== "paired" || read.code.deviceId === null)
    return controlError(`terminal_pairing_${state}`, 409);
  if (
    !hasPantryLocation(
      change.context.configuration,
      change.selection.pantryLocationId,
      read.location.currency,
    )
  )
    return controlError("terminal_pairing_invalid", 422);
  return assignCounterTarget(request, change, {
    location: read.location,
    target: { kind: "paired_physical", providerDeviceId: read.code.deviceId },
    transport: "server_terminal",
    adapterVersion: SQUARE_TERMINAL_ADAPTER_VERSION,
    invalid: "terminal_pairing_invalid",
  });
}

/**
 * Lets the Square Point of Sale app on the counter iPad take a counter's
 * card, e-money and PayPay payments on a Square Reader (Plan 90 Phase 3B).
 * Square's Sandbox has no Point of Sale API, so only a production
 * organisation can choose it.
 */
async function handleSquarePosAppAssignment(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  const change = await beginSquareCounterChange(
    request,
    env,
    organisationIdRaw,
    {
      parse: parseSquarePosAppSelection,
      invalid: "terminal_configuration_invalid",
      operation: "terminal.assignment.square_pos_app",
      suffix: "/square-pos-app",
    },
  );
  if (change instanceof Response) return change;
  const location = counterLocation(
    change.context,
    change.selection.pantryLocationId,
    change.selection.providerLocationId,
  );
  if (location === null)
    return controlError("terminal_configuration_invalid", 422);
  return assignCounterTarget(request, change, {
    location,
    target: { kind: "square_pos_app" },
    transport: "client_app_handoff",
    adapterVersion: SQUARE_POS_APP_ADAPTER_VERSION,
    invalid: "terminal_configuration_invalid",
  });
}

function parseSquarePosAppSelection(
  body: Readonly<Record<string, unknown>>,
): Readonly<{
  pantryLocationId: string;
  integrationAccountId: string;
  providerLocationId: string;
}> | null {
  const keys = Object.keys(body).sort().join(",");
  return keys === "integrationAccountId,pantryLocationId,providerLocationId" &&
    nonEmpty(body.pantryLocationId) &&
    nonEmpty(body.integrationAccountId) &&
    nonEmpty(body.providerLocationId)
    ? {
        pantryLocationId: body.pantryLocationId,
        integrationAccountId: body.integrationAccountId,
        providerLocationId: body.providerLocationId,
      }
    : null;
}

type SquareCounterChange<Selection> = Readonly<{
  env: Env;
  authorized: AuthorizedRequest;
  mutation: CounterMutation;
  context: PairingContext;
  selection: Selection;
}>;

/**
 * The start of a change to a production counter's Square payments: an
 * admin, the idempotent start of the mutation and the Square account.
 */
async function beginSquareCounterChange<
  Selection extends Readonly<{
    pantryLocationId: string;
    integrationAccountId: string;
  }>,
>(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  change: Readonly<{
    parse: (body: Readonly<Record<string, unknown>>) => Selection | null;
    invalid: string;
    operation: string;
    suffix: string;
  }>,
): Promise<SquareCounterChange<Selection> | Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError(change.invalid, 422);
  const selection = change.parse(body.value);
  if (selection === null) return controlError(change.invalid, 422);
  const mutation = await beginCounterMutation(
    request,
    env,
    authorized,
    body.value,
    change.operation,
    change.suffix,
  );
  if (mutation instanceof Response) return mutation;
  const context = await pairingContext(
    env,
    authorized,
    selection.integrationAccountId,
  );
  if (context instanceof Response) return context;
  return { env, authorized, mutation, context, selection };
}

/** The account's location for a counter, or null when the counter cannot use it. */
function counterLocation(
  context: PairingContext,
  pantryLocationId: string,
  providerLocationId: string,
): SquareLocationChoice | null {
  const location = findSquareLocation(
    context.account.locations,
    providerLocationId,
  );
  return location !== null &&
    hasPantryLocation(
      context.configuration,
      pantryLocationId,
      location.currency,
    )
    ? location
    : null;
}

/**
 * Points the counter at a target, or keeps the active assignment that
 * already does, then answers with the counters.
 */
async function assignCounterTarget(
  request: Request,
  change: SquareCounterChange<Readonly<{ pantryLocationId: string }>>,
  next: Readonly<{
    location: SquareLocationChoice;
    target: TerminalAssignment["target"];
    transport: TerminalAssignment["transport"];
    adapterVersion: string;
    invalid: string;
  }>,
): Promise<Response> {
  const { authorized, context, mutation, selection } = change;
  const database = authorized.executionScope.database;
  const current = await readActiveTerminalAssignment(
    database,
    authorized.organisationId,
    selection.pantryLocationId,
  );
  if (!current.ok && current.error.code === "terminal_assignment_corrupt")
    return controlError("terminal_assignment_corrupt", 409);
  const account = providerAccountBinding(context.sourceAccount, next.location);
  const unchanged =
    current.ok &&
    current.value.state.kind === "active" &&
    current.value.merchantId === context.configuration.merchantId &&
    current.value.pantryLocationId === selection.pantryLocationId &&
    current.value.providerLocationId === next.location.providerLocationId &&
    current.value.transport === next.transport &&
    current.value.adapterVersion === next.adapterVersion &&
    JSON.stringify(current.value.target) === JSON.stringify(next.target) &&
    JSON.stringify(current.value.account) === JSON.stringify(account);
  const now = Date.now();
  if (!unchanged) {
    const assignment = parseTerminalAssignment({
      assignmentId: `terminal_assignment_${crypto.randomUUID()}`,
      organisationId: authorized.organisationId,
      merchantId: context.configuration.merchantId,
      pantryLocationId: selection.pantryLocationId,
      account,
      providerLocationId: next.location.providerLocationId,
      target: next.target,
      transport: next.transport,
      adapterVersion: next.adapterVersion,
      revision: current.ok ? current.value.revision + 1 : 1,
      state: { kind: "active" },
    });
    if (!assignment.ok) return controlError(next.invalid, 422);
    const activated = await activateTerminalAssignment({
      db: database,
      organisationId: authorized.organisationId,
      assignment: assignment.value,
      now,
    });
    if (!activated.ok) return controlError(activated.error.code, 409);
  }
  const responseBody = {
    ok: true,
    terminalOperations: await readTerminalOperationsOf(
      change.env,
      authorized,
      now,
    ),
    configuration: context.configuration,
  };
  return finishCounterMutation(request, authorized, mutation, responseBody);
}

type CounterMutation = Readonly<{
  identity: NonNullable<Awaited<ReturnType<typeof resolveUser>>>;
  scope: ControlMutationReceiptScope;
  boundary: Readonly<{
    kind: "unversioned";
    idempotencyKey: string;
    requestHash: string;
  }>;
}>;

/** The idempotent start of a counter change, or the response it replays. */
async function beginCounterMutation(
  request: Request,
  env: Env,
  authorized: AuthorizedRequest,
  body: Readonly<Record<string, unknown>>,
  operation: string,
  routeSuffix: string,
): Promise<CounterMutation | Response> {
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/terminal-operations${routeSuffix}`,
    operation,
  });
  if (admitted instanceof Response) return admitted;
  return {
    identity: admitted.user,
    scope: admitted.scope,
    boundary: admitted.boundary,
  };
}

async function finishCounterMutation(
  request: Request,
  authorized: AuthorizedRequest,
  mutation: CounterMutation,
  responseBody: Readonly<Record<string, unknown>>,
): Promise<Response> {
  const recorded = await recordCommerceMutationReceipt({
    authorized,
    identity: mutation.identity,
    scope: mutation.scope,
    boundary: mutation.boundary,
    request,
    responseBody,
    now: Date.now(),
  });
  if (!recorded.ok) return controlError(recorded.error.code, 409);
  return controlJson(responseBody);
}

/** The production organisation's Square account that pairs a Terminal. */
async function pairingContext(
  env: Env,
  authorized: AuthorizedRequest,
  integrationAccountIdRaw: string,
): Promise<PairingContext | Response> {
  const configuration = await readTerminalConfiguration(
    env,
    authorized.executionScope,
  );
  if (configuration.kind === "error") return configuration.response;
  if (configuration.kind === "blocked")
    return controlError(configuration.reason, 409);
  if (configuration.environment !== "production")
    return controlError("production_organisation_required", 409);
  const account = findSquareAccount(
    configuration.squareAccounts,
    integrationAccountIdRaw,
  );
  const integrationAccountId = parseIntegrationAccountId(
    integrationAccountIdRaw,
  );
  const sourceAccount =
    account === null || !integrationAccountId.ok
      ? null
      : findIntegrationAccount(
          await listIntegrationAccounts({
            db: authorized.executionScope.database,
            organisationId: authorized.organisationId,
          }),
          integrationAccountId.value,
          "production",
        );
  if (account === null || sourceAccount === null)
    return controlError("integration_account_not_found", 404);
  const square = await resolveCommerceMerchant(
    env,
    authorized.executionScope,
    authorized.organisationId,
  );
  if (square === null) return controlError("square_unavailable", 503);
  return { configuration, account, sourceAccount, square };
}

/** A code of this account at one of its payment locations. */
async function readPairingCode(
  context: PairingContext,
  deviceCodeId: string,
): Promise<
  Readonly<{ code: PairingCode; location: SquareLocationChoice }> | Response
> {
  const read = await context.square.client.readSquareDeviceCode(
    context.square.merchantId,
    deviceCodeId,
  );
  if (!read.ok) return pairingProviderError(read.error);
  // Square's code names its own location, which must be one of the account's.
  const location = findSquareLocation(
    context.account.locations,
    read.value.locationId,
  );
  return location === null
    ? controlError("terminal_pairing_invalid", 422)
    : { code: pairingCode(read.value), location };
}

function pairingCode(code: CommerceSquareDeviceCodeV1): PairingCode {
  return {
    id: code.deviceCodeId,
    code: code.code,
    locationId: code.locationId,
    pairBy: code.pairBy,
    status: code.status,
    deviceId: code.deviceId,
  };
}

function providerAccountBinding(
  account: IntegrationAccount,
  location: SquareLocationChoice,
) {
  return {
    integrationAccountId: account.integrationAccountId,
    providerAccountId: account.providerAccountId,
    environment: account.environment,
    capabilityRevision: Math.max(1, account.updatedAt),
    country: location.country,
    currency: location.currency,
  };
}

/**
 * A code is open until Square pairs it or its deadline passes; an open code
 * past its deadline is expired, whatever Square still says.
 */
function pairingReadback(
  code: PairingCode,
  now: number,
): TerminalPairingReadback {
  const lapsed = code.pairBy !== null && Date.parse(code.pairBy) <= now;
  return {
    deviceCodeId: code.id,
    code: code.code,
    providerLocationId: code.locationId,
    pairBy: code.pairBy,
    status:
      code.status === "PAIRED"
        ? "paired"
        : code.status === "EXPIRED" || lapsed
          ? "expired"
          : "open",
  };
}

function pairingProviderError(error: CommerceClientError): Response {
  const unavailable =
    error.kind !== "http" || error.status === 503 || error.status >= 500;
  return controlError(
    unavailable ? "square_unavailable" : "square_request_refused",
    unavailable ? 503 : 502,
  );
}

function parseTerminalPairingRequest(
  body: Readonly<Record<string, unknown>>,
): TerminalPairingRequest | null {
  const keys = Object.keys(body).sort().join(",");
  return keys ===
    "deviceName,integrationAccountId,pantryLocationId,providerLocationId" &&
    nonEmpty(body.pantryLocationId) &&
    nonEmpty(body.integrationAccountId) &&
    nonEmpty(body.providerLocationId) &&
    nonEmpty(body.deviceName) &&
    body.deviceName.length <= 128
    ? {
        pantryLocationId: body.pantryLocationId,
        integrationAccountId: body.integrationAccountId,
        providerLocationId: body.providerLocationId,
        deviceName: body.deviceName,
      }
    : null;
}

function parseTerminalPairingActivation(
  body: Readonly<Record<string, unknown>>,
): Readonly<{ pantryLocationId: string; integrationAccountId: string }> | null {
  const keys = Object.keys(body).sort().join(",");
  return keys === "integrationAccountId,pantryLocationId" &&
    nonEmpty(body.pantryLocationId) &&
    nonEmpty(body.integrationAccountId)
    ? {
        pantryLocationId: body.pantryLocationId,
        integrationAccountId: body.integrationAccountId,
      }
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Retire a counter's assignment.
 *
 * A terminal still holding an unresolved collection cannot be retired: the
 * collection's outcome is not yet known, and removing the assignment would
 * leave a possibly-captured payment with nothing to reconcile against. The
 * operator resolves the collection first, which is the same order the money
 * itself moves in.
 */
async function handleTerminalRetirement(
  request: Request,
  env: Env,
  route: Variant<TerminalOperationsControlRoute, "terminalRetirement">,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    route.organisationIdRaw,
    "operator",
    true,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("terminal_retirement_invalid", 422);
  const admitted = await admitUserMutation({
    request,
    env,
    authorized,
    body: body.value,
    boundary: "unversioned",
    user: "before_replay",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/terminal-operations/${route.pantryLocationIdRaw}/retirement`,
    operation: "terminal.assignment.retire",
  });
  if (admitted instanceof Response) return admitted;
  const { boundary, scope, user: identity } = admitted;

  const assignment = await readActiveTerminalAssignment(
    authorized.executionScope.database,
    authorized.organisationId,
    route.pantryLocationIdRaw,
  );
  if (!assignment.ok) {
    return controlError(
      assignment.error.code === "terminal_assignment_corrupt"
        ? "terminal_assignment_corrupt"
        : "terminal_assignment_not_found",
      assignment.error.code === "terminal_assignment_corrupt" ? 409 : 404,
    );
  }
  const now = Date.now();
  const retired = await retireTerminalAssignment({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    assignmentId: assignment.value.assignmentId,
    revision: assignment.value.revision,
    // The operator withdrew this counter's authority; nothing replaced it and
    // the provider connection is untouched.
    reason: "revoked",
    now,
  });
  if (!retired) return controlError("terminal_assignment_conflict", 409);
  const responseBody = {
    ok: true,
    terminalOperations: await readTerminalOperationsOf(env, authorized, now),
  };
  const recordedMutationReceipt = await recordCommerceMutationReceipt({
    authorized,
    identity,
    scope,
    boundary,
    request,
    responseBody,
    now,
  });
  if (!recordedMutationReceipt.ok)
    return controlError(recordedMutationReceipt.error.code, 409);
  return controlJson(responseBody);
}

function match(pathname: string, pattern: RegExp): readonly string[] | null {
  const captures = pattern.exec(pathname);
  return captures === null ? null : captures.slice(1);
}

function decode(value: string | undefined): string {
  if (value === undefined)
    throw new Error("Terminal operations route capture is missing");
  return decodeURIComponent(value);
}
