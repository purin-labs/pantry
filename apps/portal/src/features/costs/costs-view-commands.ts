import {
  COSTS_VIEW_COMMANDS,
  type CostsViewCommand,
} from "@seams/control-api";
import type { CostsSheetTab } from "@seams/costs-sheet-crdt";

/**
 * The agent's view commands on Costs & margins (Plan 87 phase 4). Each one
 * makes the change that the person's own click makes, and saves nothing.
 */
export const COSTS_COMMANDS: readonly string[] = COSTS_VIEW_COMMANDS;

type CostsViewState = Readonly<{
  tab: CostsSheetTab;
  sectionFilter: string;
  search: string;
  selectedProductId: string | null;
  overview: Readonly<{
    products: readonly Readonly<{ productId: string; productType: string }>[];
  }>;
}>;

type CostsViewCommandStep<State> =
  | Readonly<{ kind: "next"; state: State }>
  | Readonly<{ kind: "rejected"; message: string }>;

export function costsViewCommandState<State extends CostsViewState>(
  state: State,
  command: CostsViewCommand,
): CostsViewCommandStep<State> {
  switch (command.name) {
    case "open_tab":
      return { kind: "next", state: { ...state, tab: command.tab } };
    case "filter_category": {
      const known =
        command.category === "all" ||
        state.overview.products.some(
          (product) => product.productType === command.category,
        );
      if (!known)
        return {
          kind: "rejected",
          message: `Costs & margins has no category "${command.category}".`,
        };
      // The category chips show on the product tabs only.
      return {
        kind: "next",
        state: {
          ...state,
          tab:
            state.tab === "supplies" || state.tab === "forecast"
              ? "margins"
              : state.tab,
          sectionFilter: command.category,
        },
      };
    }
    case "select_product": {
      const product = state.overview.products.find(
        (candidate) => candidate.productId === command.productId,
      );
      if (product === undefined)
        return {
          kind: "rejected",
          message: `Costs & margins has no product "${command.productId}".`,
        };
      // The row must show: a filter or a search that hides it ends.
      const filtered =
        state.sectionFilter !== "all" &&
        state.sectionFilter !== product.productType;
      return {
        kind: "next",
        state: {
          ...state,
          tab:
            state.tab === "supplies" || state.tab === "forecast"
              ? "margins"
              : state.tab,
          sectionFilter: filtered ? "all" : state.sectionFilter,
          search: "",
          selectedProductId: product.productId,
        },
      };
    }
  }
}
