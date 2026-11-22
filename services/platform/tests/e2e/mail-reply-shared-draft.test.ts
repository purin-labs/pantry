import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { newConversationId, newProjectId } from "@purin-labs/control-api";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import { encodeBase64Url, isRecord } from "@purin-labs/std";
import { MailReplyDoc, type MailReplyUpdate } from "@purin-labs/mail-reply-crdt";
import {
  encodeDraftClientMessage,
  parseDraftServerMessage,
  type DraftServerMessage,
} from "@purin-labs/mail-reply-crdt/protocol";
import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  type ActiveCapabilityId,
} from "../../src/authorization/capability-catalogue";
import { createAccessGrant } from "../../src/data/access-grants";
import {
  readOrganisationCapabilityPolicies,
  writeOrganisationCapabilityPolicy,
} from "../../src/data/capability-policy";
import { type IntegrationAccountId, type OrganisationId } from "../../src/ids";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { readDefaultProjectId } from "../../src/projects/case-project";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { closeSocket, openSocket } from "./hibernatable-socket-support";
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
import type { ModelRoute } from "@purin-labs/contracts";
import { readEmailProposalChatContext } from "../../src/actors/email-proposal-sources";
import { CollaborationRoom } from "../../src/actors/collaboration-room";
import { ConnectorEmail } from "../../src/actors/connector/connector-email-actor";
import { issueControlSession } from "../../src/data/control-plane";
import { network } from "./network";
import { pendingDecisionsOf } from "./access-route-support";
import {
  acceptMailboxModel,
  connectGmailMailbox,
  sendAs,
  setUpMailbox,
  draftBody,
  header,
  mailboxConnector,
} from "./gmail-mailbox-support";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    mailReplySharedDraft?: Record<string, unknown>;
    mailReplyRejected?: Record<string, unknown>;
  }
}

const ADDRESS = "replies@example.test";
const CUSTOMER = "customer@example.test";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE_ID = "m_shared_reply";
const THREAD_ID = "t_shared_reply";
const SHIPPING = "We ship it on Friday.";
const AGENT_SHIPPING = "We ship it on Friday morning, packed by hand.";
const REPLY = `Thank you for your order of Ginger financiers. ${SHIPPING}`;
/**
 * The owner's own change starts the reply. Concurrent inserts at one anchor
 * are ordered by replica, so the two changes are at different places.
 */
const GREETING = "Dear customer,\n\n";
const MERGED = `${GREETING}${REPLY.replace(SHIPPING, AGENT_SHIPPING)}`;

it(
  "lets an agent and two people edit one Inbox reply at the same time, shows the agent's named cursor, saves the merged text as the next Gmail version, sends exactly that version, refuses a viewer and a chat that did not read the reply's Project, and keeps no reply text after the send",
  { timeout: 240_000 },
  sharedReplyDraftJourney,
);
it(
  "sends no agent words to an administrator's new tab whose mailbox check started before the agent's edit added a Memory that they may not read",
  { timeout: 240_000 },
  staleParticipantCheckJourney,
);

it(
  "refuses a viewer's rejection of a Gmail reply and a rejection with a reason, then an administrator's rejection deletes the Gmail draft, ends the shared draft of the owner, sends nothing on a late approval with the review that the owner read before, and takes the reply out of the decisions that wait",
  { timeout: 240_000 },
  rejectedReplyJourney,
);

/**
 * Refactor 17, step A2.1: a refused Gmail reply through the real routes. The
 * owner's chat drafts the reply and the owner reads its review, so the owner
 * holds a send challenge. A viewer may not reject. An administrator rejects:
 * Gmail loses the draft and nothing is sent, also when the owner then
 * approves with the challenge from before the rejection.
 */
