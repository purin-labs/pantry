import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { commerceCanonicalResourceId } from "../../src/commerce/contract/resource-ids";
import { commerceHeaders } from "./commerce-support";
import { propose } from "./commerce-propose-support";
import {
  MERCHANT,
  PRODUCT,
  installEffectAuthority,
} from "./pi-sdk-effect-support";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  installSlackActorFixture,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    commerceProposeUnboundChannel?: Record<string, unknown>;
  }
}

it(
  "binds the setup's Slack channel when the owner sends for approval from a workspace whose setup never bound it",
  { timeout: 180_000 },
  unboundChannelJourney,
);

/**
 * A workspace that saved its setup before setup saves bound the Slack
 * channel has the channel in its setup but no binding for it. Send for
 * approval must not fail there with an unavailable connector: the owner's
 * send binds the free channel to the workspace's own Slack connection, and
 * the action waits for approval in that channel.
 */
async function unboundChannelJourney({ task }: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const session = await installEffectAuthority(
    fixture.selectedIntegrationAccountId,
    "listing",
  );
  // The setup names the channel, but nothing ever bound it.
  await env.DB.batch(
    [
      "DELETE FROM slack_channel_default WHERE channel_id = ?",
      "DELETE FROM slack_channel_default_revision WHERE channel_id = ?",
    ].map((sql) => env.DB.prepare(sql).bind(CHANNEL_ID)),
  );
  expect(await channelsInUse(session)).toEqual([]);

  const proposed = await propose(
    session,
    {
      kind: "update_product_description",
      productId: commerceCanonicalResourceId(MERCHANT, PRODUCT),
      productRevision: 1,
      description: "Six assorted cookies, baked each morning in our café.",
    },
    "unbound-channel",
  );
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  expect(proposed.body).toMatchObject({
    ok: true,
    action: { state: "proposed" },
  });
  const bound = await channelsInUse(session);
  expect(bound).toEqual([CHANNEL_ID]);

  task.meta.commerceProposeUnboundChannel = {
    channelsBeforeSend: [],
    proposal: {
      status: proposed.status,
      state: (proposed.body as { action: { state: string } }).action.state,
    },
    channelsAfterSend: bound,
  };
}

/** The channels that the Slack settings list as in use by this workspace. */
async function channelsInUse(session: IssuedControlSession): Promise<string[]> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${ORGANISATION_ID}/slack-routing`,
    { headers: commerceHeaders(session) },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.connections))
    throw new Error("Slack routing missing");
  const channels: string[] = [];
  for (const connection of body.connections) {
    if (!isRecord(connection) || !Array.isArray(connection.channelDefaults))
      continue;
    for (const channel of connection.channelDefaults)
      if (isRecord(channel) && typeof channel.channelId === "string")
        channels.push(channel.channelId);
  }
  return channels;
}
