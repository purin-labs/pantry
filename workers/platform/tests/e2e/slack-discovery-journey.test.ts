import { fixtureDatabase } from "./organisation-database";
import { expect, it } from "vitest";
import { exports } from "cloudflare:workers";

import { revokeAccessGrant } from "@purin-labs/authority/data/access-grants";
import { network } from "./network";
import {
  CHANNEL_ID,
  DISCOVERY_ANSWER,
  DISCOVERY_GRANT_ID,
  DISCOVERY_UNAVAILABLE,
  OTHER_CHANNEL_ID,
  OTHER_SLACK_BOT_TOKEN,
  OTHER_WORKSPACE_ID,
  REVOKED_USER_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  ORGANISATION_ID,
  USER_ID,
  WORKSPACE_ID,
  discoveryModelSimulator,
  installDiscoveryActorFixture,
  readSlackMessageText,
  signedSlackRequest,
  slackEnvelope,
  slackEnvelopeFor,
  slackSimulator,
} from "./slack-journey-support";
it("carries governed integration discovery and granted file context only to the selected Slack thread", async () => {
  const fixture = await installDiscoveryActorFixture();
  const model = discoveryModelSimulator();
  const slack = slackSimulator([SLACK_BOT_TOKEN, OTHER_SLACK_BOT_TOKEN]);
  network.use(model.handler, slack.handler);

  const root = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "Ev0E2EDISCOVERY",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> What integrations are connected?",
      }),
    ),
  );
  expect(root.status).toBe(200);
  await expect(root.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
  await expect.poll(model.requestCount, { timeout: 15_000 }).toBe(2);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(1);

  const followUp = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EDISCOVERYFOLLOWUP",
        messageTs: "1787500000.000003",
        threadTs: ROOT_TS,
        text: "Which supplier contract is available to this thread?",
      }),
    ),
  );
  expect(followUp.status).toBe(200);
  await expect(followUp.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
  await expect.poll(model.requestCount, { timeout: 15_000 }).toBe(4);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(2);

  const revoked = await revokeAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: DISCOVERY_GRANT_ID,
    expectedRevision: 1,
    reason: "Plan 35 same-Case revocation fixture",
    now: Date.now(),
  });
  expect(revoked).toMatchObject({
    ok: true,
    value: { lifecycle: { kind: "revoked", revision: 2 } },
  });
  const afterRevocation = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "message",
        eventId: "Ev0E2EDISCOVERYREVOKED",
        messageTs: "1787500000.000004",
        threadTs: ROOT_TS,
        text: "Repeat the connected-account summary you just gave.",
      }),
    ),
  );
  expect(afterRevocation.status).toBe(200);
  await expect(afterRevocation.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "case_accepted",
  });
  await expect.poll(model.requestCount, { timeout: 15_000 }).toBe(5);
  await expect.poll(slack.visibleMessageCount, { timeout: 15_000 }).toBe(3);

  const otherWorkspace = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: OTHER_WORKSPACE_ID,
        channelId: OTHER_CHANNEL_ID,
        userId: USER_ID,
        eventType: "app_mention",
        eventId: "Ev0E2EOTHERWORKSPACE",
        messageTs: "1787500000.000010",
        threadTs: "1787500000.000010",
        text: "<@U0PANTRY> What integrations are connected?",
      }),
    ),
  );
  expect(otherWorkspace.status).toBe(200);
  await expect(otherWorkspace.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "rejected",
  });

  const revokedPerson = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: WORKSPACE_ID,
        channelId: CHANNEL_ID,
        userId: REVOKED_USER_ID,
        eventType: "app_mention",
        eventId: "Ev0E2EREVOKEDPERSON",
        messageTs: "1787500000.000011",
        threadTs: "1787500000.000011",
        text: "<@U0PANTRY> What integrations are connected?",
      }),
    ),
  );
  expect(revokedPerson.status).toBe(200);
  await expect(revokedPerson.json()).resolves.toMatchObject({
    ok: true,
    durableMode: "rejected",
  });

  expect(model.requests).toHaveLength(5);
  const narrowedRequest = JSON.stringify(model.requests[4]);
  expect(narrowedRequest).not.toContain("integration_list");
  expect(narrowedRequest).not.toContain(DISCOVERY_ANSWER);
  expect(narrowedRequest).not.toContain("Dropbox, Gmail, Slack, and Stripe");
  expect(
    slack.messages.filter(isSelectedThread).map(readSlackMessageText),
  ).toEqual([
    DISCOVERY_ANSWER,
    "The separately granted file is Supplier contract.txt.",
    DISCOVERY_UNAVAILABLE,
  ]);
  const routingMessages = slack.messages.filter(isOtherChannel);
  expect(routingMessages).toHaveLength(1);
  expect(routingMessages.map(readSlackMessageText)).toEqual([
    expect.stringContaining("not assigned to an organisation"),
  ]);
  expect(JSON.stringify(routingMessages)).not.toContain(DISCOVERY_ANSWER);
  expect(fixture.otherIntegrationAccountId).not.toBe(
    fixture.selectedIntegrationAccountId,
  );
});

function isSelectedThread(message: Record<string, string>): boolean {
  return message.channel === CHANNEL_ID && message.thread_ts === ROOT_TS;
}

function isOtherChannel(message: Record<string, string>): boolean {
  return message.channel === OTHER_CHANNEL_ID;
}
