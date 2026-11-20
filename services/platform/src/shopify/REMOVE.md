# How to remove Shopify

Shopify is a connection of Seams Pantry. All its Platform code is in this folder
(Refactor 17, step A2.5). This file lists what to delete with the folder, so that a
removal is one piece of work with a known end.

The counts are from 2026-11-20. Run the commands again before a removal.

## 1. This folder

Delete `services/platform/src/shopify/`: the connector, the webhooks, the action
execution, the provider adapter (`provider-adapter.ts`), the connection workflow
(`connection-workflow.ts`), the location observation (`location-observation.ts`) and
the queue message (`queue-messages.ts`), the connection check
(`connection-observation.ts`) and the credential check (`credential-replacement.ts`).

## 2. The files that import this folder

Nine source files outside the folder import it. Remove the Shopify lines in each one.

| File                                                                                                        | What it uses                                                            |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `provider-adapters/catalogue.ts`                                                                            | The registration of the provider adapter and of the connection workflow |
| `integration-gateway.ts`                                                                                    | The Shopify routes of the Worker                                        |
| `ingress-queue.ts`                                                                                          | The queue message type in the union, and its parser                     |
| `gateway/support.ts`                                                                                        | The queue message for a webhook                                         |
| `actors/organisation.ts`, `actors/organisation/schema.ts`, `actors/organisation/organisation-actor-base.ts` | The location observation that the Organisation actor holds              |
| `commerce/provider-execution.ts`                                                                            | The execution of a commerce action on Shopify                           |
| `provider-lifecycle/credential-replacement.ts`                                                              | One `case` line for the check of a replaced credential                  |

`commerce/provider-execution.ts` is the one direct call that is not a registration.
Step A2.5 puts it behind the `CommerceProvider` port. After that, a removal changes
only registration lines.

Find the importers again:

```bash
grep -rlE 'from "[^"]*shopify/[a-z/-]+"' services/platform/src | grep -v src/shopify/
```

## 3. The value `"shopify"` in the closed unions

Remove `"shopify"` from the provider unions and the commerce system union in
`packages/contracts`, `packages/commerce-contracts` and `packages/control-api`. The
type check then shows each place that still names it: 60 Platform source files and 28
Portal files name Shopify today.

Also delete `packages/commerce-contracts/src/records/shopify.ts` and
`packages/commerce-contracts/src/shopify-normalizer.ts`.

## 4. Tests

- Delete `services/platform/tests/shopify-acceptance.test.ts`,
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
- The `SHOPIFY_*` values in `services/platform/wrangler.jsonc`, the Wrangler secrets
  `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, and their bindings in `env.ts`.
- The OAuth callback and the webhook address at Shopify, in the Shopify partner
  account. A person must remove these.

## 6. Stored data

A removal of code does not remove stored rows. Rows with the provider `shopify` stay
in `integration_account`, `provider_connection` and the commerce projections. Decide
before the removal: revoke the connections first (the normal disconnect), or drop the
rows in the Plan 93 cutover.

## 7. The Portal

The Integrations page, the access pages and the commerce pages show Shopify as a
choice. Remove the entry from `apps/portal/src/integration-catalogue.ts` first; the
type check then shows the pages that still handle it.

## 8. The map and the lints

Remove the rule `services/platform/src/shopify/` and the pairs with `areas/shopify`
from `scripts/layers.json` and `scripts/layers-ratchet.json`, then run
`node scripts/check-layers.mjs --update`, `node scripts/check-unused.mjs --update`
and `node scripts/check-clones.mjs --update`.
