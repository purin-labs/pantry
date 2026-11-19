import type {
  OrganisationDatabase,
  OrganisationStatement,
} from "../../src/database-handles";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { fixtureDatabase } from "./organisation-database";
import { readControlMutationReplay } from "../../src/data/control-mutation";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import { forkChat } from "../../src/chat/forks";
import { readChatControlAuthority } from "../../src/chat/information-flow";
import {
  changeWorkspaceAiBudget,
  settleWorkspaceAiBudget,
  type WorkspaceAiBudget,
  readWorkspaceAiBudget,
} from "../../src/data/workspace-ai-budget";
import { readPortalChatAttachmentKeys } from "../../src/chat/attachments";
import { parseChat, type ChatTimelineView, type ChatAttachmentView } from "@purin-labs/control-api/portal/chat";
import { parseOrganisationPlacementMoveTarget } from "../../src/data/organisation-placement";
import {
  type ActorRelocationId,
  startActorRelocation,
  resumeActorRelocation,
} from "../../src/actors/actor-relocation";
import { prepareActorRestoreManifest } from "../../src/actors/actor-restore-manifest";
import { loadActorExport } from "../../src/actors/actor-export";
import {
  startActorRestore,
  resumeActorRestore,
} from "../../src/actors/actor-restore";
import { sha256Hex } from "@purin-labs/std";
import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, vi } from "vitest";
import { decodeBase64, isRecord } from "@purin-labs/std";
import { parseConversationId } from "@purin-labs/control-api";
import { MenuDraftDoc, type MenuDraftUpdate } from "@purin-labs/menu-draft-crdt";
import {
  encodeMenuDraftClientMessage,
  parseMenuDraftServerMessage,
  type MenuDraftServerMessage,
} from "@purin-labs/menu-draft-crdt/protocol";
import { parseSessionId, parseUserId, type UserId } from "../../src/ids";
import {
  issueControlSession,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import {
  createAccessGrant,
  revokeAccessGrant,
} from "../../src/data/access-grants";
import { writeOrganisationCapabilityPolicy } from "../../src/data/capability-policy";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import {
  requireActiveOrganisationActor,
  resolveActiveSessionActor,
} from "../../src/actors/actor-router";
import { readConversation, type ConversationScope } from "../../src/chat/store";
import {
  chatForkAttachments,
  parseChatForkHistory,
  parseChatHistorySnapshot,
} from "../../src/chat/fork-history";
import { waveHeader, h264Fixture } from "../media-fixtures";
import { network } from "./network";
import {
  ORGANISATION_ID,
  inspectSlackActors,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  signedSlackRequest,
  slackEnvelope,
  slackFileSimulator,
  slackSimulator,
  SLACK_ACTOR_USER_ID,
} from "./slack-journey-support";

const BRIEF = "CONNECTED_FORK_BRIEF: proofing capacity is twelve trays.";
const SOURCE_TEXT =
  "<@U0PANTRY> retain these bakery files as historical context.";
const SOURCE_RESPONSE = "The connected bakery files are accepted.";
const SOURCE_ID = requiredConversationId(
  "conv_00000000-0000-4000-8000-0000000042a1",
);
const REQUEST_ID = "connected_source";
const ROOT_TS = "1787590000.000042";
const PNG = connectedImage();

it(
  "forks retained media and reads later human edits from the same live Yjs room in independent Pi sessions",
  connectedForkJourney,
  100_000,
);

async function connectedForkJourney({
  task,
}: import("vitest").TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const { scope, session } = await controlClient();
  const requests: string[] = [];
  const slack = slackSimulator();
  const media = [
    {
      id: "F0FORKTEXT",
      name: "brief.txt",
      mimetype: "text/plain",
      bytes: new TextEncoder().encode(BRIEF),
    },
    { id: "F0FORKPNG", name: "layout.png", mimetype: "image/png", bytes: PNG },
    {
      id: "F0FORKWAV",
      name: "call.wav",
      mimetype: "audio/wav",
      bytes: waveHeader(),
    },
    {
      id: "F0FORKMP4",
      name: "line.mp4",
      mimetype: "video/mp4",
      bytes: h264Fixture(),
    },
  ];
  const files = slackFileSimulator(media);
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      reply.bind(null, requests),
    ),
    slack.handler,
    files.infoHandler,
    files.downloadHandler,
  );
  expect(
    (
      await exports.default.fetch(
        await signedSlackRequest(
          slackEnvelope({
            eventType: "app_mention",
            eventId: "Ev0CONNECTEDFORK",
            messageTs: ROOT_TS,
            threadTs: ROOT_TS,
            text: SOURCE_TEXT,
            files: media.map(slackFileReference),
          }),
        ),
      )
    ).status,
  ).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);
  expect(files.downloads.sort()).toEqual([
    "F0FORKMP4",
    "F0FORKPNG",
    "F0FORKTEXT",
    "F0FORKWAV",
  ]);
  const source = await inspectSlackActors(fixture.connectorId);
  if (
    !source.session.ok ||
    source.session.value.checkpoint.kind !== "current"
  ) {
    throw new Error("Source did not commit a harness checkpoint");
  }
  const resolved = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: source.sessionId,
    now: Date.now(),
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  await evictDurableObject(resolved.value);
  const acquired = await parseChatHistorySnapshot(
    await resolved.value.readCompletedChatHistory({
      organisationId: ORGANISATION_ID,
      sessionId: source.sessionId,
      turnId: source.session.value.checkpoint.turnId,
      throughSequence: null,
    }),
  );
  const form = new FormData();
  form.set(
    "command",
    JSON.stringify({
      kind: "message",
      conversationId: SOURCE_ID,
      requestId: REQUEST_ID,
      model: "moonshotai/kimi-k3",
      text: SOURCE_TEXT,
      browserContext: { kind: "unavailable" },
      surfaceContext: null,
    }),
  );
  for (const attachment of chatForkAttachments(acquired)) {
    const object = await env.ARCHIVE.get(attachment.objectKey);
    if (object === null) throw new Error("Missing acquired source bytes");
    form.append(
      "files",
      new File([await object.arrayBuffer()], attachment.displayName, {
        type: attachment.descriptor.media.mediaType,
      }),
    );
  }
  const headers = controlHeaders(session);
  delete headers["content-type"];
  const uploaded = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    { method: "POST", headers, body: form },
  );
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  const uploadedBody: unknown = await uploaded.json();
  if (!isRecord(uploadedBody)) throw new Error("Missing uploaded chat");
  const uploadedChat = parseChat(uploadedBody.conversation);
  const uploadedUser = uploadedChat.timeline.find(isUserTimelineEvent);
  expect(uploadedUser?.attachments.map(attachmentFilename).sort()).toEqual([
    "brief.txt",
    "call.wav",
    "layout.png",
    "line.mp4",
  ]);
  await expect
    .poll(chatWork.bind(null, session, SOURCE_ID), { timeout: 15_000 })
    .toBe("ready");
  const callsAfterUpload = requests.length;
  const replayUpload = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    { method: "POST", headers, body: form },
  );
  expect(replayUpload.status, await replayUpload.clone().text()).toBe(200);
  expect(requests).toHaveLength(callsAfterUpload);
  const changedUpload = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    { method: "POST", headers, body: changedUploadForm(form) },
  );
  expect(changedUpload.status).toBe(409);
  expect(requests).toHaveLength(callsAfterUpload);
  const portalSource = await readConversation(fixtureDatabase(), scope, SOURCE_ID);
  const sourceBinding = portalSource?.conversation.historyBindings.at(-1);
  if (sourceBinding === undefined || sourceBinding.responseId === null)
    throw new Error("Portal source did not commit history");
  const responseId = sourceBinding.responseId;
  const sourceSessionId = parseSessionId(sourceBinding.sessionId);
  if (!sourceSessionId.ok) throw new Error(sourceSessionId.error.code);
  const admitted = {
    sessionId: sourceSessionId.value,
    turnId: sourceBinding.turnId,
  };
  assertPreparedMedia(requests[0] ?? "");
  assertPreparedMedia(requests[1] ?? "");
  const controlActor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId: ORGANISATION_ID,
    sessionId: admitted.sessionId,
    now: Date.now(),
  });
  if (!controlActor.ok) throw new Error(controlActor.error.code);
  await evictDurableObject(controlActor.value);

  const owner = await MenuPeer.open(session);
  const observer = await MenuPeer.open(session);
  try {
    await owner.sync();
    await owner.submit(
      "initial-layout",
      owner.document.addItem({
        id: "item_fork_croissant",
        productId: "product_croissant",
        displayName: "Butter croissant",
        description: "Current shared menu",
        placement: { sectionId: "section_main", order: 0 },
      }),
    );
    await observer.sync();
    const before = await menuSnapshot(session);
    const callsBeforeFork = requests.length;
    const fork = await createFork(
      session,
      SOURCE_ID,
      "connected_fork",
      responseId,
    );
    expect(requests).toHaveLength(callsBeforeFork);
    expect(await menuSnapshot(session)).toEqual(before);
    const history = await retainedHistory(scope, fork.conversationId);
    const attachments = chatForkAttachments(history);
    expect(attachments).toHaveLength(4);
    expect(attachments.map(attachmentClass).sort()).toEqual([
      "audio",
      "document",
      "image",
      "video",
    ]);

    const broadcast = observer.next("update_broadcast");
    await owner.submit(
      "human-layout-move",
      owner.document.moveItem("item_fork_croissant", {
        sectionId: "section_main",
        order: 7,
      }),
    );
    const changed = await broadcast;
    if (changed.kind !== "update_broadcast")
      throw new Error("Missing human layout broadcast");
    const applied = observer.document.apply(changed.update);
    if (!applied.ok) throw new Error(applied.error.code);
    expect(observer.document.read()).toEqual(owner.document.read());
    expect(observer.document.read().items[0]?.placement.order).toBe(7);
    const current = await menuSnapshot(session);
    expect(current.value.documentId).toBe(before.value.documentId);
    expect(current.value.revision).toBe(before.value.revision + 1);

    await continueFork(session, fork.conversationId, "connected_alternative");
    assertPreparedMedia(requests.at(-1) ?? "");
    expect(await menuSnapshot(session)).toEqual(current);
    const continued = await readConversation(
      fixtureDatabase(),
      scope,
      fork.conversationId,
    );
    const cutoff = continued?.conversation.historyBindings.at(-1);
    if (cutoff === undefined || cutoff.responseId === null)
      throw new Error("Missing fork cutoff");
    const nested = await createFork(
      session,
      fork.conversationId,
      "connected_nested",
      cutoff.responseId,
    );
    expect(await menuSnapshot(session)).toEqual(current);
    const nestedBroadcast = observer.next("update_broadcast");
    await owner.submit(
      "human-nested-layout-move",
      owner.document.moveItem("item_fork_croissant", {
        sectionId: "section_main",
        order: 11,
      }),
    );
    const nestedChanged = await nestedBroadcast;
    if (nestedChanged.kind !== "update_broadcast")
      throw new Error("Missing nested human layout broadcast");
    const nestedApplied = observer.document.apply(nestedChanged.update);
    if (!nestedApplied.ok) throw new Error(nestedApplied.error.code);
    expect(observer.document.read()).toEqual(owner.document.read());
    const nestedCurrent = await menuSnapshot(session);
    expect(nestedCurrent.value.documentId).toBe(current.value.documentId);
    expect(nestedCurrent.value.revision).toBe(current.value.revision + 1);
    await continueFork(
      session,
      nested.conversationId,
      "connected_nested_alternative",
    );
    assertPreparedMedia(requests.at(-1) ?? "");
    expect(await menuSnapshot(session)).toEqual(nestedCurrent);
    expect(requests).toHaveLength(8);
    await continueFork(
      session,
      nested.conversationId,
      "connected_revoked_read",
    );
    expect(requests).toHaveLength(11);
    expect(await menuSnapshot(session)).toEqual(nestedCurrent);
    expect(
      (await readConversation(fixtureDatabase(), scope, SOURCE_ID))?.conversation
        .completedRequests,
    ).toEqual([REQUEST_ID]);
    expect(slack.visibleMessageCount()).toBe(1);
    expect(files.downloads).toHaveLength(4);
    owner.close();
    observer.close();
    const restore = await restoreConnectedChats(
      scope,
      session,
      nested.conversationId,
      requests,
    );
    const forkJournalFencing = await verifyForkJournalFencing(
      scope,
      session,
      responseId,
    );
    expect(await menuSnapshot(session)).toEqual(nestedCurrent);
    Object.assign(task.meta, {
      connectedForkEvidence: {
        runtime:
          "Pi SDK with deterministic provider; signed Slack ingress and real D1/R2/Actors/Yjs",
        uploadReplay:
          "Identical multipart replay makes no model call; changed bytes under the same request ID are refused",
        sourceProjection:
          "Signed Slack acquisition followed by actual multipart Portal upload admission and an independent accepted chat turn",
        portalTimelineParsed: true,
        restore,
        forkJournalFencing,
        sourceId: SOURCE_ID,
        acquisitionSessionId: source.sessionId,
        sourceSessionId: admitted.sessionId,
        cutoffId: responseId,
        destinationId: fork.conversationId,
        nestedId: nested.conversationId,
        digest: fork.digest,
        attachments,
        sourceDownloads: files.downloads,
        modelCalls: requests.length,
        sourceEvictedBeforeFork: true,
        room: {
          documentId: current.value.documentId,
          beforeRevision: before.value.revision,
          afterHumanRevision: current.value.revision,
          afterNestedHumanRevision: nestedCurrent.value.revision,
          forkMutationCount: 0,
          continuationMutationCount: 0,
          observedOrder: observer.document.read().items[0]?.placement.order,
          agentReads: [
            {
              transport: "direct_tool",
              revision: current.value.revision,
              order: 7,
            },
            {
              transport: "code_mode",
              revision: nestedCurrent.value.revision,
              order: 11,
            },
          ],
          observation:
            "Real Tool Host reads reach the Pi model after each later human edit; two authenticated Yjs clients converge",
          revokedRead:
            "Grant revoked after discovery; Tool Host rejects the next direct read without returning a snapshot",
        },
      },
    });
  } finally {
    owner.close();
    observer.close();
  }
}

