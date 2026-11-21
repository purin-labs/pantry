# Provider callback origins

Status: Active operational runbook

The standard backend command is `pnpm backend`, using named
Wrangler profiles. See [environment configuration](./environment-configuration.md).
Its portal and callback origin are `https://localhost:3003`; the permanent
`https://square-sandbox-webhook.seams.sh` ingress exposes Square webhooks only.
Run `pnpm site` alongside the backend to start the shared Caddy entrypoints.
Docker startup uses the same backend command. `pnpm slack:ingress` separately
updates the existing local Slack app and starts its restricted ingress tunnel.

Pantry uses fixed callback paths under an environment-specific origin. Moving
between local, staging, and production requires configuration changes and
provider allowlist updates. Provider-specific callback environment variables
are unnecessary.

## Runtime variables

`PANTRY_PUBLIC_ORIGIN` is the browser-facing portal origin. It owns control
session origin checks, portal links, and the Google sign-in callback.

`PANTRY_OAUTH_CALLBACK_ORIGIN` is the HTTPS origin providers call after an
integration authorization. It defaults to `PANTRY_PUBLIC_ORIGIN`, although each
deployed environment should set it explicitly. The origin must route `/v1/*`
and `/slack/install` to that environment's Platform Worker. When a separate
provider ingress origin is unset, it must also route `/hook/*` and `/slack/*`.

`PANTRY_PROVIDER_INGRESS_ORIGIN` is the optional HTTPS origin for provider
webhooks. It defaults to `PANTRY_OAUTH_CALLBACK_ORIGIN`. Local development sets
it to the existing Square-only hostname. The Slack quick tunnel updates only
the local Slack app's Events API request URL and leaves Worker bindings fixed.
Shopify registration and reconciliation use the profile value for their organisation
hook, so local Shopify webhook delivery requires a separately verified ingress
profile and routing configuration.
Deployed environments normally use the same fixed origin for both values.

| Environment        | `PANTRY_PUBLIC_ORIGIN`                     | `PANTRY_OAUTH_CALLBACK_ORIGIN`             | `PANTRY_PROVIDER_INGRESS_ORIGIN`                               |
| ------------------ | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Local              | `https://localhost:3003`                  | `https://localhost:3003`                  | `https://square-sandbox-webhook.seams.sh` (Square paths only) |
| Current production | `https://pantry.purin.io` | `https://pantry.purin.io` | Unset; uses callback origin                                   |
| Staging target     | `https://staging.console.seams.sh`        | `https://staging.console.seams.sh`        | Unset; uses callback origin                                   |
| Production target  | `https://console.seams.sh`                | `https://console.seams.sh`                | Unset; uses callback origin                                   |

Use a target value after its hostname, TLS certificate, and Worker routes are
live. Staging and production should have separate provider applications and
credentials so their callback allowlists, account modes, and secrets remain
isolated.

## Canonical URI set

For `PANTRY_OAUTH_CALLBACK_ORIGIN=https://example.com`, register these exact
integration callbacks:

```text
https://example.com/v1/control/providers/airtable/callback
https://example.com/v1/control/providers/dropbox/callback
https://example.com/v1/control/providers/gmail/callback
https://example.com/v1/control/providers/google_drive/callback
https://example.com/v1/control/providers/notion/callback
https://example.com/v1/control/providers/shopify/callback
https://example.com/v1/control/providers/slack/callback
https://example.com/v1/control/providers/square/callback
https://example.com/v1/control/providers/stripe/callback
https://example.com/v1/control/providers/whatsapp/callback
```

Slack's standalone installation flow also uses:

```text
https://example.com/slack/install
```

Google sign-in uses the browser-facing origin instead:

```text
${PANTRY_PUBLIC_ORIGIN}/v1/control/auth/google/callback
```

ChatGPT uses OpenAI's device authorization flow and has no Pantry callback URI.
Seams Checkout has no external OAuth callback.

## External configuration registry

