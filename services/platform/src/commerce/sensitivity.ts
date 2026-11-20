import type { CommerceSensitivity } from "@purin-labs/commerce-contracts";
import { exhaustiveList } from "@purin-labs/std";

/** Every commerce sensitivity, from least to most restricted. */
export const COMMERCE_SENSITIVITIES = exhaustiveList<CommerceSensitivity>()([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export function isCommerceSensitivity(
  value: unknown,
): value is CommerceSensitivity {
  return COMMERCE_SENSITIVITIES.some((sensitivity) => sensitivity === value);
}

export function sensitivityAtMost(
  value: CommerceSensitivity,
  ceiling: CommerceSensitivity,
): boolean {
  return (
    COMMERCE_SENSITIVITIES.indexOf(value) <=
    COMMERCE_SENSITIVITIES.indexOf(ceiling)
  );
}