async function controlClient(): Promise<{
  scope: ConversationScope;
  session: IssuedControlSession;
}> {
  const identity = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!identity.ok) throw new Error(identity.error.code);
  const now = Date.now();
  await fixtureDatabase().batch([
    fixtureDatabase().prepare(
      "UPDATE service_role_grant SET role = 'admin' WHERE organisation_id = ? AND user_id = ?",
    ).bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID),
    fixtureDatabase().prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_connected_fork', activated_at = ? WHERE organisation_id = ?",
    ).bind(now, ORGANISATION_ID),
  ]);
  const grant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_connected_fork",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_connected_fork",
    },
    now,
  });
  if (!grant.ok) throw new Error(grant.error.code);
  const menuGrant = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: "grant_connected_menu_read",
    subject: { kind: "organisation_role", role: "admin" },
    target: {
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.commerceMenuDraftRead,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "operator",
      userId: identity.value,
      mutationReceiptId: "receipt_connected_menu_read",
    },
    now,
  });
  if (!menuGrant.ok) throw new Error(menuGrant.error.code);
  const menuPolicy = await writeOrganisationCapabilityPolicy({
    scope: await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    write: {
      kind: "change",

      capabilityId: CAPABILITY_KEYS.commerceMenuDraftRead,
      expectedRevision: 1,
      mode: "enabled",
      provenance: {
        kind: "operator",
        userId: identity.value,
        mutationReceiptId: "receipt_connected_menu_read",
      },
      now,
    },
  });
  if (!menuPolicy.ok) throw new Error(menuPolicy.error.code);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now,
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now,
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const session = await issueControlSession({
    db: env.DB,
    userId: identity.value,
    now,
    ttlMs: 1_800_000,
  });
  return {
    scope: { organisationId: ORGANISATION_ID, userId: identity.value },
    session,
  };
}

