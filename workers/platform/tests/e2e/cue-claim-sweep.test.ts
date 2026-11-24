import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";

import { inspectOrganisationCutoverQuiescence } from "@purin-labs/tenancy/actors/organisation-cutover-quiescence";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import { CUE_DELIVERY_LEASE_MS } from "@purin-labs/surface-webhooks/server/gateway/cue-delivery";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
} from "./slack-journey-support";
import { runArmedAlarm } from "./durable-object-alarm-support";

/**
 * Refactor 15: a Cue claim whose queue message went to the dead-letter queue
 * ends.
 *
 * The Cue consumer claims a commerce Cue for its subscription, and then its
 * message is retried until the queue moves it to the dead-letter queue, so
 * nothing completes the claim. Before the fix the claim stayed `claimed` for
 * good, and it held the Organisation's cutover. Now the Organisation's alarm
 * moves a claim whose lease ended long ago to a failed delivery: the cutover
 * no longer waits for it, and a replay of the message delivers nothing twice.
 */
it(
  "ends a Cue claim that nothing completes and frees the Organisation's cutover",
  abandonedCueClaimJourney,
  60_000,
);

/** Past the lease, the queue's five retries and the sweep's grace. */
const ELAPSED_MS = 60 * 60_000;

async function abandonedCueClaimJourney(test: TestContext): Promise<void> {
  await installSlackActorFixture();
  await ensureCreatedOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const registry = await fixtureDatabase()
    .prepare(
      "SELECT physical_object_name AS name FROM durable_object_registry WHERE organisation_id = ? AND object_kind = 'organisation' AND lifecycle_status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .first<{ name: string }>();
  if (registry === null) throw new Error("Organisation Actor missing");
  const organisation = env.ORGANISATION.getByName(registry.name);
  const cue = {
    organisationId: ORGANISATION_ID,
    subscriptionId: "commerce-payment-failed",
    source: "commerce",
    nativeId: "commerce:payment_failed:order_1001",
    debounceMs: 0,
    maxPerHour: 20,
    leaseDurationMs: CUE_DELIVERY_LEASE_MS,
  } as const;

  // The consumer claims the Cue; its message then goes to the dead-letter
  // queue, so no completion follows.
  const claimed = await organisation.claimCueDelivery({
    ...cue,
    now: Date.now(),
  });
  expect(claimed).toMatchObject({ ok: true, value: { kind: "claimed" } });
  await runInDurableObject(organisation, ageCueClaims);
  expect(await runInDurableObject(organisation, readCueState)).toMatchObject({
    claimedCues: 1,
    cues: [{ state: "claimed", outcome: null }],
  });

  // The Organisation's alarm ends the claim as a failed delivery.
  await runArmedAlarm(organisation);
  const after = await runInDurableObject(organisation, readCueState);
  expect(after).toEqual({
    claimedCues: 0,
    cues: [{ state: "delivered", outcome: "failed" }],
  });

  // A replay of the dead-lettered message delivers nothing a second time.
  const replayed = await organisation.claimCueDelivery({
    ...cue,
    now: Date.now(),
  });
  expect(replayed).toMatchObject({ ok: true, value: { kind: "duplicate" } });
  Object.assign(test.task.meta, {
    cueClaimSweep: { claimed, after, replayed },
  });
}

/** Moves the claim's clock back, as the hour after the dead letter would. */
function ageCueClaims(_actor: unknown, state: DurableObjectState): void {
  state.storage.sql.exec(
    `UPDATE cue_delivery
     SET claimed_at = claimed_at - ?, lease_expires_at = lease_expires_at - ?
     WHERE state = 'claimed'`,
    ELAPSED_MS,
    ELAPSED_MS,
  );
}

/** The cues, and the claimed cues that the cutover inspection waits for. */
async function readCueState(
  _actor: unknown,
  state: DurableObjectState,
): Promise<{
  claimedCues: number;
  cues: { state: unknown; outcome: unknown }[];
}> {
  const inspection = inspectOrganisationCutoverQuiescence({
    sql: state.storage.sql,
    organisationId: ORGANISATION_ID,
    inspectedAt: Date.now(),
    alarmAt: null,
  });
  if (!inspection.ok) throw new Error(inspection.error.code);
  let claimedCues = 0;
  for (const blocker of inspection.value.blockers)
    if (blocker.kind === "claimed_cues") claimedCues += blocker.count;
  const cues = state.storage.sql
    .exec<{ state: string; outcome: string | null }>(
      "SELECT state, outcome FROM cue_delivery ORDER BY claimed_at",
    )
    .toArray()
    .map((row) => ({ state: row.state, outcome: row.outcome }));
  return { claimedCues, cues };
}
