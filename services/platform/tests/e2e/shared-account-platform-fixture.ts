import { isRecord } from "@purin-labs/std";
import { organisationDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import type { ModelRoute } from "@purin-labs/contracts";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import {
  accountInteger,
  accountObject,
  accountText,
  parseAccountScope,
  type AccountScope,
} from "../../src/account-platform/types";
import {
  readPantryProvisionApplied,
  readPantryProvisionEnvelope,
  type PantryProvisionApplied,
  type PantryProvisionEnvelope,
} from "../../src/account-platform/provisioning-boundary";
import { createAccountPlatformClient } from "../../src/account-platform/client";
import { resolvePantryAccountBinding } from "../../src/account-platform/binding";
import { linkPantryAccountUser } from "../../src/account-platform/identity";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  parseOpenAiApiKey,
  storeOrganisationOpenAiModelCredential,
} from "../../src/credential-vault";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import { resolveOrganisationModelRouteForSelection } from "../../src/models/route";
import type { OrganisationId } from "../../src/ids";
import { readActiveOrganisationMembership } from "../../src/data/control-plane";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
} from "./commerce-support";

export interface SharedAccountFixtureNativeMember {
  readonly nativeUserId: string;
  readonly nativePersonId: string;
  readonly nativeSessionId: string;
  readonly google: {
    readonly issuer: "https://accounts.google.com";
    readonly subject: string;
  };
}

interface SharedAccountFixtureSetup {
  readonly version: 1;
  readonly organisations: {
    readonly primary: {
      readonly nativeOrganisationId: string;
      readonly owner: SharedAccountFixtureNativeMember;
    };
    readonly foreign: {
      readonly nativeOrganisationId: string;
      readonly owner: SharedAccountFixtureNativeMember;
    };
  };
  readonly members: {
    readonly finance: SharedAccountFixtureNativeMember;
    readonly operator: SharedAccountFixtureNativeMember;
    readonly privateMember: SharedAccountFixtureNativeMember;
    readonly extra?: readonly SharedAccountFixtureNativeMember[];
  };
}

