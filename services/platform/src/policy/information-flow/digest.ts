import { isRecord } from "@seams/std";

export async function digestCanonical(value: unknown): Promise<string> {
  const serialized = serializeCanonical(value);
  const bytes = new TextEncoder().encode(serialized);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), hexByte).join("");
}

/**
 * Sorted-key `JSON.stringify`, the serialization behind persisted flow digests.
 * It is not @seams/std's canonicalJson: it honours `toJSON` (flow bindings and
 * contexts are Wasm classes), writes integer-like keys in ascending numeric
 * order, writes non-finite numbers as null and rejects bigints. Changing any of
 * these would change digests already stored in receipts and ledgers.
 */
export function serializeCanonical(value: unknown): string {
  const serialized = JSON.stringify(value, sortObjectKeys);
  if (serialized === undefined)
    throw new Error("canonical serialization requires a JSON value");
  return serialized;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      configurable: true,
      enumerable: true,
      value: value[key],
      writable: true,
    });
  }
  return sorted;
}
