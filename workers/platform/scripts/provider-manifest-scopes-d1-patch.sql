-- The provider_manifest rows of Square and Shopify name the scopes and the
-- webhooks that Pantry asks for. Square asks for PAYOUTS_READ for the Payouts
-- page (SQUARE_SCOPES), and Shopify asks for read_products and
-- read_publications (SHOPIFY_SCOPES) and registers six webhook topics, of
-- which Shopify may refuse the two order topics. No code reads these columns,
-- and manifest_version stays 1, so no connected account is asked to check
-- again. Apply once to the global database.
UPDATE provider_manifest
SET required_scopes = '["DEVICE_CREDENTIAL_MANAGEMENT","DEVICES_READ","MERCHANT_PROFILE_READ","PAYMENTS_READ","PAYMENTS_WRITE","PAYOUTS_READ"]'
WHERE provider = 'square' AND manifest_version = 1;
UPDATE provider_manifest
SET required_scopes = '["read_inventory","read_orders","read_products","read_publications","write_inventory","write_orders"]',
    webhook_registrations = '[{"topic":"orders/create","required":false},{"topic":"orders/updated","required":false},{"topic":"inventory_levels/update","required":true},{"topic":"products/create","required":true},{"topic":"products/update","required":true},{"topic":"products/delete","required":true}]'
WHERE provider = 'shopify' AND manifest_version = 1;
