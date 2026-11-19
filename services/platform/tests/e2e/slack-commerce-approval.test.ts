import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  requireActiveOrganisationActor,
  resolveActiveCaseActor,
} from "../../src/actors/actor-router";
import {
  digestApprovalAction,
  type MerchantActionRejectionEvidence,
} from "../../src/approval-authentication";
import { googleConfig } from "../../src/control/google-oidc-config";
import { mutationHeaders } from "./access-route-support";
import { completeCommerceApprovalFixture } from "./commerce-approval-fixture";
import { network } from "./network";
import {
  MERCHANT,
  OFFER,
  OWNER,
  PRODUCT,
  SALES_CHANNEL,
  VARIANT,
  ListingProvider,
  effectEvidence,
  installEffectAuthority,
  listingNonce,
  postControl,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import { signedButtonClick } from "./slack-side-case-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  WORKSPACE_ID,
  cardButtons,
  installSlackActorFixture,
  isApprovalCard,
  receiptsOfMessage,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackCommerceApproval?: Record<string, unknown>;
  }
}

/**
 * An owner decides an agent's commerce change from its one Slack card (Plan 56).
 *
 * A Slack agent proposes to publish a catalog listing. The thread's approval
 * card carries Approve and Decline. The member who proposed it is then made
 * an operator and clicks: only that member is told no, and nothing changes.
 * The member is made an owner again and clicks. The provider commits the listing but
 * its answer is lost, so the card says that the change is not confirmed yet.
 * A last click reconciles the change: the card says it was made, the
 * provider wrote it once, and the ledger records a Slack approval. The thread
 * never gets a second message about the change.
 */
it(
  "approves a commerce change from its Slack card for an owner, refuses an operator, and reconciles a lost provider answer with one write",
  { timeout: 120_000 },
  slackCommerceApprovalJourney,
);

/** A Decline from Slack stops the change, and a late Approve cannot revive it. */
it(
  "declines a commerce change from its Slack card and keeps that decision after a late Approve",
  { timeout: 120_000 },
  slackCommerceDeclineJourney,
);

/** An agent with nothing to add leaves the one card alone in the thread. */
it(
  "keeps the thread to the one card when the agent has nothing to add to it",
  { timeout: 120_000 },
  cardOnlyReplyJourney,
);

/** The card follows a decision in the Portal, with no click in Slack. */
it(
  "updates the Slack card when an owner declines the change in the Portal",
  { timeout: 120_000 },
  portalDecisionJourney,
);

/**
 * An approved change can fail after the approval. The listing moves after the
 * proposal, so the provider refuses the approved publication. The one card
 * then says so, with no second message and no provider ids.
 */
it(
  "shows the failed state on the one Slack card when a change approved in the Portal fails, and settles the card once",
  { timeout: 120_000 },
  portalApprovalFailureJourney,
);

it(
  "shows the failed state on the one Slack card when a change approved from the card fails",
  { timeout: 120_000 },
  slackApprovalFailureJourney,
);

/**
 * Slack is down when the failure is reported. The action stays failed, and a
 * later call on it updates the one card when Slack is back.
 */
it(
  "keeps a failed outcome pending while Slack is down and updates the one card on a later call",
  { timeout: 120_000 },
  failureDuringSlackOutageJourney,
);

/**
 * A decision reaches the ledger, but the Case update is lost: the process
 * ends between the two writes (Refactor 15, refactor 1). The Case reads the
 * ledger when the next message comes, so that message gets an answer, and a
 * late click on the card leaves the decision as it is.
 */
it(
  "answers the next thread message after a decline whose Case update was lost",
  { timeout: 120_000 },
  lostCaseUpdateJourney,
);

type Answer = Readonly<{
  ephemeral: boolean;
  replaceOriginal: boolean;
  text: string;
  buttons: readonly string[];
}>;

