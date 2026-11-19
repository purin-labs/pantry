import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, vi, type TestContext } from "vitest";
import { isRecord, parseJsonOrNull } from "@seams/std";

import type { ConnectorDO } from "../../src/actors/connector";
import {
  handleSlackIngress,
  type SlackIngressEnv,
} from "../../src/slack-ingress/handler";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  USER_ID,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  signedSlackRequest,
  slackEnvelope,
  slackEnvelopeFor,
  replyingModel,
} from "./slack-journey-support";

/**
 * The Slack ingress Worker is a second, small Worker in front of the
 * platform Worker. This journey gives it only the bindings of its own
 * profile, and the platform Worker as its service binding.
 *
 * It must complete a message that the Connector accepts, without the
 * platform Worker. It must give every other request to the platform Worker,
 * which decides it as before: also a request that its copy of the signing
 * secret does not verify, so a missing or outdated copy stops no message. A
 * message whose acceptance the ingress Worker did not see must still run one
 * time.
 */
it(
  "accepts Slack work at the Connector from the ingress Worker and gives every other request to the platform Worker",
  ingressWorkerJourney,
  90_000,
);

const SECOND_ROOT_TS = "1787500100.000001";

type Envelope = Parameters<typeof slackEnvelope>[0];

type Answer = {
  readonly status: number;
  readonly durableMode: unknown;
  readonly decidedBy: "ingress" | "platform";
};

type Acceptance = {
  readonly eventId: string;
  readonly disposition: string;
  readonly acceptedThrough: "ingress" | "platform";
  readonly admittedBy: string;
};

