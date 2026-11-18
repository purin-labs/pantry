import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import {
  newConversationId,
  newProjectId,
  parseMailReplySources,
  type MemoryCommand,
} from "@seams/control-api";
import {
  assertNever,
  decodeBase64,
  encodeBase64Url,
  isRecord,
} from "@seams/std";
import {
  requireActiveOrganisationActor,
  resolveActiveConnectorActor,
} from "../../src/actors/actor-router";
import {
  readEmailProposalChatContext,
  readEmailProposalChatSources,
  readEmailProposalSourceOutcome,
  readEmailProposalSources,
} from "../../src/actors/email-proposal-sources";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  type ActiveCapabilityId,
} from "../../src/authorization/capability-catalogue";
import { storeVaultSecret } from "../../src/credential-vault";
import { parseVaultHandle } from "../../src/credential-vault/domain";
import { createAccessGrant } from "../../src/data/access-grants";
import {
  readOrganisationCapabilityPolicies,
  writeOrganisationCapabilityPolicy,
} from "../../src/data/capability-policy";
import { gmailConnectorId } from "../../src/data/email-mailbox";
import { createActiveConnectedIntegration } from "../../src/data/integration-account";
import {
  parseIntegrationAccountId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../../src/ids";
import { resolveOrganisationModelRoute } from "../../src/models/route";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { readDefaultProjectId } from "../../src/projects/case-project";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  grantOrderRead,
  MAIL_SOURCE_ORDER_ID,
  purchasingFixture,
} from "./mail-purchasing-support";
import {
  caseEntry,
  command,
  createConversation,
  installMemoryFixture,
  post,
  postJson,
  receiptMemoryId,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import {
  connectGmailMailbox,
  sendAs,
  setUpMailbox,
} from "./gmail-mailbox-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatReplySources?: Record<string, unknown>;
  }
}

const ADDRESS = "orders@example.test";
const CUSTOMER = "customer@example.test";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE_ID = "m_chat_order";
const THREAD_ID = "t_chat_order";
const ORDER_WORDS = `Your order ${MAIL_SOURCE_ORDER_ID} is confirmed.`;
const UNREAD_WORDS = "We ship it on Friday.";
const REPLY = `${ORDER_WORDS} It holds two Ginger financier boxes. ${UNREAD_WORDS}`;
/** An order that exists nowhere and that the chat never read. */
const UNREAD_ORDER = "order_9999";
/** A second mail of the customer, for the chat that may not draft. */
const REFUSED_MESSAGE_ID = "m_chat_refused";
const REFUSED_THREAD_ID = "t_chat_refused";
/** A third mail, for the chat that reads an Airtable base. */
const AIRTABLE_MESSAGE_ID = "m_chat_airtable";
const AIRTABLE_THREAD_ID = "t_chat_airtable";
/** A fourth mail, for the chat filed in a Project. */
const PROJECT_MESSAGE_ID = "m_chat_project";
const PROJECT_THREAD_ID = "t_chat_project";
/** A fifth mail, for the chat that is shown a Memory. */
const MEMORY_MESSAGE_ID = "m_chat_memory";
const MEMORY_THREAD_ID = "t_chat_memory";
const MAILS = [
  { messageId: MESSAGE_ID, threadId: THREAD_ID },
  { messageId: REFUSED_MESSAGE_ID, threadId: REFUSED_THREAD_ID },
  { messageId: AIRTABLE_MESSAGE_ID, threadId: AIRTABLE_THREAD_ID },
  { messageId: PROJECT_MESSAGE_ID, threadId: PROJECT_THREAD_ID },
  { messageId: MEMORY_MESSAGE_ID, threadId: MEMORY_THREAD_ID },
] as const;
const PROJECT_BRIEF =
  "Gift boxes for the autumn fair leave the kitchen on Thursday.";
const PROJECT_REPLY = "Your autumn gift boxes ship on Thursday.";
const MEMORY_STATEMENT = "Kenji packs every Ginger financier gift box by hand.";
const MEMORY_WORDS = "Kenji packs your Ginger financier boxes by hand.";
const MEMORY_REPLY = `${MEMORY_WORDS} They leave the kitchen this week.`;
const AIRTABLE_BASE_ID = "appChatReplyKitchen";
const AIRTABLE_TOKEN = "mail-chat-reply-airtable-token";
const AIRTABLE_TEXT = "Ginger financier boxes leave the kitchen on Friday.";
const AIRTABLE_REPLY = "Your Ginger financier boxes ship on Friday.";

it(
  "shows the order that a reply drafted in a Portal chat cites only to a person who may read orders, drops a record that the chat never read, gates the reply on every source, Project and Memory that the chat read, and drafts nothing when the chat's label may not reach the reply",
  { timeout: 240_000 },
  chatReplySourcesJourney,
);

type Connector = DurableObjectStub<
  import("../../src/actors/connector").ConnectorDO
>;

/**
 * The owner asks a Portal chat on the Pi test route to check an order and
 * draft a reply to a customer's mail. The agent reads the order, then drafts
 * a reply that cites it and an order it never read. The Connector keeps the
 * order source and the count of the refused citation, and no word of the
 * reply. The owner's review shows the order behind its sentence. An
 * administrator who may read the mailbox but not orders may not review the
 * reply. With a grant to orders, the administrator sees the same source.
 * A third chat reads an Airtable base and drafts a reply: the administrator
 * may review it only with a grant to that base. A chat filed in a Project
 * that the administrator may not read, and a chat shown a Memory that is
 * hidden from them, draft replies that only the owner may review, until the
 * owner shares the Project. Once the owner revokes the Memory, its reply
 * needs a fresh draft. Then a second chat reads the order, and the Organisation disconnects its
 * commerce system before the chat drafts. The order source is no longer
 * current, so the chat's label no longer reaches the reply sink: the Session
 * writes no Gmail draft and no proposal.
 */
