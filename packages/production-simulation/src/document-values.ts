import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  parseId,
  parseSha256Hex,
  parseStoredId,
  type IdKind,
} from "./identity.ts";
import { normalizeQuantity } from "./quantity.ts";
import { logicalTime, stepCount, tickDuration } from "./time.ts";
import type { Result } from "./result.ts";

/** Internal decoding failure. Public boundaries translate it to a Result. */
export class InvalidDocument extends Error {}

export function requireValue(condition: boolean): asserts condition {
  if (!condition) throw new InvalidDocument("Invalid simulation document");
}

export function record(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireValue(isRecord(raw) && hasExactKeys(raw, keys));
  return raw;
}

export function array<T>(raw: unknown, parse: (raw: unknown) => T): T[] {
  requireValue(Array.isArray(raw));
  const values: T[] = [];
  for (const item of raw) values.push(parse(item));
  return values;
}

export function nullable<T>(
  raw: unknown,
  parse: (raw: unknown) => T,
): T | null {
  return raw === null ? null : parse(raw);
}

export function integer(raw: unknown): number {
  requireValue(typeof raw === "number" && Number.isSafeInteger(raw));
  return raw;
}

export function natural(raw: unknown): number {
  const value = integer(raw);
  requireValue(value >= 0);
  return value;
}

export function positive(raw: unknown): number {
  const value = natural(raw);
  requireValue(value > 0);
  return value;
}

export function text(raw: unknown): string {
  requireValue(typeof raw === "string");
  return raw;
}

export function boolean(raw: unknown): boolean {
  requireValue(typeof raw === "boolean");
  return raw;
}

export function choice<const T extends string | number>(
  raw: unknown,
  ...values: T[]
): T {
  for (const value of values) if (raw === value) return value;
  throw new InvalidDocument("Unknown simulation document variant");
}

export function value<T, E>(result: Result<T, E>): T {
  requireValue(result.ok);
  return result.value;
}

export function id<K extends IdKind>(kind: K, raw: unknown) {
  return value(parseStoredId(kind, raw));
}

export function authored<K extends IdKind>(kind: K, raw: unknown) {
  return value(parseId(kind, raw));
}

export function ids<K extends IdKind>(kind: K, raw: unknown) {
  requireValue(Array.isArray(raw));
  const result = [];
  for (const item of raw) result.push(id(kind, item));
  return result;
}

export function digest(raw: unknown) {
  return value(parseSha256Hex(raw));
}

export function time(raw: unknown) {
  return value(logicalTime(natural(raw)));
}

export function duration(raw: unknown) {
  return value(tickDuration(natural(raw)));
}

export function steps(raw: unknown) {
  return value(stepCount(natural(raw)));
}

export function interval(raw: unknown) {
  const r = record(raw, ["start", "end"]);
  const start = time(r.start);
  const end = time(r.end);
  requireValue(end > start);
  return { start, end };
}

export function quantity(raw: unknown) {
  const r = record(raw, ["amount", "unit"]);
  const amount = natural(r.amount);
  switch (choice(r.unit, "each", "milligram", "microliter")) {
    case "each":
      return value(normalizeQuantity({ amount, scale: 0, unit: "each" }));
    case "milligram":
      return value(normalizeQuantity({ amount, scale: 3, unit: "gram" }));
    case "microliter":
      return value(normalizeQuantity({ amount, scale: 3, unit: "milliliter" }));
  }
}

export function kind(raw: unknown): string {
  requireValue(isRecord(raw));
  return text(raw.kind);
}
