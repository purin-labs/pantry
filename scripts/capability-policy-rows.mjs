// Shared by the policy-row check and the backfill SQL. `deploy` and
// `pnpm backend` fail when an Organisation lacks the policy row of any
// capability of the catalogue, because the Access read then answers
// `access_control_read_unavailable`.
import { CAPABILITY_CATALOGUE } from "../services/platform/src/authorization/capability-catalogue.ts";

export const POLICY_TABLE = "organisation_capability_policy";

/** SQL list of `(capability_id, capability_version)` for the catalogue. */
export function catalogueValues() {
  return CAPABILITY_CATALOGUE.map(
    ({ capabilityId, capabilityVersion }) =>
      `  ('${capabilityId}', ${Number(capabilityVersion)})`,
  ).join(",\n");
}

/** One row for each Organisation and capability that has no policy row. */
export const MISSING_POLICY_QUERY = `
SELECT o.organisation_id AS organisation_id, c.capability_id AS capability_id
FROM organisation o
CROSS JOIN (
  SELECT column1 AS capability_id, column2 AS capability_version FROM (VALUES
${catalogueValues()}
  )
) AS c
LEFT JOIN ${POLICY_TABLE} p
  ON p.organisation_id = o.organisation_id
  AND p.capability_id = c.capability_id
  AND p.capability_version = c.capability_version
WHERE p.organisation_id IS NULL AND o.status <> 'purged'
ORDER BY o.organisation_id, c.capability_id`;