async function chatReplySourcesJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    route,
    paths,
  } = await installMemoryFixture();
  const gmail = new CustomerMailbox();
  gmail.serve();
  network.use(
    http.get(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Orders`, () =>
      HttpResponse.json({
        records: [{ id: "recChatReply", fields: { Title: AIRTABLE_TEXT } }],
      }),
    ),
  );
  const model = new ChatReplyModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "chatreply",
    address: ADDRESS,
    capabilities: [
      CAPABILITY_KEYS.emailMailboxRead,
      CAPABILITY_KEYS.emailReplyPropose,
    ],
  });
  model.account = account;
  await setUpMailbox(owner, organisationId, account);
  const mailboxPath = `/v1/control/organisations/${organisationId}/agent-mailboxes/${account}`;
  const on = await sendAs(owner, `${mailboxPath}/policy`, {
    policy: {
      kind: "enabled",
      maxActiveCases: 5,
      maxMessagesPerHour: 20,
      dailyTokenBudget: 200_000,
      maxMessageBytes: 262_144,
      maxAttachmentBytes: 5_242_880,
      debounce: { kind: "push_triggered", coalesceSeconds: 30 },
      overflow: "pause_and_notify",
    },
  });
  expect(on).toMatchObject({ status: 200, body: { ok: true } });
  await approveMailboxModel(organisationId);
  const connector = await mailboxConnector(organisationId, account);
  await runDurableObjectAlarm(connector);
  const merchantId = await seedOrder(organisationId, owner.userId);
  // The owner may read orders and draft replies in a chat. The
  // administrator reads the mailbox through its setup, and not orders.
  await grantOwnerChatTools(organisationId, account);
  // A member who joins the Organisation joins its Base Project. The fixture
  // adds the administrator without it, so the owner adds them.
  const baseProjectId = await readDefaultProjectId(
    (await requireOrganisationExecutionScope(env, organisationId)).database,
    organisationId,
  );
  if (baseProjectId === null) throw new Error("The Base Project is missing");
  expect(
    await postJson(owner, `${paths.projects}/${baseProjectId}/access`, {
      kind: "set_project_member",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 1,
      userId: admin.userId,
      role: "editor",
    }),
  ).toMatchObject({ status: 200 });
  await grantOrderRead(organisationId, merchantId, "grant_chat_owner_orders", {
    kind: "organisation_role",
    role: "owner",
  });
  await enableCapabilities(owner, [
    CAPABILITY_KEYS.commerceEntityPlaneContext,
    CAPABILITY_KEYS.commerceEntityRead,
    CAPABILITY_KEYS.emailReplyPropose,
  ]);

  // 1. One chat turn reads the order, then drafts the reply.
  const conversationId = newConversationId();
  const started = await post(
    owner,
    paths.chat,
    chatMessage(conversationId, route.model, MESSAGE_ID),
  );
  expect(started.status, await started.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, conversationId), { timeout: 90_000 })
    .toBe("ready");
  // Tool results reach the model as escaped JSON.
  expect(model.sourceRead).toContain(MAIL_SOURCE_ORDER_ID);
  expect(model.proposed.replaceAll("\\", "")).toContain('"kind":"proposed"');
  const proposalId = await chatProposalId(organisationId, MESSAGE_ID);

  // 2. The Connector keeps the order source and one refused citation. It
  //    keeps the chat's commerce source for the review, and no word of the
  //    reply.
  const kept = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) => ({
      sources: readEmailProposalSources(durable.storage.sql, proposalId),
      outcome: readEmailProposalSourceOutcome(durable.storage.sql, proposalId),
      chatSources: readEmailProposalChatSources(
        durable.storage.sql,
        proposalId,
      ),
      chatContext: readEmailProposalChatContext(
        durable.storage.sql,
        proposalId,
      ),
    }),
  );
  expect(kept.outcome).toEqual({ accepted: 1, dropped: 1 });
  expect(kept.sources.map((source) => source.record)).toEqual([
    {
      kind: "chat_order",
      orderId: MAIL_SOURCE_ORDER_ID,
      revision: expect.any(Number),
      source: {
        integrationAccountId: expect.any(String),
        resourceScope: expect.stringMatching(/^commerce_read:/u),
      },
    },
  ]);
  expect(kept.chatSources).toEqual([kept.sources[0]?.record.source]);
  // A new chat joins the Base Project, and its context shows Base.
  expect(kept.chatContext).toEqual({ memory: [], projects: [baseProjectId] });
  for (const words of ["confirmed", "Friday", "financier", UNREAD_ORDER])
    expect(JSON.stringify(kept)).not.toContain(words);

  // 3. The owner's review shows the order behind its sentence, and nothing
  //    of the order that the chat never read.
  const drafted = await shownSources(owner, proposalId);
  expect(drafted.body).toBe(REPLY);
  expect(drafted.sources).toEqual([
    {
      number: 1,
      record: { kind: "order", orderId: MAIL_SOURCE_ORDER_ID },
      title: `Order ${MAIL_SOURCE_ORDER_ID}`,
      detail: expect.stringContaining("Status: confirmed"),
      words: [ORDER_WORDS],
    },
  ]);
  expect(JSON.stringify(drafted.raw)).not.toContain(UNREAD_ORDER);

  // 4. The administrator may read the mailbox, not orders. The reply's words
  //    come from the order, so its review is refused and names nothing of
  //    the order.
  const denied = await review(admin, proposalId);
  expect(denied.status).toBe(403);
  expect(denied.body).toEqual({
    ok: false,
    error: "email_commerce_unavailable",
  });
  for (const words of [MAIL_SOURCE_ORDER_ID, "Order ", "financier", "Friday"])
    expect(JSON.stringify(denied.body)).not.toContain(words);

  // 5. With a grant to orders, the administrator sees the same source.
  await grantOrderRead(organisationId, merchantId, "grant_chat_admin_orders", {
    kind: "organisation_role",
    role: "admin",
  });
  const granted = await shownSources(admin, proposalId);
  expect(granted.sources).toEqual(drafted.sources);

  // 6. A third chat of the owner reads an Airtable base, not an order, and
  //    drafts a reply to the customer's third mail. The Connector keeps the
  //    base as a source of the reply. The administrator may read the mailbox
  //    and orders, not the base, so the review is refused and names nothing
  //    of the reply. With a grant to the base, the administrator may review.
  const airtable = await connectAirtable(owner);
  await enableCapabilities(owner, [CAPABILITY_KEYS.airtableApiRead]);
  model.airtable = airtable;
  model.reset("airtable", MAILS[2]);
  const airtableConversationId = newConversationId();
  const airtableStarted = await post(
    owner,
    paths.chat,
    chatMessage(airtableConversationId, route.model, AIRTABLE_MESSAGE_ID),
  );
  expect(airtableStarted.status, await airtableStarted.clone().text()).toBe(
    200,
  );
  await expect
    .poll(workKind.bind(null, owner, airtableConversationId), {
      timeout: 90_000,
    })
    .toBe("ready");
  expect(model.sourceRead).toContain(AIRTABLE_TEXT);
  expect(model.proposed.replaceAll("\\", "")).toContain('"kind":"proposed"');
  const airtableProposalId = await chatProposalId(
    organisationId,
    AIRTABLE_MESSAGE_ID,
  );
  const airtableSources = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      readEmailProposalChatSources(durable.storage.sql, airtableProposalId),
  );
  expect(airtableSources).toEqual([
    {
      integrationAccountId: airtable,
      resourceScope: `base:${AIRTABLE_BASE_ID}`,
    },
  ]);
  const airtableByOwner = await shownSources(owner, airtableProposalId);
  expect(airtableByOwner.body).toBe(AIRTABLE_REPLY);
  const airtableDenied = await review(admin, airtableProposalId);
  expect(airtableDenied.status).toBe(403);
  expect(airtableDenied.body).toEqual({
    ok: false,
    error: "email_source_unavailable",
  });
  for (const words of ["Friday", "financier", AIRTABLE_BASE_ID])
    expect(JSON.stringify(airtableDenied.body)).not.toContain(words);
  await grantAirtableRead(
    organisationId,
    airtable,
    "grant_chat_admin_airtable",
    "admin",
  );
  const airtableByAdmin = await shownSources(admin, airtableProposalId);
  expect(airtableByAdmin.body).toBe(AIRTABLE_REPLY);

  // 7. The owner shares a Project, "Kitchen notes", with nobody else, and
  //    files a chat in it. The chat's context shows the Project's brief, and
  //    the chat drafts a reply to the customer's fourth mail. The Connector
  //    keeps the Project with the reply. The administrator is not a member,
  //    so the review is refused. Once the owner adds the administrator to
  //    the Project, the review opens.
  const projectId = newProjectId();
  const created = await post(owner, paths.projects, {
    kind: "create_project",
    operationId: crypto.randomUUID(),
    projectId,
    content: { name: "Kitchen notes", brief: PROJECT_BRIEF, references: [] },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const projectAccess = `${paths.projects}/${projectId}/access`;
  expect(
    await postJson(owner, projectAccess, {
      kind: "share_project",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 0,
      members: [],
    }),
  ).toMatchObject({ status: 200 });
  const projectConversationId = newConversationId();
  await createConversation(owner, projectConversationId, route);
  const unfiled = await storedConversation(owner, projectConversationId);
  if (unfiled === null) throw new Error("The Project chat is missing");
  expect(
    await postJson(
      owner,
      `${paths.chat}/conversations/${projectConversationId}/access`,
      {
        kind: "share_conversation",
        operationId: crypto.randomUUID(),
        expectedRevision: unfiled.revision,
        projectId,
        expectedProjectAccessRevision: 1,
      },
    ),
  ).toMatchObject({ status: 200, body: { kind: "accepted" } });
  model.reset("project", MAILS[3]);
  const projectStarted = await post(
    owner,
    paths.chat,
    chatMessage(projectConversationId, route.model, PROJECT_MESSAGE_ID),
  );
  expect(projectStarted.status, await projectStarted.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, projectConversationId), {
      timeout: 90_000,
    })
    .toBe("ready");
  expect(model.context).toContain(PROJECT_BRIEF);
  expect(model.proposed.replaceAll("\\", "")).toContain('"kind":"proposed"');
  const projectProposalId = await chatProposalId(
    organisationId,
    PROJECT_MESSAGE_ID,
  );
  const projectContext = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      readEmailProposalChatContext(durable.storage.sql, projectProposalId),
  );
  expect(projectContext.projects).toContain(projectId);
  const projectByOwner = await shownSources(owner, projectProposalId);
  expect(projectByOwner.body).toBe(PROJECT_REPLY);
  const projectDenied = await review(admin, projectProposalId);
  expect(projectDenied.status).toBe(403);
  expect(projectDenied.body).toEqual({
    ok: false,
    error: "email_source_unavailable",
  });
  for (const words of ["Thursday", "autumn", "Kitchen notes"])
    expect(JSON.stringify(projectDenied.body)).not.toContain(words);
  expect(
    await postJson(owner, projectAccess, {
      kind: "set_project_member",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 1,
      userId: admin.userId,
      role: "editor",
    }),
  ).toMatchObject({ status: 200 });
  const projectByAdmin = await shownSources(admin, projectProposalId);
  expect(projectByAdmin.body).toBe(PROJECT_REPLY);

  // 8. The owner states a Memory from their first, private chat and accepts
  //    it. It applies to Portal chats, so a new chat of the owner is shown
  //    it, and drafts a reply to the customer's fifth mail that cites it.
  //    The administrator may not inspect the Memory: it rests on the
  //    owner's private chat. The owner's review shows the Memory behind its
  //    sentence. The administrator's review is refused and names nothing of
  //    it.
  const cited = (
    await caseEntry(
      owner,
      conversationId,
      `draft a reply to the customer's mail ${MESSAGE_ID}`,
      "operator_instruction",
    )
  ).evidence;
  const proposeMemory: MemoryCommand = {
    commandId: "chat_reply_memory_propose",
    expectedRevision: 0,
    kind: "propose",
    memoryId: null,
    submission: "own_input",
    content: {
      memoryKind: "fact",
      statement: MEMORY_STATEMENT,
      applicability: { kind: "portal_chat" },
      validity: {
        timezone: "Asia/Tokyo",
        effectiveFrom: "2026-10-01",
        effectiveUntil: null,
        dependsOn: [cited],
      },
      evidence: [cited],
      sourceCaseId: cited.caseId,
    },
  };
  const proposedMemory = await command(owner, proposeMemory);
  expect(proposedMemory.status, JSON.stringify(proposedMemory.body)).toBe(200);
  const memoryId = receiptMemoryId(proposedMemory.body);
  expect(
    await command(owner, {
      commandId: "chat_reply_memory_accept",
      expectedRevision: 1,
      kind: "accept",
      memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200 });
  model.memoryId = memoryId;
  // A turn's Memory read can be unavailable for a moment; a new chat then
  // asks again, as a person would.
  let memoryAttempts = 0;
  do {
    memoryAttempts += 1;
    model.reset("memory", MAILS[4]);
    const memoryConversationId = newConversationId();
    const memoryStarted = await post(
      owner,
      paths.chat,
      chatMessage(memoryConversationId, route.model, MEMORY_MESSAGE_ID),
    );
    expect(memoryStarted.status, await memoryStarted.clone().text()).toBe(200);
    await expect
      .poll(workKind.bind(null, owner, memoryConversationId), {
        timeout: 90_000,
      })
      .toBe("ready");
  } while (model.drafts === 0 && memoryAttempts < 3);
  expect(model.drafts).toBe(1);
  expect(model.proposed.replaceAll("\\", "")).toContain('"kind":"proposed"');
  const memoryProposalId = await chatProposalId(
    organisationId,
    MEMORY_MESSAGE_ID,
  );
  const memoryContext = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      readEmailProposalChatContext(durable.storage.sql, memoryProposalId),
  );
  expect(memoryContext.memory).toEqual([{ memoryId, revision: 1 }]);
  const memoryByOwner = await shownSources(owner, memoryProposalId);
  expect(memoryByOwner.body).toBe(MEMORY_REPLY);
  expect(memoryByOwner.sources).toMatchObject([
    { number: 1, record: { kind: "memory" }, words: [MEMORY_WORDS] },
  ]);
  const memoryDenied = await review(admin, memoryProposalId);
  expect(memoryDenied.status).toBe(403);
  expect(memoryDenied.body).toEqual({
    ok: false,
    error: "email_source_unavailable",
  });
  for (const words of ["Kenji", "financier", memoryId])
    expect(JSON.stringify(memoryDenied.body)).not.toContain(words);
  // As for a mailbox reply, the owner's review lists the Memory that the
  // chat was shown, and the reply stands only while that Memory does. Once
  // the owner revokes it, the reply needs a fresh draft.
  expect(isRecord(memoryByOwner.raw) ? memoryByOwner.raw.memory : null).toEqual(
    [{ memory_id: memoryId, revision: 1, statement: MEMORY_STATEMENT }],
  );
  expect(
    await command(owner, {
      commandId: "chat_reply_memory_revoke",
      expectedRevision: 1,
      kind: "revoke",
      memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200 });
  const memoryRevoked = await review(owner, memoryProposalId);
  expect(memoryRevoked.status).not.toBe(200);
  expect(memoryRevoked.body).toEqual({
    ok: false,
    error: "email_memory_changed",
  });

  // 9. A second chat of the owner reads the order. Before it drafts a reply
  //    to the customer's second mail, the Organisation disconnects its
  //    commerce system. The owner's grants and the policy do not change, so
  //    the turn keeps its authority and may still call the tool. The order
  //    source gives no current label, so the reply sink refuses the chat's
  //    label: no Gmail draft, no proposal.
  model.reset("order", MAILS[1]);
  model.beforeDraft = disconnectCommerceSystem.bind(null, organisationId);
  const refusedConversationId = newConversationId();
  const refusedStarted = await post(
    owner,
    paths.chat,
    chatMessage(refusedConversationId, route.model, REFUSED_MESSAGE_ID),
  );
  expect(refusedStarted.status, await refusedStarted.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, refusedConversationId), {
      timeout: 90_000,
    })
    .toMatch(/^(ready|failed)$/u);
  const refusedWork = await workKind(owner, refusedConversationId);
  expect(model.sourceRead).toContain(MAIL_SOURCE_ORDER_ID);
  expect(model.beforeDraft).toBeNull();
  expect(model.drafts).toBe(1);
  expect(model.proposed.replaceAll("\\", "")).not.toContain(
    '"kind":"proposed"',
  );
  const draftedIds = [
    proposalId,
    airtableProposalId,
    projectProposalId,
    memoryProposalId,
  ].sort();
  expect(gmail.drafts.size).toBe(4);
  expect([...(await chatProposalIds(organisationId))].sort()).toEqual(
    draftedIds,
  );
  const refusedRecords = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) => ({
      drafts: durable.storage.sql
        .exec<{ proposalId: string }>(
          "SELECT DISTINCT proposal_id AS proposalId FROM connector_email_draft ORDER BY proposal_id",
        )
        .toArray()
        .map((row) => row.proposalId),
      sourceOutcomes: durable.storage.sql
        .exec<{ proposalId: string }>(
          "SELECT proposal_id AS proposalId FROM email_proposal_source_outcome ORDER BY proposal_id",
        )
        .toArray()
        .map((row) => row.proposalId),
    }),
  );
  expect(refusedRecords).toEqual({
    drafts: draftedIds,
    sourceOutcomes: draftedIds,
  });

  // The JSON reporter writes this record, so a run leaves its evidence.
  task.meta.chatReplySources = {
    repeat:
      "SATYR_ACCOUNT_WORKER_ARTIFACT=<seams>/.artifacts/shared-account-platform/account-worker/index.mjs pnpm --filter @seams/platform exec vitest run --config vitest.e2e.config.ts tests/e2e/mail-chat-reply-sources.test.ts --reporter=json --outputFile=<file>",
    route: route.model,
    proposalId,
    citationsMade: 2,
    kept: kept.outcome,
    keptRecords: kept.sources.map((source) => source.record),
    chatSources: kept.chatSources,
    reviewByOwner: drafted.sources,
    reviewWithoutOrderGrant: { status: denied.status, body: denied.body },
    reviewAfterOrderGrant: granted.sources,
    airtableSource: {
      proposalId: airtableProposalId,
      chatSources: airtableSources,
      reviewByOwner: airtableByOwner.body,
      reviewWithoutBaseGrant: {
        status: airtableDenied.status,
        body: airtableDenied.body,
      },
      reviewAfterBaseGrant: airtableByAdmin.body,
    },
    projectSource: {
      proposalId: projectProposalId,
      chatContext: projectContext,
      reviewByOwner: projectByOwner.body,
      reviewWithoutMembership: {
        status: projectDenied.status,
        body: projectDenied.body,
      },
      reviewAfterMembership: projectByAdmin.body,
    },
    memorySource: {
      proposalId: memoryProposalId,
      attempts: memoryAttempts,
      chatContext: memoryContext,
      reviewByOwner: memoryByOwner.sources,
      reviewByAdministrator: {
        status: memoryDenied.status,
        body: memoryDenied.body,
      },
      reviewAfterRevoke: {
        status: memoryRevoked.status,
        body: memoryRevoked.body,
      },
    },
    refusedAtReplySink: {
      work: refusedWork,
      draftCalls: model.drafts,
      toolResult: model.proposed,
      connectorDrafts: refusedRecords.drafts,
      gmailDrafts: gmail.drafts.size,
    },
    gmailDrafts: gmail.drafts.size,
    unexpectedGmailRequests: gmail.unexpected,
  };
}