async function rejectedReplyJourney({ task }: TestContext): Promise<void> {
  const { organisationId, owner, admin, viewer, gmail, proposalId } =
    await draftReply();
  const waiting = { kind: "email_review", id: proposalId };
  const rejectPath = `${replyPath(organisationId, proposalId)}/reject`;
  expect(await pendingDecisionsOf(organisationId, owner.session)).toContainEqual(
    waiting,
  );
  const ownerRoom = new ReplyRoomClient(
    await openSocket(
      `https://localhost/v1/control/organisations/${organisationId}/email-replies/${proposalId}/draft/socket`,
      owner.session,
    ),
  );
  await ownerRoom.sync();
  const reviewed = await reviewBody(owner, proposalId);

  // 1. A viewer may not reject, and a rejection carries no reason. The reply
  //    still waits, and Gmail keeps the draft.
  const byViewer = await sendAs(viewer, rejectPath, {});
  expect(byViewer).toEqual({
    status: 404,
    body: { ok: false, error: "organisation_role_insufficient" },
  });
  const withReason = await sendAs(admin, rejectPath, { reason: "wrong tone" });
  expect(withReason).toEqual({
    status: 422,
    body: { ok: false, error: "email_reply_request_invalid" },
  });
  expect(gmail.deleted).toEqual([]);
  expect(await pendingDecisionsOf(organisationId, admin.session)).toContainEqual(
    waiting,
  );

  // 2. The administrator rejects. Gmail loses the draft, and the shared
  //    draft of the owner ends.
  const ownerClosed = ownerRoom.closed();
  const rejected = await sendAs(admin, rejectPath, {});
  expect(rejected).toEqual({
    status: 200,
    body: { ok: true, kind: "rejected", cleanup: "deleted" },
  });
  expect(gmail.deleted).toHaveLength(1);
  await ownerClosed;
  expect(ownerRoom.failures).toEqual(["draft_closed"]);

  // 3. The owner approves with the review from before the rejection. Nothing
  //    is sent.
  const late = await sendAs(
    owner,
    `${replyPath(organisationId, proposalId)}/approve`,
    {
      version: reviewed.version,
      snapshotDigest: reviewed.snapshotDigest,
      challenge: reviewed.challenge,
    },
  );
  expect(late.status).toBeGreaterThanOrEqual(400);
  expect(late.body).toMatchObject({ ok: false });
  expect(gmail.sent).toEqual([]);

  // 4. The reply waits for nobody.
  for (const person of [owner, admin])
    expect(
      await pendingDecisionsOf(organisationId, person.session),
    ).not.toContainEqual(waiting);
  await ownerRoom.close();
  expect(gmail.unexpected).toEqual([]);

  task.meta.mailReplyRejected = {
    proposalId,
    viewer: byViewer,
    rejectionWithReason: withReason,
    rejection: rejected,
    gmailDraftsDeleted: gmail.deleted,
    ownerSocket: ownerRoom.failures,
    lateApproval: late,
    gmailSent: gmail.sent,
  };
}

/**
 * Refactor 11 part 2 (F3). An agent edit can add sources to a reply, so the
 * room forgets each participant's mailbox check before the edit. A check that
 * started before the edit ends after it, and it must not be kept: the edit's
 * broadcast checks each participant again.
 *
 * The owner accepts a Memory that the administrator may not read, and a new
 * chat of the owner is shown it. The administrator opens a second tab, and
 * its mailbox check waits at the Connector. The chat's agent edits the
 * reply, so the reply now rests on the owner's Memory too. The check then
 * ends with its old answer. Neither of the administrator's tabs may get the
 * agent's words.
 */
