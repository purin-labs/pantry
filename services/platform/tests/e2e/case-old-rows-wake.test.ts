import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { http } from "msw";
import { expect, it, type TestContext } from "vitest";

import type { MachineCensus } from "../../src/actors/lifecycle/machine-census";
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
 * Old Case rows with no wakeup end when their Case wakes (Refactor 15).
 *
 * The production census found an answer 478 hours old that nothing
 * delivered, and an approval wait 94 hours old, each in a Case with no
 * alarm. Only new work sets the wakeup of an alarm step, so a row from a
 * release before that step had none. The approval step also read only the
 * approval that the Case still waits for.
 *
 * A person asks Pantry a question in Slack, and the thread gets the answer.
 * The journey then gives the Case the rows that the earlier release left:
 * an undelivered answer from 20 days ago, a waiting approval from 4 days ago
 * that the Case no longer waits for and whose action the ledger does not
 * hold, its assignment ended as abandoned (as the earlier fix ended every
 * old one), and no alarm. The Case's process ends. When the Case wakes for any
 * read, it sets its wakeup; that wakeup drops the old answer as undelivered
 * and lapses the old approval, and the thread still has one answer.
 */
it(
  "ends an old undelivered answer and an old approval wait when their Case wakes",
  oldRowsWakeJourney,
  120_000,
);

const DAY_MS = 24 * 60 * 60_000;
const OLD_OUTPUT = "output_old_rows_wake";
const OLD_APPROVAL_NONCE = "nonce_old_rows_wake";

async function oldRowsWakeJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  const slack = slackSimulator();
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () =>
      openRouterText("The walk-in holds 18 kg of butter.", "answer"),
    ),
    slack.handler,
  );
  const asked = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelope({
        eventType: "app_mention",
        eventId: "EvR15OldRowsWake",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: "<@U0SATYR> how much butter is in the walk-in?",
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
  const stopped = env.CASE.getByName(registry.name);
  // The rows that the earlier release left, then the end of the process.
  await runInDurableObject(stopped, leaveEarlierReleaseRows);
  const before = await openAges(stopped);
  expect(before).toEqual({
    "case_approval_wait.waiting": { pastExitNoAlarm: 1, untimed: 0 },
    "case_output.pending": { pastExitNoAlarm: 1, untimed: 0 },
  });
  await runInDurableObject(stopped, loseProcess).catch(ignoreLostProcess);

  // The Case wakes for a read. Its wakeup ends both rows.
  const woken = env.CASE.getByName(registry.name);
  await expect
    .poll(
      async () => {
        await runDurableObjectAlarm(woken);
        return runInDurableObject(woken, readOldRows);
      },
      { timeout: 10_000, interval: 250 },
    )
    .toEqual({ output: "dropped:undelivered", approval: "lapsed" });
  expect(await openAges(woken)).toEqual({});
  expect(slack.visibleMessageCount()).toBe(1);
  Object.assign(test.task.meta, {
    caseOldRowsWake: {
      before,
      after: await runInDurableObject(woken, readOldRows),
    },
  });
}

/**
 * What a Case of the earlier release holds: an answer from 20 days ago that
 * nothing delivered, a waiting approval from 4 days ago that the Case no
 * longer waits for and whose action the ledger does not hold, each
 * assignment ended as abandoned, and no alarm.
 */
async function leaveEarlierReleaseRows(
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
  sql.exec(
    "INSERT INTO case_output (output_id, delivery_id, idempotency_key, lifecycle_json) VALUES (?, ?, ?, ?)",
    OLD_OUTPUT,
    `${OLD_OUTPUT}_delivery`,
    `${OLD_OUTPUT}_key`,
    JSON.stringify({ kind: "pending", output }),
  );
  sql.exec(
    "UPDATE case_journal SET accepted_at = ? WHERE entry_id = ?",
    Date.now() - 20 * DAY_MS,
    output.entryId,
  );
  const caseId = sql
    .exec<{ case_id: string }>(
      "SELECT case_id FROM case_meta WHERE singleton = 1",
    )
    .one().case_id;
  const proposalId = "proposal_old_rows_wake";
  sql.exec(
    "INSERT INTO case_commerce_approval (action_nonce, proposal_id, payload) VALUES (?, ?, ?)",
    OLD_APPROVAL_NONCE,
    proposalId,
    JSON.stringify({
      kind: "waiting",
      request: {
        caseId,
        proposalId,
        actionNonce: OLD_APPROVAL_NONCE,
        expectedCaseRevision: 1,
        requestedAt: Date.now() - 4 * DAY_MS,
      },
    }),
  );
  const old = Date.now() - 20 * DAY_MS;
  const active = sql
    .exec<{ assignment_id: string; lifecycle_json: string }>(
      "SELECT assignment_id, lifecycle_json FROM case_assignment WHERE json_extract(lifecycle_json, '$.kind') IN ('assigned', 'running')",
    )
    .toArray();
  for (const row of active) {
    const lifecycle = JSON.parse(row.lifecycle_json) as {
      kind: "assigned" | "running";
      assignment: { assignmentId: string; sessionId: string };
      start?: unknown;
    };
    const settled = {
      kind: "settled",
      assignment: lifecycle.assignment,
      start: lifecycle.start ?? {
        startId: `start_abandoned_${lifecycle.assignment.assignmentId}`,
        sessionId: lifecycle.assignment.sessionId,
        acceptedAt: old,
      },
      disposition: {
        kind: "abandoned",
        reason:
          lifecycle.kind === "running" ? "session_quiescent" : "never_started",
        settledAt: old,
      },
    };
    sql.exec(
      "UPDATE case_assignment SET lifecycle_json = ? WHERE assignment_id = ?",
      JSON.stringify(settled),
      row.assignment_id,
    );
  }
  await state.storage.deleteAlarm();
}

function readOldRows(
  _actor: unknown,
  state: DurableObjectState,
): { output: string | null; approval: string | null } {
  const sql = state.storage.sql;
  const output = sql
    .exec<{ kind: string; reason: string | null }>(
      `SELECT json_extract(lifecycle_json, '$.kind') AS kind,
              json_extract(lifecycle_json, '$.reason') AS reason
       FROM case_output WHERE output_id = ?`,
      OLD_OUTPUT,
    )
    .toArray()[0];
  const approval = sql
    .exec<{ kind: string }>(
      "SELECT json_extract(payload, '$.kind') AS kind FROM case_commerce_approval WHERE action_nonce = ?",
      OLD_APPROVAL_NONCE,
    )
    .toArray()[0];
  return {
    output:
      output === undefined
        ? null
        : output.reason === null
          ? output.kind
          : `${output.kind}:${output.reason}`,
    approval: approval?.kind ?? null,
  };
}

/**
 * The Case's open states that hold a row past its exit or a row with no
 * time, as the census reads them.
 */
async function openAges(
  caseActor: DurableObjectStub<import("../../src/actors/case").CaseDO>,
): Promise<Record<string, { pastExitNoAlarm: number; untimed: number }>> {
  const census: readonly MachineCensus[] = await caseActor.machineCensus();
  const open: Record<string, { pastExitNoAlarm: number; untimed: number }> = {};
  for (const entry of census)
    for (const [state, age] of Object.entries(entry.ages ?? {}))
      if (age.pastExit > 0 || age.untimed > 0)
        open[`${entry.machine}.${state}`] = {
          pastExitNoAlarm: age.pastExitNoAlarm,
          untimed: age.untimed,
        };
  return open;
}

function loseProcess(_actor: unknown, state: DurableObjectState): void {
  state.abort("Old rows journey: the Actor's process is lost");
}

function ignoreLostProcess(): void {}
