/**
 * The entity plane needs a stable identifier; nobody should have to invent one.
 * The supplier's own name becomes it, or null with no letter or number.
 */
export function supplierIdFromName(displayName: string): string | null {
  const slug = displayName
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug.length === 0 ? null : slug;
}