async function staleParticipantCheckJourney(): Promise<void> {
  const {
    organisationId,
    owner,
    admin,
    route,
    paths,
    model,
    connector,
    drafting,
  } = await draftReply();
  const proposalId = model.proposalId ?? "";
  const socketUrl = `https://localhost/v1/control/organisations/${organisationId}/email-replies/${proposalId}/draft/socket`;
  const ownerRoom = new ReplyRoomClient(
    await openSocket(socketUrl, owner.session),
  );
  const adminRoom = new ReplyRoomClient(
    await openSocket(socketUrl, admin.session),
  );
  expect(await adminRoom.sync()).toMatchObject({ access: "edit" });
  await ownerRoom.sync();

  // The owner states a Memory from the chat that drafted the reply, and
  // accepts it. It applies to Portal chats, so a new chat of the owner is
  // shown it. The administrator may not read it: it rests on the owner's
  // private chat.
  const cited = (
    await caseEntry(
      owner,
      drafting,
      `Draft a reply to the customer's mail ${MESSAGE_ID}`,
      "operator_instruction",
    )
  ).evidence;
  const proposed = await command(owner, {
    commandId: "stale_check_memory_propose",
    expectedRevision: 0,
    kind: "propose",
    memoryId: null,
    submission: "own_input",
    content: {
      memoryKind: "fact",
      statement: "Kenji packs every Ginger financier gift box by hand.",
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
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  const memoryId = receiptMemoryId(proposed.body);
  expect(
    await command(owner, {
      commandId: "stale_check_memory_accept",
      expectedRevision: 1,
      kind: "accept",
      memoryId,
      revision: 1,
    }),
  ).toMatchObject({ status: 200 });
  const chat = newConversationId();

  // The administrator opens a second tab. Its mailbox check waits at the
  // Connector.
  const check = holdMailboxCheck(admin.userId);
  const edits = countRoomEdits();
  const late: DraftServerMessage[] = [];
  try {
    const adminTab = await issueControlSession({
      db: env.DB,
      userId: admin.userId,
      now: Date.now(),
      ttlMs: 600_000,
    });
    const opening = openSocket(socketUrl, adminTab);
    await expect.poll(() => check.held, { timeout: 10_000 }).toBe(true);

    // The chat's agent edits the reply while the check waits.
    const edited = await post(
      owner,
      paths.chat,
      chatMessage(chat, route.model, "edit"),
    );
    expect(edited.status, await edited.clone().text()).toBe(200);
    await expect
      .poll(() => edits.count, { timeout: 90_000 })
      .toBeGreaterThan(0);
    check.release();
    const lateSocket = await opening;
    lateSocket.addEventListener("message", (event: MessageEvent) => {
      const parsed = parseDraftServerMessage(event.data);
      if (parsed.ok) late.push(parsed.value);
    });
    await expect
      .poll(workKind.bind(null, owner, chat), { timeout: 90_000 })
      .toBe("ready");
    expect(model.editResult.replaceAll("\\", "")).toContain(AGENT_SHIPPING);
    await expect
      .poll(() => ownerRoom.doc.read())
      .toBe(REPLY.replace(SHIPPING, AGENT_SHIPPING));

    // The reply now rests on the owner's Memory, which the administrator
    // may not read. Both of the administrator's tabs are refused.
    const replyContext = await runInDurableObject(
      connector,
      (_actor: unknown, durable: DurableObjectState) =>
        readEmailProposalChatContext(durable.storage.sql, proposalId),
    );
    expect(replyContext.memory).toEqual([{ memoryId, revision: 1 }]);
    await expect.poll(() => adminRoom.failures).toEqual(["access_revoked"]);
    expect(adminRoom.doc.read()).toBe(REPLY);
    expect(
      late
        .filter(
          (message) =>
            message.kind === "update_broadcast" ||
            message.kind === "sync_response",
        )
        .map((message) => message.kind),
    ).toEqual([]);
    await expect
      .poll(() => late.map((message) => message.kind))
      .toContain("failure");
    await closeSocket(lateSocket);
  } finally {
    check.restore();
    edits.restore();
    await ownerRoom.close();
    await adminRoom.close();
  }
}

/**
 * Holds the answer of the first mailbox check of one person at the Connector
 * until `release()`. The check itself runs unchanged, at once.
 */
function holdMailboxCheck(userId: string) {
  const prototype = ConnectorEmail.prototype;
  const original = prototype.authorizeEmailProposalDelivery;
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const hold = {
    matched: false,
    held: false,
    release(): void {
      open();
    },
    restore(): void {
      open();
      prototype.authorizeEmailProposalDelivery = original;
    },
  };
  prototype.authorizeEmailProposalDelivery = async function heldCheck(
    this: unknown,
    raw: unknown,
  ) {
    const answer: ReturnType<typeof original> = Reflect.apply(original, this, [
      raw,
    ]);
    if (
      !hold.matched &&
      isRecord(raw) &&
      isRecord(raw.authority) &&
      raw.authority.userId === userId
    ) {
      hold.matched = true;
      const settled = await answer;
      hold.held = true;
      await gate;
      return settled;
    }
    return answer;
  };
  return hold;
}

/** Counts the edits that reach a collaboration room. */
function countRoomEdits() {
  const prototype = CollaborationRoom.prototype;
  const original = prototype.mutate;
  const edits = {
    count: 0,
    restore(): void {
      prototype.mutate = original;
    },
  };
  prototype.mutate = function countedMutate(
    this: unknown,
    ...input: Parameters<typeof original>
  ) {
    edits.count++;
    return Reflect.apply(original, this, input);
  } as typeof original;
  return edits;
}

/**
 * A private Portal chat of the owner drafts a reply to a customer's mail; its
 * context showed the Base Project. The owner and an administrator open the
 * reply's shared draft; a viewer, who may not read the mailbox, is refused.
 * A chat filed in another Project was never shown Base, so it may not read
 * the draft. The owner types a greeting that has not reached
 * the server yet, and a second chat asks the agent to improve the shipping
 * sentence: the agent reads the draft and edits it, and both people see its
 * named cursor and its change. The owner's greeting then arrives. A send
 * before a save is refused, because the Gmail draft lacks the shared text.
 * The save writes the merged text as Gmail version 2 and records no
 * correction, because the agent and the owner both wrote it. The send sends
 * exactly that text, the room ends each socket, and it keeps no reply text.
 */
async function sharedReplyDraftJourney({ task }: TestContext): Promise<void> {
  const {
    organisationId,
    owner,
    admin,
    viewer,
    route,
    paths,
    gmail,
    model,
    connector,
    baseProjectId,
    proposalId,
  } = await draftReply();

  // 2. The owner and the administrator open the shared draft; the viewer may
  //    not read the mailbox and is refused before any text.
  const socketUrl = `https://localhost/v1/control/organisations/${organisationId}/email-replies/${proposalId}/draft/socket`;
  const ownerRoom = new ReplyRoomClient(
    await openSocket(socketUrl, owner.session),
  );
  const adminRoom = new ReplyRoomClient(
    await openSocket(socketUrl, admin.session),
  );
  const viewerRoom = new ReplyRoomClient(
    await openSocket(socketUrl, viewer.session),
  );
  const ownerSync = await ownerRoom.sync();
  const adminSync = await adminRoom.sync();
  expect(ownerSync).toMatchObject({
    access: "edit",
    savedVersion: 1,
    unsaved: false,
  });
  expect(adminSync).toMatchObject({
    access: "edit",
    savedVersion: 1,
    unsaved: false,
  });
  expect(ownerRoom.doc.read()).toBe(REPLY);
  expect(adminRoom.doc.read()).toBe(REPLY);
  await expect.poll(() => viewerRoom.failures).toEqual(["access_revoked"]);
  expect(viewerRoom.doc.read()).toBe("");

  // 3. A chat of the owner filed in the Project "Kitchen notes" asks for the
  //    same edit. Its context never showed Base, which the reply rests on, so
  //    it may not read the draft, and nobody sees an agent cursor.
  const projectId = newProjectId();
  const created = await post(owner, paths.projects, {
    kind: "create_project",
    operationId: crypto.randomUUID(),
    projectId,
    content: {
      name: "Kitchen notes",
      brief: "Notes for the pastry kitchen.",
      references: [],
    },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  expect(
    await postJson(owner, `${paths.projects}/${projectId}/access`, {
      kind: "share_project",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 0,
      members: [],
    }),
  ).toMatchObject({ status: 200 });
  const outside = newConversationId();
  await fileChat(owner, paths.chat, route, outside, projectId, 1);
  const refused = await post(
    owner,
    paths.chat,
    chatMessage(outside, route.model, "edit"),
  );
  expect(refused.status, await refused.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, outside), { timeout: 90_000 })
    .toBe("ready");
  expect(model.refusal).toContain("has not read every source");
  expect(model.editResult).toBe("");
  for (const room of [ownerRoom, adminRoom])
    expect(room.agentFrames.flat()).toEqual([]);
  expect(adminRoom.doc.read()).toBe(REPLY);

  // 4. The owner types a greeting. It has not reached the server when the
  //    agent edits the shipping sentence in a second private chat.
  const greeting = requireUpdate(ownerRoom.doc.edit(`${GREETING}${REPLY}`));
  model.refusal = "";
  const editing = newConversationId();
  const edited = await post(
    owner,
    paths.chat,
    chatMessage(editing, route.model, "edit"),
  );
  expect(edited.status, await edited.clone().text()).toBe(200);
  try {
    await expect
      .poll(workKind.bind(null, owner, editing), { timeout: 90_000 })
      .toBe("ready");
  } catch (error) {
    const failed = await storedConversation(owner, editing);
    throw new Error(
      JSON.stringify({
        work: failed?.conversation.work,
        lastEvent: failed?.conversation.timeline.at(-1),
      }).slice(0, 2000),
      { cause: error },
    );
  }
  expect(model.readResult).toContain("Thank you for your order");
  expect(model.editResult.replaceAll("\\", "")).toContain(AGENT_SHIPPING);
  // Both people saw the agent's named cursor on the reply body, and it
  // cleared after the room's hold.
  for (const room of [ownerRoom, adminRoom]) {
    const shown = room.agentFrames.flat();
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((activity) => activity.target === "body")).toBe(true);
    expect(shown[0]?.agent.displayName).toEqual(expect.any(String));
    await expect
      .poll(() => room.agentFrames.at(-1), { timeout: 15_000 })
      .toEqual([]);
  }
  await expect
    .poll(() => adminRoom.doc.read())
    .toBe(REPLY.replace(SHIPPING, AGENT_SHIPPING));

  // The reply now also rests on what the editing chat read.
  const replyContext = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      readEmailProposalChatContext(durable.storage.sql, proposalId),
  );
  expect(replyContext.projects).toEqual([baseProjectId]);

  // 5. The owner's greeting arrives after the agent's edit. Both changes
  //    stay, and everyone holds the same text.
  await ownerRoom.submit("owner-greeting", greeting);
  await expect.poll(() => adminRoom.doc.read()).toBe(MERGED);
  expect(ownerRoom.doc.read()).toBe(MERGED);

  // 6. A send before a save is refused: Gmail still holds version 1.
  const unsaved = await reviewBody(owner, proposalId);
  const early = await sendAs(
    owner,
    `${replyPath(organisationId, proposalId)}/approve`,
    {
      version: unsaved.version,
      snapshotDigest: unsaved.snapshotDigest,
      challenge: unsaved.challenge,
    },
  );
  expect(early).toEqual({
    status: 409,
    body: { ok: false, error: "email_reply_draft_unsaved" },
  });
  expect(gmail.sent).toEqual([]);

  // 7. The save writes the merged text as Gmail version 2. The agent and the
  //    owner both wrote it, so it records no correction.
  const saved = await sendAs(
    owner,
    `${replyPath(organisationId, proposalId)}/draft-save`,
    {},
  );
  expect(saved).toEqual({
    status: 200,
    body: { ok: true, kind: "saved", version: 2 },
  });
  expect(gmail.updates).toEqual([MERGED]);
  const corrections = await runInDurableObject(
    connector,
    (_actor: unknown, durable: DurableObjectState) =>
      durable.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM connector_email_reply_correction WHERE proposal_id = ?",
          proposalId,
        )
        .one().count,
  );
  expect(corrections).toBe(0);
  const savedReview = await reviewBody(owner, proposalId);
  expect(savedReview).toMatchObject({ version: 2, body: MERGED });

  // 8. The send sends exactly the saved text. The room ends each socket and
  //    keeps no reply text; a socket opened after the send is closed too.
  const ownerClosed = ownerRoom.closed();
  const adminClosed = adminRoom.closed();
  const sent = await sendAs(
    owner,
    `${replyPath(organisationId, proposalId)}/approve`,
    {
      version: savedReview.version,
      snapshotDigest: savedReview.snapshotDigest,
      challenge: savedReview.challenge,
    },
  );
  expect(sent).toMatchObject({
    status: 200,
    body: { ok: true, kind: "sent", version: 2 },
  });
  expect(gmail.sent).toEqual([MERGED]);
  await Promise.all([ownerClosed, adminClosed]);
  expect(ownerRoom.failures).toEqual(["draft_closed"]);
  expect(adminRoom.failures).toEqual(["draft_closed"]);
  const late = new ReplyRoomClient(await openSocket(socketUrl, owner.session));
  await expect.poll(() => late.failures).toEqual(["draft_closed"]);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const stored = await runInDurableObject(
    organisation,
    (_actor: unknown, durable: DurableObjectState) => ({
      drafts: durable.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM mail_reply_draft WHERE proposal_id = ?",
          proposalId,
        )
        .one().count,
      operations: durable.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM mail_reply_draft_operation WHERE proposal_id = ?",
          proposalId,
        )
        .one().count,
      closed: durable.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM mail_reply_draft_closed WHERE proposal_id = ?",
          proposalId,
        )
        .one().count,
    }),
  );
  expect(stored).toEqual({ drafts: 0, operations: 0, closed: 1 });
  for (const room of [ownerRoom, adminRoom, viewerRoom, late])
    await room.close();
  expect(gmail.unexpected).toEqual([]);

  task.meta.mailReplySharedDraft = {
    proposalId,
    replyBeforeEdit: REPLY,
    agentRead: model.readResult.length > 0,
    agentCursorFrames: {
      owner: ownerRoom.agentFrames,
      admin: adminRoom.agentFrames,
    },
    viewer: viewerRoom.failures,
    chatOutsideProject: model.refusalSeen,
    sendBeforeSave: early,
    save: saved,
    gmailUpdates: gmail.updates,
    correctionsRecorded: corrections,
    send: sent,
    gmailSent: gmail.sent,
    socketsAfterSend: {
      owner: ownerRoom.failures,
      admin: adminRoom.failures,
      reopened: late.failures,
    },
    storedAfterSend: stored,
  };
}