/** One chat message of the owner that asks for a reply to one mail. */
function chatMessage(
  conversationId: string,
  model: string,
  messageId: string,
): Record<string, unknown> {
  return {
    kind: "message",
    conversationId,
    requestId: `request_${crypto.randomUUID()}`,
    model,
    text: `Check ${MAIL_SOURCE_ORDER_ID} and draft a reply to the customer's mail ${messageId}.`,
    surfaceContext: null,
    browserContext: { kind: "unavailable" },
  };
}

/** What a chat reads before it drafts, and the tool that reads it. */
const READERS = {
  order: "commerce_entity_context",
  airtable: "airtable_api_read",
  project: null,
  memory: null,
} as const;

/**
 * A chat model that checks a source and drafts the reply. It finds the tools,
 * reads the order or the Airtable base, or relies on the Project or the
 * Memory that its context shows, drafts once, and then answers with the
 * result.
 */
class ChatReplyModel {
  account: IntegrationAccountId | null = null;
  airtable: IntegrationAccountId | null = null;
  memoryId: string | null = null;
  /** What this chat relies on before it drafts. */
  read: keyof typeof READERS = "order";
  /** The customer's mail that the reply answers. */
  mail: (typeof MAILS)[number] = MAILS[0];
  /** Runs once, after the read and before the draft. */
  beforeDraft: (() => Promise<void>) | null = null;
  sourceRead = "";
  /** The messages that the chat's last model request carried. */
  context = "";
  proposed = "";
  drafts = 0;
  searches = 0;

