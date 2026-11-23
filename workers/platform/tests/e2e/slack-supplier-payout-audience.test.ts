import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";

import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import { enableCapability } from "./access-route-support";
import { connectCommerceFixture } from "./commerce-support";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  USER_ID,
  WORKSPACE_ID,
  createRequiredGrant,
  installSlackActorFixture,
  signedSlackRequest,
  slackEnvelopeFor,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackSupplierPayoutAudience?: Record<string, unknown>;
  }
}

/**
 * Supplier payout figures reach only a Slack channel whose audience may read
 * them.
 *
 * The café has two connected channels: #finance and the shop floor. Payout
 * reads are enabled, the operator role holds a payout read grant, and only
 * #finance holds a grant of its own. The same operator asks for the
 * outstanding supplier payouts in each channel. #finance gets the figures.
 * The shop floor gets the fixed refusal and no figure, although the person
 * who asked may read payouts: a channel answer reaches everyone in the
 * channel, so the requester's own grant does not admit it.
 */
it(
  "posts supplier payout figures only to a Slack channel with its own payout read grant",
  { timeout: 120_000 },
  supplierPayoutAudienceJourney,
);

const FLOOR_CHANNEL_ID = "C0E2EFLOOR";
const FLOOR_ROOT_TS = "1787500100.000001";
const SUPPLIER_ID = "supplier_flour_mill";
const FIGURE = "186,000 JPY";
const REFUSAL = "This workspace is not permitted to read supplier payouts.";
const PAYOUT_READ_TARGET = {
  kind: "platform_capability",
  capabilityId: CAPABILITY_KEYS.commerceSupplierPayoutRead,
  capabilityVersion: 1,
} as const;

async function supplierPayoutAudienceJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const owner = fixture.ownerSession;
  await connectCommerceFixture(
    ORGANISATION_ID,
    owner.session.userId,
    "merchant_bakery_c3_supplier_payout",
  );
  await enableCapability(
    ORGANISATION_ID,
    owner,
    CAPABILITY_KEYS.commerceSupplierPayoutRead,
  );
  await connectFloorChannel(fixture.selectedIntegrationAccountId);
  const now = Date.now();
  await createRequiredGrant({
    grantId: "grant_e2e_payout_read_finance",
    subject: {
      kind: "conversation",
      integrationAccountId: fixture.selectedIntegrationAccountId,
      conversationId: CHANNEL_ID,
    },
    target: PAYOUT_READ_TARGET,
    now,
  });
  await createRequiredGrant({
    grantId: "grant_e2e_payout_read_operators",
    subject: { kind: "organisation_role", role: "operator" },
    target: PAYOUT_READ_TARGET,
    now,
  });
  await seedOutstandingPayout(now);

  const slack = slackSimulator();
  const modelRequests: unknown[] = [];
  network.use(
    slack.handler,
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      function recordModelRequest({ request }) {
        modelRequests.push(request.url);
        return HttpResponse.json({ error: "unexpected" }, { status: 500 });
      },
    ),
  );

  // 1. #finance holds a grant: the thread gets the figures.
  await askForPayouts("Ev_PAYOUT_FINANCE", CHANNEL_ID, ROOT_TS);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(1);
  const finance = slack.messages[0];
  expect(finance).toMatchObject({ channel: CHANNEL_ID, thread_ts: ROOT_TS });
  expect(finance?.text).toContain("GMO Aozora");
  expect(finance?.text).toContain(`${SUPPLIER_ID}: ${FIGURE}`);

  // 2. The shop floor holds none: the same person gets the refusal there.
  await askForPayouts("Ev_PAYOUT_FLOOR", FLOOR_CHANNEL_ID, FLOOR_ROOT_TS);
  await expect.poll(slack.visibleMessageCount, { timeout: 30_000 }).toBe(2);
  const floor = slack.messages[1];
  expect(floor).toMatchObject({
    channel: FLOOR_CHANNEL_ID,
    thread_ts: FLOOR_ROOT_TS,
    text: REFUSAL,
  });
  expect(floor?.text).not.toContain(FIGURE);
  expect(floor?.text).not.toContain(SUPPLIER_ID);
  // A payout question is answered without the model.
  expect(modelRequests).toEqual([]);

  Object.assign(test.task.meta, {
    slackSupplierPayoutAudience: {
      grants: [
        {
          subject: `conversation:${CHANNEL_ID}`,
          capability: "commerce.supplier_payout.read",
        },
        {
          subject: "organisation_role:operator",
          capability: "commerce.supplier_payout.read",
        },
      ],
      posts: slack.messages.map(channelThreadAndText),
    },
  });
}

/** An operator asks Pantry in a channel, as the Slack app delivers it. */
async function askForPayouts(
  eventId: string,
  channelId: string,
  ts: string,
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: WORKSPACE_ID,
        channelId,
        userId: USER_ID,
        eventType: "app_mention",
        eventId,
        messageTs: ts,
        threadTs: ts,
        text: "<@U0PANTRY> show supplier payouts",
      }),
    ),
  );
  expect(response.status).toBe(200);
}

/** A second channel that the Organisation connected, with no grant of its own. */
async function connectFloorChannel(
  integrationAccountId: string,
): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slack_channel_default (
         installation_id, channel_id, connection_id, revision, bound_by_user_id, bound_at
       ) VALUES ('installation_e2e_slack', ?, 'connection_e2e_slack_org', 1,
         'user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab', ?)`,
    ).bind(FLOOR_CHANNEL_ID, now),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO organisation_slack_channel (
         organisation_id, integration_account_id, workspace_id, channel_id,
         provider_revision, connected_at
       ) VALUES (?, ?, ?, ?, 'channel-e2e-floor', ?)`,
      )
      .bind(
        ORGANISATION_ID,
        integrationAccountId,
        WORKSPACE_ID,
        FLOOR_CHANNEL_ID,
        now,
      ),
  ]);
}

/** A flour payout whose outcome Pantry does not know, so it is outstanding. */
async function seedOutstandingPayout(now: number): Promise<void> {
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        `INSERT INTO supplier_payable (
         organisation_id, payable_id, merchant_id, supplier_id, purchase_request_id,
         currency, gross_amount_minor, in_flight_minor, settled_minor,
         lifecycle, revision, payable_json, updated_at
       ) VALUES (?, 'supplier_payable_flour', 'merchant_bakery_c3_supplier_payout',
         ?, 'purchase_request_flour', 'JPY', 186000, 186000, 0, 'approved', 1, '{}', ?)`,
      )
      .bind(ORGANISATION_ID, SUPPLIER_ID, now),
    fixtureDatabase()
      .prepare(
        `INSERT INTO supplier_payout (
         organisation_id, payout_id, payable_id, supplier_id, purchase_request_id,
         rail, integration_account_id, destination_revision_id, currency,
         recipient_amount_minor, fee_ceiling_minor, idempotency_key,
         state_kind, approval_digest, payout_json, revision, created_at, updated_at
       ) VALUES (?, 'supplier_payout_flour', 'supplier_payable_flour', ?,
         'purchase_request_flour', 'gmo_aozora_private', 'integration_gmo',
         'destination_revision_flour', 'JPY', 186000, 500, 'payout-flour-1',
         'indeterminate', ?, '{}', 2, ?, ?)`,
      )
      .bind(ORGANISATION_ID, SUPPLIER_ID, "ab".repeat(32), now, now),
  ]);
}

function channelThreadAndText(post: Record<string, string>) {
  return { channel: post.channel, thread: post.thread_ts, text: post.text };
}