/**
 * A private Portal chat of the owner drafts a reply to a customer's mail. The
 * reply rests on the Base Project, which the administrator may read.
 */
async function draftReply() {
  const {
    organisationId,
    author: owner,
    reviewer: admin,
    viewer,
    route,
    paths,
  } = await installMemoryFixture();
  const gmail = new ReplyMailbox();
  gmail.serve();
  const model = new SharedReplyModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
  );
  const account = await connectGmailMailbox(organisationId, owner, {
    label: "sharedreply",
    address: ADDRESS,
    capabilities: [
      CAPABILITY_KEYS.emailMailboxRead,
      CAPABILITY_KEYS.emailReplyPropose,
    ],
  });
  model.account = account;
  await setUpMailbox(owner, organisationId, account);
  const policy = await sendAs(
    owner,
    `/v1/control/organisations/${organisationId}/agent-mailboxes/${account}/policy`,
    {
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
    },
  );
  expect(policy).toMatchObject({ status: 200, body: { ok: true } });
  await acceptMailboxModel(organisationId, owner);
  const connector = await mailboxConnector(organisationId, account);
  await runDurableObjectAlarm(connector);
  await grantOwnerReplyTools(organisationId, account);
  // A member who accepts an invitation joins the Base Project (Plan 95).
  const baseProjectId = await readDefaultProjectId(
    (await requireOrganisationExecutionScope(env, organisationId)).database,
    organisationId,
  );
  if (baseProjectId === null) throw new Error("The Base Project is missing");
  await enableCapabilities(owner, [
    CAPABILITY_KEYS.emailMailboxRead,
    CAPABILITY_KEYS.emailReplyPropose,
  ]);

  // 1. A private Portal chat of the owner drafts the reply.
  const drafting = newConversationId();
  const drafted = await post(
    owner,
    paths.chat,
    chatMessage(drafting, route.model, "draft"),
  );
  expect(drafted.status, await drafted.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, owner, drafting), { timeout: 90_000 })
    .toBe("ready");
  const proposalId = await replyProposalId(organisationId);
  model.proposalId = proposalId;
  expect(await reviewBody(owner, proposalId)).toMatchObject({
    version: 1,
    body: REPLY,
  });
  return {
    organisationId,
    owner,
    admin,
    viewer,
    route,
    paths,
    gmail,
    model,
    connector,
    baseProjectId,
    proposalId,
    drafting,
  };
}