  /** Starts a new chat that relies on `read` and answers `mail`. */
  reset(read: keyof typeof READERS, mail: (typeof MAILS)[number]): void {
    this.read = read;
    this.mail = mail;
    this.sourceRead = "";
    this.context = "";
    this.proposed = "";
    this.drafts = 0;
    this.searches = 0;
  }

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.clone().json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("The model request is invalid");
    this.context = JSON.stringify(body.messages);
    const offered = offeredToolNames(body);
    const results = body.messages.flatMap((message: unknown) =>
      isRecord(message) && message.role === "tool"
        ? [JSON.stringify(message.content)]
        : [],
    );
    const calls = body.messages.flatMap((message: unknown) =>
      isRecord(message) && Array.isArray(message.tool_calls)
        ? message.tool_calls.flatMap((call: unknown) =>
            isRecord(call) &&
            isRecord(call.function) &&
            typeof call.function.name === "string"
              ? [call.function.name]
              : [],
          )
        : [],
    );
    const id = `chat_reply_${String(calls.length)}`;
    if (calls.includes("email_reply_propose")) {
      this.proposed = results.at(-1) ?? "";
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The reply draft is ready for review in the Inbox.",
        }),
        id,
      );
    }
    const reader = READERS[this.read];
    const missing = [reader, "email_reply_propose"].filter(
      (name): name is string => name !== null && !offered.includes(name),
    );
    if (missing.length > 0) {
      if (++this.searches > 4) throw new Error("Tool discovery did not end");
      return openRouterToolCall(
        "tool_search",
        { query: missing.join(" "), limit: 8 },
        id,
      );
    }
    if (reader === "airtable_api_read" && !calls.includes(reader)) {
      if (this.airtable === null) throw new Error("Airtable is not connected");
      return openRouterToolCall(
        reader,
        {
          requestJson: JSON.stringify({
            kind: "request",
            integrationAccountId: this.airtable,
            method: "GET",
            path: `/v0/${AIRTABLE_BASE_ID}/Orders`,
            body: null,
          }),
        },
        id,
      );
    }
    if (reader === "commerce_entity_context" && !calls.includes(reader))
      return openRouterToolCall(
        reader,
        {
          request: {
            selection: {
              kind: "entity_seeds",
              seeds: [
                {
                  origin: "system",
                  typeId: "order",
                  entityId: MAIL_SOURCE_ORDER_ID,
                },
              ],
            },
            traversal: { maxDepth: 0, resultLimit: 1 },
            allowedSensitivity: "internal",
            allowedAttributeIds: ["lifecycle"],
            freshnessRequirement: "current_only",
          },
        },
        id,
      );
    this.sourceRead = reader === null ? "" : (results.at(-1) ?? "");
    // A chat that was not shown the Memory drafts nothing.
    if (
      this.read === "memory" &&
      (this.memoryId === null ||
        !this.context.includes(`memory:${this.memoryId}`) ||
        !this.context.includes(MEMORY_STATEMENT))
    )
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "I know nothing to cite." }),
        id,
      );
    if (this.account === null) throw new Error("The mailbox is not connected");
    const beforeDraft = this.beforeDraft;
    this.beforeDraft = null;
    await beforeDraft?.();
    this.drafts += 1;
    return openRouterToolCall(
      "email_reply_propose",
      {
        integrationAccountId: this.account,
        messageId: this.mail.messageId,
        threadId: this.mail.threadId,
        ...this.draft(),
      },
      id,
    );
  }

  /** The body and the citations of this chat's reply. */
  private draft(): Readonly<{
    body: string;
    sources: readonly Readonly<{ source: string; text: string }>[] | null;
  }> {
    switch (this.read) {
      case "order":
        return {
          body: REPLY,
          sources: [
            { source: `order:${MAIL_SOURCE_ORDER_ID}`, text: ORDER_WORDS },
            // A record that this chat never read.
            { source: `order:${UNREAD_ORDER}`, text: UNREAD_WORDS },
          ],
        };
      case "airtable":
        return { body: AIRTABLE_REPLY, sources: null };
      case "project":
        return { body: PROJECT_REPLY, sources: null };
      case "memory":
        return {
          body: MEMORY_REPLY,
          sources: [
            { source: `memory:${String(this.memoryId)}`, text: MEMORY_WORDS },
          ],
        };
      default:
        return assertNever(this.read);
    }
  }
}

