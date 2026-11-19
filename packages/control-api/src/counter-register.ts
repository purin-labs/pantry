import type { OrderQueueEntry } from "./order-queue.ts";

export type CounterRegisterPaymentMethod = "card" | "felica" | "qr_code";

export type CounterRegisterModifierOption = Readonly<{
  modifierOptionId: string;
  name: string;
  priceDeltaMinor: number;
  currency: string;
}>;

export type CounterRegisterModifierGroup = Readonly<{
  modifierGroupId: string;
  revision: number;
  name: string;
  minimumSelections: number;
  maximumSelections: number;
  options: readonly CounterRegisterModifierOption[];
}>;

export type CounterRegisterMenuEntry = Readonly<{
  menuEntryId: string;
  sectionId: string;
  offerId: string;
  variantId: string;
  title: string;
  description: string | null;
  unitPrice: Readonly<{ amountMinor: number; currency: string }>;
  soldOutUntil: string | null;
  available: boolean;
  modifierGroups: readonly CounterRegisterModifierGroup[];
}>;

export type CounterRegisterMenuSection = Readonly<{
  sectionId: string;
  name: string;
  position: number;
  entries: readonly CounterRegisterMenuEntry[];
}>;

export type CounterRegisterMenu = Readonly<{
  menuId: string;
  name: string;
  sections: readonly CounterRegisterMenuSection[];
}>;

export type CounterRegisterPolicy = Readonly<{
  revision: number;
  currency: string;
  cashEnabled: boolean;
  catalogScope:
    | Readonly<{ kind: "supported_items" }>
    | Readonly<{
        kind: "published_menu";
        menuId: string;
        maxQuantityPerLine: number;
      }>;
  tax: Readonly<{
    kind: "none" | "percentage";
    basisPoints: number;
    inclusion: "included" | "added";
  }>;
}>;

export type CounterRegisterTerminal = Readonly<{
  assigned: boolean;
  provider: "square_terminal" | "gmo_stera" | null;
  assignmentRevision: number | null;
  targetKind:
    | "sandbox_simulated"
    | "paired_physical"
    | "lan_gateway_device"
    | null;
  deviceId: string | null;
  gatewayId: string | null;
  deviceSourceKey: string | null;
  ready: boolean;
  blockedReason: string | null;
  supportedMethods: readonly CounterRegisterPaymentMethod[];
}>;

export type CounterRegisterSnapshot = Readonly<{
  schemaVersion: "satyr.counter-register.v1";
  merchantId: string;
  satyrLocationId: string;
  currency: string;
  policy: CounterRegisterPolicy | null;
  menu: CounterRegisterMenu | null;
  terminal: CounterRegisterTerminal;
  openQueueCount: number;
  openOrders: readonly OrderQueueEntry[];
}>;

export type CounterRegisterBasketLine = Readonly<{
  lineKey: string;
  menuId: string;
  menuEntryId: string;
  title: string;
  modifierOptionIds: readonly string[];
  modifierLabels: readonly string[];
  quantity: number;
  unitPriceMinor: number;
  currency: string;
}>;

export type RegisterSurfaceCommand =
  | Readonly<{
      kind: "register.add_item";
      menuEntryId: string;
      modifierOptionIds?: readonly string[];
      quantity?: number;
    }>
  | Readonly<{
      kind: "register.update_line";
      lineKey: string;
      quantity: number;
    }>
  | Readonly<{
      kind: "register.remove_line";
      lineKey: string;
    }>
  | Readonly<{
      kind: "register.clear_basket";
    }>;

export function isCounterRegisterPaymentMethod(
  raw: unknown,
): raw is CounterRegisterPaymentMethod {
  return raw === "card" || raw === "felica" || raw === "qr_code";
}
