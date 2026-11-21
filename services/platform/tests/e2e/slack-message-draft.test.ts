import { SLACK_APP_NAME } from "@purin-labs/control-api";
import { env, exports } from "cloudflare:workers";
import { organisationDatabase, fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { newConversationId, type ConversationId } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { CAPABILITY_KEYS } from "../../src/authorization/capability-catalogue";
import { storeVaultSecret } from "../../src/credential-vault";
import { createAccessGrant } from "../../src/data/access-grants";
import { createOrganisationInstall } from "../../src/data/organisation";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import {
  installMemoryFixture,
  post,
  postJson,
  storedConversation,
  workKind,
  type Member,
} from "./memory-support";
import { network } from "./network";
import {
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requiredPlacement,
  requiredVaultHandle,
  requiredWorkspaceId,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackMessageDraft?: Record<string, unknown>;
  }
}

const WORKSPACE_ID = requiredWorkspaceId("T0DRAFTS01");
const KITCHEN = "C0KITCHEN01";
const GENERAL = "C0GENERAL01";
const FINANCE = "C0FINANCE01";
const BOT_TOKEN = "xoxb-e2e-drafts";
const DRAFT_TEXT =
  "Morning team: bake 48 almond croissants on Friday. The Ginza shop sold out by 10:00.";
const EDITED_TEXT = `${DRAFT_TEXT}\nLamination starts at 05:30.`;
const GENERAL_TEXT = "The butter delivery moves to Thursday at 15:00.";

it(
  "lets the agent draft a Slack message in a Portal chat that only the chat's owner can send, once, to a connected channel",
  { timeout: 240_000 },
  slackDraftJourney,
);

