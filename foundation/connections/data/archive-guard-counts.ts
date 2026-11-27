/**
 * The counts that the archive by a support admin needs to be 0: each text
 * is one SELECT in brackets with one `?`, the organisation id. Tenancy puts
 * them into its one guard read (Refactor 17).
 */
export const COMMERCE_LINK_COUNTS_SQL = {
  merchantBindings: `(SELECT COUNT(*) FROM commerce_merchant_binding
            WHERE organisation_id = ?)`,
  activeShopifyAccounts: `(SELECT COUNT(*) FROM integration_account
            WHERE organisation_id = ? AND provider = 'shopify'
              AND lifecycle = 'active' AND is_default_for_provider = 1)`,
} as const;
