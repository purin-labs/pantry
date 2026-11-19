# Plan 93 — Rename the deployed Workers

Status: draft, 19 November 2026. Nothing is done. The owner asked for this
plan ("Plan a Worker rename").
Owner: the deploy procedure and the Cloudflare account.
Touches: [Plan 91 — names](plan-91-seams-atelier-rename.md) (the rule for
the deployed layer, and phase 4: the public address),
[Plan 80 — multi-tenant Underclerk](plan-80-underclerk-multi-tenant-backend.md),
the Console deploy in seams-monorepo, and the shop Mac.

## Goal

The production and staging Workers get names of the current brand. No
person loses data, a connection or a saved item. At the end, no Worker name,
container name or `workers.dev` address says `satyr` or `underclerk`.

Not in this plan:

- D1, R2, KV and queue names (`satyr-global-tokyo`, `satyr-archive-apac`,
  `satyr-events`, `underclerk-apac` and the others). No person sees them, and
  a new name needs a copy of the data. A later plan can do them.
- Wire values: event kinds `underclerk.*.v1`, the provider id
  `satyr_commerce`, stored area values. They stay, as Plan 91 says.
- The cookie and storage names. Plan 91 phase 4 changes them with the new
  origin.
- The GitHub organisation rename. It does not touch Cloudflare names.

## This plan changes a Plan 91 rule

Plan 91 ("Four layers of a name") keeps the names of the deployed layer. On
19 November 2026 the owner chose to rename the Workers. This plan changes the
rule for Worker names and container names only. Durable Object class names
are an optional last step. Update the Plan 91 table and the AGENTS.md
glossary in the same change as the production rename.

## Facts (dev `5fa2889`, 19 November 2026)

### The Workers

| Production Worker | Stored state | Called by | Public address |
|---|---|---|---|
| `satyr-edge` | 7 SQLite Durable Object classes with data (Organisation, Session, Case, Connector, CodeModePlatformGovernorActor, ConversationResidencyActor, DeviceFleetActor). 3 container classes (WorkspaceExecutor, MessageLinkFetch, CustomConnectorFetch). 3 crons. Consumer of `satyr-events` and `satyr-cues`. 29 Wrangler secrets. 3 Secrets Store bindings | `satyr-slack-ingress` (service binding, and the Connector class by `script_name`) | `satyr-edge.n6378056.workers.dev` |
| `underclerk` | 2 SQLite Durable Object classes with data (UnderclerkMerchantDO, UnderclerkShopNameDO). R2 `underclerk-apac`. 4 Wrangler secrets | `satyr-edge`, `seams-shop` (service bindings) | `underclerk.n6378056.workers.dev` |
| `satyr-code-mode-sandbox` | 1 SQLite class (CodeModeSandbox), legacy `migrations` | `satyr-edge` (class by `script_name`) | none in use |
| `satyr-chatgpt-exit` | 1 container class (ChatGptExitContainer) | `satyr-edge` | none in use |
| `satyr-model-exit` | none | `satyr-edge` | none in use |
| `satyr-vault-onepassword` | none | `satyr-edge` | none in use |
| `satyr-slack-ingress` | none of its own | Slack | `satyr-slack-ingress.n6378056.workers.dev` |
| `satyr-docs` | none | Portal link | `satyr-docs.n6378056.workers.dev` |
| `seams-shop` | none | — | `shop.seams.tokyo` (custom domain) |

Each Worker in the table, except `satyr-slack-ingress`, `satyr-docs` and
`seams-shop`, has a `-staging` entry in its Wrangler file. I did not check
the Cloudflare account. Staging Portal runs on
`staging.satyr.seams.sh`. The test Workers `satyr-voice-path-test`,
`satyr-archive-acceptance`, `satyr-shop-gateway-journey` and
`satyr-shop-voice-journey` hold no production data.

Container apps have their own names in the Wrangler files:
`satyr-edge-workspaceexecutorcontainer`,
`satyr-edge-messagelinkfetchcontainer`,
`satyr-edge-customconnectorfetchcontainer`, `satyr-chatgpt-exit-container`
and the staging copies.

### Who uses the old addresses

`satyr-edge.n6378056.workers.dev`:

- Platform variables `PANTRY_PUBLIC_ORIGIN`, `PANTRY_OAUTH_CALLBACK_ORIGIN`,
  `GMAIL_PUBSUB_AUDIENCE`, `ACCOUNT_PLATFORM_ASSERTION_ISSUER` and
  `ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE`.
- The OAuth apps at each provider: Slack, Google sign-in, Gmail, Google
  Drive, Square, Stripe Connect and its webhook, Shopify
  (`integrations/shopify/shopify.app.toml`), Airtable, Notion, Dropbox and
  the Meta (WhatsApp) webhook.