/** Stands in for Slack's chat.postMessage and records each post. */
class SlackPosts {
  readonly posts: { channel: string; text: string; clientMsgId: string }[] = [];
  /** Answers that Slack gives before it accepts posts again. */
  refusals: string[] = [];

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    expect(request.headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
    const body: unknown = await request.json();
    // The agent's draft is posted as Markdown.
    const text = isRecord(body) ? (body.markdown_text ?? body.text) : undefined;
    if (
      !isRecord(body) ||
      typeof body.channel !== "string" ||
      typeof text !== "string" ||
      typeof body.client_msg_id !== "string"
    )
      throw new Error("The Slack post is invalid");
    const refusal = this.refusals.shift();
    if (refusal !== undefined)
      return HttpResponse.json({ ok: false, error: refusal });
    this.posts.push({
      channel: body.channel,
      text,
      clientMsgId: body.client_msg_id,
    });
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787600000.00010${String(this.posts.length)}`,
    });
  }
}

type Turn = Readonly<{ channel: string | null; text: string }>;

/**
 * A model that drafts the message of the current turn. It finds the tool,
 * reads the Slack account reference from integration_list, drafts once and
 * then replies with the tool's answer.
 */
class DraftingModel {
  readonly toolOutputs: string[][] = [];
  turn: Turn | null = null;

  async respond({
    request,
  }: Parameters<HttpResponseResolver>[0]): Promise<Response> {
    const turn = this.turn;
    if (turn === null) throw new Error("No turn is active");
    const body: unknown = await request.clone().json();
    if (!isRecord(body) || !Array.isArray(body.messages))
      throw new Error("model request is invalid");
    const text = JSON.stringify(body.messages);
    const current = text.slice(
      Math.max(0, text.lastIndexOf("Current user request")),
    );
    const offered = offeredToolNames(body);
    const outputs = body.messages.flatMap((message) =>
      isRecord(message) && message.role === "tool"
        ? [JSON.stringify(message.content)]
        : [],
    );
    const calls = body.messages.flatMap((message) =>
      isRecord(message) && Array.isArray(message.tool_calls)
        ? message.tool_calls.flatMap((call) =>
            isRecord(call) &&
            isRecord(call.function) &&
            typeof call.function.name === "string"
              ? [call.function.name]
              : [],
          )
        : [],
    );
    const id = `draft_${String(this.toolOutputs.length)}_${String(calls.length)}`;
    if (!current.includes(turn.text.slice(0, 20)))
      return openRouterText(
        JSON.stringify({ kind: "reply", text: "Done." }),
        id,
      );
    if (calls.includes("slack_message_propose")) {
      this.toolOutputs.push(outputs);
      return openRouterText(
        JSON.stringify({
          kind: "reply",
          text: "The draft is ready on the card. Send it when it looks right.",
        }),
        id,
      );
    }
    if (
      !offered.includes("slack_message_propose") &&
      !calls.includes("tool_search")
    )
      return openRouterToolCall(
        "tool_search",
        { query: "slack_message_propose integration_list", limit: 8 },
        id,
      );
    const accountRef = slackAccountRef(outputs);
    if (accountRef === null)
      return openRouterToolCall("integration_list", {}, id);
    return openRouterToolCall(
      "slack_message_propose",
      { accountRef, channel: turn.channel, text: turn.text },
      id,
    );
  }
}

async function slackDraftJourney({ task }: TestContext): Promise<void> {
  const { organisationId, author, reviewer, viewer, route, paths } =
    await installMemoryFixture();
  const slack = new SlackPosts();
  const model = new DraftingModel();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      model.respond.bind(model),
    ),
    http.post(
      "https://slack.com/api/chat.postMessage",
      slack.respond.bind(slack),
    ),
  );
  const integrationAccountId = await connectSlack(author);
  for (const capability of [
    CAPABILITY_KEYS.integrationDiscoveryRead,
    CAPABILITY_KEYS.slackMessagePropose,
  ])
    await setCapabilityMode(author, capability, "enabled");

  // A channel that the organisation did not connect gets no draft.
  const refused = newConversationId();
  const refusedOutputs = await draft(
    model,
    author,
    route.model,
    refused,
    paths.chat,
    {
      channel: "#finance",
      text: DRAFT_TEXT,
    },
  );
  expect(JSON.stringify(refusedOutputs)).toContain("not connected to Seams Pantry");
  expect(JSON.stringify(refusedOutputs)).not.toContain(FINANCE);
  expect(await drafts(author, paths.chat, refused)).toEqual([]);

  // The agent drafts for #kitchen. Nothing reaches Slack.
  const conversation = newConversationId();
  await draft(model, author, route.model, conversation, paths.chat, {
    channel: "kitchen",
    text: DRAFT_TEXT,
  });
  const [kitchen] = await drafts(author, paths.chat, conversation);
  expect(kitchen).toMatchObject({
    channelId: KITCHEN,
    channelName: "kitchen",
    workspaceName: "Noix de Beurre",
    body: DRAFT_TEXT,
    lifecycle: "awaiting_approval",
    version: 1,
  });
  expect(slack.posts).toEqual([]);
  const draftPath = `${paths.chat}/conversations/${conversation}/slack-messages/${String(kitchen?.proposalId)}`;

  // Only the person who can open the chat can read or send its drafts.
  const card = await postJson(author, draftPath, null);
  expect(card.status).toBe(200);
  expect(channelsOf(card.body)).toEqual([
    { channelId: GENERAL, name: "general" },
    { channelId: KITCHEN, name: "kitchen" },
  ]);
  const otherAdmin = await send(reviewer, draftPath, kitchen, KITCHEN);
  expect(otherAdmin.status).toBe(404);
  const otherAdminRead = await postJson(reviewer, draftPath, null);
  expect(otherAdminRead.status).toBe(404);
  const viewerSend = await send(viewer, draftPath, kitchen, KITCHEN);
  expect([403, 404]).toContain(viewerSend.status);
  expect(slack.posts).toEqual([]);

  // An edit makes a new version. A Send for the old text is refused.
  const edited = await mutate(author, `${draftPath}/edit`, {
    version: 1,
    text: EDITED_TEXT,
    channelId: KITCHEN,
  });
  expect(edited.status).toBe(200);
  const editedDraft = draftOf(edited.body);
  expect(editedDraft).toMatchObject({ version: 2, body: EDITED_TEXT });
  const stale = await send(author, draftPath, kitchen, KITCHEN);
  expect(stale.status).toBe(409);
  // A channel outside the connected ones is refused before any post.
  const unconnected = await send(author, draftPath, editedDraft, FINANCE);
  expect(unconnected.status).toBe(409);
  expect(slack.posts).toEqual([]);

  // Send posts the edited text once. A repeated Send answers with the same post.
  const sent = await send(author, draftPath, editedDraft, KITCHEN);
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  expect(draftOf(sent.body)).toMatchObject({
    lifecycle: "sent",
    channelId: KITCHEN,
    messageTs: "1787600000.000101",
  });
  const repeated = await send(author, draftPath, editedDraft, KITCHEN);
  expect(repeated.status).toBe(200);
  expect(slack.posts).toEqual([
    { channel: KITCHEN, text: EDITED_TEXT, clientMsgId: expect.any(String) },
  ]);
  const discardSent = await mutate(author, `${draftPath}/discard`, {
    version: 2,
  });
  expect(discardSent.status).toBe(409);

  // Slack refuses a post when the app is not in the channel. The draft says
  // so, takes a new version, and posts once after the app joins.
  await draft(model, author, route.model, conversation, paths.chat, {
    channel: GENERAL,
    text: GENERAL_TEXT,
  });
  const general = (await drafts(author, paths.chat, conversation)).find(
    (entry) => entry.body === GENERAL_TEXT,
  );
  expect(general).toMatchObject({ channelId: GENERAL, version: 1 });
  const generalPath = `${paths.chat}/conversations/${conversation}/slack-messages/${String(general?.proposalId)}`;
  slack.refusals.push("not_in_channel");
  const refusedPost = await send(author, generalPath, general, GENERAL);
  expect(refusedPost.status).toBe(200);
  const failed = draftOf(refusedPost.body);
  expect(failed).toMatchObject({
    lifecycle: "send_failed",
    version: 2,
    failureCode: "not_in_channel",
  });
  expect(String(failed.failureMessage)).toContain(`Invite the ${SLACK_APP_NAME} app`);
  const retried = await send(author, generalPath, failed, GENERAL);
  expect(draftOf(retried.body)).toMatchObject({ lifecycle: "sent" });
  expect(slack.posts.map((entry) => entry.channel)).toEqual([KITCHEN, GENERAL]);
  expect(new Set(slack.posts.map((entry) => entry.clientMsgId)).size).toBe(2);

  const stored = await storedConversation(author, conversation);
  task.meta.slackMessageDraft = {
    organisationId,
    integrationAccountId,
    refused: { toolOutputs: refusedOutputs },
    drafts: await drafts(author, paths.chat, conversation),
    denied: {
      otherAdminSend: otherAdmin.status,
      otherAdminRead: otherAdminRead.status,
      viewerSend: viewerSend.status,
      staleVersion: stale.status,
      unconnectedChannel: unconnected.status,
      discardAfterSend: discardSent.status,
    },
    slackPosts: slack.posts.map((entry) => ({
      channel: entry.channel,
      text: entry.text,
    })),
    timelineKinds: stored?.conversation.timeline.map((event) => event.kind),
  };
}

/**
 * Connects the Slack workspace "Noix de Beurre" with #kitchen and #general,
 * as the Integrations page leaves it, and grants the owner role the right to
 * list integrations and to draft Slack messages.
 */
async function connectSlack(owner: Member): Promise<string> {
  const now = Date.now();
  const scope = await requireOrganisationExecutionScope(
    env,
    owner.organisationId,
  );
  const tokenHandle = requiredVaultHandle("vault:slack:bot:e2e-drafts");
  const install = await createOrganisationInstall(organisationDatabase(owner.organisationId), env.DB, {
    organisationId: owner.organisationId,
    name: "Noix de Beurre",
    surfaceKind: "slack",
    workspaceId: WORKSPACE_ID,
    installModel: "unlisted",
    botTokenRef: tokenHandle,
    scopes: ["channels:read", "chat:write"],
    placement: requiredPlacement(),
    createdAt: now - 2_000,
    installedAt: now - 1_000,
  });
  const stored = await storeVaultSecret({
    db: fixtureDatabase(),
    keys: env,
    organisationId: owner.organisationId,
    handle: tokenHandle,
    secret: { kind: "bearer", value: BOT_TOKEN },
    now,
  });
  if (!stored.ok) throw new Error(stored.error.code);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_installation (
         installation_id, environment, app_id, workspace_id, credential_organisation_id,
         bot_token_ref, install_model, scopes_json, lifecycle, installed_at, updated_at,
         disabled_at, revoked_at
       ) VALUES ('installation_e2e_drafts', 'development', 'A12345678', ?, ?, ?,
         'unlisted', '["chat:write"]', 'active', ?, ?, NULL, NULL)`,
    ).bind(WORKSPACE_ID, owner.organisationId, tokenHandle, now, now),
    env.DB.prepare(
      `INSERT INTO slack_organisation_connection (
         connection_id, installation_id, organisation_id, integration_account_id,
         lifecycle, revision, connected_at, updated_at, disabled_at, revoked_at
       ) VALUES ('connection_e2e_drafts', 'installation_e2e_drafts', ?, ?,
         'active', 1, ?, ?, NULL, NULL)`,
    ).bind(owner.organisationId, install.integrationAccountId, now, now),
    ...[KITCHEN, GENERAL].map((channelId) =>
      env.DB.prepare(
        `INSERT INTO slack_channel_default (
           installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at
         ) VALUES ('installation_e2e_drafts', ?, 'connection_e2e_drafts', 1, ?, ?)`,
      ).bind(channelId, owner.userId, now),
    ),
  ]);
  await scope.database.batch([
    scope.database
      .prepare(
        `INSERT INTO provider_resource_snapshot (
           snapshot_revision, organisation_id, integration_account_id, provider,
           environment, query_hash, created_at
         ) VALUES ('snapshot_e2e_drafts', ?, ?, 'slack', 'development', 'channels', ?)`,
      )
      .bind(owner.organisationId, install.integrationAccountId, now),
    ...[
      [KITCHEN, "kitchen"],
      [GENERAL, "general"],
      [FINANCE, "finance"],
    ].map(([channelId, name]) =>
      scope.database
        .prepare(
          `INSERT INTO provider_discovered_resource (
             snapshot_revision, canonical_resource_id, provider_resource_id,
             provider_account_id, display_label, access_state, provider_revision,
             resource_kind
           ) VALUES ('snapshot_e2e_drafts', ?, ?, ?, ?, 'accessible', 'e2e', 'slack_channel')`,
        )
        .bind(
          `slack_channel:${String(channelId)}`,
          channelId,
          WORKSPACE_ID,
          name,
        ),
    ),
  ]);
  for (const [grantId, target] of [
    [
      "grant_e2e_drafts_discovery",
      {
        kind: "platform_capability",
        capabilityId: CAPABILITY_KEYS.integrationDiscoveryRead,
        capabilityVersion: 1,
      },
    ],
    [
      "grant_e2e_drafts_slack",
      {
        kind: "provider_resource",
        capabilityId: CAPABILITY_KEYS.slackMessagePropose,
        capabilityVersion: 1,
        integrationAccountId: install.integrationAccountId,
        resourceScope: "channel_message",
      },
    ],
  ] as const) {
    const created = await createAccessGrant({
      db: scope.database,
      organisationId: owner.organisationId,
      grantId,
      subject: { kind: "organisation_role", role: "owner" },
      target,
      provenance: {
        kind: "baseline",
        profile: "read_and_propose",
        profileVersion: 1,
        materializationReceiptId: `receipt_${grantId}`,
      },
      now: now - 500,
    });
    if (!created.ok) throw new Error(created.error.code);
  }
  return install.integrationAccountId;
}