async function ingressWorkerJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const model = replyingModel();
  const slack = recordingSlack();
  network.use(model.handler, slack.handler);
  const logs = vi.spyOn(console, "log");
  const warnings = vi.spyOn(console, "warn");
  test.onTestFinished(logs.mockRestore);
  test.onTestFinished(warnings.mockRestore);
  const ingress = ingressWorker(env.CONNECTOR);

  // A wrong signature is not decided here. The platform Worker refuses it.
  const forged = await signedSlackRequest(
    slackEnvelope({
      eventType: "app_mention",
      eventId: "Ev55E_IN_FORGED",
      messageTs: ROOT_TS,
      threadTs: ROOT_TS,
      text: "<@U0PANTRY> open this case",
    }),
  );
  forged.headers.set("x-slack-signature", `v0=${"0".repeat(64)}`);
  const refused = await ingress.fetch(forged);
  expect(refused.status).toBe(401);
  expect(ingress.forwarded).toEqual(["POST /slack/events"]);

  // First use: no Connector serves the placement. The platform Worker
  // decides the message and activates one.
  const root = await ingress.send({
    eventType: "app_mention",
    eventId: "Ev55E_IN_ROOT",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0PANTRY> open this case",
  });
  expect(root).toEqual(accepted("platform"));
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(1);

  // A reply: the ingress Worker asks the Connector and answers Slack. It
  // shows the thinking status with the bot credential that it resolved.
  const reply: Envelope = {
    eventType: "message",
    eventId: "Ev55E_IN_REPLY",
    messageTs: "1787500000.000002",
    threadTs: ROOT_TS,
    text: "continue in the same case",
  };
  expect(await ingress.send(reply)).toEqual(accepted("ingress"));
  await ingress.settled();
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(2);
  await expect.poll(slack.statusCount, { timeout: 15_000 }).toBe(2);
  expect(slack.statuses[1]).toMatchObject({
    channel_id: CHANNEL_ID,
    thread_ts: ROOT_TS,
  });
  expect(model.sessionIds[1]).toBe(model.sessionIds[0]);

  // Slack sends the same event again. The Connector knows it.
  expect(await ingress.send(reply)).toEqual(accepted("ingress"));

  // A new thread opens its Case through the same decision.
  const secondRoot = await ingress.send({
    eventType: "app_mention",
    eventId: "Ev55E_IN_SECOND",
    messageTs: SECOND_ROOT_TS,
    threadTs: SECOND_ROOT_TS,
    text: "<@U0PANTRY> open a second case",
  });
  expect(secondRoot).toEqual(accepted("ingress"));
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(3);
  expect(model.sessionIds[2]).not.toBe(model.sessionIds[0]);

  // A refusal belongs to the platform Worker, which answers the member.
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET status = 'revoked', revoked_at = ?
     WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'`,
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const revoked = await ingress.send({
    eventType: "message",
    eventId: "Ev55E_IN_REVOKED",
    messageTs: "1787500000.000003",
    threadTs: ROOT_TS,
    text: "one more thing",
  });
  expect(revoked).toEqual({
    status: 200,
    durableMode: "rejected",
    decidedBy: "platform",
  });
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET status = 'active', revoked_at = NULL
     WHERE organisation_id = ? AND person_id = 'person_e2e-slack-actor'`,
    )
    .bind(ORGANISATION_ID)
    .run();

  // The Connector accepts a message, and the answer to the ingress Worker is
  // lost. The platform Worker asks again and finds the accepted work. The
  // message runs one time.
  const lossy = ingressWorker(withLostAnswers(env.CONNECTOR));
  const lost = await lossy.send({
    eventType: "message",
    eventId: "Ev55E_IN_LOST",
    messageTs: "1787500000.000004",
    threadTs: ROOT_TS,
    text: "and this one",
  });
  expect(lost).toEqual(accepted("platform"));
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(4);

  // Requests that the ingress Worker never decides.
  const stop = await ingress.send({
    eventType: "message",
    eventId: "Ev55E_IN_STOP",
    messageTs: "1787500000.000005",
    threadTs: ROOT_TS,
    text: "stop",
  });
  expect(stop.decidedBy).toBe("platform");
  const stranger = await ingress.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: "T0E2ENOBODY",
        channelId: CHANNEL_ID,
        userId: USER_ID,
        eventType: "app_mention",
        eventId: "Ev55E_IN_STRANGER",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> hello",
      }),
    ),
  );
  await stranger.arrayBuffer();
  const challenge = await ingress.fetch(
    await signedSlackRequest({ type: "url_verification", challenge: "c-55e" }),
  );
  expect(await challenge.json()).toEqual({ challenge: "c-55e" });
  // Another path of the platform is not served through this Worker.
  const health = await ingress.fetch(new Request("http://pantry.test/health"));
  expect(health.status).toBe(404);
  // The forged request, the root, the refusal, the stop command, the
  // unknown workspace and the challenge.
  expect(ingress.forwarded).toEqual([
    "POST /slack/events",
    "POST /slack/events",
    "POST /slack/events",
    "POST /slack/events",
    "POST /slack/events",
    "POST /slack/events",
  ]);
  expect(lossy.forwarded).toEqual(["POST /slack/events"]);

  // An ingress Worker with no copy of the signing secret, and one with an
  // outdated copy, complete nothing. The platform Worker accepts both
  // replies with the secret that counts.
  const withoutSecret = ingressWorker(env.CONNECTOR, "");
  expect(
    await withoutSecret.send({
      eventType: "message",
      eventId: "Ev55E_IN_NO_COPY",
      messageTs: "1787500000.000006",
      threadTs: ROOT_TS,
      text: "a reply through a Worker with no copy",
    }),
  ).toEqual(accepted("platform"));
  const outdated = ingressWorker(env.CONNECTOR, "an-outdated-signing-secret");
  expect(
    await outdated.send({
      eventType: "message",
      eventId: "Ev55E_IN_OLD_COPY",
      messageTs: "1787500000.000007",
      threadTs: ROOT_TS,
      text: "a reply through a Worker with an outdated copy",
    }),
  ).toEqual(accepted("platform"));
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(6);

  // Six accepted messages ran one time each: the root, the reply, the
  // second thread, the message with the lost answer and the two replies
  // that the platform Worker verified.
  await ingress.settled();
  await lossy.settled();
  await expect.poll(slack.messageCount, { timeout: 30_000 }).toBe(6);
  expect(model.requests).toBe(6);
  const acceptances = acceptedWork(logs.mock.calls);
  expect(acceptances).toEqual([
    acceptance("Ev55E_IN_ROOT", "accepted", "platform", "worker"),
    acceptance("Ev55E_IN_REPLY", "accepted", "ingress", "connector"),
    acceptance("Ev55E_IN_REPLY", "duplicate", "ingress", "connector"),
    acceptance("Ev55E_IN_SECOND", "accepted", "ingress", "connector"),
    acceptance("Ev55E_IN_LOST", "duplicate", "platform", "connector"),
    acceptance("Ev55E_IN_NO_COPY", "accepted", "platform", "connector"),
    acceptance("Ev55E_IN_OLD_COPY", "accepted", "platform", "connector"),
  ]);
  expect(
    tracedEvents(
      warnings.mock.calls,
      "integration_gateway.slack.ingress_signature_unverified",
    ),
  ).toHaveLength(2);
  const failedFastPaths = tracedEvents(
    warnings.mock.calls,
    "integration_gateway.slack.ingress_fast_path_failed",
  );
  expect(failedFastPaths).toEqual(["Ev55E_IN_LOST"]);
  Object.assign(test.task.meta, {
    slackIngressWorker: {
      acceptances,
      failedFastPaths,
      requestsGivenToThePlatform: [...ingress.forwarded, ...lossy.forwarded],
      requestsOfAWorkerWithNoCopy: withoutSecret.forwarded,
      requestsOfAWorkerWithAnOutdatedCopy: outdated.forwarded,
      modelRequests: model.requests,
      deliveredMessages: slack.messages.length,
      progressStatuses: slack.statuses.length,
    },
  });
}

function accepted(decidedBy: Answer["decidedBy"]): Answer {
  return { status: 200, durableMode: "case_accepted", decidedBy };
}

function acceptance(
  eventId: string,
  disposition: string,
  acceptedThrough: Acceptance["acceptedThrough"],
  admittedBy: string,
): Acceptance {
  return { eventId, disposition, acceptedThrough, admittedBy };
}

/**
 * One ingress Worker. Its bindings are the ones of its Wrangler profile, and
 * no other binding of the platform Worker.
 */
function ingressWorker(
  connector: DurableObjectNamespace<ConnectorDO>,
  signingSecret: string | undefined = env.SLACK_SIGNING_SECRET,
): {
  readonly forwarded: string[];
  readonly fetch: (request: Request) => Promise<Response>;
  readonly send: (envelope: Envelope) => Promise<Answer>;
  readonly settled: () => Promise<void>;
} {
  const forwarded: string[] = [];
  const background: Promise<unknown>[] = [];
  const bindings: SlackIngressEnv = {
    DB: env.DB,
    ORGANISATION_DB_WNAM: env.ORGANISATION_DB_WNAM,
    ORGANISATION_DB_APAC: env.ORGANISATION_DB_APAC,
    PANTRY_ORGANISATION_PLACEMENT_PROFILE:
      env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
    VAULT_ROOT_V1: env.VAULT_ROOT_V1,
    VAULT_ROOT_V2: env.VAULT_ROOT_V2,
    PANTRY_VAULT_ACTIVE_KEY_VERSION: env.PANTRY_VAULT_ACTIVE_KEY_VERSION,
    SLACK_SIGNING_SECRET: signingSecret,
    PANTRY_DEPLOYMENT_PROFILE: env.PANTRY_DEPLOYMENT_PROFILE,
    SLACK_APP_ID: env.SLACK_APP_ID,
    CONNECTOR: connector,
    PLATFORM: { fetch: giveToPlatform },
  };
  const context = { waitUntil: keepBackgroundWork };
  return { forwarded, fetch, send, settled };

  function fetch(request: Request): Promise<Response> {
    return handleSlackIngress(request, bindings, context);
  }

  async function send(envelope: Envelope): Promise<Answer> {
    const before = forwarded.length;
    const response = await fetch(
      await signedSlackRequest(slackEnvelope(envelope)),
    );
    const body: unknown = await response.json();
    return {
      status: response.status,
      durableMode: isRecord(body) ? body.durableMode : null,
      decidedBy: forwarded.length === before ? "ingress" : "platform",
    };
  }

  function giveToPlatform(input: RequestInfo | URL): Promise<Response> {
    if (!(input instanceof Request))
      throw new Error("The ingress Worker gives the platform a request");
    forwarded.push(`${input.method} ${new URL(input.url).pathname}`);
    return exports.default.fetch(input);
  }

  function keepBackgroundWork(work: Promise<unknown>): void {
    background.push(work);
  }

  async function settled(): Promise<void> {
    await Promise.all(background);
  }
}

/**
 * A Connector namespace whose Slack admission reaches the Connector and then
 * loses its answer.
 */
function withLostAnswers(
  namespace: DurableObjectNamespace<ConnectorDO>,
): DurableObjectNamespace<ConnectorDO> {
  return new Proxy(namespace, {
    get(target, property): unknown {
      if (property !== "get") return bound(target, property);
      return function getLossyStub(
        ...args: Parameters<typeof target.get>
      ): DurableObjectStub<ConnectorDO> {
        return new Proxy(target.get(...args), { get: lossyStubProperty });
      };
    },
  });
}

function lossyStubProperty(
  stub: DurableObjectStub<ConnectorDO>,
  property: string | symbol,
): unknown {
  if (property !== "admitSlackCaseWork") return Reflect.get(stub, property);
  return async function admitAndLoseTheAnswer(
    ...args: Parameters<typeof stub.admitSlackCaseWork>
  ): Promise<never> {
    const admitted = await stub.admitSlackCaseWork(...args);
    if (!admitted.ok || admitted.value.kind !== "accepted")
      throw new Error("The Connector did not accept the message");
    throw new Error("The answer of the Connector was lost");
  };
}

function bound(target: object, property: string | symbol): unknown {
  const value: unknown = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}

function acceptedWork(
  calls: readonly (readonly unknown[])[],
): readonly Acceptance[] {
  const acceptances: Acceptance[] = [];
  for (const [logged] of calls) {
    if (typeof logged !== "string") continue;
    const row = parseJsonOrNull(logged);
    if (
      !isRecord(row) ||
      row.event !== "integration_gateway.slack.case_accepted"
    )
      continue;
    acceptances.push({
      eventId: String(row.event_id),
      disposition: String(row.disposition),
      acceptedThrough:
        row.ingress_worker === "slack_ingress" ? "ingress" : "platform",
      admittedBy: String(row.admitted_by),
    });
  }
  return acceptances;
}

function tracedEvents(
  calls: readonly (readonly unknown[])[],
  event: string,
): readonly string[] {
  const eventIds: string[] = [];
  for (const [logged] of calls) {
    if (typeof logged !== "string") continue;
    const row = parseJsonOrNull(logged);
    if (isRecord(row) && row.event === event)
      eventIds.push(String(row.event_id));
  }
  return eventIds;
}

function recordingSlack(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly messages: Record<string, string>[];
  readonly statuses: Record<string, string>[];
  readonly messageCount: () => number;
  readonly statusCount: () => number;
} {
  const messages: Record<string, string>[] = [];
  const statuses: Record<string, string>[] = [];
  return {
    messages,
    statuses,
    messageCount: countOf.bind(null, messages),
    statusCount: countOf.bind(null, statuses),
    handler: http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, { messages, statuses }),
    ),
  };
}

function countOf(rows: readonly unknown[]): number {
  return rows.length;
}

async function respondToSlack(
  recorded: {
    readonly messages: Record<string, string>[];
    readonly statuses: Record<string, string>[];
  },
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  // Every Slack call must carry this organisation's bot credential.
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const body: unknown = slackPostFields(await request.json());
  if (!isStringRecord(body)) throw new Error("Slack request body is invalid");
  switch (params.method) {
    case "assistant.threads.setStatus":
      recorded.statuses.push(body);
      return HttpResponse.json({ ok: true });
    case "chat.postEphemeral":
      return HttpResponse.json({ ok: true });
    case "chat.postMessage":
      recorded.messages.push(body);
      return HttpResponse.json({
        ok: true,
        channel: body.channel,
        ts: `1787500001.${String(recorded.messages.length).padStart(6, "0")}`,
      });
    default:
      throw new Error(`Unexpected Slack method: ${String(params.method)}`);
  }
}
