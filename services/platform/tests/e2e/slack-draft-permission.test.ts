import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { SLACK_PERMISSION_RESUME_TEXT } from "../../src/actors/connector-case-work";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { revokeProductRead } from "./access-route-support";
import { commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { installProductSource } from "./product-source-support";
import {
  allowAsPortal,
  decide,
  givePortalHandles,
  readRequest,
  requestIdIn,
} from "./permission-request-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  offeredToolNames,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";

/**
 * An agent asks for the product reads that a description draft edit needs.
 *
 * An operator asks Pantry in a Slack channel to change a passage of a product
 * description. The draft tools are turned off, and nobody can read product
 * records. The agent asks for the draft read and edit; Pantry adds the product
 * read to the same request. A channel turn answers the whole channel, so the
 * channel needs its own read grant; the edit writes the product into a draft
 * that the operator role reads, so the role needs one too. The owner allows
 * all four items in one prompt and connects the thread to the draft. The
 * continued turn reads the draft and replaces the passage.
 *
 * The owner then takes the channel's product read away; the role keeps its
 * read. In a second thread the agent reads the draft, and no grant admits the
 * read in the channel: Pantry asks for the channel's product read by itself,
 * and the agent says that it asked instead of reporting that data is
 * unavailable. After the allow, the request continues and reads the edited
 * draft.
 */
it(
  "asks for the product read that a Slack draft edit needs and continues after an owner allows it",
  draftPermissionJourney,
  240_000,
);

const PRODUCT_ID = "product_permission_e2e";
const COMMERCE_MERCHANT_ID = "merchant_bakery_c3_draft_permission";
// The form a person may copy from elsewhere; the draft tools take the plain id.
const PREFIXED_PRODUCT_ID = `underclerk:${COMMERCE_MERCHANT_ID}:${PRODUCT_ID}`;
const INITIAL_DESCRIPTION = "Freshly baked croissant.";
const EDITED_DESCRIPTION = "Croissant baked at dawn with cultured butter.";
const SECOND_ROOT_TS = "1787500300.000001";
// The thread is connected to the draft, so the person does not name the
// product.
const EDIT_QUESTION = `change the croissant description to "${EDITED_DESCRIPTION}"`;
const READ_QUESTION = `read me the croissant description (${PRODUCT_ID})`;
const ANSWERS = {
  askedEdit: "I asked an owner for permission to edit the description draft.",
  edited: "The croissant description draft now says it is baked at dawn.",
  askedRead: "I asked an owner for permission to read product records.",
  read: `The draft says: ${EDITED_DESCRIPTION}`,
} as const;
const ALLOWED_NOTICE =
  "An owner or admin allowed the permission. Sous Chef continues the request now.";

type Recorded = {
  readonly requests: Record<string, unknown>[];
  /** Tool searches for a hidden draft tool; they do not count as steps. */
  searches: number;
  /** What the model was told for a product id with the merchant prefix. */
  unknownProduct?: string;
  /** The product id that the read of the connected draft returned. */
  connectedProduct?: string;
};

async function draftPermissionJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  await activateOrganisation();
  await installProductSource({
    organisationId: ORGANISATION_ID,
    ownerUserId: owner.session.userId,
    merchantId: COMMERCE_MERCHANT_ID,
    productId: PRODUCT_ID,
    description: INITIAL_DESCRIPTION,
  });
  const recorded: Recorded = { requests: [], searches: 0 };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    slack.handler,
  );

  // 1. The agent asks for the draft tools; Pantry adds the product read.
  await postMention("Ev_DRAFT_PERMISSION_EDIT", ROOT_TS, EDIT_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(recorded.requests.length - recorded.searches).toBe(2);
  expect(textsOf(slack.messages)).toEqual([
    expect.stringContaining(
      "Sous Chef needs permission to read product records, read scoped commerce context and edit a product description draft",
    ),
    ANSWERS.askedEdit,
  ]);
  const editRequestId = requestIdIn(slack.messages);
  expect(
    await readRequest(ORGANISATION_ID, owner, editRequestId),
  ).toMatchObject({
    status: "pending",
    requesterRole: "operator",
    items: [
      {
        itemId: "commerce.entity.read:product:conversation",
        label: "Read product records",
        granted: false,
        grant: {
          subjectLabel: "this Slack channel",
          target: {
            kind: "commerce_entity_type",
            entityTypeId: { origin: "system", typeId: "product" },
          },
        },
      },
      {
        itemId: "commerce.entity.read:product:requester",
        granted: false,
        grant: { subjectLabel: "Operators" },
      },
      { capabilityId: "commerce.entity_plane.context", granted: false },
      {
        capabilityId: "commerce.product_description_draft.edit",
        granted: false,
      },
    ],
  });

  // 2. An allow before Access changes names every missing item.
  const early = await decide(ORGANISATION_ID, owner, editRequestId, "allow");
  expect(early.status).toBe(409);
  expect(await early.json()).toEqual({
    ok: false,
    error: "permission_missing",
    capabilityIds: [
      "commerce.entity_plane.context",
      "commerce.product_description_draft.edit",
    ],
    entityTypeReads: ["product"],
  });

  // 3. The owner connects the thread and allows as the Portal prompt does.
  await connectThread(owner, ROOT_TS);
  const allowed = await allowAsPortal(ORGANISATION_ID, owner, editRequestId);
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect(
    await readRequest(ORGANISATION_ID, owner, editRequestId),
  ).toMatchObject({
    status: "allowed",
    items: [
      { granted: true },
      { granted: true },
      { granted: true },
      { granted: true },
    ],
  });

  // 4. The continued turn names a product id the shop does not know and is
  //    told how to correct it. It reads the connected draft without an id,
  //    and replaces the passage in the product that the read names.
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  expect(recorded.requests.length - recorded.searches).toBe(6);
  expect(recorded.unknownProduct).toContain(
    `No product has the id ${PREFIXED_PRODUCT_ID}.`,
  );
  expect(recorded.connectedProduct).toBe(PRODUCT_ID);
  expect(textsOf(slack.messages)[0]).toBe(ALLOWED_NOTICE);
  expect(textsOf(slack.messages).slice(2)).toEqual([ANSWERS.edited]);
  const edited = await readDraft();
  expect(edited).toMatchObject({
    ok: true,
    value: { draft: { kind: "active", description: EDITED_DESCRIPTION } },
  });

  // 5. Without the channel's product read, a draft read asks for it.
  await revokeProductRead(ORGANISATION_ID, owner, "conversation");
  await postMention("Ev_DRAFT_PERMISSION_READ", SECOND_ROOT_TS, READ_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(5);
  expect(recorded.requests.length - recorded.searches).toBe(8);
  expect(textsOf(slack.messages).slice(3)).toEqual([
    expect.stringMatching(
      /^Sous Chef needs permission to read product records to finish this request\./u,
    ),
    ANSWERS.askedRead,
  ]);
  const readRequestId = requestIdIn(slack.messages.slice(3));
  expect(readRequestId).not.toBe(editRequestId);
  expect(
    await readRequest(ORGANISATION_ID, owner, readRequestId),
  ).toMatchObject({
    status: "pending",
    items: [
      {
        itemId: "commerce.entity.read:product:conversation",
        granted: false,
      },
      { itemId: "commerce.entity.read:product:requester", granted: true },
    ],
  });

  // 6. After the allow, the request continues and reads the edited draft.
  const readAllowed = await allowAsPortal(
    ORGANISATION_ID,
    owner,
    readRequestId,
  );
  expect(readAllowed.status).toBe(200);
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(6);
  expect(recorded.requests.length - recorded.searches).toBe(10);
  expect(textsOf(slack.messages)[3]).toBe(ALLOWED_NOTICE);
  expect(textsOf(slack.messages).slice(5)).toEqual([ANSWERS.read]);
  expect(threadsOf(slack.messages)).toEqual([
    ROOT_TS,
    ROOT_TS,
    ROOT_TS,
    SECOND_ROOT_TS,
    SECOND_ROOT_TS,
    SECOND_ROOT_TS,
]);

  Object.assign(test.task.meta, {
    slackDraftPermission: {
      modelRequests: recorded.requests.length,
      unknownProduct: recorded.unknownProduct,
      connectedProduct: recorded.connectedProduct,
      posts: slack.messages.map(threadAndText),
      editRequest: await readRequest(ORGANISATION_ID, owner, editRequestId),
      readRequest: await readRequest(ORGANISATION_ID, owner, readRequestId),
      draft: edited,
    },
  });
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  // A large catalogue hides the draft tools behind tool_search; the model
  // searches before it reads, as a real model does.
  const step = recorded.requests.length - recorded.searches;
  if (
    (step === 3 || step === 7 || step === 9) &&
    !offered.includes("product_description_draft_read") &&
    lastToolName(body) !== "tool_search"
  ) {
    recorded.searches += 1;
    return openRouterToolCall(
      "tool_search",
      {
        query: "product_description_draft_read product_description_draft_edit",
      },
      `call_draft_search_${String(recorded.searches)}`,
    );
  }
  switch (step) {
    case 1:
      expect(offered).toContain("request_permission");
      expect(offered).not.toContain("product_description_draft_edit");
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: [
            "commerce.entity_plane.context",
            "commerce.product_description_draft.edit",
          ],
          entityTypeReads: [],
        },
        "call_permission_draft",
      );
    case 2:
      expect(requireLastToolOutput(body)).toContain("permission_requested");
      return openRouterText(ANSWERS.askedEdit, "draft_permission_asked");
    case 3: {
      // The continued turn has the draft tools and the person's question.
      const text = JSON.stringify(body.messages);
      expect(text).toContain(SLACK_PERMISSION_RESUME_TEXT);
      expect(text).toContain(EDITED_DESCRIPTION);
      return openRouterToolCall(
        "product_description_draft_read",
        { productId: PREFIXED_PRODUCT_ID },
        "call_draft_read_prefixed",
      );
    }
    case 4:
      recorded.unknownProduct = requireLastToolOutput(body);
      return openRouterToolCall(
        "product_description_draft_read",
        { productId: null },
        "call_draft_read",
      );
    case 5: {
      const output = requireLastToolOutput(body);
      expect(output).toContain(INITIAL_DESCRIPTION);
      recorded.connectedProduct = /productId\\?":\\?"([A-Za-z0-9_:-]+)/u.exec(
        output,
      )?.[1];
      return openRouterToolCall(
        "product_description_draft_edit",
        {
          productId: recorded.connectedProduct,
          oldText: INITIAL_DESCRIPTION,
          newText: EDITED_DESCRIPTION,
        },
        "call_draft_edit",
      );
    }
    case 6:
      expect(requireLastToolOutput(body)).toContain(EDITED_DESCRIPTION);
      return openRouterText(ANSWERS.edited, "draft_permission_edited");
    case 7:
      return openRouterToolCall(
        "product_description_draft_read",
        { productId: PRODUCT_ID },
        "call_denied_read",
      );
    case 8: {
      // The denied read asked for the grant; it does not report missing data.
      const output = requireLastToolOutput(body);
      expect(output).toContain("Seams Pantry posted a card");
      expect(output).not.toContain("Commerce read denied");
      return openRouterText(ANSWERS.askedRead, "read_permission_asked");
    }
    case 9: {
      const text = JSON.stringify(body.messages);
      expect(text).toContain(SLACK_PERMISSION_RESUME_TEXT);
      expect(text).toContain(READ_QUESTION);
      return openRouterToolCall(
        "product_description_draft_read",
        { productId: PRODUCT_ID },
        "call_allowed_read",
      );
    }
    case 10:
      expect(requireLastToolOutput(body)).toContain(EDITED_DESCRIPTION);
      return openRouterText(ANSWERS.read, "read_permission_answered");
    default:
      throw new Error("Unexpected model request");
  }
}