async function reply(
  requests: string[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid connected fork model request");
  requests.push(JSON.stringify(body));
  switch (requests.length) {
    case 2:
      return openRouterText(
        JSON.stringify({ kind: "reply", text: SOURCE_RESPONSE }),
        "chatcmpl_connected_2",
      );
    case 1:
      return openRouterText(
        SOURCE_RESPONSE,
        `chatcmpl_connected_${requests.length}`,
      );
    case 3:
    case 6:
    case 9:
      return openRouterToolCall(
        "tool_search",
        { query: "menu_draft_read", limit: 1 },
        `connected_menu_discovery_${requests.length}`,
      );
    case 4:
      return openRouterToolCall("menu_draft_read", {}, "connected_menu_read");
    case 7:
      return openRouterToolCall(
        "codemode",
        { code: "text(await tools.menu_draft_read({}));" },
        "connected_nested_menu_read",
      );
    case 5:
      assertCurrentMenuResult(body, 3, 7);
      break;
    case 8:
      assertCurrentMenuResult(body, 4, 11);
      break;
    case 10: {
      const revoked = await revokeAccessGrant({
        db: fixtureDatabase(),
        organisationId: ORGANISATION_ID,
        grantId: "grant_connected_menu_read",
        expectedRevision: 1,
        reason: "Revoke menu read between discovery and execution",
        now: Date.now(),
      });
      if (!revoked.ok) throw new Error(revoked.error.code);
      return openRouterToolCall(
        "menu_draft_read",
        {},
        "connected_revoked_menu_read",
      );
    }
    case 12:
      assertPreparedMedia(JSON.stringify(body));
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The restored fork retains all four accepted files.",
        }),
        "chatcmpl_connected_restore",
      );
    case 11: {
      const denied = currentToolText(body);
      expect(denied).toContain(
        "The capability could not complete this request",
      );
      expect(denied).not.toContain("documentId");
      expect(denied).not.toContain("observedAt");
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The current menu read was refused after its grant was revoked.",
        }),
        "chatcmpl_connected_revoked",
      );
    }
    default:
      throw new Error("Unexpected connected fork model call");
  }
  return openRouterText(
    JSON.stringify({
      kind: "reply",
      text: "The alternative retains the accepted files and observes the current shared menu.",
    }),
    `chatcmpl_connected_${requests.length}`,
  );
}

function assertCurrentMenuResult(
  body: Record<string, unknown>,
  revision: number,
  order: number,
): void {
  const text = currentToolText(body);
  expect(text).toContain("cafe-menu");
  expect(text).toMatch(new RegExp(`revision[^0-9]+${revision}`));
  expect(text).toMatch(new RegExp(`order[^0-9]+${order}`));
  expect(text).toContain("observedAt");
  expect(text).toContain("Butter croissant");
}

function currentToolText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) throw new Error("Missing model messages");
  for (const message of [...body.messages].reverse()) {
    if (!isRecord(message) || message.role !== "tool") continue;
    if (typeof message.content === "string") return message.content;
    throw new Error("Expected a text tool result");
  }
  throw new Error("Missing current menu tool result");
}

function controlHeaders(session: IssuedControlSession): Record<string, string> {
  return {
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
    origin: "https://localhost",
    "content-type": "application/json",
    "x-satyr-csrf": session.csrfToken,
  };
}