/** Creates an empty chat of the owner and files it in the Project. */
async function fileChat(
  owner: Member,
  chatPath: string,
  route: ModelRoute,
  conversationId: ReturnType<typeof newConversationId>,
  projectId: string,
  projectAccessRevision: number,
): Promise<void> {
  await createConversation(owner, conversationId, route);
  const stored = await storedConversation(owner, conversationId);
  if (stored === null) throw new Error("The chat is missing");
  expect(
    await postJson(
      owner,
      `${chatPath}/conversations/${conversationId}/access`,
      {
        kind: "share_conversation",
        operationId: crypto.randomUUID(),
        expectedRevision: stored.revision,
        projectId,
        expectedProjectAccessRevision: projectAccessRevision,
      },
    ),
  ).toMatchObject({ status: 200, body: { kind: "accepted" } });
}

function replyPath(organisationId: OrganisationId, proposalId: string): string {
  return `/v1/control/organisations/${organisationId}/email-replies/${proposalId}`;
}

function chatMessage(
  conversationId: string,
  model: string,
  intent: "draft" | "edit",
): Record<string, unknown> {
  return {
    kind: "message",
    conversationId,
    requestId: `request_${crypto.randomUUID()}`,
    model,
    text:
      intent === "draft"
        ? `Draft a reply to the customer's mail ${MESSAGE_ID}.`
        : "Make the shipping sentence of the waiting reply more precise.",
    browserContext: { kind: "unavailable" },
  };
}

