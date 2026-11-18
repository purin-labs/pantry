import { hasExactKeys, isNonEmptyString, isRecord } from "@seams/std";
import type { BakerySurfaceToolCommandName } from "./bakery-surface.ts";

export type BakeryBrowserBinding = Readonly<{
  browserInstanceId: string;
  conversationId: string;
}>;

export type BakeryBrowserContext =
  | Readonly<{ kind: "unavailable"; binding?: never }>
  | Readonly<{ kind: "excluded"; binding: BakeryBrowserBinding }>
  | Readonly<{ kind: "available"; binding: BakeryBrowserBinding }>;

export type BakeryContextPreparationCommand = Readonly<{
  kind: "prepare_context";
  schemaVersion: 1;
  binding: BakeryBrowserBinding;
  requiredCommand: BakerySurfaceToolCommandName;
  target?: never;
}>;

export function parseBakeryBrowserBinding(
  raw: unknown,
): BakeryBrowserBinding | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["browserInstanceId", "conversationId"]) ||
    !isNonEmptyString(raw.browserInstanceId) ||
    raw.browserInstanceId.length > 160 ||
    !isNonEmptyString(raw.conversationId) ||
    raw.conversationId.length > 160
  )
    return null;
  return {
    browserInstanceId: raw.browserInstanceId,
    conversationId: raw.conversationId,
  };
}

export function parseBakeryBrowserContext(
  raw: unknown,
): BakeryBrowserContext | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "unavailable" && hasExactKeys(raw, ["kind"]))
    return { kind: "unavailable" };
  if (
    (raw.kind !== "available" && raw.kind !== "excluded") ||
    !hasExactKeys(raw, ["kind", "binding"])
  )
    return null;
  const binding = parseBakeryBrowserBinding(raw.binding);
  return binding === null ? null : { kind: raw.kind, binding };
}
