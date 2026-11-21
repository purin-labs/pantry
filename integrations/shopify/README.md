# Shopify app configuration

Shopify is an external commerce authority for Café. The integration normalizes
catalog, inventory, order, and fulfillment facts into governed commerce
projections. Agents use those records through the same authorization and receipt
boundaries as other connected providers.

`pnpm shopify:m8:link` links this directory to the existing Dev Dashboard app
and pulls its released configuration. `pnpm shopify:m8:deploy` releases the
standalone OAuth configuration and required Admin API scopes. Pantry is not
embedded in Shopify Admin. Pantry reconciles Shopify
webhook subscriptions after OAuth so app versions do not duplicate
organisation-addressed webhook delivery.

Shopify's protected-customer-data gate can reject app-managed
`orders/create` subscriptions for a development app. In that state, create an
**Order creation** JSON webhook in Shopify Admin with this callback:

```text
https://pantry.purin.io/hook/shopify/organisation_T0BGQSSG45N
```

Use API version `2026-07`. Import the store-specific signing secret with
`pnpm shopify:m8:credentials`; the prompt is hidden and `.env.local` is ignored.
`pnpm shopify:m8:setup` then stores the signing secret in the organisation Vault and
activates the Shopify cue snapshot.

`pnpm shopify:m8:accept` creates a tagged development-store test order without
selecting Shopify's protected `Order` object. Acceptance completes only after
the signed merchant-admin webhook produces exactly one Slack proposal.
