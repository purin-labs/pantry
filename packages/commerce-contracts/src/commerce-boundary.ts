import { CommerceRejection } from "./commerce-canonical.ts";
import { SerdeRejection } from "./serde-input.ts";

/**
 * Plan 78: the `{status, value}` or `{status, error}` value that a commerce
 * Wasm export writes. TypeScript ports return the same value, so a caller can
 * take either result and compare the two.
 */
export type CommerceBoundaryResponse =
  | Readonly<{ status: "ok"; value: unknown }>
  | Readonly<{ status: "error"; error: unknown }>;

/**
 * Runs a port. A serde shape error becomes `serdeError`; a validation error
 * becomes its Rust JSON. Any other exception is a fault and propagates.
 */
export function commerceBoundary(
  run: () => unknown,
  serdeError: () => unknown,
): CommerceBoundaryResponse {
  try {
    return { status: "ok", value: run() };
  } catch (error) {
    if (error instanceof SerdeRejection)
      return { status: "error", error: serdeError() };
    if (error instanceof CommerceRejection)
      return { status: "error", error: error.error };
    throw error;
  }
}

/** serde_json's error for a shape it could not read. The reason text differs from Rust. */
export function invalidJson(): unknown {
  return { code: "invalid_json", reason: "invalid JSON shape" };
}