/** Slack, the model and the click answers of one thread with one proposal. */
async function proposeInSlack(eventId: string, reply?: string) {
  const fixture = await installSlackActorFixture();
  const slack = slackSimulator();
  const provider = new ListingProvider(reply);
  const answers: Answer[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      provider.respond.bind(provider),
    ),
    http.post(
      "https://hooks.slack.com/actions/:team/:id/:token",
      async function recordAnswer({ request }) {
        const body: unknown = await request.json();
        if (!isRecord(body)) throw new Error("Invalid click answer");
        answers.push({
          ephemeral: body.response_type === "ephemeral",
          replaceOriginal: body.replace_original === true,
          text: String(body.text),
          buttons: cardButtons({
            blocks: JSON.stringify(body.blocks ?? []),
          }),
        });
        return HttpResponse.text("ok");
      },
    ),
  );
  const owner = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );
  await sendListingMessage(
    "app_mention",
    eventId,
    ROOT_TS,
    "<@U0PANTRY> Read the prepared cookie catalog and propose publishing its listing for approval.",
  );
  await expect
    .poll(slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(reply === undefined ? 2 : 1);
  const notice = slack.messages.find(isApprovalCard);
  if (notice === undefined) throw new Error("Approval card missing");
  return {
    connectorId: fixture.connectorId,
    integrationAccountId: fixture.selectedIntegrationAccountId,
    owner,
    slack,
    answers,
    notice,
    noticeTs: notice.ts ?? "",
    nonce: listingNonce(provider.requests),
  };
}

async function slackCommerceApprovalJourney({
  task,
}: TestContext): Promise<void> {
  const { slack, answers, notice, noticeTs, nonce } =
    await proposeInSlack("EvSlackApproval");
  const blocks: unknown = JSON.parse(notice.blocks ?? "[]");
  // The Session read the product, so the card may name it.
  expect(notice.text).toMatch(/^\*Publish listing: [^*]+\*\n\n/u);
  expect(cardButtons(notice)).toEqual(
    expect.arrayContaining([
      "commerce_action_approve",
      "commerce_action_decline",
    ]),
  );

  // 1. The linked member is now an operator. Their click is refused, to
  //    that member only.
  await setRole("operator");
  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 15_000 }).toBe(1);
  expect(answers[0]).toMatchObject({ ephemeral: true });
  expect(answers[0]?.text).toContain("Only an owner or admin");
  expect(await actionState(nonce)).toBe("proposed");
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });

  // 2. As an owner, the click approves and runs the change. The provider
  //    commits it, but its answer is lost. The card offers a second look.
  await setRole("owner");
  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(2);
  expect(answers[1]).toMatchObject({ replaceOriginal: true });
  expect(answers[1]?.text).toContain("has not confirmed");
  expect(answers[1]?.buttons).toContain("commerce_action_approve");
  expect(answers[1]?.buttons).not.toContain("commerce_action_decline");
  expect(await actionState(nonce)).toBe("indeterminate");
  expect(await effectEvidence()).toMatchObject({ mutations: 1 });

  // 3. A last click reconciles it: one write, a Slack approval on record, and
  //    one card that says so, with no internal ids and no new message.
  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(3);
  expect(answers[2]).toMatchObject({ replaceOriginal: true });
  expect(answers[2]?.text).toContain(`Approved by <@${USER_ID}>`);
  expect(answers[2]?.text).toContain("Seams Pantry made the change.");
  expect(answers[2]?.buttons).not.toContain("commerce_action_approve");
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toBe(answers[2]?.text);
  expect(slack.messages[0]?.text).not.toMatch(/receipt_|underclerk:/u);
  expect(slack.visibleMessageCount()).toBe(2);
  const final = await readAction(nonce);
  expect(final).toMatchObject({
    state: "confirmed",
    approval: {
      principal: { userId: OWNER, role: "owner" },
      authentication: {
        kind: "slack_verified_link",
        slackUserId: USER_ID,
        challenge: { actionNonce: nonce },
      },
    },
  });
  expect(await effectEvidence()).toMatchObject({ mutations: 1 });

  task.meta.slackCommerceApproval = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (signed interaction payloads and response URLs)",
      "commerce provider (Underclerk test merchant that loses one answer)",
    ],
    nonce,
    noticeBlocks: blocks,
    answers,
    thread: slack.messages,
    finalAction: final,
    provider: await effectEvidence(),
  };
}

