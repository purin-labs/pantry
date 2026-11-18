import type { OrganisationDatabase } from "../../src/database-handles";
import { decodeBase64, encodeBase64Url, isRecord } from "@seams/std";
import { organisationDatabase } from "./organisation-database";
import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { network } from "./network";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import { createAccessGrant } from "../../src/data/access-grants";
import { encodeContextVisibility } from "../../src/authorization/access-grants/visibility";
import {
  replaceFileGrantAdmissions,
  createFileProjectionCommand,
  applyFileProjectionCommand,
} from "../../src/context/files";
import { ProviderFileProjectionSourceReader } from "../../src/context/files/provider-source";
import { upsertFileResourceSource } from "../../src/context/files/persistence";
import type { CanonicalFileReference } from "../../src/context/files/tools";
import { storeFilePlacementCredential } from "../../src/provider-workflows/file-context-credential";
import type {
  ModelRoute,
  OrganisationCapabilityPolicy,
} from "@seams/contracts";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import {
  authorizeCapabilityUse,
  compileTurnAuthority,
  type CompiledTurnAuthority,
} from "../../src/authorization/access-grants";
import { buildControlAuthority } from "../../src/request-authority";
import {
  readOrganisationCapabilityPolicies,
  writeOrganisationCapabilityPolicy,
} from "../../src/data/capability-policy";
import { readCurrentOrganisationPolicySnapshot } from "../../src/policy-snapshot";
import {
  newConversationId,
  type ConversationId,
  type ProjectId,
} from "@seams/control-api";
import {
  accountInteger,
  accountObject,
  accountText,
  parseAccountScope,
  type AccountScope,
  type AccountPrincipal,
  type LinkedPantryAccountUser,
  type PantryAccountBinding,
  type AccountTurnUsageRequest,
} from "../../src/account-platform/types";
import {
  readPantryProvisionApplied,
  readPantryProvisionEnvelope,
  type PantryProvisionApplied,
  type PantryProvisionEnvelope,
} from "../../src/account-platform/provisioning-boundary";
import { createAccountPlatformClient } from "../../src/account-platform/client";
import { resolvePantryAccountBinding } from "../../src/account-platform/binding";
import { ensurePantryAccountAutomationGrant } from "../../src/account-platform/automation";
import {
  linkPantryAccountUser,
  type PantryNativeAutomation,
} from "../../src/account-platform/identity";
import { readLatestHarnessCheckpoint } from "../../src/actors/agent-session-harness-authority";
import { authenticatedAccountConversationScope } from "../../src/account-platform/access";
import {
  readPantryExecutionBilling,
  type PantryExecutionBilling,
} from "../../src/account-platform/execution-billing";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { parseSessionId, parseUserId } from "../../src/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  parseVaultHandle,
  storeVaultSecret,
  parseOpenAiApiKey,
  storeOrganisationOpenAiModelCredential,
} from "../../src/credential-vault";
import {
  readOrganisationInferenceSelection,
  selectOrganisationInferenceSelection,
} from "../../src/data/organisation-inference-selection";
import { resolveOrganisationModelRouteForSelection } from "../../src/models/route";
import { parseConversation } from "../../src/chat/conversation";
import { readConversation, saveConversation } from "../../src/chat/store";
import type { OrganisationId } from "../../src/ids";
import {
  readActiveOrganisationMembership,
  readActiveOrganisationMembershipRevision,
} from "../../src/data/control-plane";
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

