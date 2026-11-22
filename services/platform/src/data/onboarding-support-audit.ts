import type { GlobalDatabase } from "@purin-labs/kernel/database-handles";
// The audit row of each support lookup of an organisation's onboarding.

export function operatorSupportAccessStatement(
  db: Pick<GlobalDatabase, "prepare">,
  userId: string,
  supportRole: "support_agent" | "support_admin",
  lookup: Readonly<{ kind: string }>,
  lookupHash: string,
  organisationId: string | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO onboarding_support_access_audit (
       support_access_id, user_id, support_role, lookup_kind,
       lookup_value_hash, organisation_id, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `support_access_${crypto.randomUUID()}`,
      userId,
      supportRole,
      lookup.kind,
      lookupHash,
      organisationId,
      now,
    );
}
