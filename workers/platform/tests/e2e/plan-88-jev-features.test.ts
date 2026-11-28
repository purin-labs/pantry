// Plan 88 phase 1: Jev from Pantry. Journeys J1, J2 and J6 of
// docs/history/plan-88-satyr-funded-jev.md. The fake TypeSafe only records the key and
// the purpose of each request and answers; product code chooses the key, writes
// the switch records and refuses the requests that the journeys assert.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { typeSafeMonth } from "@purin-labs/agent/typesafe/usage-store";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { commerceClient } from "./commerce-support";
import { fixtureDatabase } from "./organisation-database";
import { addOrganisationMember } from "./organisation-fixture";
import { controlFetch } from "./chat-journey-support";
import { WriteMeter } from "./write-meter";
import { runArmedAlarm } from "./durable-object-alarm-support";
import {
  change,
  features,
  installFakes,
  PANTRY_KEY,
  preview,
  shop,
} from "./jev-journey-support";

const OWN_KEY = "typesafe-own-e2e-key-00000000000";

it(
  "J1 and J2: an Organisation with no TypeSafe key sorts mail with Pantry's key, and a switch turned off stops its feature for admins only",
  noKeyJourney,
  120_000,
);

it(
  "J6: an Organisation with its own key sorts mail with that key, and the mail switch stays on across the key change",
  ownKeyJourney,
  120_000,
);

it(
  "J3: at the free use of the month a Jev call fails before any TypeSafe request, the page names the reset date, and a call accepted before the stop settles",
  allowanceJourney,
  120_000,
);

async function allowanceJourney(): Promise<void> {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = installFakes(held);
  const { organisationId, owner, accountId } = await shop("p88-allowance");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  // Seed: earlier Jev use of this month on Pantry's key, as the ledger records it.
  await runInDurableObject(
    organisation,
    seedPantryUse.bind(null, organisationId, "earlier-use", 990_000),
  );
  expect((await features(organisationId, owner.session)).allowance).toEqual({
    usedMicrousd: 990_000,
    limitMicrousd: 1_000_000,
    resetsAt: typeSafeMonth(Date.now()).next,
    reached: false,
  });

  // A call is accepted while it fits, and stays in flight at TypeSafe.
  const accepted = preview(organisationId, owner.session, accountId, ["m1"]);
  await expect.poll(() => calls.length, { timeout: 10_000 }).toBe(1);
  // Meanwhile other Jev use of the month takes the rest of the free use.
  await runInDurableObject(
    organisation,
    seedPantryUse.bind(null, organisationId, "other-use", 8_000),
  );

  // The next call fails before any TypeSafe request.
  const refused = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(refused.status).not.toBe(200);
  expect(await refused.text()).toContain("allowance_reached");
  expect(calls).toHaveLength(1);

  // The call accepted before the stop settles with its answer.
  release();
  const settled = await accepted;
  expect(settled.status, await settled.clone().text()).toBe(200);
  expect(await settled.json()).toMatchObject({
    kind: "preview",
    classifications: [{ messageId: "m1", outcome: "matched" }],
  });

  // The page says the free use is used and names the reset date.
  const view = await features(organisationId, owner.session);
  expect(view.allowance).toMatchObject({
    limitMicrousd: 1_000_000,
    resetsAt: typeSafeMonth(Date.now()).next,
    reached: true,
  });
  expect(view.allowance?.usedMicrousd).toBeGreaterThan(998_000);
  expect(calls).toHaveLength(1);
}

/** One settled Pantry-funded related Cases row: other Jev use of the current month. */
function seedPantryUse(
  organisationId: OrganisationId,
  evaluationId: string,
  costMicrousd: number,
  _actor: unknown,
  state: DurableObjectState,
): void {
  const at = Math.max(typeSafeMonth(Date.now()).start, Date.now() - 5_000);
  state.storage.sql.exec(
    `INSERT INTO typesafe_evaluation (
      organisation_id, purpose, evaluation_id, request_digest, policy_revision, funding,
      connection_revision, disclosure_decision_digest, input_bytes, reserved_input_tokens,
      reserved_wall_ms, reserved_cost_microusd, estimated_cost_microusd, input_tokens,
      output_tokens, reserved_at, expires_at, state, settlement_state, failure_code
    ) VALUES (?, 'case_context_discovery_relationship', ?, ?, 1, 'pantry_platform', NULL, ?, 100, 100,
      1000, ?, ?, 100, 0, ?, ?, 'evaluated', 'settled', NULL)`,
    organisationId,
    evaluationId,
    "a".repeat(64),
    "b".repeat(64),
    costMicrousd,
    costMicrousd,
    at,
    at + 1_000,
  );
}

