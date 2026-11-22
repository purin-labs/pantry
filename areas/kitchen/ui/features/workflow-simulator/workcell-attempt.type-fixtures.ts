import type {
  PhysicsRecording,
  PhysicsRequest,
} from "@purin-labs/bakery-model/bakery-physics";
import type {
  WaitingAttempt,
  CompletedAttempt,
  ReservationResult,
  SettlementResult,
} from "@purin-labs/production-simulation/recipes/bakery/workcell-attempt";
import { reserveWorkcell } from "@purin-labs/production-simulation/recipes/bakery/workcell-attempt";
import { loadWorkcellReplay, type PlaybackSession } from "@purin-labs/production-simulation/simulator/playback-state";

declare const pending: WaitingAttempt;
declare const completed: CompletedAttempt;
declare const recording: PhysicsRecording;
declare const rawRequest: Omit<PhysicsRequest, symbol>;
declare const replay: PlaybackSession;

// @ts-expect-error Reservation requires compiled timing and bindings, beyond a parsed native request.
reserveWorkcell({ kind: "empty" }, pending.input.request);
// @ts-expect-error Awaiting evidence cannot supply attached recording playback.
loadWorkcellReplay(replay, pending);

// @ts-expect-error Raw requests must cross the parser boundary.
const unvalidated: PhysicsRequest = { ...rawRequest };
// @ts-expect-error Waiting work cannot carry terminal evidence.
const premature: WaitingAttempt = { ...pending, recording };
// @ts-expect-error A broad spread cannot turn a waiting attempt into a completion.
const forged: CompletedAttempt = {
  ...pending,
  kind: "completed",
  recording,
  settledTime: 1,
  resources: completed.resources,
};
const physical: CompletedAttempt = {
  ...completed,
  // @ts-expect-error Simulation attempts grant no physical execution authority.
  input: { ...completed.input, source: "physical" },
};
// @ts-expect-error Rejected reservations cannot acquire an attempt.
const rejectedReservation: ReservationResult = {
  kind: "rejected",
  message: "busy",
  attempt: pending,
};
const missingEvidence: SettlementResult = {
  kind: "accepted",
  // @ts-expect-error Successful settlement requires terminal evidence and allocations.
  attempt: pending,
};
// @ts-expect-error Direct construction cannot supply the private lifecycle brand.
const direct: WaitingAttempt = {
  kind: "awaiting-evidence",
  input: pending.input,
  resources: pending.resources,
};
void [
  unvalidated,
  premature,
  forged,
  physical,
  rejectedReservation,
  missingEvidence,
  direct,
];
