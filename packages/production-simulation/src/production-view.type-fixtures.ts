import type { ProductionView } from "./production-view.ts";
import type { HostView } from "./execution-view.ts";
import type { RecoveryView } from "./execution-view.ts";
import type { ObservationView } from "./observation-view.ts";

import type { DrainStatus } from "./state.ts";
declare const drain: DrainStatus;
// @ts-expect-error Unavailable observations cannot carry execution state.
const bad: ProductionView = { kind: "unavailable", drain };
// @ts-expect-error A supported observation requires its complete domain projection.
const incomplete: ProductionView = {
  kind: "available",
  version: 1,
  orders: [],
};
// @ts-expect-error A bare worker payload cannot be a parsed host view.
const rawView: HostView = { time: 0, events: 0, cells: [] };
void bad;
void incomplete;
void rawView;
// @ts-expect-error Recovery requires bindings or an explicit unavailable state.
const incompleteRecovery: RecoveryView = {
  kind: "recovery-required",
  task: "transfer",
  failedAt: 0,
};
declare const observation: ObservationView;
// @ts-expect-error Historical observations confer no execution command authority.
const historicalHost: HostView = { ...observation };
void incompleteRecovery;
void historicalHost;
import type { MaterialStorageHistoryView } from "./material-history.ts";

declare const materialHistory: Extract<
  MaterialStorageHistoryView,
  { kind: "available" }
>;
// @ts-expect-error A retained build with no history cannot claim measured intervals.
export const unavailableMaterialHistory: MaterialStorageHistoryView = {
  ...materialHistory,
  kind: "unavailable",
};
