import type { HeldEffectAction } from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";

import { normalizeUntrustedText } from "./context/untrusted-text";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/index";

/**
 * One tool effect as its handler is about to run it: the operation and the
 * arguments. A Session that read outside-written text asks a person before
 * such an effect (Plan 89), and the person must see the action itself.
 */
export type EffectAction = Readonly<{
  operation: string;
  arguments: unknown;
}>;

/** What the request stores: the digest that a pass must match, and the view. */
type HeldEffectActionRecord = Readonly<{
  digest: string;
  action: HeldEffectAction;
}>;

const DETAIL_LIMIT = 12;

/**
 * The stored form of an action. The digest covers every argument. The view
 * lists the first values as plain text, written by this code from the typed
 * arguments, so that no model text describes the action to the person.
 */
export async function heldEffectActionRecord(
  action: EffectAction,
): Promise<HeldEffectActionRecord> {
  const leaves: { name: string; value: string }[] = [];
  collectLeaves("", action.arguments, leaves);
  const details = leaves.slice(0, DETAIL_LIMIT);
  if (leaves.length > DETAIL_LIMIT)
    details.push({
      name: "more",
      value: `${String(leaves.length - DETAIL_LIMIT)} more values`,
    });
  return {
    digest: await digestCanonical({
      operation: action.operation,
      arguments: action.arguments ?? null,
    }),
    action: {
      operation: plainText(action.operation),
      details,
    },
  };
}

function collectLeaves(
  path: string,
  value: unknown,
  leaves: { name: string; value: string }[],
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectLeaves(`${path}[${String(index + 1)}]`, item, leaves);
    });
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).sort())
      collectLeaves(path === "" ? key : `${path}.${key}`, value[key], leaves);
    return;
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    return;
  leaves.push({
    name: plainText(path === "" ? "value" : path),
    value: plainText(String(value)),
  });
}

function plainText(value: string): string {
  return normalizeUntrustedText(value, "display_name").text;
}
