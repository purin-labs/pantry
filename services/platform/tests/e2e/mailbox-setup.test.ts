import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse } from "msw";
import {
  encodeMailboxSetupAgentChoice,
  parseMailboxSetupPlan,
  type MailboxSetupAgentChoice,
  type MailboxSetupPlan,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { acceptedExecutionAuthority } from "../../src/organisation-access/access";
import { compileTurnAuthority } from "../../src/authorization/access-grants/turn-authority";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { readAgentMailboxBinding } from "../../src/data/email-mailbox";
import {
  readActiveOrganisationMembership,
  readActiveOrganisationMembershipRevision,
} from "../../src/data/control-plane";
import { type IntegrationAccountId, type OrganisationId } from "../../src/ids";
import { authorizeMailSource } from "../../src/mail-inbox/contract/mail-source-authorization";
import { resolveOrganisationModelRoute } from "../../src/models/route";
import { readCurrentOrganisationPolicySnapshot } from "../../src/policy-snapshot";
import {
  buildAgentMailboxAuthority,
  buildControlAuthority,
} from "../../src/request-authority";
import {
  runMailboxSetup,
  type MailboxSetupTransport,
} from "../../../../apps/portal/src/features/mail-setup/run";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import { connectGmailMailbox, sendAs } from "./gmail-mailbox-support";

const ADDRESS = "orders@example.test";

it(
  "takes a connected mailbox with no agent to one that may read, draft and be reviewed, through the changes its setup plan names",
  { timeout: 120_000 },
  mailboxSetupJourney,
);

async function mailboxSetupJourney({ task }: TestContext): Promise<void> {
  // A new Organisation on the account authority, with the access defaults
  // that each new Organisation gets. It has no agent and no area.
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
  } = await installMemoryFixture();
  const account = await connectMailbox(organisationId, owner);
  const base = `/v1/control/organisations/${organisationId}`;
  const mailboxPath = `${base}/agent-mailboxes/${account}`;
  const plan = (
    person: Member = owner,
    choice: MailboxSetupAgentChoice = { kind: "automatic" },
  ) =>
    readPlan(
      person,
      `${mailboxPath}/setup?agent=${encodeURIComponent(encodeMailboxSetupAgentChoice(choice))}`,
    );
  const enabled = {
    kind: "enabled",
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 200_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
    debounce: { kind: "push_triggered", coalesceSeconds: 30 },
    overflow: "pause_and_notify",
  };

  // 1. Nothing is ready. The plan settles on the mail agent that Pantry
  //    creates, because the workspace has no agent, and its first change
  //    creates that agent. The read changes nothing.
  const first = await plan();
  expect(first.status).toBe(200);
  expect(first.plan).toMatchObject({
    agent: { choice: { kind: "new" }, name: "Mail assistant", state: "absent" },
    model: { kind: "not_approved" },
    next: {
      kind: "agent_operation",
      body: { kind: "create_agent_definition", role: "mail_assistant" },
    },
  });
  expect(states(first.plan)).toEqual({
    agent: "missing",
    reply_drafts: "missing",
    agent_context: "missing",
    review: "missing",
    model: "missing",
  });
  expect((await plan()).plan).toEqual(first.plan);
  // The plan is for a person who can make its changes. An admin reads it. A
  // member with a lower role gets the answer of an absent record.
  expect((await plan(admin)).status).toBe(200);
  expect((await plan(viewer)).status).toBe(404);
  // Before the setup, each check that a mail turn and a draft review make
  // refuses: the mailbox cannot be turned on, no reply may be drafted, and
  // the owner cannot read the mailbox in Pantry.
  expect(
    await sendAs(owner, `${mailboxPath}/policy`, { policy: enabled }),
  ).toEqual({
    status: 409,
    body: { ok: false, error: "agent_mailbox_unassigned" },
  });
  expect(await mayDraftReplies(organisationId)).toBe(false);
  expect(await readsMailbox(owner, account)).toBe(false);

  // 2. The owner presses the setup action. The Portal's own runner makes
  //    each change that the plan names, one at a time, through the control
  //    route that the change belongs to. Nothing else writes a record.
  const made = await setUp(owner, organisationId, account, {
    kind: "automatic",
  });
  expect(made).toEqual([
    "agent_operation:create_agent_definition",
    "agent_operation:create_area",
    "agent_operation:install_agent",
    "assign_agent",
    `enable_action:${CAPABILITY_KEYS.emailReplyPropose}`,
    "grant_access:platform",
    `enable_action:${CAPABILITY_KEYS.emailMailboxRead}`,
    "grant_access:provider_resource",
    "grant_access:provider_resource",
  ]);
  const ready = await plan();
  expect(ready.plan).toMatchObject({
    agent: { name: "Mail assistant", state: "assigned" },
    next: null,
    model: { kind: "not_approved" },
  });
  expect(states(ready.plan)).toEqual({
    agent: "met",
    reply_drafts: "met",
    agent_context: "met",
    review: "met",
    model: "missing",
  });

  // 3. The records are the ones the runtime reads. The mailbox turns on. A
  //    turn of its agent compiles its authority with the Case context. A
  //    reply may be drafted. The owner and the admin read the mailbox in
  //    Pantry, and the member with a lower role does not.
  const on = await sendAs(owner, `${mailboxPath}/policy`, { policy: enabled });
  expect(on).toMatchObject({ status: 200, body: { ok: true } });
  const policyVersion = publishedPolicyVersion(on.body);
  const authority = await turnAuthority(organisationId, account, policyVersion);
  expect(authority).toMatchObject({ ok: true });
  expect(authority.capabilities).toContain(CAPABILITY_KEYS.contextCaseRead);
  expect(await mayDraftReplies(organisationId)).toBe(true);
  expect(await readsMailbox(owner, account)).toBe(true);
  expect(await readsMailbox(admin, account)).toBe(true);
  expect(await readsMailbox(viewer, account)).toBe(false);

  // 4. Pantry records the approval of the model for mailbox content. No
  //    change of the plan does. With that record the plan has nothing left.
  await approveModel(organisationId);
  const approved = await plan();
  expect(approved.plan).toMatchObject({
    next: null,
    model: { kind: "approved" },
  });
  expect(Object.values(states(approved.plan))).toEqual(
    Array.from({ length: 5 }, () => "met"),
  );

  // 5. The owner gives the mailbox to a second agent that exists and is not
  //    active. The plan makes it active in the area that exists and assigns
  //    it. The agent's grant names the assignment and its revision, so the
  //    earlier grant no longer serves, and the plan asks for it again.
  const second = await sendAs(owner, `${base}/operations`, {
    kind: "create_agent_definition",
    displayName: "Order desk",
    role: "orders",
    purpose: "Answers mail about orders.",
    instructions: "Answer mail about orders.",
    requestedCapabilities: [],
    skillRefs: [],
  });
  expect(second.status).toBe(201);
  const orderDesk = definitionId(second.body, "Order desk");
  const choice: MailboxSetupAgentChoice = {
    kind: "definition",
    agentDefinitionId: orderDesk,
  };
  const chosen = () => plan(owner, choice);
  const before = await chosen();
  expect(before.plan).toMatchObject({
    agent: { choice, name: "Order desk", state: "inactive" },
    next: { kind: "agent_operation", body: { kind: "install_agent" } },
  });
  // The automatic choice keeps the agent that answers the mailbox now.
  expect((await plan()).plan?.agent).toMatchObject({
    name: "Mail assistant",
    state: "assigned",
  });
  const changed = await setUp(owner, organisationId, account, choice);
  expect(changed).toEqual([
    "agent_operation:install_agent",
    "assign_agent",
    "grant_access:platform",
  ]);
  const after = await chosen();
  expect(after.plan).toMatchObject({
    agent: { name: "Order desk", state: "assigned" },
    next: null,
  });
  expect(Object.values(states(after.plan))).toEqual(
    Array.from({ length: 5 }, () => "met"),
  );
  const rebound = await turnAuthority(organisationId, account, policyVersion);
  expect(rebound).toMatchObject({ ok: true });
  expect(rebound.capabilities).toContain(CAPABILITY_KEYS.contextCaseRead);

  // 6. A choice that names no agent of this Organisation is refused, and so
  //    is a mailbox that is not connected.
  expect(
    (await plan(owner, { kind: "installation", installationId: "missing" }))
      .status,
  ).toBe(409);
  expect(
    (
      await readPlan(
        owner,
        `${base}/agent-mailboxes/integration_account_missing/setup`,
      )
    ).status,
  ).toBe(404);

  Object.assign(task.meta, {
    mailboxSetup: {
      before: states(first.plan),
      changes: made,
      afterChanges: states(ready.plan),
      afterModelApproval: states(approved.plan),
      changeOfAgent: changed,
    },
  });
}

