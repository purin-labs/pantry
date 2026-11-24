import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, type HttpResponseResolver } from "msw";
import {
  encodeMailboxSetupAgentChoice,
  mailboxModelConsentRequest,
  type MailboxModelReview,
  type MailboxSetupPlan,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { acceptedExecutionAuthority } from "@purin-labs/tenancy/organisation-access/access";
import { compileTurnAuthority } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { readAgentMailboxBinding } from "@purin-labs/area-inbox/server/data/email-mailbox";
import {
  readActiveOrganisationMembership,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import {
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeMailSource } from "@purin-labs/area-inbox-contract/server/mail-source-authorization";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import {
  buildAgentMailboxAuthority,
  buildControlAuthority,
} from "@purin-labs/authority/request-authority/index";
import { setUpMailbox } from "@purin-labs/area-inbox/ui/features/mail-setup/turn-on";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import { modelToolResults } from "./chat-journey-support";
import {
  FakeGmailMailbox,
  connectGmailMailbox,
  draftReplyTurn,
  evaluateAt,
  mailboxConnector,
  portalSetupTransport,
  runDueMailWork,
  readPlan,
  reviewOf,
  scheduledAt,
  sendAs,
  type MailboxConnector,
} from "./gmail-mailbox-support";

const ADDRESS = "orders@example.test";
const MAIL_TEXT = "Can we still add ten cases of butter to tomorrow's order?";
const PAID_DEFAULT = "google/gemini-4-hydrogen";
const PAID_OTHER = "moonshotai/kimi-k3";
/** The OpenRouter routing of a model that may receive mail. */
const ZERO_RETENTION = {
  sort: "throughput",
  data_collection: "deny",
  zdr: true,
};

it(
  "turns a connected mailbox on with one press and one consent of the owner, refuses a member without the right, and holds new mail after a change of model until a new consent",
  { timeout: 240_000 },
  mailboxTurnOnJourney,
);

async function mailboxTurnOnJourney({
  task,
  onTestFinished,
}: TestContext): Promise<void> {
  // A new Organisation on the account authority, with the access defaults
  // that each new Organisation gets. It has no agent and no area. It runs
  // Pantry's paid route with its default model.
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
  } = await installMemoryFixture();
  const gmail = new FakeGmailMailbox({
    address: ADDRESS,
    sender: "Supplier <supplier@example.test>",
    subject: "Tomorrow's order",
    text: MAIL_TEXT,
  });
  gmail.serve();
  const agent = new MailAgent();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      agent.answer.bind(agent),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "setup",
    address: ADDRESS,
  });
  const base = `/v1/control/organisations/${organisationId}`;
  const mailboxPath = `${base}/agent-mailboxes/${account}`;
  const plan = (person: Member = owner) =>
    readPlan(
      person,
      `${mailboxPath}/setup?agent=${encodeURIComponent(encodeMailboxSetupAgentChoice({ kind: "automatic" }))}`,
    );

  // 1. Nothing is ready. The plan settles on the mail agent that Pantry
  //    creates, because the workspace has no agent. Purin reviewed the
  //    workspace's model for email, and nobody accepted its data terms yet.
  //    The read changes nothing. A member below the admin role gets the
  //    answer of an absent record.
  const first = await plan();
  expect(first.status).toBe(200);
  expect(first.plan).toMatchObject({
    agent: { choice: { kind: "new" }, name: "Mail assistant", state: "absent" },
    model: {
      kind: "consent_needed",
      review: {
        keySource: "platform",
        provider: "openai-compatible",
        model: PAID_DEFAULT,
        name: "Gemini 4 Hydrogen",
        recipients: "OpenRouter and Google Vertex AI",
        termsUrl: "https://openrouter.ai/docs/guides/features/zdr",
      },
    },
  });
  expect(Object.values(states(first.plan))).toEqual(
    Array.from({ length: 5 }, () => "missing"),
  );
  expect((await plan(admin)).status).toBe(200);
  expect((await plan(viewer)).status).toBe(404);
  const review = reviewOf(first.plan);
  // Without an agent the mailbox cannot turn on, whoever asks.
  expect(
    await sendAs(owner, `${mailboxPath}/policy`, {
      policy: { kind: "enabled" },
    }),
  ).toEqual({
    status: 409,
    body: { ok: false, error: "agent_mailbox_unassigned" },
  });

  // 2. A member without the right checks the box and presses Turn on. The
  //    Portal's own press stops at its first read. The consent route
  //    refuses the member too. Nothing changes: no reply may be drafted,
  //    the mailbox stays off and nobody accepted the terms.
  const refused = await press(viewer, organisationId, account, {
    turnOn: true,
    accepted: review,
  });
  expect(refused).toEqual({ done: false, changes: [] });
  expect(
    await sendAs(
      viewer,
      `${mailboxPath}/model-consent`,
      mailboxModelConsentRequest(review),
    ),
  ).toEqual({
    status: 404,
    body: { ok: false, error: "organisation_role_insufficient" },
  });
  expect(await mayDraftReplies(organisationId)).toBe(false);
  expect((await readMailbox(owner, mailboxPath)).policy).toMatchObject({
    kind: "disabled_by_default",
  });
  expect(await acceptances(organisationId)).toEqual([]);

  // 3. The owner checks the box and presses Turn on once. The Portal's own
  //    press makes each change that the plan names, through the control
  //    route that the change belongs to, records the acceptance, then turns
  //    the mailbox on with no limits named.
  const pressed = await press(owner, organisationId, account, {
    turnOn: true,
    accepted: review,
  });
  expect(pressed).toEqual({
    done: true,
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
      "model_consent",
      "turn_on",
    ],
  });
  const done = await plan();
  expect(done.plan).toMatchObject({
    agent: { name: "Mail assistant", state: "assigned" },
    next: null,
    model: { kind: "approved", review: { model: PAID_DEFAULT } },
  });
  expect(Object.values(states(done.plan))).toEqual(
    Array.from({ length: 5 }, () => "met"),
  );
  // The acceptance copies Purin's review and names the owner and the
  // receipt of the press.
  const accepted = await acceptances(organisationId);
  expect(accepted).toEqual([
    {
      model: PAID_DEFAULT,
      evidenceReference: review.termsUrl,
      evidenceOwner: "Purin",
      disclosedRecipients: review.recipients,
      reviewExpiresAt: review.reviewExpiresAt,
      consentedBy: owner.userId,
      consentReference: expect.stringMatching(/^receipt_/u),
      revoked: false,
    },
  ]);

  // 4. The mailbox is on with the server's limits. A turn of its agent
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

  // 5. A new email reaches the agent on the accepted model. OpenRouter is
  //    asked to route it only to an endpoint that trains on no prompt and
  //    keeps none after the answer.
  const connector = await mailboxConnector(organisationId, account);
  const admit = async (messageId: string, threadId: string) => {
    gmail.arrive(messageId, threadId);
    const checked = await sendAs(owner, `${mailboxPath}/check`, {});
    const evaluated = await runInDurableObject(
      connector,
      evaluateAt.bind(null, organisationId, scheduledAt(checked)),
    );
    expect(evaluated, JSON.stringify(evaluated)).toMatchObject({
      kind: "evaluated",
      admitted: 1,
    });
  };
  await admit("first_message", "first_thread");
  await agentReads(agent, connector, PAID_DEFAULT);
  await expect
    .poll(() => gmail.drafts.size, { timeout: 60_000, interval: 500 })
    .toBe(1);

  // 6. The workspace's model changes. Nobody accepted the new model's
  //    terms, so the setup asks for the checkbox again and the agent reads
  //    no new mail: its turn waits for another attempt.
  env.PANTRY_PLATFORM_PI_MODEL = PAID_OTHER;
  onTestFinished(() => {
    delete env.PANTRY_PLATFORM_PI_MODEL;
  });
  const changed = await plan();
  expect(changed.plan?.model).toMatchObject({
    kind: "consent_needed",
    review: { model: PAID_OTHER, name: "Kimi K3" },
  });
  expect(states(changed.plan).model).toBe("missing");
  await admit("second_message", "second_thread");
  await runDueMailWork(connector);
  expect(await runInDurableObject(connector, waitingTurns)).toEqual([
    { messageId: "second_message", attempts: 1 },
  ]);
  expect(agent.readsOn(PAID_OTHER)).toBe(false);

  // 7. The owner checks the box for the new model and presses Continue:
  //    the press records the acceptance and changes nothing else. The mail
  //    that waited reaches the agent on the new model.
  const continued = await press(owner, organisationId, account, {
    turnOn: false,
    accepted: reviewOf(changed.plan),
  });
  expect(continued).toEqual({ done: true, changes: ["model_consent"] });
  expect((await plan()).plan?.model.kind).toBe("approved");
  await agentReads(agent, connector, PAID_OTHER);
  expect(agent.routing()).toEqual([ZERO_RETENTION]);

  // 8. Turn off withdraws each acceptance, because no mailbox of the
  //    Organisation is on: the next Turn on asks again.
  expect(await sendAs(owner, `${mailboxPath}/disable`, {})).toMatchObject({
    status: 200,
  });
  expect((await plan()).plan?.model.kind).toBe("consent_needed");
  expect(
    (await acceptances(organisationId)).map((row) => [row.model, row.revoked]),
  ).toEqual([
    [PAID_DEFAULT, true],
    [PAID_OTHER, true],
  ]);

  Object.assign(task.meta, {
    mailboxTurnOn: {
      before: states(first.plan),
      refusedPress: refused,
      ownerPress: pressed,
      after: states(done.plan),
      policy: on.policy,
      acceptance: accepted,
      modelChange: { held: "second_message", continued },
      routing: agent.routing(),
    },
  });
}