/**
 * A chat model. The first chat drafts the reply. The second chat reads the
 * reply's shared draft and replaces its shipping sentence. A large catalogue
 * hides tools behind tool_search, so the model searches first.
 */
class SharedReplyModel {
  account: IntegrationAccountId | null = null;
  proposalId: string | null = null;
  readResult = "";
  editResult = "";
  /** The refused read of the last chat, if any. */
  refusal = "";
  refusalSeen = "";
  searches = 0;

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const body: unknown = await request.clone().json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("The model request is invalid");
    const offered = offeredToolNames(body);
    const text = JSON.stringify(body.messages);
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
    const id = `shared_reply_${String(calls.length)}`;
    if (this.account === null) throw new Error("The mailbox is not connected");
    const editing = text.includes("shipping sentence");
    const needed = editing
      ? ["email_reply_draft_read", "email_reply_draft_edit"]
      : ["email_reply_propose"];
    const last = needed.at(-1) ?? "";
    if (calls.includes(last)) {
      if (editing) this.editResult = results.at(-1) ?? "";
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The reply is ready for review.",
        }),
        id,
      );
    }
    const missing = needed.filter((name) => !offered.includes(name));
    if (missing.length > 0) {
      if (++this.searches > 6) throw new Error("Tool discovery did not end");
      return openRouterToolCall(
        "tool_search",
        { query: missing.join(" "), limit: 8 },
        id,
      );
    }
    if (!editing)
      return openRouterToolCall(
        "email_reply_propose",
        {
          integrationAccountId: this.account,
          messageId: MESSAGE_ID,
          threadId: THREAD_ID,
          body: REPLY,
          sources: null,
        },
        id,
      );
    if (this.proposalId === null) throw new Error("No reply to edit");
    if (!calls.includes("email_reply_draft_read"))
      return openRouterToolCall(
        "email_reply_draft_read",
        { integrationAccountId: this.account, proposalId: this.proposalId },
        id,
      );
    const read = results.at(-1) ?? "";
    if (read.includes("has not read every source")) {
      this.refusal = read;
      this.refusalSeen = read;
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "I may not read that reply here.",
        }),
        id,
      );
    }
    this.readResult = read;
    return openRouterToolCall(
      "email_reply_draft_edit",
      {
        integrationAccountId: this.account,
        proposalId: this.proposalId,
        oldText: SHIPPING,
        newText: AGENT_SHIPPING,
      },
      id,
    );
  }
}