/** Gmail for this mailbox: the customer's five mails and the drafts. */
class CustomerMailbox {
  drafts = new Map<string, { raw: string; threadId: string }>();
  unexpected: string[] = [];

  serve(): void {
    network.use(
      http.get(`${GMAIL}/profile`, () =>
        HttpResponse.json({ emailAddress: ADDRESS, historyId: "1000" }),
      ),
      http.post(`${GMAIL}/watch`, () =>
        HttpResponse.json({
          historyId: "1000",
          expiration: String(Date.now() + 2 * 86_400_000),
        }),
      ),
      http.post(`${GMAIL}/stop`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${GMAIL}/history`, () =>
        HttpResponse.json({ historyId: "1000", history: [] }),
      ),
      ...MAILS.map(({ messageId, threadId }) =>
        http.get(`${GMAIL}/messages/${messageId}`, () =>
          HttpResponse.json({
            id: messageId,
            threadId,
            labelIds: ["INBOX"],
            sizeEstimate: 2_048,
            internalDate: String(Date.now() - 60_000),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: `Customer <${CUSTOMER}>` },
                { name: "To", value: ADDRESS },
                { name: "Subject", value: `Where is ${MAIL_SOURCE_ORDER_ID}?` },
                { name: "Message-ID", value: `<${messageId}@example.test>` },
              ],
              body: {
                data: encodeBase64Url(
                  new TextEncoder().encode(
                    `Is my ${MAIL_SOURCE_ORDER_ID} confirmed? I need the financiers this week.`,
                  ),
                ),
              },
            },
          }),
        ),
      ),
      http.get(`${GMAIL}/drafts`, ({ request }) => {
        const query = new URL(request.url).searchParams.get("q");
        const drafts: { id: string }[] = [];
        for (const [id, draft] of this.drafts)
          if (query === `rfc822msgid:${header(draft.raw, "Message-ID")}`)
            drafts.push({ id });
        return HttpResponse.json({ drafts });
      }),
      http.get(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        const id = String(params.draftId);
        const draft = this.drafts.get(id);
        if (draft === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        return HttpResponse.json({
          id,
          message: {
            id: `message_${id}`,
            threadId: draft.threadId,
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: ADDRESS },
                { name: "To", value: header(draft.raw, "To") ?? CUSTOMER },
                { name: "Subject", value: header(draft.raw, "Subject") ?? "" },
              ],
              body: {
                data: encodeBase64Url(
                  new TextEncoder().encode(draftBody(draft.raw)),
                ),
              },
            },
          },
        });
      }),
      http.post(`${GMAIL}/drafts`, async ({ request }) => {
        const raw: unknown = await request.json();
        if (
          !isRecord(raw) ||
          !isRecord(raw.message) ||
          typeof raw.message.raw !== "string"
        )
          throw new Error("Invalid Gmail draft");
        const id = `draft_${this.drafts.size + 1}`;
        const threadId =
          typeof raw.message.threadId === "string" ? raw.message.threadId : "";
        this.drafts.set(id, { raw: raw.message.raw, threadId });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}`, threadId },
        });
      }),
      http.all(`${GMAIL}/*`, ({ request }) => {
        this.unexpected.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }),
    );
  }
}

