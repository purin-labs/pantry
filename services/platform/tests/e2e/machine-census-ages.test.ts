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

/**
 * The census of Actor states says how old each stuck row is (Refactor 15,
 * S5).
 *
 * A person asks Pantry a question in Slack, and the thread gets the answer.
 * The Case then holds two answers that nothing delivered: one from two days
 * ago, and one whose journal entry is gone, so no time says how old it is.
 * The Case also has no alarm, so no reconciler wakes for either answer. The
 * admin census counts both pending answers, names the one past its exit in
 * an Actor with no alarm, and names the one with no time, so an operator can
 * tell a stuck row from a new one.
 */
it(
  "names the age of stuck Actor rows, the rows with no time, and an Actor with no alarm",
  censusAgesJourney,
  60_000,
);

const DAY_MS = 24 * 60 * 60_000;

async function censusAgesJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () =>
      openRouterText("The proofer holds 40 trays tonight.", "answer"),
    ),
    slack.handler,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvR15CensusAges",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0SATYR> how many trays does the proofer hold tonight?",
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

  // The faults: two undelivered answers and a Case with no alarm.
  await runInDurableObject(caseActor, seedStuckAnswers);

  const census = await machineCensus();
  expect(census.machines.case_output?.pending).toBe(2);
  const pending = census.ages.case_output?.pending;
  expect(pending).toMatchObject({
    pastExit: 1,
    pastExitNoAlarm: 1,
    untimed: 1,
  });
  expect(pending?.oldestAgeMs).toBeGreaterThan(2 * DAY_MS);
  expect(slack.visibleMessageCount()).toBe(1);
  Object.assign(test.task.meta, { machineCensusAges: census.ages });
}

/**
 * Copies the settled answer as two pending answers. The first names the
 * settled answer's journal entry, dated two days back; the second names an
 * entry that the journal no longer holds. Then it removes the Case alarm.
 */
async function seedStuckAnswers(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const sql = state.storage.sql;
  const settled = sql
    .exec<{ lifecycle_json: string }>(
      "SELECT lifecycle_json FROM case_output WHERE json_extract(lifecycle_json, '$.kind') = 'settled' LIMIT 1",
    )
    .one();
  const { output } = JSON.parse(settled.lifecycle_json) as {
    output: { entryId: string };
  };
  const answers = [
    { id: "output_census_dated", output },
    {
      id: "output_census_untimed",
      output: { ...output, entryId: "entry_census_journal_gone" },
    },
  ];
  for (const answer of answers)
    sql.exec(
      "INSERT INTO case_output (output_id, delivery_id, idempotency_key, lifecycle_json) VALUES (?, ?, ?, ?)",
      answer.id,
      `${answer.id}_delivery`,
      `${answer.id}_key`,
      JSON.stringify({ kind: "pending", output: answer.output }),
    );
  sql.exec(
    "UPDATE case_journal SET accepted_at = ? WHERE entry_id = ?",
    Date.now() - 2 * DAY_MS - 60_000,
    output.entryId,
  );
  await state.storage.deleteAlarm();
}

type StateAge = Readonly<{
  oldestAgeMs: number | null;
  pastExit: number;
  pastExitNoAlarm: number;
  untimed: number;
}>;

/** The admin census of Actor states: counts and row ages. */
async function machineCensus(): Promise<{
  machines: Record<string, Record<string, number>>;
  ages: Record<string, Record<string, StateAge>>;
}> {
  const response = await exports.default.fetch(
    new Request("https://localhost/v1/admin/machine-census", {
      headers: { authorization: `Bearer ${env.ORGANISATION_ADMIN_TOKEN}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    machines?: Record<string, Record<string, number>>;
    ages?: Record<string, Record<string, StateAge>>;
  };
  return { machines: body.machines ?? {}, ages: body.ages ?? {} };
}