/** One person's socket on the reply's shared draft, with a local replica. */
class ReplyRoomClient {
  readonly doc: MailReplyDoc;
  readonly agentFrames: (readonly CollaborationAgentActivity[])[] = [];
  readonly failures: string[] = [];
  readonly messages: DraftServerMessage[] = [];
  private readonly receive = this.message.bind(this);

  constructor(readonly socket: WebSocket) {
    const doc = MailReplyDoc.create("");
    if (!doc.ok) throw new Error(doc.error.code);
    this.doc = doc.value;
    socket.addEventListener("message", this.receive);
  }

  /** Syncs with the room and returns what the room reported. */
  async sync(): Promise<
    Readonly<{ access: string; savedVersion: number; unsaved: boolean }>
  > {
    const vector = this.doc.stateVector();
    if (!vector.ok) throw new Error(vector.error.code);
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error(
        `The room refused the socket: ${this.failures.join(", ")}`,
      );
    const response = this.next((message) => message.kind === "sync_response");
    this.socket.send(
      encodeDraftClientMessage({
        kind: "sync_request",
        stateVector: vector.value,
      }),
    );
    const synced = await response;
    if (synced.kind !== "sync_response") throw new Error("No sync response");
    return {
      access: synced.access,
      savedVersion: synced.savedVersion,
      unsaved: synced.unsaved,
    };
  }

  /** Sends a local change and waits for the room to accept it. */
  async submit(updateId: string, update: MailReplyUpdate): Promise<void> {
    const accepted = this.next(
      (message) =>
        message.kind === "update_accepted" && message.updateId === updateId,
    );
    this.socket.send(
      encodeDraftClientMessage({ kind: "submit_update", updateId, update }),
    );
    await accepted;
  }

  /** Resolves when the room closes this socket. */
  closed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSED) return resolve();
      this.socket.addEventListener("close", () => resolve(), { once: true });
    });
  }

  async close(): Promise<void> {
    this.socket.removeEventListener("message", this.receive);
    await closeSocket(this.socket);
  }

  private message(event: MessageEvent): void {
    const parsed = parseDraftServerMessage(event.data);
    if (!parsed.ok)
      throw new Error(`Invalid reply draft frame: ${String(event.data)}`);
    const message = parsed.value;
    this.messages.push(message);
    switch (message.kind) {
      case "sync_response":
        requireApplied(this.doc.apply(message.missingUpdate));
        return;
      case "update_broadcast":
        requireApplied(this.doc.apply(message.update));
        return;
      case "presence_changed":
        this.agentFrames.push(message.agents);
        return;
      case "failure":
        this.failures.push(message.code);
        return;
      case "update_accepted":
        return;
    }
  }

  private next(
    accept: (message: DraftServerMessage) => boolean,
  ): Promise<DraftServerMessage> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent): void => {
        const parsed = parseDraftServerMessage(event.data);
        if (!parsed.ok || !accept(parsed.value)) return;
        this.socket.removeEventListener("message", onMessage);
        resolve(parsed.value);
      };
      this.socket.addEventListener("message", onMessage);
      this.socket.addEventListener(
        "close",
        () => reject(new Error("The reply draft socket closed")),
        { once: true },
      );
    });
  }
}