/** Sends one chat message and waits until its turn has finished. */
async function draft(
  model: DraftingModel,
  person: Member,
  modelName: string,
  conversationId: ConversationId,
  chatPath: string,
  turn: Turn,
): Promise<readonly string[]> {
  model.turn = turn;
  const before = model.toolOutputs.length;
  const started = await post(person, chatPath, {
    kind: "message",
    conversationId,
    requestId: `request_${crypto.randomUUID()}`,
    model: modelName,
    text: `Post this to Slack: ${turn.text}`,
    browserContext: { kind: "unavailable" },
  });
  expect(started.status, await started.clone().text()).toBe(200);
  await expect
    .poll(workKind.bind(null, person, conversationId), { timeout: 60_000 })
    .toBe("ready");
  model.turn = null;
  expect(model.toolOutputs.length).toBe(before + 1);
  return model.toolOutputs.at(-1) ?? [];
}

type DraftView = Readonly<Record<string, unknown>>;

async function drafts(
  person: Member,
  chatPath: string,
  conversationId: ConversationId,
): Promise<readonly DraftView[]> {
  const read = await postJson(
    person,
    `${chatPath}?conversation=${conversationId}`,
    null,
  );
  expect(read.status).toBe(200);
  if (!isRecord(read.body) || !Array.isArray(read.body.slackDrafts))
    throw new Error("The chat read has no Slack drafts");
  return read.body.slackDrafts.filter(isRecord);
}