async function createFork(
  session: IssuedControlSession,
  sourceId: string,
  operationId: string,
  messageId: string,
): Promise<{ conversationId: string; digest: string }> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat/conversations/${sourceId}`,
    {
      method: "PATCH",
      headers: controlHeaders(session),
      body: JSON.stringify({ action: "fork", operationId, messageId }),
    },
  );
  const raw: unknown = await response.json();
  expect(response.status, JSON.stringify(raw)).toBe(200);
  if (
    !isRecord(raw) ||
    raw.kind !== "ready" ||
    typeof raw.conversationId !== "string" ||
    typeof raw.digest !== "string"
  ) {
    throw new Error(`Fork refused: ${JSON.stringify(raw)}`);
  }
  return { conversationId: raw.conversationId, digest: raw.digest };
}

async function continueFork(
  session: IssuedControlSession,
  conversationId: string,
  requestId: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      method: "POST",
      headers: controlHeaders(session),
      body: JSON.stringify({
        kind: "message",
        conversationId,
        requestId,
        model: "moonshotai/kimi-k3",
        text: "Read the current shared menu and report its croissant order. Retain the files as historical context.",
        browserContext: { kind: "unavailable" },
        surfaceContext: null,
      }),
    },
  );
  expect(response.status).toBe(200);
  await expect
    .poll(chatWork.bind(null, session, conversationId), { timeout: 15_000 })
    .toBe("ready");
}

async function chatWork(
  session: IssuedControlSession,
  conversationId: string,
): Promise<string> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${conversationId}`,
    { headers: controlHeaders(session) },
  );
  const raw: unknown = await response.json();
  if (!isRecord(raw)) {
    throw new Error(`Missing chat state: ${JSON.stringify(raw)}`);
  }
  const conversation = parseChat(raw.conversation);
  if (conversation.work.kind === "failed")
    throw new Error(JSON.stringify(conversation.work));
  return conversation.work.kind;
}

function isUserTimelineEvent(
  event: ChatTimelineView,
): event is Extract<typeof event, { kind: "user" }> {
  return event.kind === "user";
}

function attachmentFilename(attachment: ChatAttachmentView): string {
  return attachment.filename;
}

async function retainedHistory(
  scope: ConversationScope,
  conversationId: string,
) {
  const row = await fixtureDatabase().prepare(
    "SELECT history_json FROM portal_chat_fork WHERE organisation_id = ? AND user_id = ? AND destination_conversation_id = ? AND status = 'ready'",
  )
    .bind(scope.organisationId, scope.userId, conversationId)
    .first<{ history_json: string }>();
  if (row === null) throw new Error("Missing retained fork history");
  return parseChatForkHistory(JSON.parse(row.history_json));
}

function attachmentClass(
  attachment: ReturnType<typeof chatForkAttachments>[number],
): string {
  return attachment.descriptor.kind;
}

function assertPreparedMedia(prompt: string): void {
  expect(prompt).toContain(BRIEF);
  expect(prompt).toContain("data:image/png;base64,");
  expect(prompt).toContain("class=audio");
  expect(prompt).toContain("class=video");
  expect(prompt).toContain("contents not interpreted");
  expect(prompt).toContain("decoder_required");
}

type MenuSnapshot = Readonly<{
  value: Readonly<{ documentId: string; revision: number; draft: unknown }>;
}>;

async function menuSnapshot(
  session: IssuedControlSession,
): Promise<MenuSnapshot> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/menu-draft`,
    { headers: controlHeaders(session) },
  );
  expect(response.status).toBe(200);
  const raw: unknown = await response.json();
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.value) ||
    typeof raw.value.documentId !== "string" ||
    typeof raw.value.revision !== "number"
  ) {
    throw new Error("Invalid current menu snapshot");
  }
  return {
    value: {
      documentId: raw.value.documentId,
      revision: raw.value.revision,
      draft: raw.value.draft,
    },
  };
}

class MenuPeer {
  readonly document = MenuDraftDoc.createReplica();
  private readonly messages: MenuDraftServerMessage[] = [];
  private readonly pending = new Map<
    MenuDraftServerMessage["kind"],
    PromiseWithResolvers<MenuDraftServerMessage>
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", this.receive.bind(this));
  }

  static async open(session: IssuedControlSession): Promise<MenuPeer> {
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/menu-draft/socket`,
      {
        headers: { ...controlHeaders(session), Upgrade: "websocket" },
      },
    );
    expect(response.status).toBe(101);
    if (response.webSocket === null) throw new Error("Missing menu socket");
    response.webSocket.accept();
    return new MenuPeer(response.webSocket);
  }

  async sync(): Promise<void> {
    const vector = this.document.stateVector();
    if (!vector.ok) throw new Error(vector.error.code);
    const response = this.next("sync_response");
    this.socket.send(
      encodeMenuDraftClientMessage({
        kind: "sync_request",
        stateVector: vector.value,
      }),
    );
    const message = await response;
    if (message.kind !== "sync_response") throw new Error("Missing room sync");
    const applied = this.document.apply(message.missingUpdate);
    if (!applied.ok) throw new Error(applied.error.code);
    this.messages.length = 0;
  }

  async submit(
    updateId: string,
    result:
      | Readonly<{ ok: true; value: MenuDraftUpdate }>
      | Readonly<{ ok: false; error: Readonly<{ code: string }> }>,
  ): Promise<void> {
    if (!result.ok) throw new Error(result.error.code);
    const response = this.next("update_accepted");
    this.socket.send(
      encodeMenuDraftClientMessage({
        kind: "submit_update",
        updateId,
        update: result.value,
      }),
    );
    expect(await response).toEqual({ kind: "update_accepted", updateId });
  }

  next(kind: MenuDraftServerMessage["kind"]): Promise<MenuDraftServerMessage> {
    const index = this.messages.findIndex(messageKind.bind(null, kind));
    if (index >= 0) {
      const message = this.messages.splice(index, 1)[0];
      if (message === undefined) throw new Error("Missing queued room message");
      return Promise.resolve(message);
    }
    if (this.pending.has(kind))
      throw new Error("Duplicate room message waiter");
    const pending = Promise.withResolvers<MenuDraftServerMessage>();
    this.pending.set(kind, pending);
    return pending.promise;
  }

  private receive(event: MessageEvent): void {
    const parsed = parseMenuDraftServerMessage(event.data);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const message = parsed.value;
    if (message.kind === "failure") throw new Error(message.code);
    if (message.kind === "presence_changed") return;
    const pending = this.pending.get(message.kind);
    if (pending === undefined) this.messages.push(message);
    else {
      this.pending.delete(message.kind);
      pending.resolve(message);
    }
  }

  close(): void {
    this.document.destroy();
    this.socket.close();
  }
}

function messageKind(
  kind: MenuDraftServerMessage["kind"],
  message: MenuDraftServerMessage,
): boolean {
  return message.kind === kind;
}

