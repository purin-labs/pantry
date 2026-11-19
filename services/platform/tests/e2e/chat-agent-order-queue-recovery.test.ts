// A move of the shop's order queue when the Session Actor is lost, and a person
// who loses the staff role during a turn (Plan 81). A real shop and order; a
// scripted model and a simulated Slack.
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import { OrganisationDO } from "../../src/actors/organisation";
import { advanceOrderQueueEntry } from "../../src/commerce/order-queue-commands";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { enableCapability } from "./access-route-support";
import {
  placeCafeOrder,
  publishCafeMenu,
  required,
} from "./cafe-order-support";
import { lastCalledTool } from "./chat-permission-support";
import {
  deliverAfterConnectorLease,
  loseSession,
  organisationActor,
  sessionObjectName,
} from "./durable-codemode-journey-support";
import { network } from "./network";
import {
  MERCHANT,
  installEffectAuthority,
  providerClient,
  sendListingMessage,
} from "./pi-sdk-effect-support";
import {
  ORGANISATION_ID,
  createRequiredGrant,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  openRouterToolCall,
  requireLastToolOutput,
  slackSimulator,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    chatAgentOrderQueueRecovery?: Record<string, unknown>;
  }
}

type Step = (output: string) => Response;

it(
  "answers a lost hand-over from its receipt, and refuses a person who lost the staff role with no prompt",
  { timeout: 240_000 },
  async (test: TestContext): Promise<void> => {
    const fixture = await installSlackActorFixture();
    const slack = slackSimulator();
    const steps: Step[] = [];
    network.use(
      slack.handler,
      http.post(
        "https://openrouter.ai/api/v1/chat/completions",
        replyInOrder.bind(null, steps),
      ),
    );
    const session = await installEffectAuthority(
      fixture.selectedIntegrationAccountId,
      "plugin",
    );
    await discoverSlackChannel("public_channel", Date.now() - 60_000);
    await enableCapability(
      ORGANISATION_ID,
      session,
      "commerce.order_queue.advance",
    );
    await createRequiredGrant({
      grantId: "grant_pi_queue_owner",
      subject: { kind: "organisation_role", role: "owner" },
      target: {
        kind: "platform_capability",
        capabilityId: "commerce.order_queue.advance",
        capabilityVersion: 1,
      },
      now: Date.now(),
    });
    const roleChange = Promise.withResolvers<void>();
    const client = providerClient();
    const shop = await client.provisionDemo({
      schemaVersion: "underclerk.provision-demo.v2",
      externalReference: ORGANISATION_ID,
      merchantId: MERCHANT,
      profile: "cafe_patisserie",
      createdAt: new Date().toISOString(),
    });
    if (!shop.ok) throw new Error(JSON.stringify(shop.error));
    await publishCafeMenu(MERCHANT);

    const queue = async () =>
      (await required(client.readPickupQueue(MERCHANT))).entries;
    const orderId = await placeCafeOrder(MERCHANT);
    const lost = (await queue()).find((entry) => entry.orderId === orderId);
    if (lost === undefined) throw new Error("The paid order is not queued");
    const ready = await advanceOrderQueueEntry(
      { client, merchantId: MERCHANT },
      lost.fulfillmentId,
      "ready",
      "journey_order_ready",
    );
    expect(ready).toEqual({ ok: true });

    // The hand-over commits and writes its receipt. The tool call then waits at
    // the screen signal, and the process is lost there.
    const signals: unknown[] = [];
    await runInDurableObject(
      await organisationActor(),
      holdScreenSignals.bind(null, test, signals),
    );
    const handedOver: string[] = [];
    steps.push(
      () =>
        openRouterToolCall(
          "tool_search",
          { query: "order_queue_advance", limit: 1 },
          "queue_lost_search",
        ),
      () =>
        openRouterToolCall(
          "order_queue_advance",
          { fulfillmentId: lost.fulfillmentId, action: "hand_over" },
          "queue_lost_call",
        ),
      (output) => {
        handedOver.push(output);
        return openRouterText("PI_HANDED_OVER", "queue_lost_answer");
      },
    );
    await sendListingMessage(
      "app_mention",
      "EvOrderQueueLost",
      "1710000900.000100",
      "<@U0PANTRY> The buyer has the order. Hand it over.",
      "1710000900.000100",
    );
    await expect.poll(() => signals.length, { timeout: 30_000 }).toBe(1);
    expect(await queue()).not.toContainEqual(
      expect.objectContaining({ fulfillmentId: lost.fulfillmentId }),
    );
    // The call is still in flight: the model has not read its output.
    expect(steps).toHaveLength(1);
    const sessionName = (await sessionObjectName()).name;
    const nextSession = await loseSession({
      session: env.SESSION.getByName(sessionName),
      sessionName,
    });

    // The next process runs the call again. Its receipt answers, the order is
    // not refused as gone, and no second signal or receipt appears.
    await deliverAfterConnectorLease({ slack }, nextSession);
    expect(slack.messages.map((message) => message.text).join("\n")).toContain(
      "PI_HANDED_OVER",
    );
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]).toContain("receiptId");
    expect(handedOver[0]).not.toContain("left the queue");
    expect(signals).toHaveLength(1);
    const scope = await requireOrganisationExecutionScope(env, ORGANISATION_ID);
    const receipts = await scope.database
      .prepare(
        "SELECT COUNT(*) AS n FROM control_mutation_receipt WHERE organisation_scope = ? AND route = ? AND operation = 'order_queue.hand_over'",
      )
      .bind(
        ORGANISATION_ID,
        `/v1/control/organisations/${ORGANISATION_ID}/commerce/order-queue/${lost.fulfillmentId}/advance`,
      )
      .first<{ readonly n: number }>();
    expect(receipts?.n).toBe(1);
    const snapshot = await required(client.readStockSnapshot(MERCHANT));
    expect(
      snapshot.commerce.resources.orders.find((order) => order.id === orderId)
        ?.lifecycle.state,
    ).toBe("fulfilled");

    // The person loses the staff role while the turn runs. The page would now
    // refuse them, so the agent moves nothing for them and nobody gets a prompt.
    const secondOrderId = await placeCafeOrder(MERCHANT);
    const open = (await queue()).find(
      (entry) => entry.orderId === secondOrderId,
    );
    if (open === undefined) throw new Error("The second order is not queued");
    steps.push(
      () =>
        openRouterToolCall(
          "tool_search",
          { query: "order_queue_advance", limit: 1 },
          "queue_demoted_search",
        ),
      () => {
        roleChange.resolve(makeSlackPersonViewer());
        return openRouterToolCall(
          "order_queue_advance",
          { fulfillmentId: open.fulfillmentId, action: "start" },
          "queue_demoted_move",
        );
      },
    );
    await sendListingMessage(
      "app_mention",
      "EvOrderQueueDemoted",
      "1710000950.000100",
      "<@U0PANTRY> Start the order.",
      "1710000950.000100",
    );
    await expect
      .poll(() => slack.messages.map((message) => message.text).join("\n"), {
        timeout: 60_000,
      })
      .toContain("couldn’t complete this request");
    await roleChange.promise;
    expect(
      (await queue()).find((entry) => entry.orderId === secondOrderId),
    ).toMatchObject({
      stage: "preparing",
      preparation: { state: "not_started" },
    });
    const asked = await scope.database
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_permission_request WHERE organisation_id = ?",
      )
      .bind(ORGANISATION_ID)
      .first<{ readonly n: number }>();
    expect(asked?.n).toBe(0);

    test.task.meta.chatAgentOrderQueueRecovery = {
      handedOverOutput: handedOver[0],
      screenSignals: signals.length,
      handOverReceipts: receipts?.n,
      roleLostAnswer: slack.messages.at(-1)?.text,
      permissionRequests: asked?.n,
    };
  },
);