/**
 * One press of the setup action: the Portal's runner, with the session of
 * one person. It returns the changes that the runner made, in order.
 */
async function setUp(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
  choice: MailboxSetupAgentChoice,
): Promise<readonly string[]> {
  const made: string[] = [];
  const transport: MailboxSetupTransport = {
    read: async (path) => {
      const response = await exports.default.fetch(`https://localhost${path}`, {
        headers: commerceHeaders(person.session),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body));
      return body;
    },
    mutate: async (path, _method, body) => {
      const sent = await sendAs(person, path, body);
      if (sent.status !== 200 && sent.status !== 201)
        throw new Error(JSON.stringify(sent));
      made.push(changeName(path, body));
      return sent.body;
    },
  };
  const plan = await runMailboxSetup(
    transport,
    { organisationId, integrationAccountId: account },
    choice,
  );
  expect(plan.next).toBeNull();
  return made;
}

/** A change by its control route and what it asks for. */
function changeName(path: string, body: unknown): string {
  const record = isRecord(body) ? body : {};
  if (path.endsWith("/operations"))
    return `agent_operation:${String(record.kind)}`;
  if (path.endsWith("/bind")) return "assign_agent";
  if (path.endsWith("/access-control/grants"))
    return `grant_access:${isRecord(record.target) ? String(record.target.kind) : ""}`;
  const capability = /\/access-control\/capabilities\/([^/]+)$/u.exec(path);
  if (capability !== null)
    return `enable_action:${decodeURIComponent(capability[1] ?? "")}`;
  throw new Error(`The setup used a route outside its four: ${path}`);
}