function decodeRaw(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(encoded.replaceAll("-", "+").replaceAll("_", "/")) ??
      new Uint8Array(),
  );
}

function header(encoded: string, name: string): string | null {
  const head = decodeRaw(encoded).split("\r\n\r\n")[0] ?? "";
  return (
    head
      .split("\r\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? null
  );
}

function draftBody(encoded: string): string {
  return new TextDecoder().decode(
    decodeBase64(
      (decodeRaw(encoded).split("\r\n\r\n")[1] ?? "").replaceAll(/\s+/gu, ""),
    ) ?? new Uint8Array(),
  );
}

/** Every reply that a chat drafted, as the Inbox projection names it. */
async function chatProposalIds(
  organisationId: OrganisationId,
): Promise<readonly string[]> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const rows = await scope.database
    .prepare(
      "SELECT proposal_id AS proposalId FROM email_reply_proposal WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .all<{ proposalId: string }>();
  return rows.results.map((row) => row.proposalId);
}

/** The one reply that a chat drafted to one mail. */
async function chatProposalId(
  organisationId: OrganisationId,
  messageId: string,
): Promise<string> {
  const replies = (await chatProposalIds(organisationId)).filter((id) =>
    id.endsWith(`_${messageId}`),
  );
  expect(replies).toHaveLength(1);
  const proposalId = replies[0];
  if (proposalId === undefined) throw new Error("The chat drafted no reply");
  expect(proposalId).toMatch(
    new RegExp(`^proposal_email_.+_${messageId}$`, "u"),
  );
  return proposalId;
}

async function review(
  person: Member,
  proposalId: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return postJson(
    person,
    `/v1/control/organisations/${person.organisationId}/email-replies/${proposalId}`,
    null,
  );
}

/** One person's review: the body and the sources as the Portal reads them. */
async function shownSources(person: Member, proposalId: string) {
  const read = await review(person, proposalId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  if (
    !isRecord(read.body) ||
    !isRecord(read.body.proposal) ||
    typeof read.body.proposal.body !== "string"
  )
    throw new Error(JSON.stringify(read.body));
  const body = read.body.proposal.body;
  const sources = parseMailReplySources(read.body.sources, body.length);
  if (sources === null) throw new Error(JSON.stringify(read.body.sources));
  return {
    raw: read.body,
    body,
    sources: sources.map((source) => ({
      number: source.number,
      record: source.record,
      title: source.title,
      detail: source.detail,
      words: source.spans.map((span) => body.slice(span.start, span.end)),
    })),
  };
}

/**
 * Turns capabilities on as the owner, then publishes the policy. The Access
 * page does not list the commerce context capability.
 */
async function enableCapabilities(
  owner: Member,
  capabilityIds: readonly ActiveCapabilityId[],
): Promise<void> {
  const organisationId = owner.organisationId;
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const current = await readOrganisationCapabilityPolicies({
    db: scope.database,
    organisationId,
  });
  if (!current.ok) throw new Error(current.error.code);
  for (const capabilityId of capabilityIds) {
    const policy = current.value.find(
      (candidate) => candidate.capabilityId === capabilityId,
    );
    if (policy?.mode === "enabled") continue;
    const changed = await writeOrganisationCapabilityPolicy({
      scope,
      write: {
        kind: "change",
        capabilityId,
        expectedRevision: policy?.revision ?? 1,
        mode: "enabled",
        provenance: {
          kind: "operator",
          userId: owner.userId,
          mutationReceiptId: `receipt_chat_reply_${capabilityId}`,
        },
        now: Date.now(),
      },
    });
    if (!changed.ok) throw new Error(changed.error.code);
  }
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId,
    organisation: await requireActiveOrganisationActor({
      env,
      organisationId,
      now: Date.now(),
    }),
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);
}

/**
 * The Organisation no longer has a selected commerce system. Its grants and
 * its policy stay as they are.
 */
async function disconnectCommerceSystem(
  organisationId: OrganisationId,
): Promise<void> {
  const removed = await fixtureDatabase()
    .prepare(
      "DELETE FROM organisation_commerce_system WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .run();
  expect(removed.meta.changes).toBe(1);
}

/**
 * An Airtable base as its connection leaves it, with its credential. The
 * owner role may read it.
 */
async function connectAirtable(owner: Member): Promise<IntegrationAccountId> {
  const now = Date.now();
  const organisationId = owner.organisationId;
  const handle = parseVaultHandle(
    `vault:${organisationId.toLowerCase()}:airtable:chatreply`,
  );
  if (!handle.ok) throw new Error("Vault handle invalid");
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId,
    handle: handle.value,
    now,
    secret: { kind: "bearer", value: AIRTABLE_TOKEN },
  });
  if (!stored.ok) throw new Error(stored.error.code);
  const connected = await createActiveConnectedIntegration(fixtureDatabase(), {
    organisationId,
    provider: "airtable",
    providerSubjectId: "usrChatReply",
    environment: "development",
    authMode: "api_key",
    authority: { kind: "connection_credential", credentialRef: handle.value },
    grantedScopes: ["data.records:read"],
    createdByUserId: owner.userId,
    providerAccountId: "usrChatReply",
    accountKind: "user_grant",
    displayName: "Kitchen schedule",
    capabilities: [CAPABILITY_KEYS.airtableApiRead],
    audiencePolicy: { kind: "operator" },
    retentionPolicy: { kind: "organisation_default" },
    now,
  });
  const account = parseIntegrationAccountId(
    connected.account.integrationAccountId,
  );
  if (!account.ok) throw new Error(account.error.code);
  await grantAirtableRead(
    organisationId,
    account.value,
    "grant_chat_owner_airtable",
    "owner",
  );
  return account.value;
}

