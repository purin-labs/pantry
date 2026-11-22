import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse } from "msw";
import {
  encodeMailboxSetupAgentChoice,
  parseMailboxSetupPlan,
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
import { readCurrentOrganisationPolicySnapshot } from "../../src/policy-snapshot";
import {
  buildAgentMailboxAuthority,
  buildControlAuthority,
} from "../../src/request-authority";
import { setUpMailbox } from "../../../../apps/portal/src/features/mail-setup/turn-on";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import {
  approveMailboxModel,
  connectGmailMailbox,
  portalSetupTransport,
  sendAs,
} from "./gmail-mailbox-support";

const ADDRESS = "orders@example.test";

it(
  "turns a connected mailbox on with one press of the owner, and refuses the same press of a member without the right",
  { timeout: 120_000 },
  mailboxTurnOnJourney,
);

async function mailboxTurnOnJourney({ task }: TestContext): Promise<void> {
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
  const plan = (person: Member = owner) =>
    readPlan(
      person,
      `${mailboxPath}/setup?agent=${encodeURIComponent(encodeMailboxSetupAgentChoice({ kind: "automatic" }))}`,
    );

  // 1. Nothing is ready. The plan settles on the mail agent that Pantry
  //    creates, because the workspace has no agent. Pantry has not approved
  //    the model for email content, so the Portal offers no Turn on yet. The
  //    read changes nothing. A member below the admin role gets the answer
  //    of an absent record.
  const first = await plan();
  expect(first.status).toBe(200);
  expect(first.plan).toMatchObject({
    agent: { choice: { kind: "new" }, name: "Mail assistant", state: "absent" },
    model: { kind: "not_approved" },
  });
  expect(Object.values(states(first.plan))).toEqual(
    Array.from({ length: 5 }, () => "missing"),
  );
  expect((await plan(admin)).status).toBe(200);
  expect((await plan(viewer)).status).toBe(404);
  // Without an agent the mailbox cannot turn on, whoever asks.
  expect(
    await sendAs(owner, `${mailboxPath}/policy`, {
      policy: { kind: "enabled" },
    }),
  ).toEqual({
    status: 409,
    body: { ok: false, error: "agent_mailbox_unassigned" },
  });

  // 2. Pantry records the approval of the model for mailbox content. The
  //    Portal's Turn on is then ready.
  await approveMailboxModel(organisationId, "mailbox-setup-e2e");
  expect((await plan()).plan?.model).toEqual({ kind: "approved" });

  // 3. A member without the right presses Turn on. The Portal's own press
  //    stops at its first read, and nothing changes: no reply may be
  //    drafted and the mailbox stays off.
  const refused = await turnOn(viewer, organisationId, account);
  expect(refused).toEqual({ turnedOn: false, changes: [] });
  expect(await mayDraftReplies(organisationId)).toBe(false);
  expect((await readMailbox(owner, mailboxPath)).policy).toMatchObject({
    kind: "disabled_by_default",
  });

  // 4. The owner presses Turn on once. The Portal's own press makes each
  //    change that the plan names, through the control route that the
  //    change belongs to, then turns the mailbox on with no limits named.
  const pressed = await turnOn(owner, organisationId, account);
  expect(pressed).toEqual({
    turnedOn: true,
    changes: [
      "agent_operation:create_agent_definition",
      "agent_operation:create_area",
      "agent_operation:install_agent",
      "assign_agent",
      `enable_action:${CAPABILITY_KEYS.emailReplyPropose}`,
      "grant_access:platform",
      `enable_action:${CAPABILITY_KEYS.emailMailboxRead}`,
      "grant_access:provider_resource",
      "grant_access:provider_resource",
      "turn_on",
    ],
  });
  const done = await plan();
  expect(done.plan).toMatchObject({
    agent: { name: "Mail assistant", state: "assigned" },
    next: null,
  });
  expect(Object.values(states(done.plan))).toEqual(
    Array.from({ length: 5 }, () => "met"),
  );

  // 5. The mailbox is on with the server's limits. A turn of its agent
  //    compiles its authority with the Case context. A reply may be
  //    drafted. The owner and the admin read the mailbox in Pantry, and the
  //    member with a lower role does not.
  const on = await readMailbox(owner, mailboxPath);
  expect(on.policy).toMatchObject({
    kind: "enabled",
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 1_000_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
  });
  const policyVersion = on.policy.policyVersion;
  if (typeof policyVersion !== "number")
    throw new Error("The policy has no version");
  const authority = await turnAuthority(organisationId, account, policyVersion);
  expect(authority).toMatchObject({ ok: true });
  expect(authority.capabilities).toContain(CAPABILITY_KEYS.contextCaseRead);
  expect(await mayDraftReplies(organisationId)).toBe(true);
  expect(await readsMailbox(owner, account)).toBe(true);
  expect(await readsMailbox(admin, account)).toBe(true);
  expect(await readsMailbox(viewer, account)).toBe(false);

  Object.assign(task.meta, {
    mailboxTurnOn: {
      before: states(first.plan),
      refusedPress: refused,
      ownerPress: pressed,
      after: states(done.plan),
      policy: on.policy,
    },
  });
}

/**
 * One press of Turn on: the Portal's own action, with the session of one
 * person. It returns whether the mailbox turned on and the changes that the
 * press made, in order.
 */
async function turnOn(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<Readonly<{ turnedOn: boolean; changes: readonly string[] }>> {
  const changes: string[] = [];
  const transport = portalSetupTransport(person, (path, body) =>
    changes.push(changeName(path, body)),
  );
  const turnedOn = await setUpMailbox(
    transport,
    { organisationId, integrationAccountId: account },
    { kind: "automatic" },
    true,
  ).then(
    () => true,
    () => false,
  );
  return { turnedOn, changes };
}

async function readMailbox(
  person: Member,
  mailboxPath: string,
): Promise<Readonly<{ policy: Record<string, unknown> }>> {
  const response = await exports.default.fetch(
    `https://localhost${mailboxPath}`,
    { headers: commerceHeaders(person.session) },
  );
  const body: unknown = await response.json();
  if (
    !response.ok ||
    !isRecord(body) ||
    !isRecord(body.mailbox) ||
    !isRecord(body.mailbox.policy)
  )
    throw new Error(JSON.stringify(body));
  return { policy: body.mailbox.policy };
}

/** A change by its control route and what it asks for. */
function changeName(path: string, body: unknown): string {
  const record = isRecord(body) ? body : {};
  if (path.endsWith("/operations"))
    return `agent_operation:${String(record.kind)}`;
  if (path.endsWith("/bind")) return "assign_agent";
  if (path.endsWith("/policy")) return "turn_on";
  if (path.endsWith("/access-control/grants"))
    return `grant_access:${isRecord(record.target) ? String(record.target.kind) : ""}`;
  const capability = /\/access-control\/capabilities\/([^/]+)$/u.exec(path);
  if (capability !== null)
    return `enable_action:${decodeURIComponent(capability[1] ?? "")}`;
  throw new Error(`Turn on used a route outside its five: ${path}`);
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
