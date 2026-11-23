# Shopify integration

This runbook records the Shopify-specific setup and failure modes that matter
for Pantry. Shopify is an external commerce authority. Pantry uses the standalone
authorization-code OAuth flow, stores the resulting credential in the organisation
Vault, registers organisation webhooks after OAuth, and normalizes the initial catalog
and order snapshot into provider-neutral commerce projections.

## Shopify app configuration

Create and release an app version with:

- App URL: `https://pantry.purin.io/portal`
- Redirect URL:
  `https://pantry.purin.io/v1/control/providers/shopify/callback`
- Required scopes:
  `read_products,read_orders,read_inventory,read_publications,write_orders,write_inventory`
- Legacy install flow enabled.

Shopify calls the standard authorization-code OAuth flow the **legacy install
flow**. Pantry is a standalone merchant application, rather than an embedded
Shopify Admin application, so this is the correct flow. Do not add an embedded
App Bridge dependency solely to avoid Shopify's “legacy” label.

Changing scopes, URLs, webhook declarations, or install-flow settings in the
Dev Dashboard does not update the active app automatically. Create and
**release** a new app version after every configuration change. Reconnect the
shop in Pantry afterward so the new authorization grant is captured in a fresh
credential generation.

The current first loop includes the Online Store publication lane. Shopify's
`publications` query requires `read_publications`; product and variant
publication records are read alongside the existing `read_products` grant.
When `read_publications` is absent, Pantry records the lane as unavailable and
retains Products and Variants without inventing a default channel or Offer.

## Identity and publication mapping

Pantry preserves Shopify's canonical GraphQL GIDs. The connector converts the
numeric IDs present in REST webhook payloads to the corresponding typed GID at
the ingress boundary, so projections never carry an ambiguous numeric-only
identity. Product, ProductVariant, InventoryItem, Location, Order,
OrderTransaction, Fulfillment, and Shipment records retain their provider GID.

Shopify does not expose a standalone Offer resource. Pantry uses the Shopify
Publication GID as the `SalesChannel` identity and derives an Offer identity
from the ordered pair `(ProductVariant GID, Publication GID)`. The resulting
canonical identity is `shopify:offer:<variantGid>:<publicationGid>`. The first
publication lane uses the shop-default variant price; market-specific
contextual pricing remains deferred until the required publication/listing
queries and scopes are enabled.

The v1 snapshot accepts only a publication that Shopify identifies as
supporting future publishing and that resolves to one source-backed Channel.
Shopify documents future scheduling as an Online Store capability. Pantry maps
that publication to `SalesChannelKind::Online`; other publication types remain
unprojected until their source fields support an equally explicit kind mapping.

## Scope semantics

Shopify write scopes imply their corresponding read scopes. In particular:

| Granted scope     | Also authorizes  |
| ----------------- | ---------------- |
| `write_inventory` | `read_inventory` |
| `write_orders`    | `read_orders`    |
| `write_products`  | `read_products`  |

The OAuth response may omit an implied read scope. Pantry's scope boundary must
therefore evaluate effective authorization, rather than require every requested
scope to appear literally in the returned scope string. Keep this equivalence
Shopify-specific.

References:

- [Shopify authorization-code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)
- [Shopify access-scope management](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes)

## Protected customer data

Order reads and `ORDERS_CREATE` webhook registration require protected customer
data access. Configure **Protected customer data** for the app in the Shopify
Dev Dashboard and provide the applicable purposes, such as store management and
app functionality.

Base protected-data access is enough for Pantry's current customer-safe order
projection. Do not request the optional customer name, email, phone, or address
fields unless a reviewed product requirement needs them. Development stores
receive approved development access immediately; public distribution has
additional Shopify review requirements.

A missing protected-data grant may look inconsistent:

- shop identity discovery succeeds;
- product and inventory webhooks succeed;
- `ORDERS_CREATE` is rejected or absent;
- initial order reads fail.

Treat that combination as a protected-data configuration problem before
rotating credentials repeatedly.

## Webhook ownership

Pantry owns Shopify webhook registration through the Admin GraphQL API after
OAuth. The desired topics are:

- `INVENTORY_LEVELS_UPDATE`
- `ORDERS_CREATE`
- `ORDERS_UPDATED`
- `PRODUCTS_CREATE`
- `PRODUCTS_DELETE`
- `PRODUCTS_UPDATE`

Do not also declare these as version-managed Shopify app webhooks. Two
configuration authorities create duplicate subscriptions and confusing release
errors. The OAuth provisioning flow reconciles the organisation-specific webhook URI,
records provider-native subscription IDs, and binds every row to the active
credential generation.

Shopify order webhook bodies do not contain the complete transaction,
fulfillment, and shipment graph required by Pantry's canonical records. Signed
`ORDERS_CREATE` and `ORDERS_UPDATED` deliveries therefore enqueue
`shopify.commerce_refresh.v1` with the exact Order GID. The consumer fetches the
complete Order and passes it through the same versioned snapshot mapper used by
initial synchronization. Retried queue deliveries converge through stable
provider-delivery and observation identities.

`PRODUCTS_DELETE` is a complete deletion signal. Pantry accepts it as a
canonical Product delete and records an OrganisationActor-owned tombstone at the
provider revision. Older snapshots cannot recreate the Product. A later,
complete provider upsert with a newer revision may recreate it explicitly.

Health projection must inspect the current credential generation. Disabled or
revoked rows retained from an older generation are audit history and must not
make the active integration appear degraded.