function requiredConversationId(raw: string) {
  const parsed = parseConversationId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function connectedImage(): Uint8Array {
  const bytes = decodeBase64(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8f8AAAAASUVORK5CYII=",
  );
  if (bytes === null) throw new Error("Invalid connected image fixture");
  return bytes;
}

function slackFileReference(
  file: Readonly<{
    id: string;
    name: string;
    mimetype: string;
    bytes: Uint8Array;
  }>,
): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimetype: file.mimetype,
    size: file.bytes.length,
    timestamp: 1_787_590_000,
  };
}

async function restoreConnectedChats(
  scope: ConversationScope,
  session: IssuedControlSession,
  nestedId: string,
  requests: readonly string[],
) {
  const sourceScope = await OrganisationExecutionScope.resolve(
    env,
    ORGANISATION_ID,
  );
  if (!sourceScope.ok) throw new Error(sourceScope.error.code);
  const initialBudget = await readWorkspaceAiBudget(fixtureDatabase(), ORGANISATION_ID);
  if (!initialBudget.ok) throw new Error(initialBudget.error);
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: "e2e",
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const attachmentKeys = await readPortalChatAttachmentKeys(
    fixtureDatabase(),
    env.ARCHIVE,
    ORGANISATION_ID,
  );
  const attachmentKey = attachmentKeys.find(isAttachmentContentKey);
  if (attachmentKey === undefined)
    throw new Error("Missing attachment fixture");
  const attachment = await env.ARCHIVE.get(attachmentKey);
  if (attachment === null) throw new Error("Missing attachment content");
  const attachmentBytes = await attachment.arrayBuffer();
  await env.ARCHIVE.delete(attachmentKey);
  try {
    expect(
      await startActorRelocation({
        env,
        organisationId: ORGANISATION_ID,
        target: target.value,
        now: Date.now(),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "referenced_r2_missing", key: attachmentKey },
    });
    expect(await sourceScope.value.isActive()).toBe(true);
  } finally {
    await env.ARCHIVE.put(attachmentKey, attachmentBytes, {
      httpMetadata: attachment.httpMetadata,
      customMetadata: attachment.customMetadata,
    });
  }
  const started = await startActorRelocation({
    env,
    organisationId: ORGANISATION_ID,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  await interruptPublication("relocation");
  const pause = vi
    .spyOn(OrganisationExecutionScope.prototype, "isActive")
    .mockImplementationOnce(
      freezeAfterScopeRead.bind(
        null,
        sourceScope.value,
        started.value.relocationId,
      ),
    );
  try {
    const rejectedBudget = await changeWorkspaceAiBudget({
      scope: sourceScope.value,
      limits: { maxTokens: 128000, maxWallMs: 180000, maxToolCalls: 20 },
      expectedRevision: initialBudget.value.revision,
      mutationReceiptId: "receipt_plan55_paused_budget",
      now: Date.now(),
    });
    expect(rejectedBudget).toEqual({
      ok: false,
      error: "workspace_ai_budget_conflict",
    });
  } finally {
    pause.mockRestore();
  }
  expect(await readWorkspaceAiBudget(fixtureDatabase(), ORGANISATION_ID)).toEqual(
    initialBudget,
  );
  const frozenSettlement = budgetSettlementInput(
    sourceScope.value,
    initialBudget.value,
    scope.userId,
  );
  const frozenEvidence = await budgetSettlementEvidence(
    initialBudget.value.mutationReceiptId,
  );
  expect(await settleWorkspaceAiBudget(frozenSettlement)).toEqual({
    ok: false,
    error: "workspace_ai_budget_conflict",
  });
  expect(
    await budgetSettlementEvidence(initialBudget.value.mutationReceiptId),
  ).toEqual(frozenEvidence);
  const relocationRollback = await verifyPublicationRollback(
    "relocation",
    started.value.relocationId,
    started.value.sourcePlacementEpoch,
    started.value.targetPlacementEpoch,
  );
  await env.DB.prepare("DROP TRIGGER plan55_interrupt_publication").run();
  const relocated = await resumeActorRelocation({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
  if (!relocated.ok || relocated.value.status !== "retained")
    throw new Error(JSON.stringify(relocated));
  expect(await sourceScope.value.isActive()).toBe(false);
  expect(
    await changeWorkspaceAiBudget({
      scope: sourceScope.value,
      limits: initialBudget.value.limits,
      expectedRevision: initialBudget.value.revision,
      mutationReceiptId: "receipt_plan55_retired_budget",
      now: Date.now(),
    }),
  ).toEqual({ ok: false, error: "workspace_ai_budget_unavailable" });
  const manifest = await prepareActorRestoreManifest({
    env,
    relocationId: started.value.relocationId,
    now: Date.now(),
  });
  if (!manifest.ok) throw new Error(JSON.stringify(manifest.error));
  const attachmentOwners = new Set<string>();
  for (const object of manifest.value.objects) {
    if (
      object.identity.objectKind !== "case" &&
      object.identity.objectKind !== "session"
    )
      continue;
    const loaded = await loadActorExport({
      bucket: env.ARCHIVE,
      root: env.DATA_ENCRYPTION_ROOT,
      ref: object.exportRef,
    });
    if (!loaded.ok) throw new Error(loaded.error.code);
    for (const reference of loaded.value.payload.r2) {
      if (
        reference.sourceKey.startsWith(`attachments/${ORGANISATION_ID}/`) &&
        isAttachmentContentKey(reference.sourceKey)
      )
        attachmentOwners.add(object.identity.objectKind);
    }
  }
  expect([...attachmentOwners].sort()).toEqual(["case", "session"]);
  const listed = await env.ARCHIVE.list({
    prefix: `attachments/${ORGANISATION_ID}/`,
  });
  expect(listed.truncated).toBe(false);
  const digests: Record<string, string> = {};
  const chatKeys = await readPortalChatAttachmentKeys(
    fixtureDatabase(),
    env.ARCHIVE,
    ORGANISATION_ID,
  );
  expect(chatKeys).toHaveLength(8);
  for (const key of chatKeys) {
    const stored = await env.ARCHIVE.get(key);
    if (stored === null) throw new Error("Missing export source");
    digests[key] = await sha256Hex(new Uint8Array(await stored.arrayBuffer()));
  }
  const tables = [
    "portal_chat_fork",
    "session_turn_access",
    "portal_conversation_user",
    "portal_conversation",
    "case_project",
    "project_access_operation",
    "project_member",
    "portal_chat_directory_project",
    "project",
    "portal_chat_conversation_access_operation",
    "portal_chat_directory_operation",
    "portal_chat_deletion",
    "portal_chat_directory",
  ];
  await fixtureDatabase().batch(tables.map(deleteOrganisationRows));
  // Simulate a clean account whose organisation identities and configuration were restored first.
  await env.DB.prepare(
    "DELETE FROM state_object_relocation_item WHERE relocation_id = ?",
  )
    .bind(started.value.relocationId)
    .run();
  await fixtureDatabase().prepare(
    "DELETE FROM durable_object_registry WHERE organisation_id = ?",
  )
    .bind(ORGANISATION_ID)
    .run();
  await env.ARCHIVE.delete(listed.objects.map(objectKey));
  expect(await readConversation(fixtureDatabase(), scope, SOURCE_ID)).toBeNull();
  const restored = await startActorRestore({
    env,
    manifest: manifest.value,
    target: target.value,
    now: Date.now(),
  });
  if (!restored.ok) throw new Error(JSON.stringify(restored.error));
  await interruptPublication("restore");
  await expect(
    resumeActorRestore({
      env,
      restoreId: restored.value.restoreId,
      now: Date.now(),
    }),
  ).rejects.toThrow("plan55_publication_interrupted");
  const restoreRollback = await verifyPublicationRollback(
    "restore",
    restored.value.restoreId,
    restored.value.localSourcePlacementEpoch,
    restored.value.targetPlacementEpoch,
  );
  await env.DB.prepare("DROP TRIGGER plan55_interrupt_publication").run();
  const completed = await resumeActorRestore({
    env,
    restoreId: restored.value.restoreId,
    now: Date.now(),
  });
  if (!completed.ok || completed.value.status !== "complete")
    throw new Error(JSON.stringify(completed));
  const replay = await resumeActorRestore({
    env,
    restoreId: restored.value.restoreId,
    now: Date.now(),
  });
  expect(replay).toEqual(completed);
  const staging = await env.ARCHIVE.list({
    prefix: `state-object-organisation-data-v1/${ORGANISATION_ID}/`,
  });
  expect(staging.objects).toEqual([]);
  for (const [key, digest] of Object.entries(digests)) {
    const stored = await env.ARCHIVE.get(key);
    if (stored === null) throw new Error(`Missing restored bytes: ${key}`);
    expect(await sha256Hex(new Uint8Array(await stored.arrayBuffer()))).toBe(
      digest,
    );
  }
  const nested = await readConversation(
    fixtureDatabase(),
    scope,
    requiredConversationId(nestedId),
  );
  const cutoff = nested?.conversation.historyBindings.at(-1);
  if (cutoff === undefined || cutoff.responseId === null)
    throw new Error("Missing restored cutoff");
  const before = requests.length;
  const fork = await createFork(
    session,
    nestedId,
    "connected_restored_fork",
    cutoff.responseId,
  );
  expect(requests).toHaveLength(before);
  await continueFork(
    session,
    fork.conversationId,
    "connected_restored_continuation",
  );
  expect(requests).toHaveLength(before + 1);
  const budgetScope = await OrganisationExecutionScope.resolve(
    env,
    ORGANISATION_ID,
  );
  if (!budgetScope.ok) throw new Error(budgetScope.error.code);
  const budgetChange = {
    scope: budgetScope.value,
    limits: { maxTokens: 128000, maxWallMs: 180000, maxToolCalls: 20 },
    expectedRevision: initialBudget.value.revision,
    mutationReceiptId: "receipt_plan55_current_budget",
    now: Date.now(),
  };
  const changedBudget = await changeWorkspaceAiBudget(budgetChange);
  if (!changedBudget.ok) throw new Error(changedBudget.error);
  expect(changedBudget.value.activation).toBe("pending");
  expect(await changeWorkspaceAiBudget(budgetChange)).toEqual(changedBudget);
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const policy = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!policy.ok) throw new Error(policy.error.code);
  const settlement = budgetSettlementInput(
    budgetScope.value,
    changedBudget.value,
    scope.userId,
  );
  await fixtureDatabase().prepare(
    `CREATE TRIGGER plan55_interrupt_budget_settlement
    BEFORE INSERT ON onboarding_audit_event
    WHEN NEW.operation = 'access_control.budget.change'
    BEGIN SELECT RAISE(ABORT, 'plan55_budget_settlement_interrupted'); END`,
  ).run();
  await expect(settleWorkspaceAiBudget(settlement)).rejects.toThrow(
    "plan55_budget_settlement_interrupted",
  );
  expect(await readWorkspaceAiBudget(fixtureDatabase(), ORGANISATION_ID)).toEqual(
    changedBudget,
  );
  expect(
    await budgetSettlementEvidence(changedBudget.value.mutationReceiptId),
  ).toEqual({ receipt: null, audit: null });
  await fixtureDatabase().prepare("DROP TRIGGER plan55_interrupt_budget_settlement").run();
  const settled = await settleWorkspaceAiBudget(settlement);
  if (!settled.ok) throw new Error(settled.error);
  const evidence = await budgetSettlementEvidence(
    changedBudget.value.mutationReceiptId,
  );
  expect(evidence.receipt).not.toBeNull();
  expect(evidence.audit).not.toBeNull();
  expect(
    await readControlMutationReplay({
      db: fixtureDatabase(),
      scope: {
        userId: scope.userId,
        organisationScope: ORGANISATION_ID,
        route: `/v1/control/organisations/${ORGANISATION_ID}/access-control/ai-budget`,
        operation: "access_control.budget.change",
      },
      boundary: settlement.boundary,
    }),
  ).toEqual({
    kind: "replay",
    receipt: { responseStatus: 200, responseBody: settled.value },
  });
  const activeBudget = await readWorkspaceAiBudget(fixtureDatabase(), ORGANISATION_ID);
  expect(activeBudget).toMatchObject({
    ok: true,
    value: { activation: "active", revision: initialBudget.value.revision + 1 },
  });
  const unavailable = await OrganisationExecutionScope.resolve(
    {
      DB: env.DB,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE:
        '{"kind":"affinity","placementCellId":"unconfigured","locationHint":"wnam","databaseBinding":"DB"}',
    },
    ORGANISATION_ID,
  );
  expect(unavailable).toEqual({
    ok: false,
    error: {
      code: "organisation_cell_unavailable",
      organisationId: ORGANISATION_ID,
    },
  });
  return {
    manifestDigestB64: manifest.value.manifestDigestB64,
    actors: manifest.value.objects.length,
    restoredObjects: Object.keys(digests).length,
    sourcePlacementEpoch: manifest.value.sourcePlacementEpoch,
    targetPlacementEpoch: completed.value.targetPlacementEpoch,
    continuationId: fork.conversationId,
    repeatedRestore: "identical receipt",
    publication: { relocationRollback, restoreRollback },
    budgetFencing: {
      pausedWrite: "rejected after live check, before commit",
      frozenActivation: "rejected",
      retiredScope: "rejected",
      unconfiguredCell: "unavailable",
      currentEpoch: budgetScope.value.placement.placementEpoch,
      activeBudget,
      settlement: {
        auditFailure: "activation and receipt rolled back",
        retry: "committed",
        replay: "identical response",
        evidence,
      },
    },
  };
}

function isAttachmentContentKey(key: string): boolean {
  return !key.includes("/portalref/");
}
function deleteOrganisationRows(table: string): D1PreparedStatement {
  // The Organisation keeps its default Project: it is configuration, not chat state.
  const kept =
    table === "project"
      ? " AND project_id NOT IN (SELECT project_id FROM organisation_default_project WHERE organisation_id = project.organisation_id)"
      : "";
  return fixtureDatabase().prepare(
    `DELETE FROM ${table} WHERE organisation_id = ?${kept}`,
  ).bind(ORGANISATION_ID);
}
function objectKey(object: R2Object): string {
  return object.key;
}

function changedUploadForm(source: FormData): FormData {
  const changed = new FormData();
  let replaced = false;
  for (const [key, value] of source.entries()) {
    if (key === "files" && value instanceof File && !replaced) {
      changed.append(
        key,
        new File(["Changed after admission"], value.name, { type: value.type }),
      );
      replaced = true;
    } else changed.append(key, value);
  }
  return changed;
}

async function interruptPublication(kind: "relocation" | "restore") {
  await env.DB.prepare(
    `
    CREATE TRIGGER plan55_interrupt_publication
    BEFORE UPDATE OF status ON state_object_${kind}
    WHEN NEW.status = 'published'
    BEGIN
      SELECT RAISE(ABORT, 'plan55_publication_interrupted');
    END
  `,
  ).run();
}

async function verifyPublicationRollback(
  kind: "relocation" | "restore",
  operationId: string,
  sourceEpoch: number,
  targetEpoch: number,
) {
  const placements = await env.DB.prepare(
    `SELECT placement_epoch AS epoch, status FROM organisation_placement
     WHERE organisation_id = ? AND placement_epoch IN (?, ?)
     ORDER BY placement_epoch`,
  )
    .bind(ORGANISATION_ID, sourceEpoch, targetEpoch)
    .all();
  expect(placements.results).toEqual([
    { epoch: sourceEpoch, status: "frozen" },
    { epoch: targetEpoch, status: "reserved" },
  ]);
  const journal = await env.DB.prepare(
    `SELECT status, published_at FROM state_object_${kind}
     WHERE ${kind}_id = ?`,
  )
    .bind(operationId)
    .first();
  expect(journal).toEqual({
    status: kind === "relocation" ? "copying" : "importing",
    published_at: null,
  });
  return { placements: placements.results, journal };
}

const readScopeActive = OrganisationExecutionScope.prototype.isActive;

type ForkJournalStage = "admission" | "preparation" | "publication" | "failure";
type ForkJournalEvidence = Awaited<ReturnType<typeof forkJournalEvidence>>;
type ForkJournalRace = {
  scope: ConversationScope;
  operationId: string;
  stage: ForkJournalStage;
  state:
    | { kind: "waiting" }
    | { kind: "freezing" }
    | {
        kind: "frozen";
        relocationId: ActorRelocationId;
        before: ForkJournalEvidence;
      };
};

async function verifyForkJournalFencing(
  scope: ConversationScope,
  session: IssuedControlSession,
  responseId: string,
) {
  const evidence = [];
  const stages: readonly ForkJournalStage[] = [
    "admission",
    "preparation",
    "publication",
    "failure",
  ];
  for (const stage of stages) {
    const placement = await OrganisationExecutionScope.resolve(
      env,
      scope.organisationId,
    );
    if (!placement.ok) throw new Error(placement.error.code);
    const authority = await readChatControlAuthority(fixtureDatabase(), scope);
    if (authority === null) throw new Error("Missing fork authority");
    const operationId = `p55_fork_${stage}`;
    const command = {
      operationId,
      messageId: stage === "failure" ? "response_unaccepted" : responseId,
    };
    const race: ForkJournalRace = {
      scope,
      operationId,
      stage,
      state: { kind: "waiting" },
    };
    const prepare = fixtureDatabase().prepare.bind(fixtureDatabase());
    const pause = vi
      .spyOn(fixtureDatabase(), "prepare")
      .mockImplementation(interceptForkJournal.bind(null, race, prepare));
    try {
      const interrupted = await forkChat(
        env,
        placement.value,
        scope.userId,
        authority,
        SOURCE_ID,
        command,
      );
      expect(interrupted).toEqual({
        kind: "rejected",
        code: "chat_fork_conflict",
      });
    } finally {
      pause.mockRestore();
    }
    if (race.state.kind !== "frozen")
      throw new Error(`Fork did not reach ${stage} commit`);
    const frozen = await forkJournalEvidence(scope, operationId);
    expect(frozen).toEqual(race.state.before);
    expect(frozen.status).toBe(
      stage === "admission"
        ? null
        : stage === "publication"
          ? "prepared"
          : "preparing",
    );
    expect(frozen.destinations).toBe(stage === "publication" ? 1 : 0);
    await env.DB.prepare("DROP TRIGGER plan55_interrupt_publication").run();
    const relocated = await resumeActorRelocation({
      env,
      relocationId: race.state.relocationId,
      now: Date.now(),
    });
    expect(relocated).toMatchObject({
      ok: true,
      value: { status: "retained" },
    });
    const fresh = await OrganisationExecutionScope.resolve(
      env,
      scope.organisationId,
    );
    if (!fresh.ok) throw new Error(fresh.error.code);
    expect(fresh.value.placement.placementEpoch).toBeGreaterThan(
      placement.value.placement.placementEpoch,
    );
    expect(
      await forkChat(
        env,
        placement.value,
        scope.userId,
        authority,
        SOURCE_ID,
        command,
      ),
    ).toEqual({ kind: "rejected", code: "chat_fork_conflict" });
    expect(await forkJournalEvidence(scope, operationId)).toEqual(frozen);
    const response = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${scope.organisationId}/chat/conversations/${SOURCE_ID}`,
      {
        method: "PATCH",
        headers: controlHeaders(session),
        body: JSON.stringify({ action: "fork", ...command }),
      },
    );
    const settled: unknown = await response.json();
    expect(response.status, JSON.stringify(settled)).toBe(
      stage === "failure" ? 409 : 200,
    );
    expect(settled).toMatchObject({
      kind: stage === "failure" ? "failed" : "ready",
      operationId,
    });
    const current = await forkJournalEvidence(scope, operationId);
    expect(current.status).toBe(stage === "failure" ? "failed" : "ready");
    expect(current.destinations).toBe(stage === "failure" ? 0 : 1);
    if (frozen.digest !== null) expect(current.digest).toBe(frozen.digest);
    const replay = await exports.default.fetch(
      `https://localhost/v1/control/organisations/${scope.organisationId}/chat/conversations/${SOURCE_ID}`,
      {
        method: "PATCH",
        headers: controlHeaders(session),
        body: JSON.stringify({ action: "fork", ...command }),
      },
    );
    expect(await replay.json()).toEqual(settled);
    expect(await forkJournalEvidence(scope, operationId)).toEqual(current);
    evidence.push({
      stage,
      sourceCell: placement.value.placement.placementCellId,
      currentCell: fresh.value.placement.placementCellId,
      sourceEpoch: placement.value.placement.placementEpoch,
      currentEpoch: fresh.value.placement.placementEpoch,
      frozen,
      retiredScope: "rejected",
      settled: current,
      replay: "identical",
    });
  }
  return evidence;
}

function interceptForkJournal(
  race: ForkJournalRace,
  prepare: OrganisationDatabase["prepare"],
  sql: string,
): OrganisationStatement {
  const statement = prepare(sql);
  if (race.state.kind === "waiting" && forkJournalStage(sql) === race.stage) {
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementationOnce(
      bindForkJournalCommit.bind(null, race, bind),
    );
  }
  return statement;
}

function bindForkJournalCommit(
  race: ForkJournalRace,
  bind: D1PreparedStatement["bind"],
  ...values: unknown[]
): D1PreparedStatement {
  const statement = bind(...values);
  const run = statement.run.bind(statement);
  vi.spyOn(statement, "run").mockImplementationOnce(
    freezeForkJournalCommit.bind(null, race, run),
  );
  return statement;
}

function forkJournalStage(sql: string): ForkJournalStage | null {
  if (sql.includes("INSERT OR IGNORE INTO portal_chat_fork"))
    return "admission";
  if (sql.includes("UPDATE portal_chat_fork SET status = 'prepared'"))
    return "preparation";
  if (sql.includes("UPDATE portal_chat_fork SET status = 'ready'"))
    return "publication";
  if (sql.includes("UPDATE portal_chat_fork SET status = 'failed'"))
    return "failure";
  return null;
}

async function freezeForkJournalCommit<T = Record<string, unknown>>(
  race: ForkJournalRace,
  run: D1PreparedStatement["run"],
): Promise<D1Result<T>> {
  race.state = { kind: "freezing" };
  const before = await forkJournalEvidence(race.scope, race.operationId);
  // Each fault uses a fresh cell while earlier source cells retain recovery data.
  const target = parseOrganisationPlacementMoveTarget({
    kind: "affinity",
    placementCellId: `e2e-fork-${race.stage}`,
    locationHint: "wnam",
  });
  if (!target.ok) throw new Error(target.error.code);
  const started = await startActorRelocation({
    env,
    organisationId: race.scope.organisationId,
    target: target.value,
    now: Date.now(),
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  await interruptPublication("relocation");
  await expect(
    resumeActorRelocation({
      env,
      relocationId: started.value.relocationId,
      now: Date.now(),
    }),
  ).rejects.toThrow("plan55_publication_interrupted");
  race.state = {
    kind: "frozen",
    relocationId: started.value.relocationId,
    before,
  };
  return run<T>();
}

async function forkJournalEvidence(
  scope: ConversationScope,
  operationId: string,
) {
  const journal = await fixtureDatabase().prepare(
    "SELECT * FROM portal_chat_fork WHERE organisation_id = ? AND user_id = ? AND operation_id = ?",
  )
    .bind(scope.organisationId, scope.userId, operationId)
    .first();
  const destinations = await fixtureDatabase().prepare(
    `SELECT c.* FROM portal_conversation c JOIN portal_chat_fork f
      ON f.organisation_id = c.organisation_id AND f.user_id = c.user_id AND f.destination_conversation_id = c.conversation_id
      WHERE f.organisation_id = ? AND f.user_id = ? AND f.operation_id = ?`,
  )
    .bind(scope.organisationId, scope.userId, operationId)
    .all();
  const directory = await fixtureDatabase().prepare(
    "SELECT * FROM portal_chat_directory WHERE organisation_id = ? AND user_id = ?",
  )
    .bind(scope.organisationId, scope.userId)
    .all();
  const personal = await fixtureDatabase().prepare(
    "SELECT * FROM portal_conversation_user WHERE organisation_id = ? AND user_id = ? ORDER BY conversation_id",
  )
    .bind(scope.organisationId, scope.userId)
    .all();
  return {
    status: journal?.status ?? null,
    digest: journal?.digest ?? null,
    destinations: destinations.results.length,
    stateDigest: await sha256Hex(
      JSON.stringify({
        journal,
        destinations: destinations.results,
        directory: directory.results,
        personal: personal.results,
      }),
    ),
  };
}

async function freezeAfterScopeRead(
  scope: OrganisationExecutionScope,
  relocationId: ActorRelocationId,
): Promise<boolean> {
  const active = await readScopeActive.call(scope);
  expect(active).toBe(true);
  await expect(
    resumeActorRelocation({ env, relocationId, now: Date.now() }),
  ).rejects.toThrow("plan55_publication_interrupted");
  return active;
}

function budgetSettlementInput(
  scope: OrganisationExecutionScope,
  budget: WorkspaceAiBudget,
  userId: UserId,
) {
  return {
    scope,
    budget,
    userId,
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: `key_${budget.mutationReceiptId}`,
      requestHash: "plan55_budget_settlement_hash",
    },
    identity: {
      receiptId: budget.mutationReceiptId,
      auditEventId: `audit_${budget.mutationReceiptId}`,
      correlationId: "plan55_budget_settlement",
      causationId: "plan55_budget_settlement",
      portalSubjectHash: "plan55_budget_subject",
      createdAt: Date.now(),
    },
    environment: "development" as const,
    configurationVersion: 1,
    projectionRevision: 1,
  };
}

async function budgetSettlementEvidence(receiptId: string) {
  const receipt = await fixtureDatabase().prepare(
    "SELECT receipt_id, response_status FROM control_mutation_receipt WHERE receipt_id = ?",
  )
    .bind(receiptId)
    .first();
  const audit = await fixtureDatabase().prepare(
    "SELECT audit_event_id, idempotency_receipt_id FROM onboarding_audit_event WHERE idempotency_receipt_id = ?",
  )
    .bind(receiptId)
    .first();
  return { receipt, audit };
}