/** Lets one role read the Airtable base. */
async function grantAirtableRead(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
  grantId: string,
  role: "owner" | "admin",
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const created = await createAccessGrant({
    db: scope.database,
    organisationId,
    grantId,
    subject: { kind: "organisation_role", role },
    target: {
      kind: "provider_resource",
      capabilityId: CAPABILITY_KEYS.airtableApiRead,
      capabilityVersion: 1,
      integrationAccountId: account,
      resourceScope: `base:${AIRTABLE_BASE_ID}`,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: `receipt_${grantId}`,
    },
    now: Date.now(),
  });
  if (!created.ok) throw new Error(created.error.code);
}

/** Lets the owner role read orders in a chat and draft replies in the mailbox. */
async function grantOwnerChatTools(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  for (const [grantId, target] of [
    [
      "grant_chat_reply_propose",
      {
        kind: "provider_resource",
        capabilityId: CAPABILITY_KEYS.emailReplyPropose,
        capabilityVersion: 1,
        integrationAccountId: account,
        resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
      },
    ],
    [
      "grant_chat_commerce_context",
      {
        kind: "platform_capability",
        capabilityId: CAPABILITY_KEYS.commerceEntityPlaneContext,
        capabilityVersion: 1,
      },
    ],
  ] as const) {
    const created = await createAccessGrant({
      db: scope.database,
      organisationId,
      grantId,
      subject: { kind: "organisation_role", role: "owner" },
      target,
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_${grantId}`,
      },
      now: Date.now(),
    });
    if (!created.ok) throw new Error(created.error.code);
  }
}

/**
 * The Organisation's commerce data in Commerce, with one confirmed order.
 * The mailbox agent gets no commerce grant.
 */
async function seedOrder(
  organisationId: OrganisationId,
  userId: string,
): Promise<string> {
  const merchantId = `merchant_mail_purchasing_chat_${crypto.randomUUID()}`;
  const connectionId = `provider_connection_${crypto.randomUUID()}`;
  const accountId = `integration_${crypto.randomUUID()}`;
  const bindingId = `underclerk_binding_${crypto.randomUUID()}`;
  const now = Date.now();
  const provision = await env.UNDERCLERK.fetch(
    `http://underclerk.test/v1/admin/merchants/${merchantId}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer underclerk-e2e-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: organisationId,
        merchantId,
        createdAt: new Date(now).toISOString(),
      }),
    },
  );
  expect(provision.status, await provision.text()).toBe(200);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO provider_connection (provider_connection_id, organisation_id, provider, auth_mode, authority_kind, credential_generation, credential_ref, provider_application, application_credential_generation, asset_grant_revision, lifecycle, granted_scopes, created_by_user_id, created_at, updated_at, disabled_at, revoked_at, environment, provider_subject_id) VALUES (?, ?, 'underclerk', 'api_key', 'connection_credential', 1, 'vault:mail:chatreply:e2e', NULL, NULL, NULL, 'active', '[]', ?, ?, ?, NULL, NULL, 'development', '')`,
      )
      .bind(connectionId, organisationId, userId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO integration_account (integration_account_id, organisation_id, provider_connection_id, provider, provider_account_id, account_kind, display_name, lifecycle, lifecycle_reason_code, capability_set, audience_policy, retention_policy, created_at, updated_at, disabled_by_user_id, disabled_at, revoked_at, environment, is_default_for_provider) VALUES (?, ?, ?, 'underclerk', ?, 'merchant', 'Chat reply acceptance', 'active', NULL, '[]', '{}', '{}', ?, ?, NULL, NULL, NULL, 'development', 0)`,
      )
      .bind(accountId, organisationId, connectionId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO underclerk_merchant_binding (binding_id, organisation_id, integration_account_id, merchant_id, environment, delivery_signing_key_id, delivery_signing_public_key_b64, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'development', 'key_mail_e2e', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1, ?, ?)`,
      )
      .bind(bindingId, organisationId, accountId, merchantId, now, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_commerce_system (organisation_id, system_kind, underclerk_binding_id, shopify_integration_account_id, revision, selected_at, selected_by_user_id) VALUES (?, 'satyr_commerce', ?, NULL, 1, ?, ?)`,
      )
      .bind(organisationId, bindingId, now, userId),
  ]);
  const seeded = await purchasingFixture(organisationId, merchantId, "order");
  expect(seeded.status, await seeded.text()).toBe(200);
  return merchantId;
}