async function slackCommerceDeclineJourney(): Promise<void> {
  const { slack, answers, noticeTs, nonce } =
    await proposeInSlack("EvSlackDecline");

  // 1. An operator cannot decline.
  await setRole("operator");
  await click(nonce, noticeTs, "commerce_action_decline");
  await expect.poll(() => answers.length, { timeout: 15_000 }).toBe(1);
  expect(answers[0]).toMatchObject({ ephemeral: true });
  expect(await actionState(nonce)).toBe("proposed");

  // 2. An owner declines. The one card says so, and it loses its decisions.
  await setRole("owner");
  await click(nonce, noticeTs, "commerce_action_decline");
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(2);
  expect(answers[1]?.text).toContain(`Declined by <@${USER_ID}>`);
  expect(answers[1]?.text).toContain("Nothing changed.");
  expect(answers[1]?.buttons).not.toContain("commerce_action_approve");
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toBe(answers[1]?.text);
  expect(slack.visibleMessageCount()).toBe(2);
  expect(await actionState(nonce)).toBe("rejected");

  // 3. A late Approve from a stale client changes nothing.
  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(3);
  expect(answers[2]?.text).toContain("Declined by");
  expect(await actionState(nonce)).toBe("rejected");
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });
}

async function cardOnlyReplyJourney(): Promise<void> {
  const { connectorId, slack, answers, noticeTs, nonce } = await proposeInSlack(
    "EvSlackCardOnly",
    "See the card above.",
  );
  // The answer settles on the card's message, so its turn has ended.
  await expect
    .poll(receiptsOfMessage.bind(null, connectorId, noticeTs), {
      timeout: 30_000,
    })
    .toBe(2);
  expect(slack.visibleMessageCount()).toBe(1);

  await click(nonce, noticeTs, "commerce_action_decline");
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toBe(answers[0]?.text);
  expect(answers[0]?.text).toContain("Nothing changed.");
  expect(slack.visibleMessageCount()).toBe(1);
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });
}