/**
 * The model of the mail agent. Each turn reads its Case, drafts one reply
 * and ends. It keeps each request's model and routing, and whether the
 * request held the arrived mail.
 */
class MailAgent {
  readonly requests: {
    model: unknown;
    provider: unknown;
    holdsMail: boolean;
  }[] = [];

  async answer({ request }: Parameters<HttpResponseResolver>[0]) {
    const raw: unknown = await request.json();
    this.requests.push({
      model: isRecord(raw) ? raw.model : null,
      provider: isRecord(raw) ? raw.provider : null,
      holdsMail: JSON.stringify(raw).includes("ten cases of butter"),
    });
    return draftReplyTurn(modelToolResults(raw), "Yes, we can add them.");
  }

  /** Whether a request on this model held the arrived mail. */
  readsOn(model: string): boolean {
    return this.requests.some(
      (request) => request.model === model && request.holdsMail,
    );
  }

  /** Each distinct routing that the requests asked OpenRouter for. */
  routing(): unknown[] {
    const seen = new Map<string, unknown>();
    for (const request of this.requests)
      seen.set(JSON.stringify(request.provider), request.provider);
    return [...seen.values()];
  }
}

/** Runs the Connector's due work until the agent read the mail on `model`. */
async function agentReads(
  agent: MailAgent,
  connector: MailboxConnector,
  model: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (!agent.readsOn(model)) await runDueMailWork(connector);
        return agent.readsOn(model);
      },
      { timeout: 60_000, interval: 500 },
    )
    .toBe(true);
}

