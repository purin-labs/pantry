import { canonicalJson } from "@seams/std";

/** A shared physical resource or product must have one consistent definition. */
export function sharedRecipeRecords<T extends Readonly<{ id: string }>>(
  left: readonly T[],
  right: readonly T[],
): T[] {
  const records = new Map<string, T>();
  for (const entry of left) records.set(entry.id, entry);
  for (const entry of right) {
    const previous = records.get(entry.id);
    if (
      previous !== undefined &&
      canonicalJson(previous) !== canonicalJson(entry)
    )
      throw new Error(`Conflicting recipe definition: ${entry.id}`);
    records.set(entry.id, entry);
  }
  return [...records.values()];
}
