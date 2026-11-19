# The Commerce MCP server

Your coding agent (Claude Code, Codex or another MCP client) can build your
shop's own site against Commerce. It reads your storefronts, your catalog
and your café menu with live prices, makes a test pickup checkout, and reads
an order. The contract is [the spec](spec.md), section 3.

## Connect

1. In the Pantry Portal, open **API keys** and make a key for the agent.
   Give it only the scopes that it needs:
   - `settings:read` for `list_storefronts`
   - `catalog:read` for `read_catalog`
   - `orders:write` for `create_checkout` (a checkout holds stock until its
     quote expires)
   - `orders:read` for `read_order`
2. Copy the key. The Portal shows it one time only.
3. Add the server to your agent. The address is your merchant's MCP path on
   the Commerce Worker:

   ```text
   https://underclerk.n6378056.workers.dev/v1/admin/merchants/<merchantId>/mcp
   ```

   For Claude Code:

   ```bash
   claude mcp add --transport http commerce \
     https://underclerk.n6378056.workers.dev/v1/admin/merchants/<merchantId>/mcp \
     --header "Authorization: Bearer <your key>"
   ```

Keep the key out of your site's source and out of the browser. Your site's
pages use the buyer routes, which need no key.

## Tools

| Tool               | Scope           | What it does                                                                              |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `list_storefronts` | `settings:read` | Each storefront: its ID, sales channel, pickup or shipping, checkout settings.            |
| `read_catalog`     | `catalog:read`  | What a buyer sees on one storefront: listings, menus, live prices and deals. Or a search. |
| `create_checkout`  | `orders:write`  | A guest buyer's cart and pickup checkout, with the buyer session token that pays it.      |
| `read_order`       | `orders:read`   | One order: its state, lines, totals, payments and fulfilment.                             |

A menu entry names its `variantId`; the item's title is on the listing with
the same `variantId`.

## Retries

A buyer's idempotency keys belong to its buyer session. To retry a
`create_checkout` safely, send the same `idempotencyKey` with the
`buyerSessionToken` of the first answer. Without the token, the call makes a
new buyer and a new checkout.

## Payment

No tool pays. Your site pays a checkout with the buyer session token, through
the buyer routes of `@purin-labs/commerce-client` (`createPaymentSession`, then
`reconcilePayment`), as a browser does.
