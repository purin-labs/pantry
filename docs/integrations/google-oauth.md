# Google OAuth clients

Inventory recorded 2026-09-08 from the local Worker configuration and the
owner's Google Cloud Console screenshots. Client IDs are public identifiers.
Secret values must never be added to this document.

Google SSO signs a person into Pantry; Gmail and Drive connect that person's
provider accounts. Each flow has its own callback path.

## Production: one client in project `purin-pantry`

Since Plan 93 step 4 (22 November 2026), production uses one web client,
"Purin Pantry web", in the Google Cloud project `purin-pantry` (number
`136715459438`), for all three flows. The consent screen is External and
"In production"; Google verification of the Gmail scopes is still open, so
Gmail and Drive connects show Google's "unverified app" screen and count
against the 100-user cap. Sign-in asks only `openid`, `email` and `profile`.

```text
136715459438-i2qutsi27kb4ka9c3qkhvu1v42jvuhdq.apps.googleusercontent.com
```

`GOOGLE_OIDC_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_ID` and `GDRIVE_OAUTH_CLIENT_ID`
in `env.production.vars` name it, and the three `*_CLIENT_SECRET` Worker
secrets hold its one secret. `GDRIVE_PICKER_APP_ID` is the project number,
and `GDRIVE_PICKER_API_KEY` is the key "Pantry Picker", limited to the
Picker API and `https://pantry.purin.io/*`.

## Local development: the same client

Local development uses the production client "Purin Pantry web" of
`purin-pantry` for sign-in, Gmail and Drive, with the local callbacks of the
table below and the JavaScript origin `https://localhost:3003`. The
`env.local` profile of `services/platform/wrangler.jsonc` holds the same
client id; the git-ignored `services/platform/.dev.vars.local` holds its
secret and the "Pantry Picker" key, which also allows
`https://localhost:3003/*`. Local Gmail push uses the topic
`projects/purin-pantry/topics/pantry-gmail-push-local`, which has no
subscription. Plan 93 deleted the old projects `satyr-gmail-dev` and
`satyr-drive-pilot` on 22 November 2026.

## Redirect allowlists

In each client's Google Cloud Console page, use **Authorized redirect URIs**.
Keep the current production callback when maintaining a client that serves
both local and production flows.

| Client | Local redirect URI                                                  | Current production redirect URI                                      |
| ------ | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SSO    | `https://localhost:3003/v1/control/auth/google/callback`            | `https://pantry.purin.io/v1/control/auth/google/callback`            |
| Gmail  | `https://localhost:3003/v1/control/providers/gmail/callback`        | `https://pantry.purin.io/v1/control/providers/gmail/callback`        |
| Drive  | `https://localhost:3003/v1/control/providers/google_drive/callback` | `https://pantry.purin.io/v1/control/providers/google_drive/callback` |

SSO derives its callback from `PANTRY_PUBLIC_ORIGIN`. Gmail and Drive derive
theirs from `PANTRY_OAUTH_CALLBACK_ORIGIN`. Both local origins are
`https://localhost:3003`. Exact scheme, port, path, and trailing slash matter.

The SSO web client's local **Authorized JavaScript origin** is
`https://localhost:3003`; its current production origin is
`https://pantry.purin.io`. The Drive screenshot also shows
both origins. The Gmail screenshot shows only the production JavaScript
origin, alongside the correct local server-side redirect URI.

Remove retired `http://localhost:8787` origins and callbacks after migration.
Internal Worker port `3101` is behind Caddy and does not belong in these
browser-facing allowlists. The Square-only webhook tunnel is unrelated to
these Google callbacks.

## Where configuration and secrets live

- Local client IDs and origins: `services/platform/wrangler.jsonc`, under
  `env.local.vars`.
- Local client secrets: ignored `services/platform/.dev.vars.local`, using
  the three secret names in the inventory. The committed
  `services/platform/.dev.vars.example` lists names without values.
- Production client secrets: Cloudflare Worker secrets for `pantry`,
  selected explicitly with the production profile. Production SSO and Drive
  client IDs currently live there too.
- Connected Gmail/Drive account credentials: encrypted Vault records owned
  by the existing organisation/account lifecycle. These are separate from the
  application client secrets.

Do not put client secrets into portal/Vite variables, screenshots, Git,
handoffs, or this inventory. Changing callback allowlists does not require
rotating a client secret. If a secret is rotated, update the corresponding
runtime secret store and verify that flow before retiring the previous secret.

## Verification status and follow-up

The screenshots show the correct local SSO and Gmail redirect URIs. The Drive
local JavaScript origin is visible, but its local redirect URI is below the
captured area and remains unverified. SSO's screenshot also contains the old
8787 entries; their removal and saved Console state have not been confirmed.

After saving any Console changes, run `pnpm backend` and `pnpm site`, then use
`https://localhost:3003` to complete each flow: Google sign-in, connect Gmail,
and connect Drive. Confirm successful return to Pantry and the expected
account. Screenshots of configured URLs alone do not establish end-to-end
OAuth success.

Gmail push delivery additionally needs Pub/Sub configuration; OAuth callback
registration does not verify incoming email delivery. See the
[Gmail mailbox runbook](../runbooks/gmail-mailboxes.md).

## Planned ownership and environment separation

The intended next setup uses a dedicated Google account to administer Pantry's
Google Cloud projects and OAuth applications. This account is administrative
ownership; Gmail integrations still connect the mailboxes selected by their
users. Account creation, ownership transfer, and environment provisioning have
not been performed.

Create isolated dev, staging, and production configurations. Within each
environment, retain separate SSO, Gmail, and Drive OAuth clients: three clients
per environment, nine in total. Each client has its own secret and allows only
that environment's approved origins and callbacks. Decide the Google Cloud
project layout when provisioning; the existing project labels above describe
the current setup only.

Migration sequence:

1. Create and secure the dedicated administrative account, including recovery
   access, and grant it the required project access before removing any
   existing owner access.
2. Confirm the dev, staging, and production hostnames and Google Cloud project
   layout. Provision isolated Pantry runtime resources; staging does not yet
   have a configured Wrangler profile.
3. Create the three OAuth clients per environment. Configure the appropriate
   consent settings, test users or publishing requirements, API access, and
   exact callback allowlists for each integration.
4. Record the new project IDs, client IDs, owners, and origins in this
   inventory. Store secrets in each environment's secret store; keep secret
   values out of documentation.
5. Switch one environment at a time and prove SSO, Gmail, and Drive end to
   end. Plan Gmail/Drive reconnection when changing client IDs: existing
   account tokens are bound to their original OAuth client.
6. Retire superseded clients and allowlist entries after the affected accounts
   have migrated and the new flows are verified.

Related operational details:
[environment configuration](../runbooks/environment-configuration.md) and
[provider callback origins](../runbooks/provider-callback-origins.md).