/**
 * Pantry's operator approves the workspace's model for mailbox content. The
 * setup never writes this record.
 */
async function approveMailboxModel(
  organisationId: OrganisationId,
): Promise<void> {
  const now = Date.now();
  const route = await resolveOrganisationModelRoute({
    env,
    organisationId,
    now,
  });
  if (!route.ok) throw new Error(route.error.code);
  await fixtureDatabase()
    .prepare(
      "INSERT INTO gmail_inference_eligibility (organisation_id, key_source, provider, model, evidence_reference, evidence_owner, disclosed_recipients, permitted_purpose, consent_reference, reviewed_at, review_expires_at, consented_at, revoked_at) VALUES (?, ?, ?, ?, 'synthetic-chat-reply-e2e', 'synthetic-reviewer', 'openrouter', 'email_processing', 'synthetic-consent', ?, ?, ?, NULL)",
    )
    .bind(
      organisationId,
      route.value.keySource,
      route.value.provider,
      route.value.model,
      now,
      now + 3_600_000,
      now,
    )
    .run();
}

async function mailboxConnector(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<Connector> {
  const connectorId = gmailConnectorId(account);
  if (!connectorId.ok) throw new Error("Invalid connector");
  const connector = await resolveActiveConnectorActor({
    env,
    namespace: env.CONNECTOR,
    organisationId,
    connectorId: connectorId.value,
    now: Date.now(),
  });
  if (!connector.ok) throw new Error(connector.error.code);
  return connector.value;
}
