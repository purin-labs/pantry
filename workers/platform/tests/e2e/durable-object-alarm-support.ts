import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

type AlarmStub = Parameters<typeof runDurableObjectAlarm>[0];

/**
 * Runs the alarm that the object must hold, to its end. The journey fails if
 * the object holds no alarm. Use it when nothing else can take the alarm
 * first: the alarm is in the future, or the object has no work in the
 * background.
 */
export async function runArmedAlarm(stub: AlarmStub): Promise<void> {
  expect(
    await runDurableObjectAlarm(stub),
    "The Durable Object holds no alarm",
  ).toBe(true);
}

/**
 * Runs one full alarm of the object to its end, as the runtime does: the
 * stored alarm goes, then the handler runs. Use it when the object's own work
 * in the background can fire, move or delete the stored alarm first. There,
 * `runDurableObjectAlarm` can find no alarm and run nothing.
 */
export async function runAlarmHandler(stub: AlarmStub): Promise<void> {
  await runInDurableObject(stub, runStoredAlarmHandler);
}

async function runStoredAlarmHandler(
  actor: DurableObject,
  state: DurableObjectState,
): Promise<void> {
  if (actor.alarm === undefined)
    throw new Error("The Durable Object has no alarm handler");
  await state.storage.deleteAlarm();
  await actor.alarm();
}
