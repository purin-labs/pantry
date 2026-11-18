import type { CommerceMutationErrorV1 } from "@seams/commerce-client";
import { errorMessage } from "@seams/std";

export function invalidCommand(error: unknown): CommerceMutationErrorV1 {
  return { code: "invalid_command", field: errorMessage(error) };
}

export function requireIdentity(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim())
    throw new Error(`${field} must be normalized text`);
  return value;
}