Shopify exposes only the Location ID with `read_inventory`; the name, active
state, and timestamp fields used by Pantry's observation require
`read_locations` (or `read_markets_home`). Verify the effective grant during
the connection attempt before querying those fields.
The canonical mapper still requires an explicit `LocationKind`, while Shopify's
Location object does not provide Pantry's `store | warehouse |
fulfillment_center | pickup_point` classification. Until that source fact or a
reviewed merchant classification is available, leave the canonical Location
record absent and never fabricate it from an inventory-level payload or name.

Represent this as two lanes at the Shopify boundary:

1. When `read_locations` or `read_markets_home` is granted, the initial
   connection query reads active and inactive Shopify locations and passes each
   source envelope to `OrganisationDO.acceptShopifyLocationObservation`. The resulting
   `ShopifyLocationObservation` stores the normalized provider location ID and
   canonical Shopify GID, plus the name and active state,
   `updatedAt`, source revision, occurred time, and observation time. Address
   and fulfillment capabilities remain deferred until Shopify supplies them in
   the source envelope.
   With inventory-only access, the initial sync records `skipped_scope` and does
   not issue a partial Location query. The observation command remains ready for
   a later authorized sync.
2. Keep the classification lane on the OrganisationActor-owned observation as either
   `pending` or `assigned`. An assigned observation carries the Pantry
   `LocationKind`, classifier control identity, mapping revision, and
   classification time. The classification command binds the exact observation
   revision and atomically creates the canonical Location. A pending observation is visible as
   `classification_required` and does not create a canonical Location.

Assignment immediately projects the retained location observation; newer
provider revisions retain the mapping and advance the canonical Location. The
initial inventory snapshot and later webhooks already key each position to the
same Shopify Location GID, so classification requires no inventory replay. Keep
inventory quantities keyed to the Shopify
location identity while classification is pending, but block actions that
depend on a location role. Never infer the classification from
`fulfillsOnlineOrders`, `isFulfillmentService`, fulfillment-service identity,
name, or address. The Shopify boundary type must model the missing
classification explicitly rather than requiring a synthetic provider `kind`
field.

## Fulfillment and shipment snapshots

The initial order sync reads Shopify Fulfillment records with `read_orders`.
Pantry emits a canonical Fulfillment only when Shopify supplies its Fulfillment,
Order, and Location GIDs, complete fulfilled-line quantities, an estimated
delivery time, and a lifecycle that maps without guessing. It emits a Shipment
only when the Fulfillment has exactly one complete carrier/tracking identity and
a non-empty FulfillmentEvent history whose statuses, timestamps, and location
facts all map to Pantry's shipment lifecycle.

Shopify models tracking inside Fulfillment and provides no independent Shipment
GID. Pantry therefore derives the Shipment identity from the Fulfillment GID and
encoded tracking number. Multi-package tracking is omitted in this first
mapping because Shopify's fulfillment-wide event history cannot be attributed
to an individual package reliably. Missing estimates, locations, event
locations, unsupported event states, and incomplete tracking details leave the
resource absent. They do not become placeholder commerce records.

## Cloudflare `fetch` receiver

Worker-native `fetch` must be invoked as a detached function when it is supplied
through a dependency-injection object:

```ts
const fetcher = input.fetcher;
const response = await fetcher(url, init);
```

Calling `input.fetcher(url, init)` binds `this` to `input`. Cloudflare rejects
that receiver with an illegal-invocation error. Pantry surfaces this as:

```text
shopify.initial_sync_failed
resource: catalog
reasonCode: shopify_initial_sync_transport_failed
```

Mock fetch functions often tolerate the incorrect receiver, so the focused
connector test must assert that the injected fetcher receives `undefined` as
its receiver.

## Initial snapshot behavior

After identity, credential, and webhook provisioning succeed, Pantry fetches a
bounded, cursor-paged snapshot of products and orders. It publishes the
normalized records through the existing commerce event boundary. A successful
OAuth callback is not sufficient evidence that the integration is ready; the
provider connection attempt must reach `connected` after this snapshot.

Empty Shopify product descriptions are valid. The portal renders them as “No
description.” Boundary parsers must accept an empty description while retaining
normal length and type validation.

When the initial snapshot fails, inspect the redacted Worker diagnostic before
reinstalling:

```text
shopify.initial_sync_failed {
  organisationId,
  resource: catalog | orders,
  reasonCode
}
```

Use the resource and reason code to distinguish transport, HTTP, and response
shape failures. Repeated OAuth reconnects are useful only after the underlying
configuration or connector defect is corrected.

## Acceptance checklist

After releasing a Shopify app version and reconnecting the shop, verify:

1. The latest `provider_connection_attempt` is `connected`.
2. The integration account is `active` with no lifecycle reason.
3. The credential generation is active and the previous generation is
   superseded.
4. All six desired webhook topics are `live` on the current generation.
5. The portal reports the Shopify credential and webhooks as healthy.
6. The Products page contains Shopify catalog projections, including products
   with empty descriptions.
7. The Orders page contains customer-safe Shopify order projections.
8. Worker `/health` is green and the event queue has no unresolved initial-sync
   work.

The Shopify client secret is a deployment secret. Never place it in source,
documentation, logs, support evidence, or browser screenshots. Rotate any
secret exposed through chat or screen sharing, then update the Worker secret in
the same maintenance window.

## Implementation references

- OAuth and onboarding:
  [`onboarding.ts`](../../areas/organisation/server/control/routes/onboarding.ts)
- Shopify GraphQL, webhook, and snapshot boundary:
  [`shopify-connector.ts`](../../workers/platform/src/shopify-connector.ts)
- Provider health projection:
  [`onboarding-projection.ts`](../../areas/organisation/server/data/onboarding-projection.ts)
- Merchant presentation: [commerce feature](../../areas/commerce/ui/features/commerce/index.ts)
- Operational failure codes:
  [`onboarding-operations.md`](../runbooks/onboarding-operations.md)
