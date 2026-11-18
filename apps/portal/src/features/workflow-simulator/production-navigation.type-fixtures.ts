import type { ProductionNavigation } from "./production-navigation.ts";
import type { ProductionReady } from "./production-session.ts";
import type { ProductionWorkcell } from "@seams/production-simulation/recipes/bakery/production-workcells";
import type { BakeryWorkspaceAction } from "./simulator-state.ts";
import type { Variant } from "@seams/type-utils";

declare const from: ProductionReady;
declare const operation: ProductionWorkcell;
declare function navigate(value: ProductionNavigation): void;
declare function showPanel(
  value: Variant<BakeryWorkspaceAction, "productionPanelShown">,
): void;

showPanel({ kind: "productionPanelShown", from, panel: "timeline" });
// @ts-expect-error Panel changes require the exact source run.
showPanel({ kind: "productionPanelShown", panel: "files" });
const rawPanel = { panel: "arbitrary-property" };
// @ts-expect-error A spread cannot introduce an unknown panel.
showPanel({ kind: "productionPanelShown", from, ...rawPanel });

navigate({ from, time: 0, target: { kind: "operation", operation } });
navigate({
  from,
  time: 0,
  target: { kind: "selection", selection: { kind: "batch", id: "A" } },
});

// @ts-expect-error A navigation must bind the exact run it was resolved against.
navigate({ time: 0, target: { kind: "operation", operation } });

const selection = { selection: { kind: "batch" as const, id: "A" } };
navigate({
  from,
  time: 0,
  // @ts-expect-error A spread cannot combine an operation with a schedule selection.
  target: { ...selection, kind: "operation", operation },
});

navigate({
  from,
  time: 0,
  // @ts-expect-error An operation is a separate selection branch.
  target: {
    kind: "selection",
    selection: { kind: "batch", id: "A" },
    operation,
  },
});
