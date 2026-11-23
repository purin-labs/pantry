import type {
  BakeryPlaybackAction,
  BakeryWorkcellPreparation,
} from "@purin-labs/bakery-model/bakery-surface";

const seek = { kind: "seek", seconds: 90 } satisfies BakeryPlaybackAction;
const speed = { kind: "speed", speed: 2 } satisfies BakeryPlaybackAction;

// @ts-expect-error Seeking requires an explicit cursor.
const missingCursor: BakeryPlaybackAction = { kind: "seek" };
// @ts-expect-error Play cannot carry a cursor intended for a seek.
const playWithCursor: BakeryPlaybackAction = { kind: "play", seconds: 90 };
// @ts-expect-error A broad spread must not mix speed and seek branches.
const mixedAction: BakeryPlaybackAction = { ...seek, ...speed };

void missingCursor;
void playWithCursor;
void mixedAction;

const example = {
  source: "example",
  example: "oven-cycle",
  dispatchSeconds: 45,
} as const satisfies BakeryWorkcellPreparation;
// @ts-expect-error Selecting an example requires its identity.
const missingExample: BakeryWorkcellPreparation = {
  source: "example",
  dispatchSeconds: 45,
};
// @ts-expect-error A recording preparation cannot silently carry an example identity.
const mixedPreparation: BakeryWorkcellPreparation = {
  ...example,
  source: "recording",
};
void missingExample;
void mixedPreparation;
