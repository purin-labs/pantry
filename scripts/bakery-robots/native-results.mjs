// Compares native results (recordings, sequences, handoffs, attempts) for the
// Kitchen journeys. assert.deepEqual builds a diff of both values when they
// differ, and for two recordings of several MB that diff takes many GB of
// memory: cell-robot-bindings once grew to 20 GB before macOS stopped it.
// This check has the same deep strict meaning, builds no diff, and on a
// mismatch names the first path that differs.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export function assertSameResult(actual, expected, label) {
  if (isDeepStrictEqual(actual, expected)) return;
  throw new assert.AssertionError({
    message: `${label}: the results differ at ${firstDifference(actual, expected, "$")}`,
    actual: "(not shown)",
    expected: "(not shown)",
    operator: "assertSameResult",
  });
}

function firstDifference(actual, expected, path) {
  if (Object.is(actual, expected)) return null;
  if (
    !isObject(actual) ||
    !isObject(expected) ||
    Array.isArray(actual) !== Array.isArray(expected)
  )
    return `${path} (${shown(actual)} against ${shown(expected)})`;
  // "kind" first: a different kind of result is the clearest message.
  const keys = new Set(
    ["kind", ...Object.keys(actual), ...Object.keys(expected)].filter(
      (key) => Object.hasOwn(actual, key) || Object.hasOwn(expected, key),
    ),
  );
  for (const key of keys) {
    const child = Array.isArray(actual) ? `${path}[${key}]` : `${path}.${key}`;
    if (!Object.hasOwn(actual, key) || !Object.hasOwn(expected, key))
      return `${child} (present in one result only)`;
    const found = firstDifference(actual[key], expected[key], child);
    if (found !== null) return found;
  }
  // Equal own keys and values, so the difference is the kind of object.
  return `${path} (a different kind of object)`;
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

function shown(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