function states(plan: MailboxSetupPlan | null): Record<string, string> {
  if (plan === null) throw new Error("The setup plan is missing");
  return Object.fromEntries(
    plan.requirements.map((requirement) => [requirement.id, requirement.state]),
  );
}

async function readPlan(
  person: Member,
  path: string,
): Promise<Readonly<{ status: number; plan: MailboxSetupPlan | null }>> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    headers: commerceHeaders(person.session),
  });
  const body: unknown = await response.json();
  return {
    status: response.status,
    plan:
      response.ok && isRecord(body) ? parseMailboxSetupPlan(body.setup) : null,
  };
}

function publishedPolicyVersion(body: unknown): number {
  const version =
    isRecord(body) && isRecord(body.policy) ? body.policy.policyVersion : null;
  if (typeof version !== "number") throw new Error("The policy has no version");
  return version;
}

function definitionId(body: unknown, displayName: string): string {
  const definitions =
    isRecord(body) && isRecord(body.operations)
      ? body.operations.definitions
      : null;
  if (Array.isArray(definitions))
    for (const definition of definitions)
      if (
        isRecord(definition) &&
        definition.displayName === displayName &&
        typeof definition.agentDefinitionId === "string"
      )
        return definition.agentDefinitionId;
  throw new Error(`No agent named ${displayName}`);
}