/** The reply turns that wait in the Connector for another attempt. */
function waitingTurns(_actor: unknown, state: DurableObjectState) {
  return state.storage.sql
    .exec<{ messageId: string; attempts: number }>(
      `SELECT provider_message_id AS messageId, attempts
       FROM connector_email_reply_turn ORDER BY provider_message_id`,
    )
    .toArray();
}

/** The acceptances of the Organisation, as the dispatch check reads them. */
async function acceptances(organisationId: OrganisationId) {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT model, evidence_reference AS evidenceReference,
         evidence_owner AS evidenceOwner,
         disclosed_recipients AS disclosedRecipients,
         review_expires_at AS reviewExpiresAt,
         consented_by_user_id AS consentedBy,
         consent_reference AS consentReference, revoked_at AS revokedAt
       FROM gmail_inference_eligibility WHERE organisation_id = ?
       ORDER BY model`,
    )
    .bind(organisationId)
    .all<{
      model: string;
      evidenceReference: string;
      evidenceOwner: string;
      disclosedRecipients: string;
      reviewExpiresAt: number;
      consentedBy: string | null;
      consentReference: string;
      revokedAt: number | null;
    }>();
  return rows.results.map(({ revokedAt, ...row }) => ({
    ...row,
    revoked: revokedAt !== null,
  }));
}

/**
 * One press of Turn on, or of Continue, with the checkbox as `accepted`
 * leaves it: the Portal's own action, with the session of one person. It
 * returns whether the press finished and the changes that it made, in
 * order.
 */
async function press(
  person: Member,
  organisationId: OrganisationId,
  account: IntegrationAccountId,
  input: Readonly<{ turnOn: boolean; accepted: MailboxModelReview | null }>,
): Promise<Readonly<{ done: boolean; changes: readonly string[] }>> {
  const changes: string[] = [];
  const transport = portalSetupTransport(person, (path, body) =>
    changes.push(changeName(path, body)),
  );
  const done = await setUpMailbox(
    transport,
    { organisationId, integrationAccountId: account },
    { kind: "automatic" },
    input.turnOn,
    input.accepted,
  ).then(
    () => true,
    () => false,
  );
  return { done, changes };
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
  if (path.endsWith("/model-consent")) return "model_consent";
  if (path.endsWith("/policy")) return "turn_on";
  if (path.endsWith("/access-control/grants"))
    return `grant_access:${isRecord(record.target) ? String(record.target.kind) : ""}`;
  const capability = /\/access-control\/capabilities\/([^/]+)$/u.exec(path);
  if (capability !== null)
    return `enable_action:${decodeURIComponent(capability[1] ?? "")}`;
  throw new Error(`Turn on used a route outside its six: ${path}`);
}

function states(plan: MailboxSetupPlan | null): Record<string, string> {
  if (plan === null) throw new Error("The setup plan is missing");
  return Object.fromEntries(
    plan.requirements.map((requirement) => [requirement.id, requirement.state]),
  );
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
