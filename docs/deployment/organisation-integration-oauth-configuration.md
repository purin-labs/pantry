# Organisation integration OAuth configuration

Status: Active deployment guide

This guide is the operator checklist for making every organisation-facing Pantry
integration available through the Portal. It covers shared Pantry
configuration, provider application settings, production-distribution gates,
and webhook setup required before an organisation can complete authorization without
operator assistance.

The active external authorization providers are Airtable, Dropbox, Gmail,
Google Drive, Notion, Shopify, Slack, Stripe, and WhatsApp. AI inference and
Seams Checkout also appear in the Portal, but they use Pantry-owned provisioning
flows and have no external provider OAuth application.

## Shared configuration

Use separate provider applications and credentials for local, staging, and
production whenever the provider supports them. This keeps test users,
callback allowlists, review status, webhook modes, and credential rotation
independent.

Every deployed environment needs these origins:

| Binding                         | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `PANTRY_PUBLIC_ORIGIN`           | Browser-facing Portal and control-session origin                       |
| `PANTRY_OAUTH_CALLBACK_ORIGIN`   | Provider OAuth callbacks; set explicitly in every deployed environment |
| `PANTRY_PROVIDER_INGRESS_ORIGIN` | Optional webhook origin; defaults to `PANTRY_OAUTH_CALLBACK_ORIGIN`     |

The callback and ingress origins must use HTTPS and route `/v1/*`, `/hook/*`,
and `/slack/*` to the same Platform Worker environment. A callback must match
the provider allowlist byte for byte, including scheme, hostname, port, path,
and trailing-slash behavior.

For an OAuth origin of `https://example.com`, register:

```text
https://example.com/v1/control/providers/airtable/callback
https://example.com/v1/control/providers/dropbox/callback
https://example.com/v1/control/providers/gmail/callback
https://example.com/v1/control/providers/google_drive/callback
https://example.com/v1/control/providers/notion/callback
https://example.com/v1/control/providers/shopify/callback
https://example.com/v1/control/providers/slack/callback
https://example.com/v1/control/providers/stripe/callback
https://example.com/v1/control/providers/whatsapp/callback
```

Slack's standalone installation path also uses:

```text
https://example.com/slack/install
```

Webhook endpoints use `PANTRY_PROVIDER_INGRESS_ORIGIN`:

| Provider | Endpoint                        | Registration owner                     |
| -------- | ------------------------------- | -------------------------------------- |
| Dropbox  | `/hook/dropbox`                 | Dropbox app dashboard                  |
| Gmail    | `/hook/email/google`            | Google Cloud Pub/Sub push subscription |
| Shopify  | `/hook/shopify/:organisationId` | Pantry, after organisation OAuth        |
| Slack    | `/slack/events`                 | Slack app dashboard                    |
| Stripe   | `/hook/stripe/connect`          | Stripe Connect platform                |
| WhatsApp | `/hook/whatsapp`                | Meta app dashboard                     |

Provider client IDs can be ordinary Worker variables. Client secrets, signing
secrets, webhook secrets, system-user tokens, and state secrets must be Worker
secrets and must never be committed. The binding names below are part of the
runtime contract.

## Readiness summary

| Provider     | Authorization model                                    | Production gate beyond credentials                                                                       |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Airtable     | OAuth authorization code with PKCE                     | OAuth integration completed for use by other Airtable users                                              |
| Dropbox      | OAuth authorization code with PKCE                     | App approved for production status                                                                       |
| Gmail        | Google OAuth with PKCE and offline access              | External app published, restricted scopes verified, and CASA/security assessment completed when required |
| Google Drive | Google OAuth with PKCE and offline access              | External app published; production branding and scope verification completed when required               |
| Notion       | Public OAuth connection                                | Installation scope set to any workspace                                                                  |
| Shopify      | Standalone authorization-code grant                    | Public distribution/App Store review and protected customer data approval                                |
| Slack        | OAuth v2                                               | Public Distribution activated; Marketplace listing remains optional                                      |
| Stripe       | Connect OAuth for Standard accounts                    | Connect platform configured in the matching sandbox or live mode                                         |
| WhatsApp     | Meta Embedded Signup with shared application authority | App Review/Advanced Access and production Tech Provider/business setup                                   |