it(
  "J4: a closed hour of Jev use on Pantry's key becomes one record for each feature, with the exact token total, and a later hour with no use writes nothing",
  recordsJourney,
  120_000,
);

const HOUR_MS = 3_600_000;

async function recordsJourney(): Promise<void> {
  installFakes();
  const { organisationId } = await shop("p88-records");
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  // Seed: the ledger rows of a closed hour, as the Jev calls of that hour wrote
  // them. An hour closes 5 minutes after its end, so in the first 5 minutes of
  // an hour the newest closed hour is two hours back. The seed sits three hours
  // back: the hour that the idle alarm below opens again never holds it.
  const closedHour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 3 * HOUR_MS;
  await runInDurableObject(
    organisation,
    seedHourLedger.bind(null, organisationId, closedHour),
  );
  await runArmedAlarm(organisation);

  // One record for each feature: mail 120 + 30, related Cases 70. The call on
  // the Organisation's own key in the same hour is not Pantry's use. Pantry
  // sends no hour to a meter until its own billing (Plan 95 step 6).
  expect(await runInDurableObject(organisation, readHours)).toEqual([
    { feature: "mail_classification", inputTokens: 150, state: "not_billed" },
    { feature: "related_cases", inputTokens: 70, state: "not_billed" },
  ]);

  // The Actor's alarm runs again for other work in the same hour: what any
  // alarm with nothing to seal writes.
  const meter = new WriteMeter();
  await runInDurableObject(organisation, armAlarmForOtherWork);
  const sameHour = await meter.during(async () => {
    await runArmedAlarm(organisation);
  });
  // An hour passes with no Jev use, and the alarm runs again. The seal step
  // finds no call in the new closed hour, so it writes no row more.
  await runInDurableObject(organisation, lastSealAnHourEarlier);
  const idleHour = await meter.during(async () => {
    await runArmedAlarm(organisation);
  });
  expect(
    idleHour,
    "rows of an alarm in a new hour with no Jev use, against the same hour",
  ).toEqual(sameHour);
  expect(await runInDurableObject(organisation, readHours)).toHaveLength(2);
}