export interface SharedAccountFixtureSetup {
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
      "Build the real account Worker and set SATYR_ACCOUNT_WORKER_ARTIFACT before this journey.",
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
    organisationDb.prepare(
      "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
    ).bind(organisationId, personId, client.identity.displayName),
    organisationDb.prepare(
      "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).bind(organisationId, client.identity.userId, personId, role, Date.now()),
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

/**
 * Let the account authority admit one native automation, as the grant of an
 * administrator does through the access-control route.
 */
export async function grantSharedAccountAutomation(
  organisationId: OrganisationId,
  administrator: SharedAccountNativeClient,
  native: PantryNativeAutomation,
): Promise<void> {
  const granted = await ensurePantryAccountAutomationGrant({
    env,
    scope: await requireOrganisationExecutionScope(env, organisationId),
    session: administrator.session.session,
    native,
  });
  if (!granted.ok)
    throw new Error(`Account automation grant failed: ${granted.error.code}`);
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

export interface SharedAccountFixtureInstance {
  readonly scope: AccountScope;
  readonly instanceId: string;
}

export interface SharedAccountFixtureMember {
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
      ? ["owner", "foreignOwner", "finance", "operator", "privateMember", "extra"]
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

export async function nativeProvisionRequest(
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

export async function linkAccountFixtureMember(
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

export async function createSharedAccountConversation(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  route: ModelRoute,
  projectId: ProjectId | null,
): Promise<ConversationId> {
  const conversationId = newConversationId();
  const conversation = parseConversation({
    id: conversationId,
    title: "Private account acceptance",
    lineage: { kind: "original" },
    historyBindings: [],
    modelRoute: route,
    documents: [],
    work: { kind: "ready" },
    completedRequests: [],
    timeline: [],
    pendingInputs: [],
    latestSequence: 0,
    lastReadSequence: 0,
    surfaceEventCursor: 0,
    draftText: "",
    draftUpdatedAt: null,
    effort: null,
  });
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const saved =
    projectId === null
      ? await saveConversation(scope, client.identity.userId, conversation, 0)
      : await saveConversation(scope, client.identity.userId, conversation, 0, {
          projectId,
        });
  if (saved.kind !== "saved")
    throw new Error(`Native conversation fixture failed: ${saved.kind}`);
  return conversationId;
}

export function chatPath(organisationId: OrganisationId): string {
  return `/v1/control/organisations/${organisationId}/chat`;
}

export function startSharedAccountTurn(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  conversationId: ConversationId,
  route: ModelRoute,
  requestId: string,
): Promise<Response> {
  return nativeAccountRequest(client, chatPath(organisationId), {
    kind: "message",
    conversationId,
    requestId,
    model: route.model,
    text: "Return a short acknowledgement. Do not call tools.",
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  });
}

export async function nativeConversationWork(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  conversationId: ConversationId,
): Promise<string | null> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const stored = await readConversation(
    scope.database,
    authenticatedAccountConversationScope(
      organisationId,
      client.session.session,
    ),
    conversationId,
  );
  return stored?.conversation.work.kind ?? null;
}

export async function sharedAccountSessionActor(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
  conversationId: ConversationId,
) {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const stored = await readConversation(
    scope.database,
    authenticatedAccountConversationScope(
      organisationId,
      client.session.session,
    ),
    conversationId,
  );
  const work = stored?.conversation.work;
  const binding =
    work?.kind === "running" || work?.kind === "cancelling"
      ? work.stream
      : stored?.conversation.historyBindings.at(-1);
  if (binding === undefined)
    throw new Error("Native accepted history binding missing");
  const sessionId = parseSessionId(binding.sessionId);
  if (!sessionId.ok) throw new Error(sessionId.error.code);
  const resolved = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: sessionId.value,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return {
    actor: resolved.value,
    sessionId: sessionId.value,
    turnId: binding.turnId,
  };
}

export function inspectNativeAccountBilling(
  turnId: string,
  _actor: unknown,
  state: DurableObjectState,
): PantryExecutionBilling | null {
  return readPantryExecutionBilling(state.storage.sql, turnId);
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

export function accountProducerRequest(
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

export function completedNativeUsage(
  operation: PantryExecutionBilling | null,
): AccountTurnUsageRequest {
  if (
    operation === null ||
    operation.kind !== "isolated_e2e_completed_turn" ||
    operation.phase.kind !== "delivered" ||
    operation.phase.terminal.kind !== "completed"
  )
    throw new Error("A real completed paid native turn is required");
  const identity = operation.identity;
  const terminal = operation.phase.terminal;
  return {
    version: 1,
    eventId: JSON.stringify([
      "satyr",
      identity.instanceId,
      identity.sessionId,
      identity.turnId,
      "terminal",
    ]),
    instanceId: identity.instanceId,
    occurredAt: new Date(terminal.occurredAt).toISOString(),
    meterId: "satyr.completed_turn.test",
    quantity: 1,
    unit: "turn",
    evidence: {
      kind: "satyr_turn",
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      terminalOutcome: "completed",
      reservationId: operation.phase.hold.reservationId,
      sourceRecordId: terminal.sourceRecordId,
      sourceDigest: terminal.sourceDigest,
      funding: identity.funding,
    },
  };
}

export function abortSharedAccountActor(
  _actor: unknown,
  state: DurableObjectState,
): void {
  state.abort("Shared account financial uncertainty interruption");
}

export interface SharedAccountSourceProbe {
  metadataReads: number;
  bodyReads: number;
}

export async function installSharedAccountSource(
  organisationId: OrganisationId,
  owner: SharedAccountFixtureNativeMember,
  peer: SharedAccountFixtureNativeMember,
  probe: SharedAccountSourceProbe,
): Promise<CanonicalFileReference> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const now = Date.now();
  const handle = parseVaultHandle("vault:dropbox:shared-account");
  if (!handle.ok) throw new Error(handle.error.code);
  const integration = await createActiveConnectedIntegration(scope.database, {
    organisationId,
    provider: "dropbox",
    providerSubjectId: "dbid:shared-account",
    environment: "development",
    authMode: "shared_satyr_app",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["files.metadata.read", "files.content.read"],
    createdByUserId: requireFixtureUserId(owner.nativeUserId),
    providerAccountId: "dbid:shared-account",
    accountKind: "account",
    displayName: "Shared account source fixture",
    capabilities: ["file.read"],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const secret = await storeVaultSecret({
    db: scope.database,
    keys: env,
    organisationId,
    handle: handle.value,
    secret: {
      kind: "oauth_tokens",
      accessToken: "shared-account-source-fixture",
      refreshToken: "shared-account-source-refresh",
      expiry: { kind: "provider_managed" },
    },
    now,
  });
  if (!secret.ok) throw new Error(secret.error.code);
  const reference: CanonicalFileReference = {
    integrationAccountId: integration.account.integrationAccountId,
    provider: "dropbox",
    providerFileId: "id:shared-account-source",
  };
  await addSharedAccountFileGrant(
    organisationId,
    owner.nativePersonId,
    reference,
    "id:shared-account-source",
    "grant_shared_account_source",
  );
  await addSharedAccountFileGrant(
    organisationId,
    peer.nativePersonId,
    reference,
    "id:unrelated-shared-account-source",
    "grant_shared_account_other_source",
  );
  await scope.database.batch([
    scope.database
      .prepare(
        "INSERT INTO provider_resource_snapshot (snapshot_revision, organisation_id, integration_account_id, provider, environment, query_hash, created_at) VALUES ('snapshot_shared_account', ?, ?, 'dropbox', 'development', 'shared-account', ?)",
      )
      .bind(organisationId, reference.integrationAccountId, now),
    scope.database
      .prepare(
        "INSERT INTO provider_discovered_resource (snapshot_revision, canonical_resource_id, provider_resource_id, provider_account_id, display_label, access_state, provider_revision, resource_kind) VALUES ('snapshot_shared_account', 'resource_shared_account', ?, 'dbid:shared-account', 'Restricted account supplier.pdf', 'accessible', 'shared-account-revision1', 'dropbox_file')",
      )
      .bind(reference.providerFileId),
  ]);
  await replaceFileGrantAdmissions({
    db: scope.database,
    organisationId,
    grantId: "grant_shared_account_source",
    grantRevision: 1,
    admissions: [
      {
        grantId: "grant_shared_account_source",
        grantRevision: 1,
        integrationAccountId: reference.integrationAccountId,
        provider: "dropbox",
        providerFileId: reference.providerFileId,
        containingScopeKey: `dropbox_file:${reference.providerFileId}`,
        providerRevision: { kind: "dropbox", rev: "shared-account-revision1" },
      },
    ],
    admittedAt: now,
  });
  const command = createFileProjectionCommand({
    organisationId,
    grantId: "grant_shared_account_source",
    grantRevision: 1,
    integrationAccountId: reference.integrationAccountId,
    provider: "dropbox",
    providerFileId: reference.providerFileId,
    sourceSequence: 1,
    providerRevision: { kind: "dropbox", rev: "shared-account-revision1" },
    visibilityKey: encodeContextVisibility({
      kind: "person",
      personId: owner.nativePersonId,
    }),
  });
  network.use(
    http.post("https://api.dropboxapi.com/oauth2/token", sourceRefreshToken),
    http.post(
      "https://api.dropboxapi.com/2/users/get_current_account",
      sourceDropboxAccount,
    ),
    http.post(
      "https://api.dropboxapi.com/2/files/get_metadata",
      sourceDropboxMetadata.bind(null, probe),
    ),
    http.post(
      "https://content.dropboxapi.com/2/files/download",
      unexpectedSourceBody.bind(null, probe),
    ),
  );
  const reader = new ProviderFileProjectionSourceReader({
    env: {
      ...env,
      DROPBOX_OAUTH_CLIENT_ID: "shared-account-source-client",
      DROPBOX_OAUTH_CLIENT_SECRET: "shared-account-source-secret",
    },
    db: scope.database,
    storeCredential: storeFilePlacementCredential.bind(null, env, scope),
    command,
    fetcher: fetch,
    now,
  });
  const metadata = await reader.readMetadata(command);
  if (!metadata.ok) throw new Error(metadata.error.code);
  await upsertFileResourceSource({
    scope,
    metadata: {
      integrationAccountId: reference.integrationAccountId,
      provider: "dropbox",
      providerFileId: reference.providerFileId,
      providerRevision: metadata.value.providerRevision,
      displayName: metadata.value.displayName,
      displayPath: metadata.value.displayPath,
      mediaType: metadata.value.mediaType,
      deepLink: metadata.value.deepLink,
      observedAt: now,
    },
    now,
  });
  const projection = await applyFileProjectionCommand({
    scope,
    command,
    sourceReader: reader,
    now,
  });
  if (projection.kind !== "applied")
    throw new Error("Source projection did not apply");
  return reference;
}

async function addSharedAccountFileGrant(
  organisationId: OrganisationId,
  personId: string,
  reference: CanonicalFileReference,
  providerFileId: string,
  grantId: string,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const grant = await createAccessGrant({
    db: scope.database,
    organisationId,
    grantId,
    subject: { kind: "person", personId },
    target: {
      kind: "file_resource",
      capabilityId: "file.read",
      capabilityVersion: 1,
      integrationAccountId: reference.integrationAccountId,
      scope: {
        kind: "dropbox_file",
        providerFileId,
        pathDisplay: "/Restricted account supplier.pdf",
      },
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: `receipt_${grantId}`,
    },
    now: Date.now(),
  });
  if (!grant.ok) throw new Error(grant.error.code);
}

function sourceRefreshToken(): Response {
  return HttpResponse.json({
    access_token: "shared-account-source-refreshed",
    expires_in: 14400,
  });
}

function sourceDropboxAccount(): Response {
  return HttpResponse.json({
    account_id: "dbid:shared-account",
    email: "source@example.invalid",
    name: { display_name: "Source fixture owner" },
    root_info: { home_namespace_id: "shared-account-home" },
  });
}

function sourceDropboxMetadata(probe: SharedAccountSourceProbe): Response {
  probe.metadataReads += 1;
  return HttpResponse.json({
    ".tag": "file",
    id: "id:shared-account-source",
    name: "Restricted account supplier.pdf",
    path_display: "/Restricted account supplier.pdf",
    rev: "shared-account-revision1",
    server_modified: "2026-10-03T00:00:00Z",
    size: 100,
    is_downloadable: true,
  });
}

function unexpectedSourceBody(probe: SharedAccountSourceProbe): Response {
  probe.bodyReads += 1;
  return new Response("Metadata acceptance must not request source content.", {
    status: 500,
  });
}

function requireFixtureUserId(input: string) {
  const parsed = parseUserId(input);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

/** Sign a deliberately expired boundary request with the real dedicated test key. */
export async function expiredFixtureUserAssertion(
  binding: PantryAccountBinding,
  user: LinkedPantryAccountUser,
  nativeSessionId: string,
): Promise<string> {
  const pkcs8 = decodeBase64(
    accountText(env.ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U)
      .replaceAll("-", "+")
      .replaceAll("_", "/"),
  );
  if (pkcs8 === null) throw new Error("Invalid test assertion key");
  const buffer = new ArrayBuffer(pkcs8.byteLength);
  new Uint8Array(buffer).set(pkcs8);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    buffer,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const header = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        alg: "EdDSA",
        typ: "JWT",
        kid: env.ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID,
      }),
    ),
  );
  const payload = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        issuer: env.ACCOUNT_PLATFORM_ASSERTION_ISSUER,
        audience: env.ACCOUNT_PLATFORM_ASSERTION_AUDIENCE,
        principal: fixtureUserPrincipal(user, nativeSessionId),
        nativePrincipalId: user.nativeUserId,
        scope: binding.scope,
        instanceId: binding.instanceId,
        action: "disclose",
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        authorityRevision: 0,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export function fixtureUserPrincipal(
  user: LinkedPantryAccountUser,
  nativeSessionId: string,
): AccountPrincipal {
  return {
    kind: "user",
    identity: {
      kind: "verified_provider_subject",
      userId: user.platformUserId,
      issuer: user.issuer,
      subject: user.subject,
      verificationReceiptId: user.verificationReceiptId,
    },
    authority: { kind: "authenticated_session", nativeSessionId },
  };
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

export function inspectNativeAcceptedTurn(
  sessionId: string,
  turnId: string,
  _actor: unknown,
  state: DurableObjectState,
) {
  const checkpoint = readLatestHarnessCheckpoint(state.storage.sql, sessionId);
  if (!checkpoint.ok) throw new Error(checkpoint.error.code);
  const streams = state.storage.sql
    .exec<{
      turn_id: string;
      state: string;
      last_sequence: number;
      error_detail: string | null;
    }>(
      "SELECT turn_id, state, last_sequence, error_detail FROM session_turn_stream WHERE turn_id = ?",
      turnId,
    )
    .toArray();
  return {
    checkpoint: checkpoint.value,
    streams,
    billing: readPantryExecutionBilling(state.storage.sql, turnId),
  };
}

export interface SharedNativePortalInvitation {
  readonly invitationId: string;
  readonly token: string;
  readonly role: "admin" | "operator" | "viewer";
}

export function readSharedNativePortalInvitation(
  input: unknown,
): SharedNativePortalInvitation {
  const response = accountObject(input, ["ok", "invitation", "token"]);
  if (response.ok !== true)
    throw new Error("Native shared invitation was not issued");
  const invitation = accountObject(response.invitation, [
    "organisationInvitationId",
    "invitedEmail",
    "role",
    "createdAt",
    "expiresAt",
    "kind",
  ]);
  if (
    invitation.kind !== "pending" ||
    (invitation.role !== "admin" &&
      invitation.role !== "operator" &&
      invitation.role !== "viewer")
  )
    throw new Error("Invalid native invitation state");
  accountText(invitation.invitedEmail);
  accountInteger(invitation.createdAt, 1);
  accountInteger(invitation.expiresAt, 1);
  return {
    invitationId: accountText(invitation.organisationInvitationId),
    token: accountText(response.token),
    role: invitation.role,
  };
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

export async function readNativeServiceGrant(
  organisationId: OrganisationId,
  client: SharedAccountNativeClient,
): Promise<Record<string, unknown>> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const raw = await scope.database
    .prepare(
      "SELECT role, status, platform_membership_id AS platformMembershipId, account_access_revision AS accountAccessRevision, account_acceptance_receipt_id AS accountAcceptanceReceiptId FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(organisationId, client.identity.userId)
    .first<unknown>();
  return accountObject(raw, [
    "role",
    "status",
    "platformMembershipId",
    "accountAccessRevision",
    "accountAcceptanceReceiptId",
  ]);
}

export async function sharedAccountPolicySupersession(
  organisationId: OrganisationId,
  owner: SharedAccountNativeClient,
) {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const original = await compileSharedOwnerAuthority(scope, owner);
  const initialClaim = await sharedDiscoveryClaim(scope, owner, original);
  if (!initialClaim.ok) throw new Error(initialClaim.error.code);
  const disabled = await setSharedDiscoveryPolicy(scope, owner, "disabled");
  await publishSharedNativePolicy(organisationId, scope.database);
  const staleAfterDisable = await sharedDiscoveryClaim(scope, owner, original);
  if (
    staleAfterDisable.ok ||
    staleAfterDisable.error.code !== "organisation_policy_superseded"
  )
    throw new Error("A pinned capability survived native policy supersession");
  const disabledAuthority = await compileSharedOwnerAuthority(scope, owner);
  const disabledClaim = await sharedDiscoveryClaim(
    scope,
    owner,
    disabledAuthority,
  );
  if (disabledClaim.ok)
    throw new Error("A fresh authority admitted a disabled capability");
  await setSharedDiscoveryPolicy(scope, owner, "enabled");
  await publishSharedNativePolicy(organisationId, scope.database);
  const staleAfterRestore = await sharedDiscoveryClaim(
    scope,
    owner,
    disabledAuthority,
  );
  if (
    staleAfterRestore.ok ||
    staleAfterRestore.error.code !== "organisation_policy_superseded"
  )
    throw new Error(
      "An additive native policy change preserved a pinned authority",
    );
  const current = await compileSharedOwnerAuthority(scope, owner);
  const restoredClaim = await sharedDiscoveryClaim(scope, owner, current);
  if (!restoredClaim.ok) throw new Error(restoredClaim.error.code);
  return {
    initialVersion: original.authorityPartition.policyVersion,
    disabledRevision: disabled.revision,
    disabledVersion: disabledAuthority.authorityPartition.policyVersion,
    restoredVersion: current.authorityPartition.policyVersion,
    initialClaim: initialClaim.ok,
    staleAfterDisable: staleAfterDisable.error.code,
    disabledClaim: disabledClaim.error.code,
    staleAfterRestore: staleAfterRestore.error.code,
    restoredClaim: restoredClaim.ok,
    initialDigest: original.authorityPartition.digest,
    restoredDigest: current.authorityPartition.digest,
  };
}

async function compileSharedOwnerAuthority(
  scope: OrganisationExecutionScope,
  owner: SharedAccountNativeClient,
): Promise<CompiledTurnAuthority> {
  const membership = await readActiveOrganisationMembership(
    scope.database,
    scope.organisationId,
    owner.identity.userId,
  );
  const revision = await readActiveOrganisationMembershipRevision({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  const policy = await readCurrentOrganisationPolicySnapshot(
    scope.database,
    scope.organisationId,
  );
  if (membership === null || revision === null || !policy.ok)
    throw new Error("Current owner authority is unavailable");
  const authority = buildControlAuthority({
    organisationId: scope.organisationId,
    userId: owner.identity.userId,
    requesterPersonId: membership.personId,
    membershipRevision: revision,
    role: membership.role,
  }).requestAuthority;
  const compiled = await compileTurnAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: {
      kind: "authenticated_session",
      nativeSessionId: owner.session.session.controlSessionId,
    },
    action: "execute",
    organisationId: scope.organisationId,
    requestAuthority: authority,
    policy: { version: policy.value.version },
  });
  if (!compiled.ok) throw new Error(compiled.error.code);
  return compiled.value;
}

function sharedDiscoveryClaim(
  scope: OrganisationExecutionScope,
  owner: SharedAccountNativeClient,
  compiled: CompiledTurnAuthority,
) {
  return authorizeCapabilityUse({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: {
      kind: "authenticated_session",
      nativeSessionId: owner.session.session.controlSessionId,
    },
    action: "execute",
    organisationId: scope.organisationId,
    authority: compiled.requestAuthority,
    authorityPartition: compiled.authorityPartition,
    request: {
      capabilities: [
        {
          kind: "platform_capability",
          capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
          capabilityVersion: 1,
        },
      ],
    },
  });
}

async function setSharedDiscoveryPolicy(
  scope: OrganisationExecutionScope,
  owner: SharedAccountNativeClient,
  mode: "enabled" | "disabled",
) {
  const policies = await readOrganisationCapabilityPolicies({
    db: scope.database,
    organisationId: scope.organisationId,
  });
  if (!policies.ok) throw new Error(policies.error.code);
  const current = policies.value.find(sharedDiscoveryPolicy);
  if (current === undefined)
    throw new Error("Native baseline discovery policy missing");
  const written = await writeOrganisationCapabilityPolicy({
    scope,
    write: {
      kind: "change",
      capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
      expectedRevision: current.revision,
      mode,
      provenance: {
        kind: "operator",
        userId: owner.identity.userId,
        mutationReceiptId: `shared_account_policy_${mode}`,
      },
      now: Date.now(),
    },
  });
  if (!written.ok) throw new Error(written.error.code);
  return written.value;
}

function sharedDiscoveryPolicy(policy: OrganisationCapabilityPolicy): boolean {
  return policy.capabilityId === CAPABILITY_KEYS.integrationDiscoveryRead;
}

async function publishSharedNativePolicy(
  organisationId: OrganisationId,
  database: OrganisationDatabase,
): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: database, kv: env.POLICY_KV },
    organisationId,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
}
