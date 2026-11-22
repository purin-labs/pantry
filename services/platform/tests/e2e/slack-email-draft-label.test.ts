import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { SLACK_PERMISSION_RESUME_TEXT } from "../../src/actors/connector-slack-case-work";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import type { FlowPolicyInput } from "@purin-labs/authority/policy/information-flow/index";
import { lastCalledTool } from "./chat-permission-support";
import { commerceHeaders } from "./commerce-support";
import { raiseLabel } from "./held-exit-support";
import { network } from "./network";
import { installProductSource } from "./product-source-support";
import {
  allowAsPortal,
  givePortalHandles,
  readRequest,
  requestIdIn,
} from "./permission-request-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_ACTOR_USER_ID,
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
 * Internal work enters the shared email draft from a shared Slack thread, and
 * what only the person who acts may read asks first.
 *
 * An operator asks Pantry in a Slack channel to set the subject of the
 * organisation's shared email draft. The owner allows the draft tools and the
 * product reads in one prompt and connects the thread to the email draft. The
 * continued turn writes the operator's own subject into the draft: the
 * thread's words may reach every role through the connection.
 *
 * In the same thread the operator then asks Pantry to put a product
 * description into the email body. A product is internal, so it enters.
 *
 * Last, the turn reads something that only the operator may read. The draft
 * has every role as its audience, so the operator's own access does not let
 * that content in: the edit stops, and the draft keeps its text.
 */
it(
  "writes a shared Slack thread's words and a product into the shared email draft and stops one person's private content",
  emailDraftLabelJourney,
  240_000,
);

const PRODUCT_ID = "product_email_label_e2e";
const COMMERCE_MERCHANT_ID = "merchant_bakery_c3_email_label";
const PRODUCT_DESCRIPTION =
  "Hazelnut praline layered in a dark chocolate shell.";
const SUBJECT = "Autumn gift boxes are here";
const SECOND_TS = "1787500000.000500";
const THIRD_TS = "1787500000.000600";
const PRIVATE_WORDS = "the private words of the operator";
const SUBJECT_QUESTION = `set the email draft subject to "${SUBJECT}"`;
const BODY_QUESTION = `put the praline description (${PRODUCT_ID}) into the email draft body`;
const PRIVATE_QUESTION = "add what I told you in private to the email draft";
const STOPPED = "Purin Pantry stopped this step";
const ANSWERS = {
  asked: "I asked an owner for permission to edit the email draft.",
  edited: "I changed the email draft.",
  refused: "I could not change the email draft.",
} as const;
const ALLOWED_NOTICE =
  "An owner or admin allowed the permission. Sous Chef continues the request now.";

type Recorded = {
  readonly requests: Record<string, unknown>[];
  readonly toolOutputs: string[];
  pending: ToolCall | null;
};

async function emailDraftLabelJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await givePortalHandles(ORGANISATION_ID);
  await activateOrganisation();
  await installProductSource({
    organisationId: ORGANISATION_ID,
    ownerUserId: owner.session.userId,
    merchantId: COMMERCE_MERCHANT_ID,
    productId: PRODUCT_ID,
    description: PRODUCT_DESCRIPTION,
  });
  const recorded: Recorded = { requests: [], toolOutputs: [], pending: null };
  const slack = slackSimulator();
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    slack.handler,
  );

  // 1. The agent asks for the email draft tools and the product reads.
  await postMention("Ev_EMAIL_LABEL_SUBJECT", ROOT_TS, SUBJECT_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  expect(textsOf(slack.messages)[1]).toBe(ANSWERS.asked);
  const requestId = requestIdIn(slack.messages);

  // 2. The owner connects the thread to the email draft and allows.
  await connectEmailDraftThread(owner, ROOT_TS);
  const allowed = await allowAsPortal(ORGANISATION_ID, owner, requestId);
  expect(allowed.status, await allowed.clone().text()).toBe(200);

  // 3. The continued turn writes the thread's own subject into the draft.
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(3);
  expect(textsOf(slack.messages)[0]).toBe(ALLOWED_NOTICE);
  expect(textsOf(slack.messages).slice(2)).toEqual([ANSWERS.edited]);
  const subjectOnly = {
    kind: "active",
    revision: 2,
    draft: { subject: SUBJECT, body: "" },
  };
  expect(await readEmailDraft()).toMatchObject(subjectOnly);

  // 4. A product description that the turn read enters the draft.
  await postMention("Ev_EMAIL_LABEL_BODY", SECOND_TS, BODY_QUESTION);
  await expect.poll(slack.visibleMessageCount, { timeout: 60_000 }).toBe(4);
  expect(textsOf(slack.messages)[3]).toBe(ANSWERS.edited);
  const withBody = {
    kind: "active",
    revision: 3,
    draft: { subject: SUBJECT, body: PRODUCT_DESCRIPTION },
  };
  expect(await readEmailDraft()).toMatchObject(withBody);
  expect(threadsOf(slack.messages)).toEqual([
    ROOT_TS,
    ROOT_TS,
    ROOT_TS,
    ROOT_TS,
  ]);

  // 5. What only the operator may read stops, and the draft keeps its text.
  await postMention("Ev_EMAIL_LABEL_PRIVATE", THIRD_TS, PRIVATE_QUESTION);
  await expect
    .poll(() => recorded.toolOutputs.at(-1), { timeout: 60_000 })
    .toContain(STOPPED);
  const afterStop = await readEmailDraft();
  expect(afterStop).toMatchObject(withBody);
  expect(JSON.stringify(afterStop)).not.toContain(PRIVATE_WORDS);

  Object.assign(test.task.meta, {
    slackEmailDraftLabel: {
      modelRequests: recorded.requests.length,
      posts: slack.messages.map(threadAndText),
      permissionRequest: await readRequest(ORGANISATION_ID, owner, requestId),
      stoppedToolOutput: recorded.toolOutputs.at(-1),
      draft: afterStop,
    },
  });
}