async function armAlarmForOtherWork(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

/**
 * The seal step last ran one hour earlier, and an alarm for other work is
 * due: what an hour later looks like to the Actor.
 */
async function lastSealAnHourEarlier(
  actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  state.storage.sql.exec(
    "UPDATE jev_usage_cursor SET sealed_before = sealed_before - ?",
    HOUR_MS,
  );
  await armAlarmForOtherWork(actor, state);
}

async function seedHourLedger(
  organisationId: OrganisationId,
  hourStart: number,
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const rows: readonly [string, string, string, number][] = [
    ["mail_classification", "hour-mail-1", "pantry_platform", 120],
    ["mail_classification", "hour-mail-2", "pantry_platform", 30],
    [
      "case_context_discovery_relationship",
      "hour-related-1",
      "pantry_platform",
      70,
    ],
    ["mail_classification", "hour-own-key", "organisation_byo", 500],
  ];
  for (const [purpose, evaluationId, funding, tokens] of rows) {
    const at = hourStart + 60_000;
    state.storage.sql.exec(
      `INSERT INTO typesafe_evaluation (
        organisation_id, purpose, evaluation_id, request_digest, policy_revision, funding,
        connection_revision, disclosure_decision_digest, input_bytes, reserved_input_tokens,
        reserved_wall_ms, reserved_cost_microusd, estimated_cost_microusd, input_tokens,
        output_tokens, reserved_at, expires_at, state, settlement_state, failure_code
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 100, 1000, 1000, 3000, ?, ?, 0, ?, ?, 'evaluated', 'settled', NULL)`,
      organisationId,
      purpose,
      evaluationId,
      "a".repeat(64),
      funding,
      funding === "organisation_byo" ? 1 : null,
      "b".repeat(64),
      Math.ceil(tokens * 0.042),
      tokens,
      at,
      at + 10_000,
    );
  }
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

function readHours(
  _actor: unknown,
  state: DurableObjectState,
): readonly { feature: string; inputTokens: number; state: string }[] {
  return state.storage.sql
    .exec<{ feature: string; input_tokens: number; state: string }>(
      "SELECT feature, input_tokens, state FROM jev_usage_hour ORDER BY feature",
    )
    .toArray()
    .map((row) => ({
      feature: row.feature,
      inputTokens: row.input_tokens,
      state: row.state,
    }));
}

async function noKeyJourney(): Promise<void> {
  const calls = installFakes();
  const { organisationId, owner, accountId } = await shop("p88-no-key");
  const operator = await commerceClient("p88-no-key-operator");
  await addOrganisationMember(organisationId, operator, "operator");

  // J1: no key of its own; Pantry's key funds Jev, and every switch starts off.
  const initial = await features(organisationId, owner.session);
  expect(initial).toMatchObject({
    funding: "pantry_platform",
    keyAvailable: true,
    mailClassification: {
      enabled: false,
      mailboxes: [{ integrationAccountId: accountId, covered: false }],
    },
    relatedCases: { enabled: false, mode: null },
    screenRelevance: { enabled: false },
  });
  expect((await preview(organisationId, owner.session, accountId)).status).toBe(
    409,
  );
  expect(calls).toEqual([]);

  const mailOn = await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  expect(mailOn.mailClassification).toMatchObject({
    enabled: true,
    mailboxes: [{ integrationAccountId: accountId, covered: true }],
  });
  const sorted = await preview(organisationId, owner.session, accountId);
  expect(sorted.status, await sorted.clone().text()).toBe(200);
  expect(await sorted.json()).toMatchObject({
    kind: "preview",
    classifications: [
      { messageId: "m1", ruleId: "rule_supplier", outcome: "matched" },
    ],
  });
  expect(calls).toEqual([{ key: PANTRY_KEY, purpose: "mail" }]);
  // No key of the Organisation exists, so no Vault key was read.
  expect(await typeSafeVaultSecrets(organisationId)).toBe(0);

  // J2: a non-admin reads the switches but cannot change one.
  expect((await features(organisationId, operator.session)).funding).toBe(
    "pantry_platform",
  );
  const refused = await controlFetch(
    organisationId,
    operator.session,
    "jev-features",
    {
      feature: "related_cases",
      enabled: true,
    },
  );
  // The role check hides an admin route from a lower role.
  expect(refused.status).toBe(404);
  expect((await features(organisationId, owner.session)).relatedCases).toEqual({
    enabled: false,
    mode: null,
    sourceCount: 0,
  });

  // J2: the admin turns related Cases on and off; off leaves no Jev route for a new Case.
  const relatedOn = await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: true,
  });
  expect(relatedOn.relatedCases).toEqual({
    enabled: true,
    mode: "metadata_only",
    sourceCount: 1,
  });
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  expect(
    await organisation.readCaseContextDiscoverySourceReadiness({
      organisationId,
      source: "gmail",
      integrationAccountId: accountId,
    }),
  ).toMatchObject({ ok: true, value: { kind: "ready" } });
  const relatedOff = await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: false,
  });
  expect(relatedOff.relatedCases.enabled).toBe(false);
  expect(
    await organisation.readCaseContextDiscoverySourceReadiness({
      organisationId,
      source: "gmail",
      integrationAccountId: accountId,
    }),
  ).toEqual({ ok: true, value: { kind: "inactive", reason: "disabled" } });

  // Mail classification still works after related Cases is off.
  const stillSorted = await preview(organisationId, owner.session, accountId, [
    "m2",
  ]);
  expect(stillSorted.status, await stillSorted.clone().text()).toBe(200);
  expect(calls).toEqual([
    { key: PANTRY_KEY, purpose: "mail" },
    { key: PANTRY_KEY, purpose: "mail" },
  ]);

  // Mail off stops new calls at once.
  const mailOff = await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: false,
  });
  expect(mailOff.mailClassification.enabled).toBe(false);
  expect(
    (await preview(organisationId, owner.session, accountId, ["m3"])).status,
  ).toBe(409);
  expect(calls).toHaveLength(2);

  // The screen relevance switch has its own record.
  const screenOn = await change(organisationId, owner.session, {
    feature: "screen_relevance",
    enabled: true,
  });
  expect(screenOn.screenRelevance.enabled).toBe(true);
  expect(
    (
      await controlFetch(organisationId, operator.session, "jev-features", {
        feature: "screen_relevance",
        enabled: false,
      })
    ).status,
  ).toBe(404);
  expect(
    (await features(organisationId, owner.session)).screenRelevance.enabled,
  ).toBe(true);
}

