// The identifier and label checks of the Kitchen surface wire values.
// Moved from bakery-surface.ts (file-size ratchet), so that each surface
// module checks a name with the same limits.

const MAX_IDENTIFIER_LENGTH = 160;

export const MAX_LABEL_LENGTH = 160;

export function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

export function label(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_LABEL_LENGTH
  );
}