The [Google OAuth client inventory](../integrations/google-oauth.md) records
the SSO, Gmail, and Drive client IDs, secret-setting names, callback allowlists,
and verification status.

| Service         | Configuration surface                                                                                                       | Values to register                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Airtable        | Builder Hub → OAuth integration → OAuth redirect URLs                                                                       | Exact Airtable callback for each environment served by that integration |
| Dropbox         | App Console → OAuth 2 → Redirect URIs                                                                                       | Exact Dropbox callback for each environment served by that app          |
| Google Drive    | Google Cloud OAuth client → Authorized redirect URIs                                                                        | Exact Google Drive callback for each environment served by that project |
| Notion          | Developer tools → Connection → OAuth → Redirect URIs                                                                        | Notion callback for every enabled environment                           |
| Shopify         | `integrations/shopify/shopify.app.toml` → `[auth].redirect_urls`, followed by `pnpm shopify:m8:deploy`                      | Shopify callback for the environments served by that app                |
| Slack           | Selected `services/platform/wrangler.jsonc` profile; `pnpm slack:app:update` for production or `pnpm slack:ingress` locally | Slack provider callback and standalone install callback                 |
| Stripe          | Dashboard → Connect → Onboarding options → OAuth → Redirects                                                                | Stripe callback in the matching sandbox or live platform account        |
| WhatsApp        | Meta App Dashboard → WhatsApp → Embedded signup configuration → OAuth redirect URIs                                         | WhatsApp callback for every enabled environment                         |
| Google sign-in  | Google Cloud OAuth client → Authorized redirect URIs                                                                        | Google sign-in callback based on `PANTRY_PUBLIC_ORIGIN`                  |
| Gmail mailboxes | Google Cloud OAuth client → Authorized redirect URIs                                                                        | Gmail callback for every enabled environment                            |

Slack's Event Subscriptions request URL is adjacent ingress configuration. Set
it to `${PANTRY_PROVIDER_INGRESS_ORIGIN}/slack/events` in production. Locally,
`pnpm slack:ingress` uses its current quick tunnel URL; templates contain only
app permissions and features, and the helper fills URLs from the selected
profile and tunnel. Gmail's equivalent is the
Cloud Pub/Sub push endpoint, which every environment sets to
`${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/email/google` on its own subscription. That
endpoint authenticates by OIDC rather than by path secrecy, so an origin change
also requires updating `GMAIL_PUBSUB_AUDIENCE` whenever the audience is derived
from the endpoint URL. See [Gmail mailboxes](gmail-mailboxes.md). Dropbox uses
the shared `${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/dropbox` endpoint. Shopify
uses organisation-specific `/hook/shopify/:organisationId` endpoints, while the Stripe
Connect platform uses `/hook/stripe/connect`; reconcile connected accounts
after an origin change so Pantry registers the new provider endpoints.

## Adding an environment or changing a hostname

1. Provision the hostname and TLS certificate, then route `/v1/*`, `/hook/*`,
   and `/slack/*` to the environment's Platform Worker.
2. Create or select the environment-specific provider applications and
   credentials.
3. Set `PANTRY_PUBLIC_ORIGIN` and `PANTRY_OAUTH_CALLBACK_ORIGIN` in that
   environment's Worker configuration. Set `PANTRY_PROVIDER_INGRESS_ORIGIN` only
   when webhook ingress uses a distinct public origin.
4. Add the canonical URI set to each external configuration surface. Keep the
   previous URIs during a hostname migration.
5. Deploy the Worker, Slack manifest, and Shopify app configuration.
6. Start each integration from the portal and verify that the provider reaches
   its consent screen. Complete one disposable connection per environment to
   prove the callback and credential exchange.
7. Update Slack event delivery and reconcile Shopify and Stripe webhooks.
8. After all open OAuth attempts have expired and the new origin is healthy,
   remove retired URIs from provider allowlists.

Treat callback values as exact strings. Scheme, hostname, port, path, and
trailing slash differences produce provider redirect failures.
