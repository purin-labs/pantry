# How to remove Shopify

Shopify is a connection of Purin Pantry. All its Platform code is in this folder
(Refactor 17, step A2.5). This file lists what to delete with the folder, so that a
removal is one piece of work with a known end.

The counts are from 2026-11-21. Run the commands again before a removal.

After step A2.5, the commerce area reaches Shopify through one port,
`CommerceProvider` (`areas/commerce/contract/server/commerce-provider.ts`). The
Shopify implementation is `shopifyCommerceProvider` in `commerce-provider.ts` of
this folder. The provider catalogue reaches the Shopify entry through the port
`providerModules` (`areas/integrations/server/contract/provider-modules.ts`), and
the entry is `SHOPIFY_PROVIDER_MODULE` in `provider-module.ts` of this folder. The
entry also gives the Shopify messages of the event queue (`refresh-queue.ts`): the
event queue of the webhook surface reads them through the same port. The Worker
registers both in `workers/platform/src/worker-ports.ts`, two lines. Shopify
reaches commerce through the port `commerceDeliveryIntake`
(`areas/commerce/contract/server/delivery-intake.ts`).

Two more values of this folder have a type of the contract
`areas/integrations/server/contract/provider-modules.ts`: the gateway routes
(`SHOPIFY_GATEWAY_ROUTES` in `gateway-routes.ts`) and the part of the Organisation
actor (`SHOPIFY_ORGANISATION_PART` in `organisation-part.ts`). The Worker imports
each one in one file. The rule `shopify-rule` of `pnpm lint:layer-debts` counts
each other import of this folder.

## 1. This folder

Delete `areas/integrations/shopify/`: the connector, the webhooks, the action
execution, the provider adapter (`provider-adapter.ts`), the connection workflow
(`connection-workflow.ts`), the location observation (`location-observation.ts`) and
the queue message (`queue-messages.ts`), the normalizers of the deliveries
(`delivery-normalizers.ts`), the module of the catalogue entry (`provider-module.ts`),
the commerce provider (`commerce-provider.ts`: the credential,
the execution and the reconciliation of an action, the graph read source and the
control API shape of the shop), the connection check (`connection-observation.ts`),
the credential check (`credential-replacement.ts`), the messages of the event queue
(`refresh-queue.ts`), the gateway routes (`gateway-routes.ts`) and the part of the
Organisation actor (`organisation-part.ts`).

## 2. The files that import this folder

Three source files outside the folder import it. Remove the Shopify lines in each one.

| File                                          | What it uses                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers/platform/src/worker-ports.ts`        | The two registration lines: `shopifyCommerceProvider` and `SHOPIFY_PROVIDER_MODULE`. The type check then shows the `shopify` members of `ConnectedCommerceProviders` and `ProviderModules`, and the `shopify` getter of `areas/integrations/server/provider-adapters/catalogue.ts`                                                                       |
| `workers/platform/src/integration-gateway.ts` | `SHOPIFY_GATEWAY_ROUTES`: its five route cases. The route kinds are in the gateway routing of the webhook surface: `domain.ts`, `admin.ts` and `webhooks.ts` of `surfaces/webhooks/server/gateway-routing/`                                                                                                                                              |
| `workers/platform/src/actors/organisation.ts` | `SHOPIFY_ORGANISATION_PART`: the field `shopify`, the two RPC methods `acceptShopifyLocationObservation` and `assignShopifyLocationClassification`, and the schema line in the constructor. The tables of the part stay in the Actor SQLite of each Organisation that had a shop. The class keeps its RPC method names while a Worker version calls them |

Each of these files holds only call lines or registration lines for Shopify. The
Shopify code itself is in this folder. The event queue of the webhook surface names
no Shopify file: its union holds the type `ProviderQueueMessage` of the contract.

Find the importers again:

```bash
grep -rlsE 'from "[^"]*shopify/[a-z/-]+"' workers/platform/src areas surfaces |
  grep -v areas/integrations/shopify/
```

## 3. The value `"shopify"` in the closed unions

Remove `"shopify"` from the provider unions in `packages/contracts` and
`packages/control-api`, and from the commerce system union, which has one
definition: `commerceSystemKindSchema` and its record source in
`packages/commerce-contracts/src/commerce-system.ts`. The
type check then shows each place that still names it: 60 Platform source files and 28
Portal files name Shopify today.

Also delete `packages/commerce-contracts/src/records/shopify.ts` and
`packages/commerce-contracts/src/shopify-normalizer.ts`.

## 4. Tests

- Delete `workers/platform/tests/shopify-acceptance.test.ts`,
  `shopify-action-execution.test.ts`, `shopify-auth.test.ts`,
  `shopify-connector.test.ts` and `shopify-location-observation.test.ts`.
- 27 other unit test files and 10 journey files mention Shopify. Most use it as one
  provider of several. Remove the Shopify cases, and keep each journey that checks an
  outcome with another provider.

## 5. Scripts, the app manifest and the deployment values

- `integrations/shopify/` (the Shopify app manifest and its README).
- `scripts/slack/deploy-m8-shopify-app.mjs`, `import-m7-shopify-credential.mjs`,
  `import-m8-shopify-automation-token.mjs`, `import-m8-shopify-local-credentials.mjs`
  and `link-m8-shopify-app.mjs`, with their lines in the root `package.json`.
- The `SHOPIFY_*` values in `workers/platform/wrangler.jsonc`, the Wrangler secrets
  `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, and their bindings in `foundation/kernel/env.ts`.
- The OAuth callback and the webhook address at Shopify, in the Shopify partner
  account. A person must remove these.

## 6. Stored data

A removal of code does not remove stored rows. Rows with the provider `shopify` stay
in `integration_account`, `provider_connection` and the commerce projections. Decide
before the removal: revoke the connections first (the normal disconnect), or drop the
rows in the Plan 93 cutover.

## 7. The Portal

The Integrations page, the access pages and the commerce pages show Shopify as a
choice. Remove the entry from `areas/integrations/contract/ui/integration-catalogue.ts` first; the
type check then shows the pages that still handle it.

## 8. The package, the map and the lints

This folder is a part of the package `@purin-labs/area-integrations` (Refactor 17,
Stage B). Remove its lines outside the folder:

- the export entry `./shopify/*` in `areas/integrations/package.json`;
- the line `areas/integrations/shopify` of `PLATFORM_SOURCE` in
  `scripts/lib/source-roots.mjs`;
- the line `../../areas/integrations/shopify/**/*.ts` in `tsconfig.json`,
  `tsconfig.tests.json` and `tsconfig.e2e.json` of `workers/platform`.

Remove the rule `areas/integrations/shopify/` and the pairs with `areas/shopify`
from `scripts/layers.json` and `scripts/layers-ratchet.json`, then run
`node scripts/check-layers.mjs --update`, `node scripts/check-unused.mjs --update`
and `node scripts/check-clones.mjs --update`.
