import type { SweepCheck } from "./spatial/door-sweep";

const blocked = { kind: "blocked", angle: 0.5 } satisfies SweepCheck;
// @ts-expect-error A confirmed collision requires its witness angle.
const missingAngle: SweepCheck = { kind: "blocked" };
// @ts-expect-error Spreading a blocker cannot turn its witness into a clear result.
const clearWithWitness: SweepCheck = { ...blocked, kind: "clear" };
// @ts-expect-error An unresolved interval has no confirmed collision angle.
const uncheckedWithWitness: SweepCheck = { kind: "unchecked", angle: 0.5 };

void [missingAngle, clearWithWitness, uncheckedWithWitness];
