import { Type } from "typebox";
import {
  COSTS_SURFACE,
  COSTS_TABS,
  type CostsViewCommand,
} from "@purin-labs/control-api";
import {
  defineKitchenTool,
  type KitchenToolServices,
} from "../kitchen/services";
import {
  bakerySurfaceToolSucceeded,
  readBakerySurfaceReceiptId,
} from "../bakery/surface-result";

/**
 * The agent's view commands on Costs & margins (Plan 87 phase 4). Each one
 * runs in the person's browser as their own click does and saves nothing;
 * a save stays a tool with its own approval. The result is what the page
 * shows after the command.
 */
const RERUN = {
  kind: "any_caller",
  reason: "A view command shows the same view when it runs again.",
} as const;

const UNAVAILABLE =
  "Costs & margins commands need a Portal chat whose message carries the page";

const SCREEN_RULE =
  "Use it only while the person's current message carries Costs & margins from their screen.";

const costsViewOpenTab = defineKitchenTool({
  name: "costs_view_open_tab",
  description: `Open a tab of Costs & margins on the person's screen: margins, weekly, actuals, forecast or supplies. ${SCREEN_RULE} It saves nothing.`,
  input: Type.Object(
    { tab: Type.Union(COSTS_TABS.map((tab) => Type.Literal(tab))) },
    { additionalProperties: false },
  ),
  decode: (input): CostsViewCommand => ({ name: "open_tab", tab: input.tab }),
  effect: "surface",
  rerun: RERUN,
  selection: { kind: "surface", surface: COSTS_SURFACE, command: "open_tab" },
  unavailable: UNAVAILABLE,
  handler: costsViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const costsViewFilterCategory = defineKitchenTool({
  name: "costs_view_filter_category",
  description: `Filter the Costs & margins product tables by a category that the page shows, or by "all". ${SCREEN_RULE} It saves nothing.`,
  input: Type.Object(
    { category: Type.String({ minLength: 1, maxLength: 60 }) },
    { additionalProperties: false },
  ),
  decode: (input): CostsViewCommand => ({
    name: "filter_category",
    category: input.category,
  }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: COSTS_SURFACE,
    command: "filter_category",
  },
  unavailable: UNAVAILABLE,
  handler: costsViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const costsViewSelectProduct = defineKitchenTool({
  name: "costs_view_select_product",
  description: `Show one product of Costs & margins on the person's screen: the page selects its row and the agent's label stays on it for 5 seconds. Give the product id that the page view lists. ${SCREEN_RULE} It saves nothing.`,
  input: Type.Object(
    { productId: Type.String({ minLength: 1, maxLength: 200 }) },
    { additionalProperties: false },
  ),
  decode: (input): CostsViewCommand => ({
    name: "select_product",
    productId: input.productId,
  }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: COSTS_SURFACE,
    command: "select_product",
  },
  unavailable: UNAVAILABLE,
  handler: costsViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

export const COSTS_VIEW_TOOLS = [
  costsViewOpenTab,
  costsViewFilterCategory,
  costsViewSelectProduct,
] as const;

function costsViewHandler({
  executePageViewCommand,
}: Partial<KitchenToolServices>) {
  return executePageViewCommand === undefined
    ? undefined
    : (command: CostsViewCommand, call: { readonly callId: string }) =>
        executePageViewCommand(command, call.callId);
}