export async function accountFixtureRequest(
  operation:
    | "setup"
    | "acknowledge"
    | "mutate"
    | "fault"
    | "snapshot"
    | "statement"
    | "onboarding-delivery"
    | "google-login",
  body: unknown,
): Promise<Response> {
  if (!env.ACCOUNT_PLATFORM_FIXTURE || !env.TEST_ACCOUNT_PLATFORM_BASE_URL) {
    throw new Error(
      "Build the real account Worker and set PANTRY_ACCOUNT_WORKER_ARTIFACT before this journey.",
    );
  }
  return env.ACCOUNT_PLATFORM_FIXTURE.fetch(
    new URL(
      `/__fixture/account-platform/v1/${operation}`,
      env.TEST_ACCOUNT_PLATFORM_BASE_URL,
    ),
    {
      method: "POST",
      headers: {
        authorization: "Bearer shared-account-e2e-admin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

export async function accountFixtureJson(
  operation: "setup" | "acknowledge" | "mutate" | "fault" | "snapshot",
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await accountFixtureRequest(operation, body);
  const payload: unknown = await response.json();
  if (!response.ok || !isRecord(payload)) {
    throw new Error(
      `Account fixture ${operation} failed with status ${response.status}: ${fixtureFailureMessage(payload)}.`,
    );
  }
  return payload;
}

export type SharedAccountNativeClient = Awaited<
  ReturnType<typeof commerceClient>
>;

export interface SharedAccountNativeTenants {
  readonly primary: {
    readonly organisationId: OrganisationId;
    readonly owner: SharedAccountNativeClient;
  };
  readonly foreign: {
    readonly organisationId: OrganisationId;
    readonly owner: SharedAccountNativeClient;
  };
  readonly finance: SharedAccountNativeClient;
  readonly operator: SharedAccountNativeClient;
  readonly privateMember: SharedAccountNativeClient;
  readonly setup: SharedAccountFixtureSetup;
}

async function fixtureMember(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
): Promise<SharedAccountFixtureNativeMember> {
  // The Organisation's own database, wherever its placement puts it.
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  const membership = await readActiveOrganisationMembership(
    scope.value.database,
    organisationId,
    client.identity.userId,
  );
  if (
    membership === null ||
    client.identity.issuer !== "https://accounts.google.com"
  ) {
    throw new Error(
      "The native fixture requires a current verified Google member.",
    );
  }
  return {
    nativeUserId: client.identity.userId,
    nativePersonId: membership.personId,
    nativeSessionId: client.session.session.controlSessionId,
    google: {
      issuer: client.identity.issuer,
      subject: client.identity.subject,
    },
  };
}

export async function addNativeServiceMember(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  role: "admin" | "operator" | "viewer",
): Promise<void> {
  const personId = `person_${crypto.randomUUID()}`;
  const organisationDb = organisationDatabase(organisationId);
  await organisationDb.batch([
    organisationDb
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisationId, personId, client.identity.displayName),
    organisationDb
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      )
      .bind(organisationId, client.identity.userId, personId, role, Date.now()),
  ]);
}

/** Bootstrap existing native tenants before the explicit shared-account attach. */
export async function bootstrapSharedAccountNativeTenants(): Promise<SharedAccountNativeTenants> {
  const ownerA = await commerceClient("shared-account-owner-a");
  const ownerB = await commerceClient("shared-account-owner-b");
  const primaryOrganisationId = await commerceWorkspace(
    ownerA,
    "Shared account primary",
  );
  const foreignOrganisationId = await commerceWorkspace(
    ownerB,
    "Shared account foreign",
  );
  const finance = await commerceClient("shared-account-finance");
  const operator = await commerceClient("shared-account-operator");
  const privateMember = await commerceClient("shared-account-private-member");
  await addNativeServiceMember(primaryOrganisationId, finance, "viewer");
  await addNativeServiceMember(primaryOrganisationId, operator, "admin");
  await addNativeServiceMember(
    primaryOrganisationId,
    privateMember,
    "operator",
  );
  const primaryOwner = await fixtureMember(primaryOrganisationId, ownerA);
  const foreignOwner = await fixtureMember(foreignOrganisationId, ownerB);
  const financeMember = await fixtureMember(primaryOrganisationId, finance);
  const operatorMember = await fixtureMember(primaryOrganisationId, operator);
  const privateMemberRequest = await fixtureMember(
    primaryOrganisationId,
    privateMember,
  );
  return {
    primary: { organisationId: primaryOrganisationId, owner: ownerA },
    foreign: { organisationId: foreignOrganisationId, owner: ownerB },
    finance,
    operator,
    privateMember,
    setup: {
      version: 1,
      organisations: {
        primary: {
          nativeOrganisationId: primaryOrganisationId,
          owner: primaryOwner,
        },
        foreign: {
          nativeOrganisationId: foreignOrganisationId,
          owner: foreignOwner,
        },
      },
      members: {
        finance: financeMember,
        operator: operatorMember,
        privateMember: privateMemberRequest,
      },
    },
  };
}

/** The fixture slots of the account authority that a member can take. */
export type SharedAccountMemberSlot = "finance" | "operator" | "privateMember";

/**
 * A member of the organisation, or a person whom the account authority knows
 * before Pantry gives them a role under the named person.
 */
export type SharedAccountSlotMember =
  | SharedAccountNativeClient
  | Readonly<{ client: SharedAccountNativeClient; laterPersonId: string }>;

/**
 * Attach one existing native organisation to the shared account authority.
 *
 * The account authority admits the owner and the members in the slots
 * `operator` and `privateMember`. It gives the member in the slot `finance`
 * billing access only, so it refuses that member's requests to Pantry. A slot
 * that the caller leaves empty gets an auxiliary identity that owns a separate
 * organisation. `extraMembers` get the access of `privateMember`, for a journey
 * that needs more people. The attach adds no role to the organisation under
 * test.
 */
export async function attachSharedAccountNativeOrganisation(
  input: Readonly<{
    organisationId: OrganisationId;
    owner: SharedAccountNativeClient;
    members: Readonly<
      Partial<Record<SharedAccountMemberSlot, SharedAccountSlotMember>>
    >;
    extraMembers?: readonly SharedAccountSlotMember[];
    /**
     * A second Organisation of the journey that the account authority also
     * serves. The fixture issues one instance for each role, so a journey
     * attaches its two Organisations in one call.
     */
    foreign?: Readonly<{
      organisationId: OrganisationId;
      owner: SharedAccountNativeClient;
    }>;
  }>,
): Promise<SharedAccountFixture> {
  const foreign =
    input.foreign === undefined
      ? await auxiliaryNativeOwner("foreign")
      : {
          organisationId: input.foreign.organisationId,
          member: await fixtureMember(
            input.foreign.organisationId,
            input.foreign.owner,
          ),
        };
  const slots: Record<
    SharedAccountMemberSlot,
    SharedAccountFixtureNativeMember
  > = {
    finance: await slotMember(input, "finance"),
    operator: await slotMember(input, "operator"),
    privateMember: await slotMember(input, "privateMember"),
  };
  const extraMembers = input.extraMembers ?? [];
  const extra: SharedAccountFixtureNativeMember[] = [];
  for (const member of extraMembers)
    extra.push(await nativeSlotMember(input.organisationId, member));
  const request: SharedAccountFixtureSetup = {
    version: 1,
    organisations: {
      primary: {
        nativeOrganisationId: input.organisationId,
        owner: await fixtureMember(input.organisationId, input.owner),
      },
      foreign: {
        nativeOrganisationId: foreign.organisationId,
        owner: foreign.member,
      },
    },
    members: extra.length === 0 ? slots : { ...slots, extra },
  };
  const setup = readSharedAccountFixture(
    await accountFixtureJson("setup", request),
  );
  await applyAccountFixtureProvision(setup.provisionEnvelopes.primary);
  if (input.foreign !== undefined)
    await applyAccountFixtureProvision(setup.provisionEnvelopes.foreign);
  for (const member of [...Object.values(input.members), ...extraMembers])
    await linkAccountFixtureMember(
      input.organisationId,
      "client" in member ? member.client : member,
      setup,
    );
  return setup;
}

async function slotMember(
  input: Parameters<typeof attachSharedAccountNativeOrganisation>[0],
  slot: SharedAccountMemberSlot,
): Promise<SharedAccountFixtureNativeMember> {
  const member = input.members[slot];
  if (member === undefined) return (await auxiliaryNativeOwner(slot)).member;
  return nativeSlotMember(input.organisationId, member);
}

async function nativeSlotMember(
  organisationId: OrganisationId,
  member: SharedAccountSlotMember,
): Promise<SharedAccountFixtureNativeMember> {
  if (!("client" in member)) return fixtureMember(organisationId, member);
  const { client, laterPersonId } = member;
  if (client.identity.issuer !== "https://accounts.google.com")
    throw new Error("The native fixture requires a verified Google identity.");
  return {
    nativeUserId: client.identity.userId,
    nativePersonId: laterPersonId,
    nativeSessionId: client.session.session.controlSessionId,
    google: {
      issuer: client.identity.issuer,
      subject: client.identity.subject,
    },
  };
}

async function auxiliaryNativeOwner(label: string): Promise<
  Readonly<{
    organisationId: OrganisationId;
    member: SharedAccountFixtureNativeMember;
  }>
> {
  const client = await commerceClient(`shared-account-auxiliary-${label}`);
  const organisationId = await commerceWorkspace(
    client,
    `Shared account auxiliary ${label}`,
  );
  return {
    organisationId,
    member: await fixtureMember(organisationId, client),
  };
}

interface SharedAccountFixtureInstance {
  readonly scope: AccountScope;
  readonly instanceId: string;
}

interface SharedAccountFixtureMember {
  readonly platformUserId: string;
  readonly membershipId: string;
}

/** Tokens and signed envelopes stay transient and must not enter test evidence. */
export interface SharedAccountFixture {
  readonly primary: SharedAccountFixtureInstance &
    Readonly<{ walletInstanceId: string }>;
  readonly foreign: SharedAccountFixtureInstance;
  readonly ownerPlatformUserId: string;
  readonly foreignOwnerPlatformUserId: string;
  readonly finance: SharedAccountFixtureMember;
  readonly operator: SharedAccountFixtureMember;
  readonly privateMember: SharedAccountFixtureMember;
  readonly googleIdTokens: Readonly<Record<string, string>>;
  readonly provisionEnvelopes: Readonly<{
    primary: PantryProvisionEnvelope;
    foreign: PantryProvisionEnvelope;
  }>;
}

function readFixtureInstance(input: unknown): SharedAccountFixtureInstance {
  const record = accountObject(input, ["scope", "instanceId"]);
  return {
    scope: parseAccountScope(record.scope),
    instanceId: accountText(record.instanceId),
  };
}

function readFixtureMember(input: unknown): SharedAccountFixtureMember {
  const record = accountObject(input, ["platformUserId", "membershipId"]);
  return {
    platformUserId: accountText(record.platformUserId),
    membershipId: accountText(record.membershipId),
  };
}

export function readSharedAccountFixture(input: unknown): SharedAccountFixture {
  const record = accountObject(input, [
    "version",
    "organisations",
    "members",
    "googleIdTokens",
    "deliveries",
    "provisionEnvelopes",
  ]);
  if (record.version !== 1 || !Array.isArray(record.deliveries))
    throw new Error("Invalid fixture setup version");
  const organisations = accountObject(record.organisations, [
    "primary",
    "foreign",
  ]);
  const primary = accountObject(organisations.primary, [
    "scope",
    "instanceId",
    "walletInstanceId",
  ]);
  const members = accountObject(
    record.members,
    isRecord(record.members) && Object.hasOwn(record.members, "extra")
      ? [
          "owner",
          "foreignOwner",
          "finance",
          "operator",
          "privateMember",
          "extra",
        ]
      : ["owner", "foreignOwner", "finance", "operator", "privateMember"],
  );
  const owner = accountObject(members.owner, ["platformUserId"]);
  const foreignOwner = accountObject(members.foreignOwner, ["platformUserId"]);
  const envelopes = accountObject(record.provisionEnvelopes, [
    "primary",
    "foreign",
  ]);
  if (!isRecord(record.googleIdTokens))
    throw new Error("Invalid Google proof map");
  const tokens: Record<string, string> = {};
  for (const [nativeUserId, token] of Object.entries(record.googleIdTokens))
    tokens[accountText(nativeUserId)] = accountText(token);
  return {
    primary: {
      scope: parseAccountScope(primary.scope),
      instanceId: accountText(primary.instanceId),
      walletInstanceId: accountText(primary.walletInstanceId),
    },
    foreign: readFixtureInstance(organisations.foreign),
    ownerPlatformUserId: accountText(owner.platformUserId),
    foreignOwnerPlatformUserId: accountText(foreignOwner.platformUserId),
    finance: readFixtureMember(members.finance),
    operator: readFixtureMember(members.operator),
    privateMember: readFixtureMember(members.privateMember),
    googleIdTokens: tokens,
    provisionEnvelopes: {
      primary: readPantryProvisionEnvelope(envelopes.primary),
      foreign: readPantryProvisionEnvelope(envelopes.foreign),
    },
  };
}

async function nativeProvisionRequest(
  operation: "provision" | "status",
  body: unknown,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/account-platform/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TEST_ACCOUNT_PLATFORM_PROVISION_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

export async function applyAccountFixtureProvision(
  envelope: PantryProvisionEnvelope,
): Promise<PantryProvisionApplied> {
  const response = await nativeProvisionRequest("provision", envelope);
  const raw: unknown = await response.json();
  if (!response.ok || !isRecord(raw) || raw.kind !== "accepted")
    throw new Error(
      `Native account provision failed: ${response.status} ${JSON.stringify(raw)}`,
    );
  const applied = readPantryProvisionApplied(raw.value);
  await accountFixtureJson("acknowledge", {
    version: 1,
    receipt: applied.receipt,
    owner: applied.owner,
  });
  return applied;
}

async function linkAccountFixtureMember(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  setup: SharedAccountFixture,
): Promise<void> {
  const binding = await resolvePantryAccountBinding(env, organisationId);
  if (!binding.ok) {
    const fee = await accountProducerRequest("fee-policy", {
      version: 1,
      instanceId: setup.primary.instanceId,
    });
    const client = createAccountPlatformClient(env);
    const parsedFee = client.ok
      ? await client.value.getFeePolicy(setup.primary.instanceId)
      : client;
    const nativeBinding = await env.DB.prepare(
      "SELECT instance_id AS instanceId, native_organisation_id AS nativeOrganisationId, deployment_id AS deploymentId, scope_json AS scopeJson FROM account_service_binding WHERE native_organisation_id = ?",
    )
      .bind(organisationId)
      .first<unknown>();
    throw new Error(
      `Native binding failed: ${binding.error.code}; fee policy ${fee.status} ${await fee.text()}; parsedFee ${JSON.stringify(parsedFee)}; binding ${JSON.stringify(nativeBinding)}`,
    );
  }
  const token = setup.googleIdTokens[client.identity.userId];
  if (token === undefined) throw new Error("Missing transient Google proof");
  const linked = await linkPantryAccountUser(env, {
    binding: binding.value,
    userId: client.identity.userId,
    nativeSessionId: client.session.session.controlSessionId,
    googleIdToken: token,
  });
  if (!linked.ok)
    throw new Error(`Verified identity link failed: ${linked.error.code}`);
}

export function nativeAccountRequest(
  client: SharedAccountNativeClient,
  path: string,
  body: unknown | null,
): Promise<Response> {
  if (body === null)
    return exports.default.fetch(`https://localhost${path}`, {
      headers: commerceHeaders(client.session),
    });
  return exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: commerceHeaders(client.session),
    body: JSON.stringify(body),
  });
}

export async function activateSharedAccountNativeTenant(
  organisationId: OrganisationId,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  await scope.database
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = ?, activated_at = ? WHERE organisation_id = ?",
    )
    .bind(
      `receipt_shared_account_${organisationId}`,
      Date.now(),
      organisationId,
    )
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const native = await scope.database
    .prepare(
      "SELECT name, created_at AS createdAt FROM organisation WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<unknown>();
  const metadata = accountObject(native, ["name", "createdAt"]);
  await organisation.ensureOrganisation({
    organisationId,
    name: accountText(metadata.name),
    plan: "beta",
    status: "active",
    createdAt: accountInteger(metadata.createdAt),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(JSON.stringify(policy.error));
}

export async function selectSharedAccountModelRoute(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  selection: "satyr_platform" | "organisation_openai_api_key",
): Promise<ModelRoute> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  if (selection === "organisation_openai_api_key") {
    const key = parseOpenAiApiKey(
      "sk-project-shared-account-acceptance-1234567890",
    );
    if (!key.ok) throw new Error(key.error.code);
    const stored = await storeOrganisationOpenAiModelCredential({
      db: scope.database,
      keys: env,
      organisationId,
      apiKey: key.value,
      now: Date.now(),
    });
    if (!stored.ok) throw new Error(stored.error.code);
  }
  const current = await readOrganisationInferenceSelection({
    db: scope.database,
    organisationId,
  });
  if (current === null) throw new Error("Native inference selection missing");
  const selected = await selectOrganisationInferenceSelection({
    db: scope.database,
    organisationId,
    selection:
      selection === "satyr_platform"
        ? { kind: "satyr_platform" }
        : { kind: "organisation_openai_api_key" },
    expectedConfigurationVersion: current.configurationVersion,
    selectedByUserId: client.identity.userId,
    now: Date.now(),
  });
  if (!selected.ok) throw new Error(selected.error.code);
  const route = await resolveOrganisationModelRouteForSelection({
    env,
    scope,
    now: Date.now(),
    selection: selected.value.selection,
  });
  if (!route.ok) throw new Error(route.error.code);
  return route.value;
}

export function fixtureRows(
  snapshot: Record<string, unknown>,
  table: string,
): readonly Record<string, unknown>[] {
  const value = snapshot[table];
  if (!Array.isArray(value))
    throw new Error(`Fixture snapshot missing ${table}`);
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    if (!isRecord(row)) throw new Error(`Invalid snapshot row in ${table}`);
    rows.push(row);
  }
  return rows;
}

function accountProducerRequest(
  path: "usage" | "funds/reserve" | "fee-policy" | "eligibility",
  body: unknown,
  assertion: string | null = null,
): Promise<Response> {
  if (!env.ACCOUNT_PLATFORM) throw new Error("Real account transport missing");
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (assertion !== null) headers.set("X-Account-User-Assertion", assertion);
  return env.ACCOUNT_PLATFORM.fetch(
    new Request(
      `${env.TEST_ACCOUNT_PLATFORM_BASE_URL}/account-platform/v1/${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
    ),
  );
}

function fixtureFailureMessage(payload: unknown): string {
  if (
    isRecord(payload) &&
    payload.code === "fixture_failure" &&
    typeof payload.message === "string"
  )
    return payload.message;
  return "invalid response";
}

export async function nativeServiceMemberMutation(
  organisationId: OrganisationId,
  owner: SharedAccountNativeClient,
  target: SharedAccountNativeClient,
  method: "PATCH" | "DELETE",
  body: unknown,
): Promise<Response> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const raw = await scope.database
    .prepare(
      "SELECT configuration_version AS configurationVersion FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<unknown>();
  const current = accountObject(raw, ["configurationVersion"]);
  const headers = commerceHeaders(owner.session);
  headers.set("idempotency-key", crypto.randomUUID());
  headers.set(
    "x-satyr-configuration-version",
    String(accountInteger(current.configurationVersion, 1)),
  );
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}/members/${target.identity.userId}`,
    { method, headers, body: JSON.stringify(body) },
  );
}