async function postMention(
  eventId: string,
  ts: string,
  question: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs: ts,
        threadTs: ts,
        text: `<@U0SATYR> ${question}`,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/** An active Organisation. The Slack fixture leaves its onboarding open. */
async function activateOrganisation(): Promise<void> {
  await fixtureDatabase().prepare(
    "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_draft_permission', activated_at = ? WHERE organisation_id = ?",
  )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
}

/** The owner's Slack authoring link, as the product page sends it. */
async function connectThread(
  owner: IssuedControlSession,
  threadTs: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/products/${PRODUCT_ID}/description-draft/shared-thread`,
    {
      method: "PUT",
      headers: commerceHeaders(owner),
      body: JSON.stringify({
        threadUrl: `https://e2e.slack.com/archives/${CHANNEL_ID}/p${threadTs.replace(".", "")}`,
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

/** The draft as the agent tools and the Portal editor read it. */
async function readDraft() {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  return organisation.readProductDescriptionDraft({
    organisationId: ORGANISATION_ID,
    request: { productId: PRODUCT_ID },
  });
}

function textsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map(textOf);
}

function textOf(message: Record<string, string>): string {
  return message.text ?? "";
}

function threadsOf(messages: readonly Record<string, string>[]): string[] {
  return messages.map(threadOf);
}

function threadOf(message: Record<string, string>): string {
  return message.thread_ts ?? "";
}

function threadAndText(post: Record<string, string>) {
  return { thread: post.thread_ts, text: post.text };
}

/** The tool of the latest call, when the latest message is its output. */
function lastToolName(body: Record<string, unknown>): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last: unknown = messages.at(-1);
  if (!isRecord(last) || last.role !== "tool") return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      Array.isArray(message.tool_calls)
    ) {
      const call: unknown = message.tool_calls.at(-1);
      return isRecord(call) &&
        isRecord(call.function) &&
        typeof call.function.name === "string"
        ? call.function.name
        : null;
    }
  }
  return null;
}
