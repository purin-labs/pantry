# Google OAuth clients

Inventory recorded 2026-09-08 from the local Worker configuration and the
owner's Google Cloud Console screenshots. Client IDs are public identifiers.
Secret values must never be added to this document.

Satyr uses three separate web application OAuth clients. Google SSO signs a
person into Satyr; Gmail and Drive connect that person's provider accounts.
Each flow has its own credentials and callback path.

## Client inventory

| Purpose                  | Google Cloud project shown in Console | Client ID setting        | Client secret setting        |
| ------------------------ | ------------------------------------- | ------------------------ | ---------------------------- |
| Google SSO login         | `seams`                               | `GOOGLE_OIDC_CLIENT_ID`  | `GOOGLE_OIDC_CLIENT_SECRET`  |
| Gmail integration        | `Satyr Gmail Development`             | `GMAIL_OAUTH_CLIENT_ID`  | `GMAIL_OAUTH_CLIENT_SECRET`  |
| Google Drive integration | `satyr-drive-pilot`                   | `GDRIVE_OAUTH_CLIENT_ID` | `GDRIVE_OAUTH_CLIENT_SECRET` |

Project labels above identify the observed Console projects; they are not a
verified inventory of Google Cloud project IDs. The Drive client display name
is `Satyr Google Drive (dev)`.

### Google SSO login

```text
971053349716-6307q8845efbiript6fbj86jo11mcfr4.apps.googleusercontent.com
```

### Gmail integration

```text
502066821359-gurke0m6ja02sv7t824lgei8f93vvn04.apps.googleusercontent.com
```

### Google Drive integration

```text
791319521481-4ebf0qsifdtqddm66ev837ouem2kffc1.apps.googleusercontent.com
```

These IDs match `services/platform/wrangler.jsonc` → `env.local.vars`.
Production Gmail also declares the listed Gmail ID in `env.production.vars`.
Production SSO and Drive IDs remain configured through Cloudflare secrets;
their deployed values have not been inventoried here. Do not overwrite them
with local values without checking the selected production client.

## Redirect allowlists

In each client's Google Cloud Console page, use **Authorized redirect URIs**.
Keep the current production callback when maintaining a client that serves
both local and production flows.

| Client | Local redirect URI                                                  | Current production redirect URI                                                      |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| SSO    | `https://localhost:3003/v1/control/auth/google/callback`            | `https://satyr-edge.n6378056.workers.dev/v1/control/auth/google/callback`            |
| Gmail  | `https://localhost:3003/v1/control/providers/gmail/callback`        | `https://satyr-edge.n6378056.workers.dev/v1/control/providers/gmail/callback`        |
| Drive  | `https://localhost:3003/v1/control/providers/google_drive/callback` | `https://satyr-edge.n6378056.workers.dev/v1/control/providers/google_drive/callback` |

SSO derives its callback from `SATYR_PUBLIC_ORIGIN`. Gmail and Drive derive
theirs from `SATYR_OAUTH_CALLBACK_ORIGIN`. Both local origins are
`https://localhost:3003`. Exact scheme, port, path, and trailing slash matter.

The SSO web client's local **Authorized JavaScript origin** is
`https://localhost:3003`; its current production origin is
`https://satyr-edge.n6378056.workers.dev`. The Drive screenshot also shows
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
- Production client secrets: Cloudflare Worker secrets for `satyr-edge`,
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
and connect Drive. Confirm successful return to Satyr and the expected
account. Screenshots of configured URLs alone do not establish end-to-end
OAuth success.

Gmail push delivery additionally needs Pub/Sub configuration; OAuth callback
registration does not verify incoming email delivery. See the
[Gmail mailbox runbook](../runbooks/gmail-mailboxes.md).

## Planned ownership and environment separation

The intended next setup uses a dedicated Google account to administer Satyr's
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
   layout. Provision isolated Satyr runtime resources; staging does not yet
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
