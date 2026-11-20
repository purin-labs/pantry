// The one statement that marks a stored secret as revoked. The Vault owns the
// table `vault_secret`. Another module puts this statement into its own
// batch, so that its change and the revocation happen together.

/** Marks the secret of a handle as revoked. A revoked secret keeps its time. */
export function prepareVaultSecretRevocation(
  db: Pick<D1Database, "prepare">,
  input: Readonly<{ organisationId: string; handle: string; now: number }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE vault_secret SET revoked_at = ?
       WHERE organisation_id = ? AND vault_handle = ? AND revoked_at IS NULL`,
    )
    .bind(input.now, input.organisationId, input.handle);
}