- The Gmail Pub/Sub push subscription in Google Cloud.
- The Console in seams-monorepo. It reads `PANTRY_ACCOUNT_ASSERTION_ISSUER`,
  `PANTRY_ACCOUNT_ASSERTION_AUDIENCE` and `PANTRY_SERVICE_ORIGIN` from GitHub
  secrets (`.github/workflows/deploy-console-backend.yml`). A change needs
  new secret values and a Console deploy.
- The shop Mac: `~/.satyr-voice/config.json` (`platform_origin`,
  `portal_origins`).
- Each person's bookmarks and saved sign-ins.

`underclerk.n6378056.workers.dev`:

- The platform variable `UNDERCLERK_BASE_URL`.
- The MCP clients that merchants set up
  (`services/commerce/docs/mcp.md`). Check Stripe for webhook endpoints on
  this address too.

`satyr-slack-ingress.n6378056.workers.dev`: the Slack app's event and
interaction request URLs (`scripts/slack/pantry-dev-manifest.json` for dev).

`satyr-docs.n6378056.workers.dev`: `VITE_DOCS_ORIGIN` in
`apps/portal/.env.production`.

### Secrets

Wrangler secrets are write-only. A new Worker does not get the secrets of an
old Worker. Some values have no local copy, for example
`UNDERCLERK_BUYER_SESSION_SECRET`, `UNDERCLERK_SIGNING_PRIVATE_KEY_PKCS8_B64`
and `JAPAN_CARRIER_SIGNING_KEY`. A secret with no local copy must get a new
value on a new Worker. A new signing key makes the earlier signatures fail,
unless the old public key stays published.

### What Cloudflare documents (read on 19 November 2026)

