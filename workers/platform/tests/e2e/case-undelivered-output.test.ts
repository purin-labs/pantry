import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";

import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  ROOT_TS,
  installSlackActorFixture,
  openRouterText,
  signedSlackRequest,
  slackEnvelope,
  slackSimulator,
} from "./slack-journey-support";
import { runArmedAlarm } from "./durable-object-alarm-support";

/**
 * An answer that nothing delivered ends (Refactor 15, refactor 2).
 *
 * A person asks Pantry a question in Slack, and the thread gets the answer.
 * The Case then also holds an answer that waited a day for a delivery that
 * never came, as after a Connector that gave up on its Case work. The Case
 * alarm drops that answer as undelivered, so no later path sends it, and the
 * answer that the thread got stays settled. The census of Actor states
 * counts the pending answer before the alarm and none after it.
 */
it(
  "drops an answer that waited a day for its delivery, and keeps the delivered one",
  undeliveredOutputJourney,
  60_000,
);

const STALE_OUTPUT = "output_undelivered_journey";
const DAY_MS = 24 * 60 * 60_000;

async function undeliveredOutputJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () =>
      openRouterText("Tomorrow's order holds 120 croissants.", "answer"),
    ),
    slack.handler,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvR15UndeliveredOutput",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0PANTRY> check tomorrow's croissant order",
      }),
    ),
  );
  expect(asked.status).toBe(200);
  await expect
    .poll(() => slack.visibleMessageCount(), { timeout: 30_000 })
    .toBe(1);
  const registry = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'case' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (registry === null) throw new Error("Case Actor missing");
  const caseActor = env.CASE.getByName(registry.name);
  // The thread shows the answer before the Connector's receipt settles it in
  // the Case. On a slow machine the seed below found no settled answer yet
  // (CI run 45147079820).
  await expect
    .poll(() => runInDurableObject(caseActor, readOutputs), { timeout: 30_000 })
    .toEqual([{ outputId: expect.any(String), kind: "settled", reason: null }]);

  // The fault: an answer from a day ago that is still pending.
  await runInDurableObject(caseActor, seedStalePendingOutput);
  expect(await runInDurableObject(caseActor, readOutputs)).toEqual([
    { outputId: STALE_OUTPUT, kind: "pending", reason: null },
    { outputId: expect.any(String), kind: "settled", reason: null },
  ]);

  // The census of Actor states counts it (Refactor 15, S5).
  expect(await pendingOutputCount()).toBe(1);

  await runArmedAlarm(caseActor);
  expect(await pendingOutputCount()).toBe(0);
  const outputs = await runInDurableObject(caseActor, readOutputs);
  expect(outputs).toEqual([
    { outputId: STALE_OUTPUT, kind: "dropped", reason: "undelivered" },
    { outputId: expect.any(String), kind: "settled", reason: null },
  ]);
  expect(slack.visibleMessageCount()).toBe(1);
  Object.assign(test.task.meta, { caseUndeliveredOutput: { outputs } });
}

/**
 * Copies the settled answer as a second answer that is still pending, and
 * dates the journal entry that both name one day and one minute back.
 */
function seedStalePendingOutput(
  _actor: unknown,
  state: DurableObjectState,
): void {
  const sql = state.storage.sql;
  const settled = sql
    .exec<{ lifecycle_json: string }>(
      "SELECT lifecycle_json FROM case_output WHERE json_extract(lifecycle_json, '$.kind') = 'settled' LIMIT 1",
    )
    .one();
  const lifecycle = JSON.parse(settled.lifecycle_json) as {
    output: { entryId: string };
  };
  sql.exec(
    "INSERT INTO case_output (output_id, delivery_id, idempotency_key, lifecycle_json) VALUES (?, ?, ?, ?)",
    STALE_OUTPUT,
    `${STALE_OUTPUT}_delivery`,
    `${STALE_OUTPUT}_key`,
    JSON.stringify({ kind: "pending", output: lifecycle.output }),
  );
  sql.exec(
    "UPDATE case_journal SET accepted_at = ? WHERE entry_id = ?",
    Date.now() - DAY_MS - 60_000,
    lifecycle.output.entryId,
  );
}

function readOutputs(
  _actor: unknown,
  state: DurableObjectState,
): { outputId: string; kind: string; reason: string | null }[] {
  return state.storage.sql
    .exec<{ outputId: string; kind: string; reason: string | null }>(
      `SELECT output_id AS outputId,
              json_extract(lifecycle_json, '$.kind') AS kind,
              json_extract(lifecycle_json, '$.reason') AS reason
       FROM case_output
       ORDER BY output_id = ? DESC, output_id`,
      STALE_OUTPUT,
    )
    .toArray();
}

/** The pending Case outputs that the admin census route counts. */
async function pendingOutputCount(): Promise<number> {
  const response = await exports.default.fetch(
    new Request("https://localhost/v1/admin/machine-census", {
      headers: { authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}` },
    }),
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const machines =
    typeof body === "object" && body !== null && "machines" in body
      ? (body.machines as Record<string, Record<string, number>>)
      : {};
  return machines.case_output?.pending ?? 0;
}