async function ownKeyJourney(): Promise<void> {
  const calls = installFakes();
  const { organisationId, owner, accountId } = await shop("p88-own-key");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  await change(organisationId, owner.session, {
    feature: "related_cases",
    enabled: true,
  });

  // The admin connects the Organisation's own key; the probe uses that key.
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: OWN_KEY,
    },
  );
  expect(connected.status, await connected.clone().text()).toBe(200);
  expect(calls).toEqual([{ key: OWN_KEY, purpose: "probe" }]);

  // Both switches stay on, now pinned to the Organisation's key.
  const view = await features(organisationId, owner.session);
  expect(view).toMatchObject({
    funding: "organisation_byo",
    keyAvailable: true,
    mailClassification: {
      enabled: true,
      mailboxes: [{ integrationAccountId: accountId, covered: true }],
    },
    relatedCases: { enabled: true, mode: "metadata_only" },
  });

  const sorted = await preview(organisationId, owner.session, accountId);
  expect(sorted.status, await sorted.clone().text()).toBe(200);
  // Every call used the Organisation's key; none used Pantry's key.
  expect(calls).toEqual([
    { key: OWN_KEY, purpose: "probe" },
    { key: OWN_KEY, purpose: "mail" },
  ]);
  expect(calls.some((call) => call.key === PANTRY_KEY)).toBe(false);

  // The admin removes the key: the switches move back to Pantry's key.
  const disconnected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    { operation: "disconnect", expectedRevision: 1 },
  );
  expect(disconnected.status, await disconnected.clone().text()).toBe(200);
  expect(await features(organisationId, owner.session)).toMatchObject({
    funding: "pantry_platform",
    mailClassification: { enabled: true },
    relatedCases: { enabled: true },
  });
  const back = await preview(organisationId, owner.session, accountId, ["m2"]);
  expect(back.status, await back.clone().text()).toBe(200);
  expect(calls.at(-1)).toEqual({ key: PANTRY_KEY, purpose: "mail" });
}

it(
  "J6: when the move of the mail switch to a new key fails, the Organisation tries it again, and each mailbox stays on",
  repinRetryJourney,
  120_000,
);

async function repinRetryJourney(): Promise<void> {
  installFakes();
  const { organisationId, owner, accountId } = await shop("p88-repin");
  await change(organisationId, owner.session, {
    feature: "mail_classification",
    enabled: true,
  });
  // The regional database refuses the move of the mailbox to the new key one
  // time, as a lost write does.
  await fixtureDatabase()
    .prepare(
      `CREATE TRIGGER refuse_mail_repin BEFORE INSERT ON mail_classification_eligibility
       WHEN NEW.funding = 'organisation_byo'
       BEGIN SELECT RAISE(ABORT, 'mail_repin_refused'); END`,
    )
    .run();
  const connected = await controlFetch(
    organisationId,
    owner.session,
    "integrations/typesafe",
    {
      operation: "connect",
      expectedRevision: 0,
      provider: "typesafe",
      apiKey: OWN_KEY,
    },
  );
  expect(connected.status, await connected.clone().text()).toBe(200);
  await fixtureDatabase().prepare("DROP TRIGGER refuse_mail_repin").run();
  // For now the mail switch reads as off: no mailbox is on under the key.
  expect(await features(organisationId, owner.session)).toMatchObject({
    funding: "organisation_byo",
    mailClassification: {
      enabled: false,
      mailboxes: [{ integrationAccountId: accountId, covered: false }],
    },
  });

  // A minute later the Organisation's alarm moves the mailbox again, with
  // no admin step: the mailbox reads as on under the Organisation's key.
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  await runInDurableObject(organisation, aMinuteLater);
  await runArmedAlarm(organisation);
  expect(await features(organisationId, owner.session)).toMatchObject({
    funding: "organisation_byo",
    mailClassification: {
      enabled: true,
      mailboxes: [{ integrationAccountId: accountId, covered: true }],
    },
  });
}

/**
 * A minute passes for the Organisation Actor: work that it set for the
 * next minute is due, and its alarm is set.
 */
async function aMinuteLater(
  _actor: unknown,
  state: DurableObjectState,
): Promise<void> {
  const queued = state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'jev_mail_repin'",
    )
    .toArray();
  if (queued.length > 0)
    state.storage.sql.exec(
      "UPDATE jev_mail_repin SET next_attempt_at = ? WHERE next_attempt_at <= ?",
      Date.now() - 1,
      Date.now() + 60_000,
    );
  await state.storage.setAlarm(Date.now() + HOUR_MS);
}

async function typeSafeVaultSecrets(
  organisationId: OrganisationId,
): Promise<number> {
  const row = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM vault_secret WHERE organisation_id = ? AND vault_handle LIKE '%:typesafe:%'",
    )
    .bind(organisationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