function requireUpdate(
  result: ReturnType<MailReplyDoc["edit"]>,
): MailReplyUpdate {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function requireApplied(result: ReturnType<MailReplyDoc["apply"]>): void {
  if (!result.ok) throw new Error(result.error.code);
}

/** Gmail for this mailbox: the customer's mail, the reply draft, the send. */
class ReplyMailbox {
  drafts = new Map<
    string,
    { raw: string; threadId: string; message: number }
  >();
  /** The body of each draft update, in order. */
  updates: string[] = [];
  /** The body of each sent message, in order. */
  sent: string[] = [];
  /** The Gmail drafts that a rejection deleted. */
  deleted: string[] = [];
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
      http.get(`${GMAIL}/messages/${MESSAGE_ID}`, () =>
        HttpResponse.json({
          id: MESSAGE_ID,
          threadId: THREAD_ID,
          labelIds: ["INBOX"],
          sizeEstimate: 2_048,
          internalDate: String(Date.now() - 60_000),
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: `Customer <${CUSTOMER}>` },
              { name: "To", value: ADDRESS },
              { name: "Subject", value: "When do the financiers ship?" },
              { name: "Message-ID", value: `<${MESSAGE_ID}@example.test>` },
            ],
            body: {
              data: encodeBase64Url(
                new TextEncoder().encode(
                  "I ordered Ginger financiers. When do they ship?",
                ),
              ),
            },
          },
        }),
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
            id: `message_${id}_${String(draft.message)}`,
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
        const raw = await requestRaw(request);
        const id = `draft_${String(this.drafts.size + 1)}`;
        this.drafts.set(id, {
          raw: raw.raw,
          threadId: raw.threadId,
          message: 1,
        });
        return HttpResponse.json({
          id,
          message: { id: `message_${id}_1`, threadId: raw.threadId },
        });
      }),
      http.put(`${GMAIL}/drafts/:draftId`, async ({ params, request }) => {
        const id = String(params.draftId);
        const draft = this.drafts.get(id);
        if (draft === undefined)
          return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
        const raw = await requestRaw(request);
        const message = draft.message + 1;
        this.drafts.set(id, { raw: raw.raw, threadId: raw.threadId, message });
        this.updates.push(draftBody(raw.raw));
        return HttpResponse.json({
          id,
          message: {
            id: `message_${id}_${String(message)}`,
            threadId: raw.threadId,
          },
        });
      }),
      http.delete(`${GMAIL}/drafts/:draftId`, ({ params }) => {
        this.deleted.push(String(params.draftId));
        this.drafts.delete(String(params.draftId));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${GMAIL}/messages/send`, async ({ request }) => {
        const body: unknown = await request.json();
        if (!isRecord(body) || typeof body.raw !== "string")
          throw new Error("Invalid Gmail send");
        this.sent.push(draftBody(body.raw));
        return HttpResponse.json({
          id: `sent_${String(this.sent.length)}`,
          threadId:
            typeof body.threadId === "string" ? body.threadId : THREAD_ID,
        });
      }),
      http.all(`${GMAIL}/*`, ({ request }) => {
        this.unexpected.push(`${request.method} ${request.url}`);
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }),
    );
  }
}

async function requestRaw(
  request: Readonly<{ json(): Promise<unknown> }>,
): Promise<Readonly<{ raw: string; threadId: string }>> {
  const body: unknown = await request.json();
  if (
    !isRecord(body) ||
    !isRecord(body.message) ||
    typeof body.message.raw !== "string"
  )
    throw new Error("Invalid Gmail draft");
  return {
    raw: body.message.raw,
    threadId:
      typeof body.message.threadId === "string" ? body.message.threadId : "",
  };
}

/** The one reply that the first chat drafted. */
async function replyProposalId(
  organisationId: OrganisationId,
): Promise<string> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const rows = await scope.database
    .prepare(
      "SELECT proposal_id AS proposalId FROM email_reply_proposal WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .all<{ proposalId: string }>();
  expect(rows.results).toHaveLength(1);
  const proposalId = rows.results[0]?.proposalId;
  if (proposalId === undefined) throw new Error("The chat drafted no reply");
  return proposalId;
}

/** The reply as the owner's review reads it, with the send challenge. */
async function reviewBody(
  person: Member,
  proposalId: string,
): Promise<
  Readonly<{
    version: number;
    body: string;
    snapshotDigest: string;
    challenge: string;
  }>
> {
  const read = await postJson(
    person,
    replyPath(person.organisationId, proposalId),
    null,
  );
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  const body = read.body;
  if (
    !isRecord(body) ||
    !isRecord(body.proposal) ||
    typeof body.proposal.version !== "number" ||
    typeof body.proposal.body !== "string" ||
    typeof body.proposal.snapshot_digest !== "string" ||
    typeof body.challenge !== "string"
  )
    throw new Error(JSON.stringify(body));
  return {
    version: body.proposal.version,
    body: body.proposal.body,
    snapshotDigest: body.proposal.snapshot_digest,
    challenge: body.challenge,
  };
}

/** Turns capabilities on as the owner, then publishes the policy. */
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
          mutationReceiptId: `receipt_shared_reply_${capabilityId}`,
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

/** Owners may propose replies in this mailbox from a chat. */
async function grantOwnerReplyTools(
  organisationId: OrganisationId,
  account: IntegrationAccountId,
): Promise<void> {
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const created = await createAccessGrant({
    db: scope.database,
    organisationId,
    grantId: "grant_shared_reply_propose",
    subject: { kind: "organisation_role", role: "owner" },
    target: {
      kind: "provider_resource",
      capabilityId: CAPABILITY_KEYS.emailReplyPropose,
      capabilityVersion: 1,
      integrationAccountId: account,
      resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_grant_shared_reply_propose",
    },
    now: Date.now(),
  });
  if (!created.ok) throw new Error(created.error.code);
}
