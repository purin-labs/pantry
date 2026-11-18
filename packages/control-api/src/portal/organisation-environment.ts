import type { OrganisationEnvironment } from "./settings.ts";

export function parseOrganisationEnvironment(
  raw: unknown,
): OrganisationEnvironment | null {
  return raw === "development" || raw === "production" ? raw : null;
}