/**
 * Answers each model request from the conversation so far. A large catalogue
 * hides a tool behind tool_search, so the model searches first when the tool
 * that it needs is not offered.
 */
async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  recorded.requests.push(body);
  const offered = offeredToolNames(body);
  const id = `email_draft_label_${String(recorded.requests.length)}`;
  const text = JSON.stringify(body.messages);
  const called = lastCalledTool(body);
  if (called === null) {
    if (
      !text.includes(SLACK_PERMISSION_RESUME_TEXT) &&
      !text.includes(BODY_QUESTION)
    ) {
      // The agent lacks the draft tools and sees that it may ask.
      expect(offered).toContain("request_permission");
      expect(offered).not.toContain("email_draft_edit");
      return openRouterToolCall(
        "request_permission",
        {
          capabilityIds: [
            "marketing.email_draft.edit",
            "commerce.entity_plane.context",
          ],
          entityTypeReads: ["product"],
        },
        `call_${id}`,
      );
    }
    if (text.includes(PRIVATE_QUESTION)) {
      await raiseLabel(await operatorOnly());
      return callOrSearch(recorded, offered, id, {
        tool: "email_draft_edit",
        args: {
          field: "body",
          oldText: PRODUCT_DESCRIPTION,
          newText: PRIVATE_WORDS,
          expectedRevision: 3,
        },
      });
    }
    if (text.includes(BODY_QUESTION))
      return callOrSearch(recorded, offered, id, {
        tool: "product_description_draft_read",
        args: { productId: PRODUCT_ID },
      });
    expect(text).toContain(SUBJECT);
    return callOrSearch(recorded, offered, id, {
      tool: "email_draft_edit",
      args: {
        field: "subject",
        oldText: "",
        newText: SUBJECT,
        expectedRevision: 0,
      },
    });
  }
  const output = requireLastToolOutput(body);
  switch (called) {
    case "request_permission":
      expect(output).toContain("permission_requested");
      return openRouterText(ANSWERS.asked, id);
    case "tool_search": {
      const pending = recorded.pending;
      if (pending === null) throw new Error("No tool waits for the search");
      recorded.pending = null;
      return openRouterToolCall(pending.tool, pending.args, `call_${id}`);
    }
    case "product_description_draft_read":
      expect(output).toContain(PRODUCT_DESCRIPTION);
      return callOrSearch(recorded, offered, id, {
        tool: "email_draft_edit",
        args: {
          field: "body",
          oldText: "",
          newText: PRODUCT_DESCRIPTION,
          expectedRevision: 2,
        },
      });
    case "email_draft_edit":
      recorded.toolOutputs.push(output);
      return openRouterText(
        toolSucceeded(output) ? ANSWERS.edited : ANSWERS.refused,
        id,
      );
    default:
      throw new Error(`Unexpected tool ${called}`);
  }
}

/** A read that only the person who asked in the thread may see. */
async function operatorOnly(): Promise<FlowPolicyInput> {
  const row = await fixtureDatabase()
    .prepare(
      `SELECT person_id AS personId FROM service_role_grant
     WHERE organisation_id = ? AND user_id = ?`,
    )
    .bind(ORGANISATION_ID, SLACK_ACTOR_USER_ID)
    .first<{ personId: string }>();
  if (row === null) throw new Error("The operator has no person");
  return {
    owner: { kind: "organisation", organisationId: ORGANISATION_ID },
    readers: [{ kind: "person", personId: row.personId }],
  };
}

type ToolCall = Readonly<{ tool: string; args: Record<string, unknown> }>;

/** Calls the tool when it is offered, or searches for it first. */
function callOrSearch(
  recorded: Recorded,
  offered: readonly string[],
  id: string,
  call: ToolCall,
): Response | Promise<Response> {
  if (offered.includes(call.tool))
    return openRouterToolCall(call.tool, call.args, `call_${id}`);
  recorded.pending = call;
  return openRouterToolCall("tool_search", { query: call.tool }, `call_${id}`);
}

/** Whether a tool output reports success. The output may be JSON in a string. */
function toolSucceeded(output: string | undefined): boolean {
  let value: unknown = output;
  while (typeof value === "string") value = JSON.parse(value);
  return isRecord(value) && value.success === true;
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
        threadTs: ROOT_TS,
        text: `<@U0PANTRY> ${question}`,
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/** An active Organisation. The Slack fixture leaves its onboarding open. */
async function activateOrganisation(): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_email_draft_label', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
}

/** The owner's Slack authoring link, as the email draft page sends it. */
async function connectEmailDraftThread(
  owner: IssuedControlSession,
  threadTs: string,
): Promise<void> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/collaboration/email-draft/shared-thread`,
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

/** The email draft as the Portal editor and the agent tools read it. */
async function readEmailDraft() {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const read = await organisation.readEmailDraft({
    organisationId: ORGANISATION_ID,
  });
  if (!read.ok) throw new Error(`Email draft unavailable: ${read.error.code}`);
  return read.value;
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
