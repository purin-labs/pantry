import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { ensureCreatedOrganisationActor } from "../../src/control/organisation-runtime";
import {
  commerceClient,
  commerceSyncStatus,
  commerceWorkspace,
  lastSyncedAt,
  connectCommerceFixture,
} from "./commerce-support";
import { PlanJourney } from "./production-plan-support";
import { attachSharedAccountNativeOrganisation } from "./shared-account-platform-fixture";
import {
  addWrites,
  monthlyCostUsd,
  runCronMinutes,
  WriteMeter,
  type WriteCounts,
} from "./write-meter";

declare module "vitest" {
  interface TaskMeta {
    idleTenantCost?: Record<string, unknown>;
  }
}

/**
 * What one idle shop may write in one hour, and why. Cloudflare bills each
 * line, and each shop pays it again. A line that is not here must stay at
 * zero. Before you raise or add a line, calculate its cost for one shop for
 * 30 days and write the reason beside it.
 */
const IDLE_HOUR_BUDGET: WriteCounts = {
  // The time of the last check with Commerce, one row each 5 minutes. The
  // Portal reads the shop as in sync from it. $0.009 for one shop for 30 days.
  "rows ORGANISATION": 12,
};

it(
  "costs close to nothing for a shop where nothing changes: every scheduled job runs for an hour, each object starts again, and the shop still reads as in sync",
  { timeout: 300_000 },
  idleTenantCostJourney,
);

/**
 * A café is set up with its shop in Commerce, staff change two products,
 * and Pantry's scheduled jobs run for the shop's first hour. Then nothing
 * changes. Cloudflare stops each idle object, so every later call starts it
 * again: a start must write nothing. Every cron trigger of the production
 * Worker then runs for one more hour, with the objects stopped before each
 * five minutes. The shop stays inside the budget above and still reads as in
 * sync. No alarm that ran in the idle hour is armed again.
 */
async function idleTenantCostJourney({ task }: TestContext): Promise<void> {
  const owner = await commerceClient(`idle-owner-${crypto.randomUUID()}`);
  const organisationId = await commerceWorkspace(owner, "Idle cost café");
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const merchantId = `merchant_idle_cost_${crypto.randomUUID().replaceAll("-", "")}`;
  await connectCommerceFixture(
    organisationId,
    owner.identity.userId,
    merchantId,
  );
  await attachSharedAccountNativeOrganisation({
    organisationId,
    owner,
    members: {},
  });
  const shop = new PlanJourney(organisationId, merchantId, owner.session);
  const provisioned = await shop.native.provisionDemo({
    schemaVersion: "underclerk.provision-demo.v2",
    externalReference: organisationId,
    merchantId,
    profile: "cafe_patisserie",
    createdAt: new Date().toISOString(),
  });
  expect(provisioned.ok, JSON.stringify(provisioned)).toBe(true);
  for (const slug of ["ginger_cookie", "taro_cookie"])
    await shop.describeProduct(slug);

  const meter = new WriteMeter({ underclerkMerchantId: merchantId });
  const crons = env.TEST_PRODUCTION_CRONS;
  expect(crons.length).toBeGreaterThan(0);
  const hour = 60 * 60_000;
  // Each run starts on a quarter hour, so that every trigger is due.
  const firstHourAt = Math.ceil(Date.now() / hour) * hour;

  // 1. The shop's first hour: Pantry reads the whole shop.
  const firstHour = await meter.during(() =>
    runCronMinutes({ env: meter.env, crons, from: firstHourAt, minutes: 60 }),
  );
  const synced = await commerceSyncStatus(organisationId, firstHourAt + hour);
  expect(synced).toMatchObject({ ok: true, value: { kind: "ready" } });

  // 2. Nothing changes from here. An object that starts again writes nothing.
  meter.takeStatements();
  const start = await meter.onStart();
  expect(start, "rows written by an object start").toEqual({});

  // 3. One idle hour of every cron trigger, with each object stopped before
  //    each five minutes.
  const idleHourAt = firstHourAt + hour;
  let idleHour: WriteCounts = {};
  for (let minute = 0; minute < 60; minute += 5) {
    await meter.stopObjects();
    idleHour = addWrites(
      idleHour,
      await meter.during(() =>
        runCronMinutes({
          env: meter.env,
          crons,
          from: idleHourAt + minute * 60_000,
          minutes: 5,
        }),
      ),
    );
  }
  const overBudget = Object.entries(idleHour).filter(
    ([line, amount]) => amount > (IDLE_HOUR_BUDGET[line] ?? 0),
  );
  expect(
    Object.fromEntries(overBudget),
    `writes of an idle shop in one hour, over the budget\n${meter.takeStatements().join("\n")}`,
  ).toEqual({});

  // 4. The shop still reads as in sync at the end of the idle hour.
  const idleEnd = idleHourAt + hour;
  const stillSynced = await commerceSyncStatus(organisationId, idleEnd);
  expect(stillSynced).toMatchObject({ ok: true, value: { kind: "ready" } });
  expect(lastSyncedAt(stillSynced)).toBeGreaterThanOrEqual(
    idleEnd - 15 * 60_000,
  );

  // 5. An alarm of an idle shop does its work and ends. An alarm that arms
  //    itself again runs for ever, at one billed row and one call each time.
  const armed = await meter.armedAlarms();
  const alarmWrites = await meter.during(async () => {
    await meter.runAlarms();
  });
  const armedAgain = await meter.armedAlarms();
  expect(
    Object.keys(armedAgain).filter((name) => name in armed),
    "alarms armed again after their idle run",
  ).toEqual([]);

  task.meta.idleTenantCost = {
    crons,
    firstHour,
    objectStart: start,
    idleHour,
    idleHourBudget: IDLE_HOUR_BUDGET,
    idleMonthUsdAtListPrice: monthlyCostUsd(idleHour),
    alarmsArmedAfterIdleHour: Object.keys(armed).length,
    alarmWrites,
    sync: stillSynced.ok ? stillSynced.value.kind : stillSynced,
  };
}