## Airtable

Create an OAuth integration in Airtable Builder Hub.

Pantry bindings:

| Binding                        | Kind   |
| ------------------------------ | ------ |
| `AIRTABLE_OAUTH_CLIENT_ID`     | var    |
| `AIRTABLE_OAUTH_CLIENT_SECRET` | secret |

Provider configuration:

1. Register the Airtable callback URI.
2. Enable `data.records:read` and `schema.bases:read`.
3. Configure the integration name, logo, support email, privacy policy, and
   terms required for authorization by users outside the developer account.
4. Keep the client secret server-side. Pantry supplies PKCE for every organisation
   authorization attempt.

Airtable does not currently expose a usable programmatic revocation path for
this connection. Pantry removal tells the operator to revoke the integration in
Airtable when provider-side cleanup is required.

Reference: [Using Builder Hub in Airtable](https://support.airtable.com/articles/9362950318-using-builder-hub-in-airtable).

## Dropbox

Create a scoped Dropbox API app with **Full Dropbox** access. App Folder access
cannot represent the organisation-selected files and folders used by Pantry.

Pantry bindings:

| Binding                       | Kind   |
| ----------------------------- | ------ |
| `DROPBOX_OAUTH_CLIENT_ID`     | var    |
| `DROPBOX_OAUTH_CLIENT_SECRET` | secret |

Provider configuration:

1. Register the Dropbox callback URI.
2. Enable `account_info.read`, `files.metadata.read`, and
   `files.content.read`.
3. Register `${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/dropbox` as the app webhook.
   Dropbox signs notifications with the app secret; the endpoint also answers
   Dropbox's verification challenge.
4. Apply for production status before opening the integration to arbitrary
   organisation accounts. Development status has a linked-user limit.

Pantry requests offline access and PKCE, then stores the refreshable organisation
grant in the organisation Vault.

References: [Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide),
[Dropbox scopes](https://dropbox.tech/developers/customizing-scopes-in-oauth-flow),
and [Dropbox webhooks](https://dropbox.tech/developers/announcing-dropbox-webhooks).

## Gmail

Use a dedicated Google Cloud project for Gmail. Do not reuse the Google project
that provides Portal sign-in or the Google Drive integration. Google consent,
verification, test-user limits, and restricted-scope assessment apply to an
entire project.

Pantry bindings:

| Binding                          | Kind         | Purpose                                           |
| -------------------------------- | ------------ | ------------------------------------------------- |
| `GMAIL_OAUTH_CLIENT_ID`          | var          | Web application OAuth client                      |
| `GMAIL_OAUTH_CLIENT_SECRET`      | secret       | OAuth client secret                               |
| `GMAIL_PUBSUB_TOPIC`             | var          | Fully qualified `projects/PROJECT/topics/TOPIC`   |
| `GMAIL_PUBSUB_AUDIENCE`          | var          | Exact expected OIDC `aud` claim                   |
| `GMAIL_PUBSUB_SERVICE_ACCOUNT`   | var          | Exact expected OIDC `email` claim                 |
| `GMAIL_OAUTH_PILOT_EXPIRY_DAYS`  | optional var | Set to `7` while the consent screen is in Testing |
| `GMAIL_PILOT_ACCOUNT_CAP`        | optional var | Pilot account budget; defaults to 80              |
| `GMAIL_PILOT_SUBMISSION_TRIGGER` | optional var | Verification trigger; defaults to 50              |

Google Cloud configuration:

1. Enable the Gmail API and Pub/Sub API.
2. Configure an External OAuth consent screen with accurate branding, support
   contact, home page, privacy policy, terms, and verified domains.
3. Create a Web application OAuth client and register the Gmail callback URI.
4. Declare `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.readonly`, and
   `https://www.googleapis.com/auth/gmail.compose`.
5. Publish the production application and complete Google's restricted-scope
   verification. Because Pantry handles restricted Gmail data on its servers,
   plan for the required third-party security assessment/CASA and its recurring
   renewal.

Pub/Sub configuration:

1. Create the topic named by `GMAIL_PUBSUB_TOPIC` in the same project as the
   OAuth client.
2. Grant `roles/pubsub.publisher` on that topic to
   `gmail-api-push@system.gserviceaccount.com`.
3. Create an authenticated push subscription to
   `${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/email/google`.
4. Configure its OIDC service account and audience. Copy those exact values to
   `GMAIL_PUBSUB_SERVICE_ACCOUNT` and `GMAIL_PUBSUB_AUDIENCE`.

Google Testing status limits authorizations to test users and gives refresh
tokens a short lifetime. It is suitable for a pilot, not frictionless organisation
onboarding.

References: [Gmail server-side authorization](https://developers.google.com/workspace/gmail/api/auth/web-server),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push),
and [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
See [Gmail Agent Mailboxes](../runbooks/gmail-mailboxes.md) for operations and
recovery.

## Google Drive

Use a dedicated Google Cloud project for Drive. Pantry uses `drive.file`, which
limits access to files the user explicitly selects through Google Picker or
creates with the app.

Pantry bindings:

| Binding                      | Kind   | Purpose                                                                |
| ---------------------------- | ------ | ---------------------------------------------------------------------- |
| `GDRIVE_OAUTH_CLIENT_ID`     | var    | Web application OAuth client                                           |
| `GDRIVE_OAUTH_CLIENT_SECRET` | secret | OAuth client secret                                                    |
| `GDRIVE_PICKER_API_KEY`      | var    | Browser API key restricted to the Portal origin and Google APIs in use |
| `GDRIVE_PICKER_APP_ID`       | var    | Numeric Google Cloud project number used by Picker                     |

Google Cloud configuration:

1. Enable the Google Drive API and Google Picker API.
2. Configure an External OAuth consent screen with production branding,
   support links, and verified domains.
3. Create a Web application OAuth client, register the Google Drive callback,
   and add `PANTRY_PUBLIC_ORIGIN` as an authorized JavaScript origin.
4. Declare only `https://www.googleapis.com/auth/drive.file`.
5. Create a browser API key. Restrict it to the Portal origin and to the Drive
   and Picker APIs needed by the file picker.
6. Put the Cloud project number, rather than its project ID, in
   `GDRIVE_PICKER_APP_ID`.
7. Publish the consent screen and complete any branding or scope verification
   Google requires before general organisation use.

The OAuth grant and the Picker session must use the same Google identity. The
Picker token is short-lived browser authority; the durable refresh token stays
in the organisation Vault.

References: [Google Picker for web](https://developers.google.com/workspace/drive/picker/guides/web-picker)
and [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

## Notion

Create a **Public connection** in Notion's integration dashboard. An Internal
connection can only be installed in its owning workspace.

Pantry bindings:

| Binding                      | Kind   |
| ---------------------------- | ------ |
| `NOTION_OAUTH_CLIENT_ID`     | var    |
| `NOTION_OAUTH_CLIENT_SECRET` | secret |

Provider configuration:

1. Select the installation scope that permits installation in any workspace.
   Notion fixes this choice when the public connection is created.
2. Register the Notion callback URI.
3. Enable read-content capability only. Pantry validates the resulting
   `content.read` grant.
4. Configure the public connection's organization, support, privacy, and terms
   information.

A Notion Marketplace listing is optional and separate from a public OAuth
connection.

References: [Notion public connections](https://developers.notion.com/guides/get-started/public-connections)
and [Notion OAuth authorization](https://developers.notion.com/guides/get-started/authorization).

## Shopify

Create a standalone/API-only Shopify app that uses the authorization-code
grant. Select **Public distribution** if unrelated merchants must install it;
Shopify fixes the distribution method after selection.

Pantry bindings:

| Binding                 | Kind   |
| ----------------------- | ------ |
| `SHOPIFY_CLIENT_ID`     | secret |
| `SHOPIFY_CLIENT_SECRET` | secret |

App configuration:

1. Set the app URL to `${PANTRY_PUBLIC_ORIGIN}/portal` and register the Shopify
   callback URI.
2. Enable the standalone authorization-code flow, named the legacy install
   flow in the Shopify dashboard.
3. Request `read_inventory`, `read_orders`, `read_products`,
   `read_publications`, `write_inventory`, and `write_orders`.
4. Configure Protected customer data for order access. The current projection
   does not require optional customer name, email, phone, or address fields.
5. Create and release a new app version after changing URLs, scopes, or install
   settings.
6. Complete Shopify's public-app review and App Store listing requirements.
   Limited listing visibility is sufficient when discoverability is not
   desired; Shopify review still applies.

Pantry registers and reconciles organisation-specific webhook subscriptions after
OAuth for `INVENTORY_LEVELS_UPDATE`, `ORDERS_CREATE`, `ORDERS_UPDATED`,
`PRODUCTS_CREATE`, `PRODUCTS_DELETE`, and `PRODUCTS_UPDATE`. Do not duplicate
these as version-managed app webhooks.

References: [Shopify app distribution](https://shopify.dev/docs/apps/launch/distribution),
[standalone app authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
and [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data).
See [Shopify integration](../integrations/shopify.md) for the connector-specific
runbook.

## Slack

Create a Slack app with a bot user and OAuth v2 installation.

Pantry bindings:

| Binding                    | Kind   | Purpose                                |
| -------------------------- | ------ | -------------------------------------- |
| `SLACK_CLIENT_ID`          | secret | OAuth app identity                     |
| `SLACK_CLIENT_SECRET`      | secret | OAuth code exchange and provider state |
| `SLACK_SIGNING_SECRET`     | secret | Verification of Slack HTTP requests    |
| `SLACK_OAUTH_STATE_SECRET` | secret | Standalone installation-state signing  |

Slack app configuration:

1. Register the Slack provider callback and `/slack/install` URLs.
2. Add bot scopes `app_mentions:read`, `chat:write`, `channels:history`,
   `channels:read`, `files:read`, `groups:history`, `groups:read`, and
   `im:history`.
3. Enable Event Subscriptions with request URL
   `${PANTRY_PROVIDER_INGRESS_ORIGIN}/slack/events`.
4. Subscribe to bot events `app_mention`, `message.channels`,
   `message.groups`, and `message.im`.
5. Keep Socket Mode disabled; Pantry receives signed HTTPS events.
6. Activate Public Distribution so the OAuth workspace selector can authorize
   workspaces other than the app's development workspace. Do not pass Slack's
   optional `team` parameter because it pins the authorization to one
   workspace.

The repository manifest and organisation OAuth runtime use the same scope set. Add a
scope to both surfaces only after the product has a reviewed need for it.

References: [Slack OAuth v2](https://api.slack.com/authentication/oauth-v2),
[Events API](https://api.slack.com/apis/connections/events-api), and
[Slack app distribution](https://api.slack.com/docs/slack-apps-mgmt).
See [Slack public distribution](slack-public-distribution.md) for the dashboard
procedure and verification evidence.

## Stripe

Configure Pantry as a Stripe Connect platform. The implemented OAuth flow
connects Standard accounts with `read_write` authority. Stripe recommends its
newer Connect Onboarding path for new platforms; changing Pantry to that model
requires a runtime change and is outside deployment configuration.

Pantry bindings:

| Binding                         | Kind   | Purpose                                     |
| ------------------------------- | ------ | ------------------------------------------- |
| `STRIPE_CONNECT_CLIENT_ID`      | secret | Connect OAuth client ID, `ca_...`           |
| `STRIPE_CONNECT_CLIENT_SECRET`  | secret | Matching platform secret key                |
| `STRIPE_CONNECT_WEBHOOK_ID`     | secret | Shared Connect endpoint ID, `we_...`        |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | secret | Shared endpoint signing secret, `whsec_...` |

Stripe configuration:

1. Enable Connect in the Stripe account and register the Stripe callback under
   Connect OAuth settings.
2. Use a sandbox client ID with a test secret key, or a live client ID with a
   live secret key. Pantry rejects mixed modes.
3. Create a webhook event destination for **Connected accounts** at
   `${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/stripe/connect`.
4. Subscribe it to `charge.failed`, `invoice.payment_failed`, `refund.failed`,
   and `customer.subscription.deleted`.
5. Store the resulting endpoint ID and signing secret in the Worker bindings.

The onboarding check verifies that the endpoint is enabled, its mode matches
the organisation connection, and all required event subscriptions are present.

References: [Stripe Connect OAuth](https://docs.stripe.com/connect/oauth-standard-accounts)
and [Connect webhooks](https://docs.stripe.com/connect/webhooks).

## WhatsApp

WhatsApp onboarding uses Meta Embedded Signup. Organisations grant WABA and phone
number assets to Pantry's Meta application. The signup exchange returns a
customer business token with a finite expiry; Pantry stores it in the organisation
Vault and uses it for that connection's provider operations.

Pantry bindings:

| Binding                              | Kind   | Purpose                                           |
| ------------------------------------ | ------ | ------------------------------------------------- |
| `WHATSAPP_APP_ID`                    | var    | Meta application ID                               |
| `WHATSAPP_APP_SECRET`                | secret | Meta application secret and webhook signature key |
| `WHATSAPP_VERIFY_TOKEN`              | secret | Operator-chosen webhook verification token        |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | var    | Facebook Login for Business configuration ID      |

Meta configuration:

1. Create a Meta business app, add WhatsApp, and configure Facebook Login for
   Business Embedded Signup.
2. Register the WhatsApp callback URI in the Embedded Signup configuration.
3. Request `whatsapp_business_management`,
   `whatsapp_business_messaging`, and `business_management`.
4. Configure Embedded Signup to return customer business tokens with a finite
   lifetime and the requested WABA scopes.
5. Configure the WhatsApp webhook callback as
   `${PANTRY_PROVIDER_INGRESS_ORIGIN}/hook/whatsapp`, use the exact
   `WHATSAPP_VERIFY_TOKEN`, and subscribe the `messages` field.
6. Complete App Review and Advanced Access for the requested permissions.
7. Confirm the production Tech Provider, customer funding, business
   verification, app subscription removal, and phone-number registration paths
   with Meta before opening onboarding to arbitrary organisations.

Organisation token rotation uses **Reconnect WhatsApp**. It stores the replacement in
the Vault and advances the connection credential generation so in-flight
proposals remain fenced against the old authority. Rotating the app secret is a
separate Platform rollout.

References: [Meta Embedded Signup](https://developers.facebook.com/docs/whatsapp/embedded-signup)
and [WhatsApp Cloud API webhooks](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/).
See [WhatsApp development sandbox](../runbooks/whatsapp-development-sandbox.md)
for the tested setup and remaining production gates.

## Portal entries without provider OAuth

**AI inference** is configured through Pantry's organisation subscription, organisation BYO
credential, or platform-funded model route. It has no provider callback in the
integration catalogue.

**Seams Checkout** is internal organisation commerce provisioning. It has no external
OAuth client, consent screen, or provider webhook.

Google sign-in for Portal authentication is also separate from integrations.
It uses `GOOGLE_OIDC_CLIENT_ID`, `GOOGLE_OIDC_CLIENT_SECRET`, and
`${PANTRY_PUBLIC_ORIGIN}/v1/control/auth/google/callback`. Never reuse that
Google project for Gmail or Drive scopes.

## Deployment and verification sequence

For each environment and provider:

1. Create the provider application in the matching test or production mode.
2. Complete branding, support, privacy, terms, domain verification, and public
   distribution or provider review requirements.
3. Register the exact callback and webhook URLs.
4. Configure the exact scopes and event subscriptions listed above.
5. Put non-secret IDs and origin values in the environment's Worker variables.
6. Install secrets with Wrangler or the repository's Cloudflare secret-sync
   script. Confirm their names with `wrangler secret list` without printing
   secret values.
7. Deploy the Platform Worker and any provider-owned manifest or app version.
8. Start the integration from a disposable organisation and confirm the provider
   shows a normal consent screen without a test-user or unverified-app block.
9. Complete authorization and confirm the account becomes active with the
   expected identity and scopes.
10. For multi-account providers, connect a second account or workspace and
    confirm the provider lets the user choose it.
11. Trigger one real provider event and confirm the webhook reaches the
    correct organisation.
12. Remove the connection, confirm provider-side revocation or uninstall, then
    reconnect it once. This proves both lifecycle directions before organisations
    depend on the integration.

Scope, callback, client-ID, distribution, or consent-screen changes generally
require organisations to authorize again. Roll out those changes as a provider app
version plus a Pantry reconnect procedure.

## Current deployment readiness

Audited against the runtime, `workers/platform/wrangler.jsonc`, and the remote
production Worker secret-name inventory on 2026-08-30. Secret values were not
read.

| Provider     | Repository verification                                                                       | Production Worker bindings                                                         | Remaining external gate                                                                                         | State                           |
| ------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Airtable     | OAuth, callback, and cleanup tests pass                                                       | Client ID and secret installed                                                     | Confirm the OAuth integration is available to other Airtable users                                              | Dashboard verification required |
| Dropbox      | OAuth, webhook, file context, and cleanup tests pass                                          | Client ID and secret installed                                                     | Confirm Dropbox production status                                                                               | Provider approval required      |
| Gmail        | OAuth, Pub/Sub, operating path, and cleanup tests pass                                        | OAuth and Pub/Sub bindings installed                                               | Replace the Testing pilot with a verified production project and complete CASA                                  | Pilot only                      |
| Google Drive | OAuth, Picker configuration boundary, file context, and cleanup tests pass                    | Client ID, Picker key, and Picker app ID absent; client secret absent remotely     | Create and publish the production Google project                                                                | Blocked                         |
| Notion       | OAuth, callback, and cleanup tests pass                                                       | Client ID and secret installed                                                     | Confirm Public connection and any-workspace installation                                                        | Dashboard verification required |
| Shopify      | OAuth, webhook registration, connector, and cleanup tests pass                                | Client ID and secret installed                                                     | Confirm public distribution, App Store review, and protected customer data approval                             | Provider approval required      |
| Slack        | OAuth, events, external-workspace install, removal, and reconnect tests pass                  | All four Slack secrets installed; public manifest deployed; Seams reinstalled      | Complete one external-workspace acceptance                                                                      | Nearly ready                    |
| Stripe       | Connect OAuth, shared webhook, connector, and cleanup tests pass                              | OAuth and webhook bindings installed                                               | Verify live Connect mode and connected-account webhook configuration                                            | Dashboard verification required |
| WhatsApp     | Embedded Signup, organisation-token Vault storage, webhook, lifecycle, and cleanup tests pass | Application bindings installed; organisation tokens arrive through Embedded Signup | Complete incorporation, Business Verification, Tech Provider/funding decisions, App Review, and Advanced Access | Sandbox only                    |

The Google Drive client secret is now declared in `secrets.required`, so a
future deployment fails closed until it is installed. Its three public values
must also be added to `vars` before that deployment.

The production D1 provider catalogue was repaired and verified on 2026-08-30.
It contains 18 manifests: one development and one production row for each of
the nine active providers, including Dropbox and Google Drive.

Gmail currently sets `GMAIL_OAUTH_PILOT_EXPIRY_DAYS=7`; organisation grants require
periodic reconnects until the production Google project passes verification.
Keep general WhatsApp onboarding closed until its production gates are
resolved. Slack Public Distribution was verified active for Pantry Local on
2026-08-30. Its reconciled public manifest was deployed and read back from
Slack on the same date. Pantry Local was then reinstalled successfully in Seams.

Review [Provider callback origins](../runbooks/provider-callback-origins.md)
whenever a hostname or environment changes.