async function portalDecisionJourney(): Promise<void> {
  const { owner, slack, answers, nonce } =
    await proposeInSlack("EvPortalDecline");
  const declined = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/commerce/actions/${nonce}/rejection`,
    {
      method: "POST",
      headers: mutationHeaders(owner),
      body: JSON.stringify({ reason: "merchant_declined" }),
    },
  );
  expect(declined.status, await declined.clone().text()).toBe(200);
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toContain("Declined in the Portal");
  expect(cardButtons(slack.messages[0])).not.toContain(
    "commerce_action_approve",
  );
  expect(slack.visibleMessageCount()).toBe(2);
  expect(answers).toEqual([]);
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });
}

async function portalApprovalFailureJourney({
  task,
}: TestContext): Promise<void> {
  const { owner, slack, notice, answers, nonce } =
    await proposeInSlack("EvPortalFailure");
  const noticeTs = notice.ts;
  await publishListingOutsideTheAction();

  // The owner approves in the Portal, and the provider refuses the change.
  const grant = await approvalGrant(nonce);
  const approved = await postControl(
    owner,
    `/${nonce}/approval`,
    {},
    "failed-card-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    owner,
    `/${nonce}/execute`,
    {},
    "failed-card-execute",
  );
  expect(executed.status, await executed.clone().text()).toBe(502);
  expect(await executed.json()).toMatchObject({
    error: "commerce_action_provider_execution_failed",
  });
  expect(await actionState(nonce)).toBe("failed");
  const refused = await effectEvidence();

  // The card follows with the failed text, in the one message of the change.
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toContain("but the change failed. Nothing changed.");
  const card = slack.messages[0];
  expect(card?.ts).toBe(noticeTs);
  expect(card?.text).toMatch(/^\*Publish listing: [^*]+\*\n\n/u);
  expect(card?.text).toContain("Approved in the Portal");
  expect(card?.text).toContain("See Operations in the Portal.");
  expect(card?.text).not.toContain("Nothing changes until");
  expect(card?.text).not.toMatch(/receipt_|underclerk:|merchant_|offer_/u);
  expect(cardButtons(card)).not.toContain("commerce_action_approve");
  expect(cardButtons(card)).not.toContain("commerce_action_decline");
  expect(slack.visibleMessageCount()).toBe(2);
  expect(answers).toEqual([]);

  // Another call finds the outcome settled: the same card, and no new write.
  const cardText = card?.text;
  const again = await postControl(
    owner,
    `/${nonce}/execute`,
    {},
    "failed-card-execute-again",
  );
  expect(again.status, await again.clone().text()).toBe(200);
  expect(await again.json()).toMatchObject({
    action: { state: "failed" },
    follow_up: { kind: "complete" },
  });
  expect(slack.messages[0]?.text).toBe(cardText);
  expect(slack.visibleMessageCount()).toBe(2);
  expect(await effectEvidence()).toEqual(refused);

  task.meta.slackCommerceApproval = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (simulator of its Web API)",
    ],
    nonce,
    thread: slack.messages,
    finalAction: await readAction(nonce),
    provider: refused,
  };
}

async function slackApprovalFailureJourney(): Promise<void> {
  const { slack, answers, noticeTs, nonce } =
    await proposeInSlack("EvSlackFailure");
  await publishListingOutsideTheAction();

  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
  expect(answers[0]).toMatchObject({ replaceOriginal: true });
  expect(answers[0]?.text).toContain(`Approved by <@${USER_ID}>`);
  expect(answers[0]?.text).toContain("but the change failed. Nothing changed.");
  expect(answers[0]?.buttons).not.toContain("commerce_action_approve");

  // The click's answer and the outcome delivery say the same on one card.
  await expect
    .poll(() => slack.messages[0]?.text, { timeout: 30_000 })
    .toBe(answers[0]?.text);
  expect(slack.visibleMessageCount()).toBe(2);
  expect(await actionState(nonce)).toBe("failed");
}

async function failureDuringSlackOutageJourney(): Promise<void> {
  const { owner, slack, nonce } = await proposeInSlack("EvFailureOutage");
  await publishListingOutsideTheAction();
  let slackIsDown = true;
  network.use(
    http.post("https://slack.com/api/chat.update", function slackOutage() {
      return slackIsDown
        ? HttpResponse.text("unavailable", { status: 503 })
        : undefined;
    }),
  );

  const grant = await approvalGrant(nonce);
  const approved = await postControl(
    owner,
    `/${nonce}/approval`,
    {},
    "outage-card-approve",
    grant,
  );
  expect(approved.status, await approved.clone().text()).toBe(200);
  const executed = await postControl(
    owner,
    `/${nonce}/execute`,
    {},
    "outage-card-execute",
  );
  expect(executed.status, await executed.clone().text()).toBe(502);
  expect(await actionState(nonce)).toBe("failed");
  expect(slack.messages[0]?.text).toContain("Nothing changes until");

  slackIsDown = false;
  let attempt = 0;
  await expect
    .poll(
      async () => {
        attempt += 1;
        const again = await postControl(
          owner,
          `/${nonce}/execute`,
          {},
          `outage-card-execute-${String(attempt)}`,
        );
        expect(again.status, await again.clone().text()).toBe(200);
        return slack.messages[0]?.text;
      },
      { timeout: 60_000, interval: 2_000 },
    )
    .toContain("but the change failed. Nothing changed.");
  expect(slack.visibleMessageCount()).toBe(2);
}

async function lostCaseUpdateJourney({ task }: TestContext): Promise<void> {
  const { slack, answers, noticeTs, nonce, integrationAccountId } =
    await proposeInSlack("EvLostCaseUpdate");
  const caseId = String((await readAction(nonce)).caseId);
  expect(await caseWait(caseId)).toMatchObject({
    lifecycle: { kind: "waiting", wait: { kind: "approval" } },
  });

  // 1. The owner's decline reaches the ledger, and the Case update is lost.
  await rejectInLedgerOnly(nonce, integrationAccountId);
  expect(await actionState(nonce)).toBe("rejected");
  expect(await caseWait(caseId)).toMatchObject({
    lifecycle: { kind: "waiting" },
    commerceApprovals: [{ kind: "waiting" }],
  });

  // 2. The next message in the thread gets an answer: the Case read the
  //    ledger on admission and ended its wait with the decline.
  const before = slack.visibleMessageCount();
  await sendListingMessage(
    "app_mention",
    "EvLostCaseUpdateReply",
    "1787500000.000900",
    "<@U0PANTRY> Read the catalog again.",
  );
  await expect
    .poll(slack.visibleMessageCount, { timeout: 30_000 })
    .toBe(before + 1);
  expect(slack.messages.at(-1)?.text).toContain("PI_LISTING_RESTORED");
  const recovered = await caseWait(caseId);
  expect(recovered).toMatchObject({
    lifecycle: { kind: "open" },
    commerceApprovals: [{ kind: "decided", decision: { kind: "rejected" } }],
  });

  // 3. A late Approve from the stale card changes nothing.
  await click(nonce, noticeTs);
  await expect.poll(() => answers.length, { timeout: 30_000 }).toBe(1);
  expect(answers[0]?.text).toContain("Declined by");
  expect(await actionState(nonce)).toBe("rejected");
  expect(await effectEvidence()).toMatchObject({ mutations: 0 });

  task.meta.slackCommerceApproval = {
    substituted: [
      "model provider (deterministic OpenRouter transport)",
      "Slack (signed interaction payloads and the simulator of its Web API)",
      "a lost Case update (the decline is written to the ledger only)",
    ],
    nonce,
    thread: slack.messages,
    finalAction: await readAction(nonce),
    caseAfterRecovery: recovered,
  };
}

/** Writes a Slack decline to the ledger only, as a click whose process ended. */
async function rejectInLedgerOnly(
  nonce: string,
  integrationAccountId: string,
): Promise<void> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const existing = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!existing.ok) throw new Error(existing.error.code);
  const now = Date.now();
  const rejection: MerchantActionRejectionEvidence = {
    kind: "merchant_rejection",
    principal: {
      kind: "app_user",
      userId: OWNER,
      personId: "person_e2e-slack-actor",
      role: "owner",
    } as MerchantActionRejectionEvidence["principal"],
    authentication: {
      kind: "slack_verified_link",
      integrationAccountId,
      workspaceId: WORKSPACE_ID,
      slackUserId: USER_ID,
      authenticatedAt: now,
    },
    decision: {
      kind: "rejected",
      reason: "merchant_declined",
      action: {
        organisationId: ORGANISATION_ID,
        actionNonce: nonce,
        actionDigest: await digestApprovalAction(existing.value.action),
      },
    },
  };
  const rejected = await organisation.rejectAction({
    organisationId: ORGANISATION_ID,
    nonce,
    rejection,
    now,
  });
  if (!rejected.ok) throw new Error(rejected.error.code);
}

/** The Case's lifecycle and approval records. */
async function caseWait(caseId: string): Promise<Record<string, unknown>> {
  const caseActor = await resolveActiveCaseActor({
    env,
    namespace: env.CASE,
    organisationId: ORGANISATION_ID,
    caseId: caseId as Parameters<typeof resolveActiveCaseActor>[0]["caseId"],
    now: Date.now(),
  });
  if (!caseActor.ok) throw new Error(caseActor.error.code);
  const snapshot = await caseActor.value.inspect();
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  return JSON.parse(JSON.stringify(snapshot.value)) as Record<string, unknown>;
}

/**
 * Publishes the listing with another command, as a person's own change would:
 * each record moves past the revision that the proposal holds. Commerce's
 * fixture loses the answer of the first publish, so only the evidence counts.
 */
async function publishListingOutsideTheAction(): Promise<void> {
  await providerClient().publishCatalogListing({
    merchantId: MERCHANT,
    idempotencyKey: "publish-outside-the-action",
    productId: PRODUCT,
    productRevision: 1,
    variantId: VARIANT,
    variantRevision: 1,
    offerId: OFFER,
    offerRevision: 1,
    salesChannelId: SALES_CHANNEL,
    salesChannelRevision: 1,
  });
  expect(await effectEvidence()).toMatchObject({ mutations: 1 });
}

async function approvalGrant(nonce: string): Promise<string> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  const config = googleConfig(env);
  if (config === null) throw new Error("Missing approval configuration");
  return completeCommerceApprovalFixture({
    db: env.DB,
    config,
    action: action.value.action,
    userId: OWNER,
    subject: "e2e-slack-actor",
    email: "e2e-slack-actor@example.invalid",
    stepUpId: "failed-card-step-up",
  });
}

async function click(
  nonce: string,
  noticeTs: string,
  actionId = "commerce_action_approve",
): Promise<void> {
  const response = await exports.default.fetch(
    await signedButtonClick({
      actionId,
      value: nonce,
      user: USER_ID,
      channel: CHANNEL_ID,
      threadTs: ROOT_TS,
      proposalTs: noticeTs,
    }),
  );
  expect(response.status).toBe(200);
}

async function setRole(role: "owner" | "operator"): Promise<void> {
  await fixtureDatabase()
    .prepare(
      "UPDATE service_role_grant SET role = ? WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(role, ORGANISATION_ID, OWNER)
    .run();
}

async function readAction(nonce: string): Promise<Record<string, unknown>> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const action = await organisation.getAction({
    organisationId: ORGANISATION_ID,
    nonce,
    now: Date.now(),
  });
  if (!action.ok) throw new Error(action.error.code);
  return JSON.parse(JSON.stringify(action.value)) as Record<string, unknown>;
}

async function actionState(nonce: string): Promise<unknown> {
  return (await readAction(nonce)).state;
}
