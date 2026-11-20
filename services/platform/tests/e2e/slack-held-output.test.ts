import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";

import { requireActiveOrganisationActor } from "../../src/actors/actor-router";
import { OrganisationExecutionScope } from "../../src/organisation-execution-scope";
import type { FlowPolicyInput } from "../../src/policy/information-flow";
import { compilePublishAndActivateOrganisationPolicy } from "../../src/policy-snapshot";
import { reconcileHeldOutputRequests } from "../../src/slack/held-output-release";
import {
  admin,
  decide,
  heldStatus,
  joiner,
  pendingOf,
  raiseLabel,
  readHeld,
  registeredActors,
} from "./held-exit-support";
import { network } from "./network";
import { givePortalHandles } from "./permission-request-support";
import {
  ANSWER,
  ANSWER_PARTS,
  slackStreamSimulator,
  slowModel,
} from "./slack-streamed-answer-support";
import {
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  ORGANISATION_ID,
  ROOT_TS,
  signedSlackRequest,
  slackEnvelope,
} from "./slack-journey-support";
import { pendingDecisionsOf } from "./access-route-support";

declare module "vitest" {
  interface TaskMeta {
    slackHeldOutput?: Record<string, unknown>;
  }
}

/**
 * An answer that the exit check stops waits for a person (Plan 27C, step 3).
 *
 * The agent answers in a public channel, and its turn reads a member's direct
 * message while the answer streams. The rest of the answer stops, and the
 * thread gets a notice with no word of the answer. Only that member sees the
 * request: another admin neither reads nor decides it. Allow posts the full
 * answer once. In a second thread the turn reads the same content before its
 * first word, so the thread shows no text at all. Deny drops the answer, and
 * the thread and the agent's next turn learn that. That next turn starts with
 * the private content, and its answer waits too. Nobody decides it, so it
 * expires and drops. In a third thread the channel is shared with another
 * company and the turn reads internal content. An owner or admin decides, and
 * the answer goes out.
 *
 * The journey adds the turn's read to the Session, as a tool read does. A
 * channel's grants name the channel, so no real tool gives it this content
 * today.
 */
it("holds a blocked answer and asks a person", slackHeldOutput, 240_000);

const OWNER = {
  kind: "organisation",
  organisationId: ORGANISATION_ID,
} as const;
const SECOND_ROOT_TS = "1787500200.000001";
const THIRD_ROOT_TS = "1787500300.000001";
const FOURTH_ROOT_TS = "1787500400.000001";
const SECOND_ANSWER =
  "Your direct message says that the supplier raised flour.";
const THIRD_ANSWER =
  "The private note still says that the supplier raised flour.";
const FOURTH_ANSWER = "Order 1042 ships on Friday with the gift boxes.";
const FIFTH_ANSWER = "Order 1043 ships on Monday with the tins.";