function send(
  person: Member,
  path: string,
  draftView: DraftView | undefined,
  channelId: string,
): Promise<Readonly<{ status: number; body: unknown }>> {
  return mutate(person, `${path}/send`, {
    version: draftView?.version,
    bodyDigest: draftView?.bodyDigest,
    channelId,
  });
}

/** A Portal mutation with the CSRF header that the card sends. */
async function mutate(
  person: Member,
  path: string,
  body: Record<string, unknown>,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    method: "POST",
    headers: commerceHeaders(person.session),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function draftOf(body: unknown): DraftView {
  if (!isRecord(body) || !isRecord(body.draft))
    throw new Error(`The answer has no draft: ${JSON.stringify(body)}`);
  return body.draft;
}

function channelsOf(body: unknown): unknown {
  return isRecord(body) ? body.channels : null;
}

/** The Slack account reference that integration_list returned. */
function slackAccountRef(outputs: readonly string[]): string | null {
  for (const output of outputs) {
    const match =
      /"accountRef\\?":\\?"(integration_ref_[0-9a-f]{64})\\?"[^}]*?\\?"provider\\?":\\?"slack/u.exec(
        output,
      );
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

async function setCapabilityMode(
  person: Member,
  capabilityId: string,
  mode: "enabled" | "disabled",
): Promise<void> {
  const base = `/v1/control/organisations/${person.organisationId}/access-control`;
  const read = await postJson(person, base, null);
  const view =
    isRecord(read.body) && isRecord(read.body.accessControl)
      ? read.body.accessControl
      : null;
  const capability = Array.isArray(view?.capabilities)
    ? view.capabilities.find(
        (candidate: unknown) =>
          isRecord(candidate) &&
          isRecord(candidate.definition) &&
          candidate.definition.capabilityId === capabilityId,
      )
    : undefined;
  if (
    view === null ||
    !isRecord(capability) ||
    !isRecord(capability.definition)
  )
    throw new Error(`The Access view has no ${capabilityId}`);
  if (capability.mode === mode) return;
  const headers = commerceHeaders(person.session);
  headers.set("idempotency-key", `slack-draft-${capabilityId}-${mode}`);
  const changed = await exports.default.fetch(
    `https://localhost${base}/capabilities/${capabilityId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: view.revision,
        capabilityRevision: capability.revision,
        capabilityVersion: capability.definition.capabilityVersion,
        mode,
      }),
    },
  );
  expect(changed.status, await changed.clone().text()).toBe(200);
}
