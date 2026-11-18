import {
  parseUserPreferenceDocument,
  type PreferenceArea,
  type UserId,
  type UserPreferenceDocument,
} from "../index.ts";

export function parsePreferenceResponse(
  raw: unknown,
  userId: UserId,
  area: PreferenceArea,
): UserPreferenceDocument {
  const parsed = parseUserPreferenceDocument(raw);
  if (
    !parsed.ok ||
    parsed.value.userId !== userId ||
    parsed.value.area !== area
  )
    throw new Error("preferences_response_invalid");
  return parsed.value;
}
