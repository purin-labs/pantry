import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@seams/std";

import {
  listPlacementActorRegistryEntries,
  type ActorRegistryEntry,
} from "../../src/actors/actor-registry";
import { connectorActorStub } from "../../src/actors/actor-router";
import { network } from "./network";
import {
  ORGANISATION_ID,
  ROOT_TS,
  SLACK_BOT_TOKEN,
  installSlackActorFixture,
  isStringRecord,
  slackPostFields,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  shownSlackPost,
} from "./slack-journey-support";

/**
 * A new thread's Case and Session are created together, before the Case is
 * asked to admit the message. This journey shows that a message with no agent
 * turn creates no Session.
 */
type ActorSummary = {
  readonly kind: string;
  readonly registryId: string;
  readonly lifecycle: string;
};

type Recorded = {
  modelRequests: number;
  readonly delivered: Record<string, string>[];
};

const ANSWER = "The thread is open.";

it(
  "creates no Session for a goal message that opens a thread",
  goalThreadJourney,
  60_000,
);

async function goalThreadJourney(test: TestContext): Promise<void> {
  const fixture = await installSlackActorFixture();
  const recorded = observeProviders();

  await acceptSlack({
    eventType: "app_mention",
    eventId: "Ev55E_PAIR_GOAL",
    messageTs: ROOT_TS,
    threadTs: ROOT_TS,
    text: "<@U0SATYR> goal status",
  });
  await expect
    .poll(countOf.bind(null, recorded.delivered), { timeout: 15_000 })
    .toBe(1);
  const connector = await connectorOf(fixture.connectorId);
  await expect
    .poll(caseWork.bind(null, connector), { timeout: 15_000 })
    .toEqual([]);

  const actors = await threadActors();
  expect(actors.map(kindAndLifecycle)).toEqual(["case active"]);
  expect(recorded.modelRequests).toBe(0);

  Object.assign(test.task.meta, {
    slackGoalThreadActors: {
      actors,
      modelRequests: recorded.modelRequests,
      deliveries: recorded.delivered.length,
    },
  });
}

function observeProviders(): Recorded {
  const recorded: Recorded = { modelRequests: 0, delivered: [] };
  network.use(
    http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      replyToModel.bind(null, recorded),
    ),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, recorded),
    ),
  );
  return recorded;
}

async function acceptSlack(
  envelope: Parameters<typeof slackEnvelope>[0],
): Promise<void> {
  const response = await exports.default.fetch(
    await signedSlackRequest(slackEnvelope(envelope)),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(isRecord(body) ? body.durableMode : null).toBe("case_accepted");
}

async function registryEntries(): Promise<readonly ActorRegistryEntry[]> {
  const entries = await listPlacementActorRegistryEntries({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    placementEpoch: 1,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  return entries.value;
}

/** The Case and Session entries of the organisation, in registry order. */
async function threadActors(): Promise<readonly ActorSummary[]> {
  return (await registryEntries())
    .filter(isThreadActor)
    .map(function summarise(entry): ActorSummary {
      return {
        kind: entry.identity.objectKind,
        registryId: entry.registryId,
        lifecycle: entry.lifecycleStatus,
      };
    });
}

function isThreadActor(entry: ActorRegistryEntry): boolean {
  return (
    entry.identity.objectKind === "case" ||
    entry.identity.objectKind === "session"
  );
}

function kindAndLifecycle(actor: ActorSummary): string {
  return `${actor.kind} ${actor.lifecycle}`;
}

async function connectorOf(connectorId: string) {
  const entry = (await registryEntries()).find(function isConnector(candidate) {
    return (
      candidate.identity.objectKind === "connector" &&
      candidate.identity.logicalObjectId === connectorId
    );
  });
  if (entry === undefined) throw new Error("Connector registry entry missing");
  return connectorActorStub(
    env.CONNECTOR,
    entry.physicalObjectName,
    entry.placement,
  );
}

/** The Connector's unsettled Slack work, as its state and attempt. */
function caseWork(
  connector: Awaited<ReturnType<typeof connectorOf>>,
): Promise<readonly { readonly state: string; readonly attempt: number }[]> {
  return runInDurableObject(connector, readCaseWork);
}

function readCaseWork(
  _actor: unknown,
  ctx: DurableObjectState,
): readonly { readonly state: string; readonly attempt: number }[] {
  return ctx.storage.sql
    .exec<{ state_kind: string; attempt: number }>(
      "SELECT state_kind, attempt FROM connector_case_work ORDER BY created_at",
    )
    .toArray()
    .map(function workState(row) {
      return { state: row.state_kind, attempt: row.attempt };
    });
}

function countOf(rows: readonly unknown[]): number {
  return rows.length;
}

async function replyToModel(
  recorded: Recorded,
  { request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  recorded.modelRequests += 1;
  await request.json();
  return openRouterText(ANSWER, "chatcmpl_55e_pair");
}

async function respondToSlack(
  recorded: Recorded,
  { params, request }: Parameters<HttpResponseResolver>[0],
): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${SLACK_BOT_TOKEN}`)
    return HttpResponse.json({ ok: false, error: "invalid_auth" });
  const raw: unknown = slackPostFields(await request.json());
  if (!isStringRecord(raw)) throw new Error("Slack request body is invalid");
  const body = shownSlackPost(raw);
  if (params.method === "chat.postMessage") {
    recorded.delivered.push(body);
    return HttpResponse.json({
      ok: true,
      channel: body.channel,
      ts: `1787500950.${String(recorded.delivered.length).padStart(6, "0")}`,
    });
  }
  return HttpResponse.json({ ok: true });
}