/** The Slack person becomes a viewer, and another person keeps the shop. */
async function makeSlackPersonViewer(): Promise<void> {
  const now = Date.now();
  const other = "user_8a1f4f52-3f0a-5c11-9b77-0d6f1d2c4e10";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO app_user (user_id, issuer, subject, email, display_name, email_verified, created_at, last_authenticated_at) VALUES (?, 'https://accounts.google.com', 'order-queue-owner', 'order-queue-owner@example.invalid', 'Shop owner', 1, ?, ?)",
    ).bind(other, now, now),
  ]);
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, 'person_order_queue_owner', 'Shop owner')",
      )
      .bind(ORGANISATION_ID),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at, revoked_at) VALUES (?, ?, 'person_order_queue_owner', 'owner', 'active', ?, NULL)",
      )
      .bind(ORGANISATION_ID, other, now),
    fixtureDatabase()
      .prepare(
        "UPDATE service_role_grant SET role = 'viewer' WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'",
      )
      .bind(ORGANISATION_ID),
  ]);
}

function holdScreenSignals(
  test: TestContext,
  calls: unknown[],
  actor: unknown,
): void {
  if (!(actor instanceof OrganisationDO))
    throw new Error("Unexpected Organisation Actor");
  const prototype: unknown = Object.getPrototypeOf(actor);
  if (!isRecord(prototype)) throw new Error("Unexpected Organisation Actor");
  const original = actor.signalMenuScreens;
  Object.defineProperty(prototype, "signalMenuScreens", {
    value: async (input: unknown): Promise<void> => {
      calls.push(input);
      // A pending timer: the runtime ends a call whose promise can never settle.
      await new Promise((resolve) => setTimeout(resolve, 180_000));
    },
    configurable: true,
    writable: true,
  });
  test.onTestFinished(() => {
    Object.defineProperty(prototype, "signalMenuScreens", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
}

async function replyInOrder(
  steps: Step[],
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  const body: unknown = await request.json();
  if (!isRecord(body)) throw new Error("Invalid model request");
  const step = steps.shift();
  if (step === undefined) throw new Error("Unexpected model request");
  return step(lastCalledTool(body) === null ? "" : requireLastToolOutput(body));
}
