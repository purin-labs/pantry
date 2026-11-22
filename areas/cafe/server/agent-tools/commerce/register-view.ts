import { Type } from "typebox";
import {
  REGISTER_SURFACE,
  type RegisterViewCommand,
} from "@purin-labs/control-api";
import { noArguments } from "@purin-labs/agent-tools/define-tool";
import { defineCafeTool, type CafeToolServices } from "./order-queue";
import {
  bakerySurfaceToolSucceeded,
  readBakerySurfaceReceiptId,
} from "../../../../../services/platform/src/agent-tools/bakery/surface-result";

const RERUN = {
  kind: "any_caller",
  reason: "Staging items in the Register basket moves no money and creates no order.",
} as const;

const UNAVAILABLE =
  "Café Register staging commands need a Portal chat whose message carries the Register page";

const SCREEN_RULE =
  "Use it only while the person's current message carries Café › Register from their screen. It stages the local basket only and never charges a terminal or records cash.";

const ID_FIELD = Type.String({ minLength: 1, maxLength: 200 });

const registerAddItem = defineCafeTool({
  name: "register_add_item",
  description: `Add a menu item (with optional modifier option IDs and quantity) to the operator's Café › Register basket. ${SCREEN_RULE}`,
  input: Type.Object(
    {
      menuEntryId: ID_FIELD,
      modifierOptionIds: Type.Optional(Type.Array(ID_FIELD, { maxItems: 20 })),
      quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
    },
    { additionalProperties: false },
  ),
  decode: (input): RegisterViewCommand => ({
    name: "register_add_item",
    menuEntryId: input.menuEntryId,
    ...(input.modifierOptionIds === undefined
      ? {}
      : { modifierOptionIds: input.modifierOptionIds }),
    ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
  }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: REGISTER_SURFACE,
    command: "register_add_item",
  },
  unavailable: UNAVAILABLE,
  handler: registerViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const registerUpdateLine = defineCafeTool({
  name: "register_update_line",
  description: `Update the quantity of one line in the operator's Café › Register basket. ${SCREEN_RULE}`,
  input: Type.Object(
    {
      lineKey: ID_FIELD,
      quantity: Type.Integer({ minimum: 1, maximum: 99 }),
    },
    { additionalProperties: false },
  ),
  decode: (input): RegisterViewCommand => ({
    name: "register_update_line",
    lineKey: input.lineKey,
    quantity: input.quantity,
  }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: REGISTER_SURFACE,
    command: "register_update_line",
  },
  unavailable: UNAVAILABLE,
  handler: registerViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const registerRemoveLine = defineCafeTool({
  name: "register_remove_line",
  description: `Remove one line from the operator's Café › Register basket. ${SCREEN_RULE}`,
  input: Type.Object(
    { lineKey: ID_FIELD },
    { additionalProperties: false },
  ),
  decode: (input): RegisterViewCommand => ({
    name: "register_remove_line",
    lineKey: input.lineKey,
  }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: REGISTER_SURFACE,
    command: "register_remove_line",
  },
  unavailable: UNAVAILABLE,
  handler: registerViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

const registerClearBasket = defineCafeTool({
  name: "register_clear_basket",
  description: `Clear all unstaged lines from the operator's Café › Register basket. ${SCREEN_RULE}`,
  input: noArguments(),
  decode: (): RegisterViewCommand => ({ name: "register_clear_basket" }),
  effect: "surface",
  rerun: RERUN,
  selection: {
    kind: "surface",
    surface: REGISTER_SURFACE,
    command: "register_clear_basket",
  },
  unavailable: UNAVAILABLE,
  handler: registerViewHandler,
  readReceipt: readBakerySurfaceReceiptId,
  succeeded: bakerySurfaceToolSucceeded,
});

export const REGISTER_VIEW_TOOLS = [
  registerAddItem,
  registerUpdateLine,
  registerRemoveLine,
  registerClearBasket,
] as const;

function registerViewHandler({
  executeRegisterViewCommand,
}: Partial<CafeToolServices>) {
  return executeRegisterViewCommand === undefined
    ? undefined
    : (command: RegisterViewCommand, call: { readonly callId: string }) =>
        executeRegisterViewCommand(command, call.callId);
}