/** The authority that a turn of the mailbox's agent compiles. */
async function turnAuthority(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
  mailboxPolicyVersion: number,
): Promise<Readonly<{ ok: boolean; capabilities: readonly string[] }>> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const binding = await readAgentMailboxBinding({
    db: scope.database,
    organisationId,
    integrationAccountId: account,
  });
  if (!binding.ok) throw new Error(binding.error.code);
  const policy = await readCurrentOrganisationPolicySnapshot(
    scope.database,
    organisationId,
  );
  if (!policy.ok) throw new Error(policy.error.code);
  const compiled = await compileTurnAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAuthority(
      "session_mailbox_setup",
      "turn_mailbox_setup",
    ),
    action: "execute",
    organisationId,
    requestAuthority: buildAgentMailboxAuthority({
      organisationId,
      integrationAccountId: account,
      mailboxBindingId: binding.value.binding.mailboxBindingId,
      bindingRevision: binding.value.binding.currentRevision,
      mailboxPolicyVersion,
    }).requestAuthority,
    policy: { version: policy.value.version },
  });
  return compiled.ok
    ? {
        ok: true,
        capabilities: compiled.value.effectiveGrantSet.capabilities.map(
          (capability) => capability.definition.capabilityId,
        ),
      }
    : { ok: false, capabilities: [compiled.error.code] };
}

/** Whether the Organisation's present policy lets a turn draft a reply. */
async function mayDraftReplies(
  organisationId: OrganisationId,
): Promise<boolean> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const policy = await readCurrentOrganisationPolicySnapshot(
    scope.database,
    organisationId,
  );
  if (!policy.ok) throw new Error(policy.error.code);
  return (
    policy.value.authz.allowedTools.includes(
      CAPABILITY_KEYS.emailReplyPropose,
    ) &&
    !policy.value.authz.deniedTools.includes(CAPABILITY_KEYS.emailReplyPropose)
  );
}

/** The check that each mailbox read and each draft review of a person makes. */
async function readsMailbox(
  person: Member,
  account: IntegrationAccountId,
): Promise<boolean> {
  const scope = await requireOrganisationExecutionScope(
    env,
    person.organisationId,
  );
  const [membership, membershipRevision] = await Promise.all([
    readActiveOrganisationMembership(
      fixtureDatabase(),
      person.organisationId,
      person.userId,
    ),
    readActiveOrganisationMembershipRevision({
      db: scope.database,
      organisationId: person.organisationId,
    }),
  ]);
  if (membership === null || membershipRevision === null)
    throw new Error("The person has no role");
  const authorized = await authorizeMailSource(
    env,
    buildControlAuthority({
      organisationId: person.organisationId,
      userId: person.userId,
      membershipRevision,
      requesterPersonId: person.personId,
      role: membership.role,
    }).requestAuthority,
    account,
  );
  return authorized !== null;
}

/** What Pantry's operator records after the review of a model route. */
async function approveModel(organisationId: OrganisationId): Promise<void> {
  const now = Date.now();
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now,
  });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase()
    .prepare(
      "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'mailbox-setup-e2e', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
    )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now - 1,
      now + 3_600_000,
      now - 1,
    )
    .run();
}

/**
 * A Gmail mailbox as the connection leaves it: the account, its credential,
 * the mailbox resource and the mailbox record. No agent, no grant, no policy.
 */
async function connectMailbox(
  organisationId: OrganisationId,
  owner: Member,
): Promise<IntegrationAccountId> {
  network.use(
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/profile", () =>
      HttpResponse.json({ emailAddress: ADDRESS, historyId: "1000" }),
    ),
    // The mailbox that is on asks Gmail what arrived. Nothing did.
    http.get("https://gmail.googleapis.com/gmail/v1/users/me/history", () =>
      HttpResponse.json({ historyId: "1000" }),
    ),
    http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () =>
      HttpResponse.json({
        historyId: "1000",
        expiration: String(Date.now() + 2 * 86_400_000),
      }),
    ),
  );
  return connectGmailMailbox(organisationId, owner, {
    label: "setup",
    address: ADDRESS,
  });
}