1. The Workers API addresses a Worker by a UUID that does not change and by
   a name that can change
   ([changelog, 3 September 2025](https://developers.cloudflare.com/changelog/post/2025-09-03-new-workers-api/)).
   Terraform can rename a Worker without a delete. **The docs do not say
   what a rename keeps**: Durable Objects, secrets, containers, crons, queue
   consumers, the bindings of other Workers, or the `workers.dev` address.
2. A Durable Object namespace can move to another Worker in the same
   account
   ([Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).
   The target declares `"state": "expecting-transfer"` and `"transfer_from"`.
   The source declares `"state": "transferred"` and `"transferred_to"`.
   Cloudflare moves the namespace in one atomic step. A four-deploy pattern
   gives no downtime. `satyr-edge`, `underclerk` and `satyr-chatgpt-exit`
   already use `exports`. `satyr-code-mode-sandbox` uses the legacy
   `migrations` array (`transferred_classes` with `from_script`).
3. "You cannot roll back to a version deployed before an `exports`-driven
   lifecycle change." Gradual deployments do not work with `exports`.
4. The docs say nothing about containers in a transfer.

## Two ways to rename

**Path A: rename in place.** One Workers API call changes the name. If the
test in step 1 shows that the Worker keeps its Durable Objects, secrets,
containers, crons and queue consumers, this is the cheap way. No data moves
and no secret changes.

**Path B: a new Worker and a transfer.** Deploy a Worker with the new name,
move each Durable Object namespace to it, and set each secret again. Secrets
with no local copy get new values (see "Secrets"). Stop the crons and the
queue consumer on the old Worker before the new Worker gets them, so that no
job runs twice.

Use Path A if step 1 proves it. Use Path B if it does not.

**The trap in both paths.** `wrangler deploy` finds the Worker by the `name`
in the Wrangler file. A deploy with a new name and no transfer makes a
second Worker with new, empty Durable Objects. People would then see empty
organisations. So change a `name` in a Wrangler file only in the step that
renames that Worker. Add a release guard that refuses a deploy to a Worker
name that does not exist in the account, unless the step names it.

## Steps

Each step is one release. A step does not start before the last one is in
production and checked.

### 0. Decisions and gates (no code)

- The owner answers "Decisions for the owner".
- The brand rename has started (after the hackathon), and `purin.io` is a
  zone in the Cloudflare account. Step 2 needs it.

### 1. Test on scratch Workers (no production change)

Make two Workers in the same account:

- `rename-probe-a`: one SQLite Durable Object with one row, one container
  class, one Wrangler secret, one Secrets Store binding, one cron, one queue
  consumer and a `workers.dev` address.
- `rename-probe-b`: a service binding to `rename-probe-a` and a Durable
  Object binding to it by `script_name`.

Rename `rename-probe-a` with the Workers API. Record what still works:
the row, the container, the secret, the Secrets Store value, the cron, the
queue, the old and the new `workers.dev` address, and both bindings of
`rename-probe-b`. Rename it back and record the same. Then test Path B: a
transfer of the SQLite class and of the container class to a third Worker.

Write the results into this plan, then delete the probes. This step decides
the path and the order of steps 4 to 6.

### 2. Custom domains first

This is Plan 91 phase 4, with the Purin names. After this step no outside
party uses a `workers.dev` address. Then the Worker rename in steps 4 to 6
changes nothing that a person or a provider sees.

1. Add custom domains, for example `pantry.purin.io` (Portal and callbacks),
   `commerce.purin.io` (Underclerk API and MCP), `slack.pantry.purin.io`
   (Slack ingress) and `docs.pantry.purin.io`. Staging gets
   `staging.pantry.purin.io`.
2. Add the new callback URL at each provider before the switch.
3. Switch the platform variables, `UNDERCLERK_BASE_URL` and
   `VITE_DOCS_ORIGIN`.
4. Set the new Console GitHub secrets and deploy the Console on the same day.
5. Change the Slack request URLs, the Gmail push subscription, the Shopify
   app file, the MCP doc and the shop Mac config.
6. Keep each `workers.dev` address as a redirect for 90 days.

Each person signs in one time more. Saved Portal themes reset one time.

### 3. Staging rehearsal

Rename each staging Worker with the chosen path, in the order of steps 4 to
6. Then run the E2E journeys and the live Slack journey against staging.

### 4. Production: the Workers with no stored data

`satyr-model-exit`, `satyr-vault-onepassword`, `satyr-chatgpt-exit` and
`satyr-docs`. For a Worker with no stored data, a copy is safe: deploy it
with the new name, deploy `satyr-edge` with the new service names, then
delete the old Worker. Check the secrets of each one first. There is no
downtime.

### 5. Production: Underclerk

Rename `underclerk` to the new name. Deploy `satyr-edge` and `seams-shop`
with the new service name in the same script, so that the gap is short.
Check one order, one MCP call through the custom domain and the Underclerk
pages in the Portal.

### 6. Production: `satyr-edge`, the sandbox and the Slack ingress

One release window. Rename `satyr-code-mode-sandbox` and `satyr-edge`, then
deploy `satyr-slack-ingress` (renamed) with the new `script_name` and
service name. Rename the three container apps. Check: crons run once, both
queues drain, each container starts, a person signs in, the chat answers, a
Slack card arrives, and a device sends a heartbeat.

### 7. Clean-up

- After 90 days, delete the redirect Workers on the old names.
- Delete the test Workers with old names.
- Update the release scripts and their guards, the observability scripts
  that filter by script name, the deploy procedure, the Plan 91 table, the
  AGENTS.md glossary and the memory notes.

### 8. Optional: Durable Object class names

Rename `UnderclerkMerchantDO` and `UnderclerkShopNameDO` with the `exports`
`renamed` state and the three-deploy pattern. Staging first. The event kinds
stay.

## Rollback

- Path A: rename the Worker back, if step 1 shows that a rename back is
  clean.
- Path B: a second transfer moves the namespace back. A rollback to a
  version before the transfer is not possible. So each transfer passes
  staging first.

## Risks

| Risk | Control |
|---|---|
| A deploy with a new name makes empty Durable Objects | The release guard in "The trap in both paths" |
| A caller still binds the old name | Deploy the callers in the same script as the rename |
| Containers behave differently in a rename or a transfer | Step 1 tests a container class |
| A cron or a queue job runs twice in Path B | Only one Worker has the triggers and the consumer at a time |
| New secret values break signatures or sessions | Path A keeps them. In Path B, keep the old public key published |
| Google asks for brand verification again in step 2 | Start step 2 early. Gmail scopes can take days |
| Logs and analytics split at the rename | Note the date in the observability docs |

No step adds a cron, an alarm, a poll or a write for an idle tenant. A
redirect Worker costs nothing when nobody calls it.

## Decisions for the owner

1. **The new names.** Default: `pantry` (for `satyr-edge`), `commerce` (for
   `underclerk`), `pantry-slack-ingress`, `pantry-model-exit`,
   `pantry-chatgpt-exit`, `pantry-vault-onepassword`,
   `pantry-code-mode-sandbox`, `pantry-docs` and `purin-shop` (for
   `seams-shop`). Staging adds `-staging`. Container apps become
   `pantry-<class>`.
2. **Custom domains before the rename.** Default: yes, as step 2. Without
   them, each Worker rename changes a public address, and steps 4 to 6 each
   need the provider work of step 2.
3. **Durable Object class names.** Default: no (step 8 stays optional).
4. **Storage names.** Default: keep them.

## Cost

- Step 1: about half a day. Cloudflare cost is close to zero.
- Step 2: about 1 to 2 days of my work, plus the owner's work in about 11
  provider consoles. Google verification can add days of wait. Each person
  signs in one time more. The brand rename needs this step in any case.
- Steps 3 to 7: about 2 days, with one release window for `satyr-edge`.
- No recurring cost.

Only step 2 changes what people see. Steps 1 and 3 to 7 change only names
in Cloudflare, in the logs and in the deploy scripts.