async function slackHeldOutput({ task }: TestContext): Promise<void> {
  const joining = [await joiner(), await joiner()] as const;
  await installSlackActorFixture({
    privateMember: joining[0].slot,
    extraMembers: [joining[1].slot],
  });
  const member = await admin(joining[0], "Direct message owner");
  const other = await admin(joining[1], "Other admin");
  await givePortalHandles(ORGANISATION_ID);
  await discoverSlackChannel("public_channel", Date.now() - 60_000);
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_held_output', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);

  const direct: FlowPolicyInput = {
    owner: OWNER,
    readers: [{ kind: "person", personId: member.personId }],
  };
  const orders: FlowPolicyInput = {
    owner: OWNER,
    readers: [{ kind: "organisation_role", role: "operator" }],
  };

  const shared = { value: false };
  const slack = slackStreamSimulator();
  const stream = slowModel(ANSWER_PARTS);
  network.use(
    stream.handler,
    slack.handler,
    http.get("https://slack.com/api/conversations.info", () =>
      HttpResponse.json({
        ok: true,
        channel: { is_private: false, is_ext_shared: shared.value },
      }),
    ),
  );
  const posts = (): string[] =>
    slack.calls
      .filter((call) => call.method === "chat.postMessage")
      .map((call) => String(call.body.markdown_text ?? call.body.text ?? ""));
  const cardOf = (index: number): string =>
    JSON.stringify(
      slack.calls.filter((call) => call.method === "chat.postMessage").at(index)
        ?.body.blocks ?? null,
    );
  const updates = (): Readonly<{ text: string; blocks: string }>[] =>
    slack.calls
      .filter((call) => call.method === "chat.update")
      .map((call) => ({
        text: String(call.body.text),
        blocks: JSON.stringify(call.body.blocks),
      }));

  // 1. The turn reads the direct message while the answer streams.
  await mention("EvHELD_STREAM", ROOT_TS);
  await expect
    .poll(() => slack.methods().includes("chat.startStream"), {
      timeout: 30_000,
    })
    .toBe(true);
  await raiseLabel(direct);
  await expect
    .poll(() => posts().length, { timeout: 40_000 })
    .toBeGreaterThanOrEqual(1);
  const shownBefore = slack.streamedText();
  expect(shownBefore.length).toBeLessThan(ANSWER.length);
  expect(posts()).toHaveLength(1);
  const firstNotice = posts()[0] ?? "";
  expect(firstNotice).toContain("private content");
  expect(firstNotice).not.toContain(ANSWER_PARTS.at(-1) ?? "missing");
  expect(firstNotice).not.toContain("https:");
  expect(cardOf(0)).toContain("Review in Portal");
  const firstRequest = heldRequestId(cardOf(0));
  // The answer waits as held, so no resume path sends it (Refactor 15).
  expect(await outputKinds()).toEqual({ held: 1 });

  // 2. Only the person in the audience sees the request.
  expect((await pendingOf(member)).map((held) => held.requestId)).toEqual([
    firstRequest,
  ]);
  expect(await pendingOf(other)).toEqual([]);
  // The one read over every store hides it from that person too.
  expect(await pendingDecisionsOf(ORGANISATION_ID, other.session)).toEqual([]);
  expect((await readHeld(other, firstRequest)).status).toBe(404);
  expect((await decide(other, firstRequest, "allow")).status).toBe(404);
  expect(posts()).toHaveLength(1);
  const view = await readHeld(member, firstRequest);
  expect(view.status).toBe(200);
  const viewBody = await view.json();
  expect(viewBody).toMatchObject({
    status: "pending",
    reason: "private_source",
    source: "direct_message",
    answer: ANSWER,
  });

  // 3. Allow posts the full answer once.
  const allowed = await decide(member, firstRequest, "allow");
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({
    status: "allowed",
    released: true,
  });
  expect(posts()).toEqual([firstNotice, ANSWER]);
  expect(updates().at(-1)?.text).toContain("approved the answer");
  expect(updates().at(-1)?.blocks).not.toContain("Review in Portal");
  expect((await decide(member, firstRequest, "allow")).status).toBe(200);
  expect(posts()).toHaveLength(2);
  expect((await decide(member, firstRequest, "deny")).status).toBe(409);
  expect(await outputKinds()).toEqual({ settled: 1 });
  expect(await pendingOf(member)).toEqual([]);

  // 4. The turn reads the same content before its first word.
  const bodies: unknown[] = [];
  const quick = (text: string, policy: FlowPolicyInput | null) =>
    network.use(
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        async ({ request }) => {
          bodies.push(await request.json());
          if (policy !== null) await raiseLabel(policy);
          return openRouterText(text, `chatcmpl_${crypto.randomUUID()}`);
        },
      ),
    );
  quick(SECOND_ANSWER, direct);
  const streamedChars = slack.streamedText().length;
  await mention("EvHELD_QUICK", SECOND_ROOT_TS);
  await expect.poll(() => posts().length, { timeout: 40_000 }).toBe(3);
  expect(slack.streamedText().length).toBe(streamedChars);
  const secondRequest = heldRequestId(cardOf(2));
  expect(posts().join("\n")).not.toContain(SECOND_ANSWER);

  // 5. Deny drops the answer, and the thread learns it.
  const denied = await decide(member, secondRequest, "deny");
  expect(denied.status).toBe(200);
  expect(posts()).toHaveLength(3);
  expect(updates().at(-1)?.text).toContain("did not send");
  expect(updates().at(-1)?.blocks).not.toContain("Review in Portal");
  expect(posts().join("\n")).not.toContain(SECOND_ANSWER);
  expect((await decide(member, secondRequest, "allow")).status).toBe(409);
  expect(await outputKinds()).toEqual({ settled: 1, dropped: 1 });

  // 6. The next turn knows, starts with the private content, and waits too.
  const postsAfterDeny = posts().length;
  quick(THIRD_ANSWER, null);
  await mention("EvHELD_NEXT", "1787500200.000009", SECOND_ROOT_TS);
  await expect
    .poll(() => posts().length, { timeout: 40_000 })
    .toBe(postsAfterDeny + 1);
  expect(JSON.stringify(bodies.at(-1))).toContain(
    "Sous Chef did not send the previous answer",
  );
  expect(slack.streamedText().length).toBe(streamedChars);
  const thirdRequest = heldRequestId(cardOf(-1));
  expect(posts().join("\n")).not.toContain(THIRD_ANSWER);

  // 7. Nobody decides, so the request expires and the answer drops.
  const scope = await OrganisationExecutionScope.resolve(env, ORGANISATION_ID);
  if (!scope.ok) throw new Error(scope.error.code);
  await reconcileHeldOutputRequests({
    env,
    scope: scope.value,
    now: Date.now(),
  });
  expect(await heldStatus(thirdRequest)).toBe("pending");
  await reconcileHeldOutputRequests({
    env,
    scope: scope.value,
    now: Date.now() + 8 * 24 * 60 * 60_000,
  });
  expect(await heldStatus(thirdRequest)).toBe("expired");
  expect(updates().at(-1)?.text).toContain("seven days");
  expect(await outputKinds()).toEqual({ settled: 1, dropped: 2 });

  // 8. Internal content waits at a channel that reaches another company.
  shared.value = true;
  await fixtureDatabase()
    .prepare(
      "UPDATE slack_conversation_fact SET read_at = 0 WHERE organisation_id = ?",
    )
    .bind(ORGANISATION_ID)
    .run();
  const postsBeforeShared = posts().length;
  quick(FOURTH_ANSWER, orders);
  await mention("EvHELD_SHARED", THIRD_ROOT_TS);
  await expect
    .poll(() => posts().length, { timeout: 40_000 })
    .toBe(postsBeforeShared + 1);
  const outsideNotice = posts().at(-1) ?? "";
  expect(outsideNotice).toContain("outside the Organisation");
  const fourthRequest = heldRequestId(cardOf(-1));
  expect((await pendingOf(other)).map((held) => held.reason)).toEqual([
    "outside_organisation",
  ]);
  expect((await decide(other, fourthRequest, "allow")).status).toBe(200);
  expect(posts().at(-1)).toBe(FOURTH_ANSWER);
  expect(await outputKinds()).toEqual({ settled: 2, dropped: 2 });

  // 9. Slack refuses an allowed answer for good. The answer ends as
  //    rejected, the decision is done, and the reconciliation does not post
  //    it again (Refactor 15).
  const postsBeforeRefusal = posts().length;
  quick(FIFTH_ANSWER, orders);
  await mention("EvHELD_REFUSED", FOURTH_ROOT_TS);
  await expect
    .poll(() => posts().length, { timeout: 40_000 })
    .toBe(postsBeforeRefusal + 1);
  const fifthRequest = heldRequestId(cardOf(-1));
  expect(await outputKinds()).toEqual({ settled: 2, dropped: 2, held: 1 });
  let refusedPosts = 0;
  network.use(
    http.post("https://slack.com/api/chat.postMessage", () => {
      refusedPosts += 1;
      return HttpResponse.json({ ok: false, error: "channel_not_found" });
    }),
  );
  const refused = await decide(other, fifthRequest, "allow");
  expect(refused.status).toBe(200);
  expect(await refused.json()).toMatchObject({
    status: "allowed",
    released: true,
  });
  expect(refusedPosts).toBe(1);
  expect(await outputKinds()).toEqual({ settled: 2, dropped: 2, rejected: 1 });
  await reconcileHeldOutputRequests({
    env,
    scope: scope.value,
    now: Date.now(),
  });
  expect(refusedPosts).toBe(1);
  expect(posts().join("\n")).not.toContain(FIFTH_ANSWER);

  task.meta.slackHeldOutput = {
    posts: posts(),
    cardUpdates: updates().map((update) => update.text),
    outputs: await outputKinds(),
    statuses: await Promise.all(
      [
        firstRequest,
        secondRequest,
        thirdRequest,
        fourthRequest,
        fifthRequest,
      ].map(heldStatus),
    ),
  };
}

async function mention(
  eventId: string,
  messageTs: string,
  threadTs: string = messageTs,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId,
        messageTs,
        threadTs,
        text: "<@U0PANTRY> how does the morning bake run?",
      }),
    ),
  );
  expect(response.status).toBe(200);
}

function heldRequestId(card: string): string {
  const match = /heldOutput=([0-9a-f]{32})/u.exec(card);
  if (match?.[1] === undefined) throw new Error("Held output link missing");
  return match[1];
}

/** How many outputs of every Case are in each state, with no pending left. */
async function outputKinds(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of await registeredActors("case")) {
    const snapshot = await env.CASE.getByName(name).inspect();
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    for (const output of snapshot.value.outputs)
      counts[output.kind] = (counts[output.kind] ?? 0) + 1;
  }
  return counts;
}
