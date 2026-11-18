# Google Drive and Dropbox deployment credentials

Status: Active deployment procedure

Satyr owns the Google Drive and Dropbox provider applications. An organisation never
creates an API key, OAuth client, or Dropbox app. Organisation operators only select
**Connect Google Drive** or **Connect Dropbox**, sign in to the provider, and
approve access.

Create separate provider applications for staging and production. Separate
applications keep test users, callback allowlists, consent branding, secrets,
provider review status, and incident response isolated.

## Environment origins

Provider callback URLs are derived from `SATYR_OAUTH_CALLBACK_ORIGIN`. Google
Picker's browser origin is `SATYR_PUBLIC_ORIGIN`. Deployed environments normally
use the same HTTPS origin for both values.

| Environment                     | Public and callback origin                |
| ------------------------------- | ----------------------------------------- |
| Staging target                  | `https://staging.console.seams.sh`        |
| Current production              | `https://satyr-edge.n6378056.workers.dev` |
| Production custom-domain target | `https://console.seams.sh`                |

Use an origin only after its DNS, TLS certificate, Worker route, and Portal are
live. The current production callback remains the `workers.dev` origin until a
custom-domain cutover is complete.

For each active origin, the provider URLs are:

| Provider                    | Staging                                                                       | Current production                                                                   |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Dropbox OAuth callback      | `https://staging.console.seams.sh/v1/control/providers/dropbox/callback`      | `https://satyr-edge.n6378056.workers.dev/v1/control/providers/dropbox/callback`      |
| Dropbox webhook             | `https://staging.console.seams.sh/hook/dropbox`                               | `https://satyr-edge.n6378056.workers.dev/hook/dropbox`                               |
| Google Drive OAuth callback | `https://staging.console.seams.sh/v1/control/providers/google_drive/callback` | `https://satyr-edge.n6378056.workers.dev/v1/control/providers/google_drive/callback` |
| Google JavaScript origin    | `https://staging.console.seams.sh`                                            | `https://satyr-edge.n6378056.workers.dev`                                            |

See [Provider callback origins](../runbooks/provider-callback-origins.md) before
adding an environment or changing a hostname.

## Credential placement

The six deployment values identify Satyr's provider applications. OAuth access
and refresh tokens issued for individual organisations are stored by Satyr's Vault
after consent. They do not belong in Worker configuration.

| Name                          | Source                            | Placement       | Browser-visible                     |
| ----------------------------- | --------------------------------- | --------------- | ----------------------------------- |
| `DROPBOX_OAUTH_CLIENT_ID`     | Dropbox **App key**               | Wrangler `vars` | Yes                                 |
| `DROPBOX_OAUTH_CLIENT_SECRET` | Dropbox **App secret**            | Wrangler secret | No                                  |
| `GDRIVE_OAUTH_CLIENT_ID`      | Google OAuth web client ID        | Wrangler `vars` | Yes; Google Picker uses it          |
| `GDRIVE_OAUTH_CLIENT_SECRET`  | Google OAuth web client secret    | Wrangler secret | No                                  |
| `GDRIVE_PICKER_API_KEY`       | Restricted Google browser API key | Wrangler `vars` | Yes; restrict it by website and API |
| `GDRIVE_PICKER_APP_ID`        | Google Cloud project number       | Wrangler `vars` | Yes                                 |

Client IDs, the restricted Picker API key, and the project number are public
application configuration. Client secrets are confidential server credentials.
Never put a client secret in `vars`, Portal code, D1, documentation, command
arguments, screenshots, or Git.

Do not generate a Dropbox access token for deployment. Generated tokens are for
single-account experiments and do not replace organisation OAuth.

## Dropbox application

Official links:

- [Dropbox App Console](https://www.dropbox.com/developers/apps)
- [Create a Dropbox app](https://www.dropbox.com/developers/apps/create)
- [Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide)

Repeat this procedure once for staging and once for production.

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and
   select **Create app**.
2. Choose **Scoped access** and **Full Dropbox**.

   Satyr must read pre-existing files that an organisation explicitly grants. **App
   folder** limits the app to its own `/Apps` folder and cannot support that
   flow.

3. Give the app an environment-specific name, such as `Satyr Drive Staging` or
   `Satyr Drive Production`.
4. On **Permissions**, enable only:

   - `account_info.read`
   - `files.metadata.read`
   - `files.content.read`

   Satyr requests and validates this exact scope set. Write, sharing, team,
   file-request, and collaboration permissions are unnecessary.

5. On **Settings**, add the environment's exact OAuth redirect URI from the
   table above. Scheme, hostname, path, and trailing-slash behavior must match.
6. Set **Allow public clients (Implicit Grant & PKCE)** to **Allow**. Satyr uses
   authorization-code flow with PKCE and a server-side client secret. It does
   not use implicit grant.
7. Add the environment's `/hook/dropbox` URL as the webhook URI. Dropbox should
   verify it by sending a `challenge` request and receiving the same value in an
   HTTP 200 response.
8. Do not configure Chooser, Saver, or Embedder domains. Satyr uses the Dropbox
   API and its own granted-resource UI.
9. Copy the **App key** to `DROPBOX_OAUTH_CLIENT_ID` for the matching Satyr
   environment.
10. Reveal the **App secret** only when entering it into Wrangler as
    `DROPBOX_OAUTH_CLIENT_SECRET`.
11. Keep the staging app in development status and limit it to test accounts.
    After production acceptance, complete Dropbox's production review for the
    production app before offering the connection broadly.

Dropbox application status and organisation connection status are separate. Changing
the app from development to production does not connect an organisation; every organisation
still completes OAuth.

## Google Drive project and application

Google recommends separate Cloud projects for staging and production. Use the
same project for an environment's OAuth client, Picker API key, and Picker App
ID.

Official links:

- [Google Cloud project selector](https://console.cloud.google.com/projectselector2/home/dashboard)
- [Google Auth Platform](https://console.cloud.google.com/auth/overview)
- [OAuth clients](https://console.cloud.google.com/auth/clients)
- [OAuth audience](https://console.cloud.google.com/auth/audience)
- [OAuth data access](https://console.cloud.google.com/auth/scopes)
- [API credentials](https://console.cloud.google.com/apis/credentials)
- [Enable Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Enable Google Picker API](https://console.cloud.google.com/apis/library/picker.googleapis.com)
- [Google Picker web guide](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Google Drive scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

Repeat this procedure in the staging project and production project.

### 1. Create and identify the project

1. Create or select the environment's Google Cloud project.
2. Record the numeric **Project number** from the project dashboard. This is
   `GDRIVE_PICKER_APP_ID`.

   The Picker App ID is the project number. It is not the project ID, OAuth
   client ID, or API key.

3. Enable both the **Google Drive API** and **Google Picker API**.

### 2. Configure Google Auth Platform

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   and complete **Branding** with the Satyr application name, support email,
   home page, privacy policy, terms, and authorized domains.
2. Under **Audience**:

   - staging: choose **External** with publishing status **Testing**, then add
     the engineers and test accounts that may connect;
   - production: choose the intended production audience and publish the app
     **In production** when it is ready for external organisations.

   Google testing authorizations for scopes beyond basic identity normally
   expire after seven days, including refresh tokens. Expect periodic staging
   reconnection while the project remains in Testing.

3. Under **Data Access**, add only:

   ```text
   https://www.googleapis.com/auth/drive.file
   ```

   Satyr validates this exact scope. It lets the app access files the user
   selects through Google Picker without granting blanket Drive access.

4. Use **Verification Center** to complete the production checks required by
   Google before broad external rollout. Submit only the production project for
   verification; keep development and staging isolated.

### 3. Create the OAuth web client

1. Open [OAuth clients](https://console.cloud.google.com/auth/clients), select
   **Create client**, and choose **Web application**.
2. Give it an environment-specific name.
3. Add the environment's `SATYR_PUBLIC_ORIGIN` under **Authorized JavaScript
   origins**. Enter only the origin, with no path.
4. Add the exact Google Drive callback under **Authorized redirect URIs**:

   ```text
   ${SATYR_OAUTH_CALLBACK_ORIGIN}/v1/control/providers/google_drive/callback
   ```

5. Copy the client ID to `GDRIVE_OAUTH_CLIENT_ID`.
6. Copy the client secret once and enter it into Wrangler as
   `GDRIVE_OAUTH_CLIENT_SECRET`.

The same web client ID supports the server OAuth flow and the browser Picker.
Do not reuse `GOOGLE_OIDC_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_ID`, or another Google
application's secret.

### 4. Create and restrict the Picker API key

1. Open [API credentials](https://console.cloud.google.com/apis/credentials).
2. Select **Create credentials → API key**.
3. Edit the key and set **Application restrictions** to **Websites**.
4. Add the matching Portal origin and its path wildcard. For staging:

   ```text
   https://staging.console.seams.sh
   https://staging.console.seams.sh/*
   ```

   For current production:

   ```text
   https://satyr-edge.n6378056.workers.dev
   https://satyr-edge.n6378056.workers.dev/*
   ```

5. Set **API restrictions** to **Restrict key** and allow the **Google Picker
   API**.
6. Save the key as `GDRIVE_PICKER_API_KEY` in the matching Worker `vars`.

The Picker key is sent to the organisation's browser. Its website and API
restrictions are the security boundary. Never reuse an unrestricted server key.

## Configure the Worker

### Public application values

Add the four public values to the matching Wrangler environment's `vars`:

```jsonc
{
  "DROPBOX_OAUTH_CLIENT_ID": "<dropbox-app-key>",
  "GDRIVE_OAUTH_CLIENT_ID": "<google-web-client-id>",
  "GDRIVE_PICKER_API_KEY": "<restricted-picker-api-key>",
  "GDRIVE_PICKER_APP_ID": "<google-cloud-project-number>",
}
```

The current production deployment uses the top-level `vars` in
`services/platform/wrangler.jsonc`. A staging deployment must first have a real
`env.staging` Worker configuration with its own name, D1 database, Durable
Objects, queues, buckets, service bindings, origins, and `vars`. The repository
does not currently define that environment. Do not point `--env staging` at
production bindings.

Wrangler environment variables are non-inheritable. When adding `env.staging`,
define its complete `vars` set instead of assuming top-level production values
carry over.

### Server secrets

Enter secrets interactively so they do not appear in shell history.

Current production, which is Wrangler's default environment:

```bash
pnpm --filter @seams/platform exec wrangler secret put DROPBOX_OAUTH_CLIENT_SECRET
pnpm --filter @seams/platform exec wrangler secret put GDRIVE_OAUTH_CLIENT_SECRET
```

Staging, after `env.staging` and its isolated resources exist:

```bash
pnpm --filter @seams/platform exec wrangler secret put DROPBOX_OAUTH_CLIENT_SECRET --env staging
pnpm --filter @seams/platform exec wrangler secret put GDRIVE_OAUTH_CLIENT_SECRET --env staging
```

Once an integration is intentionally enabled in an environment, include its
server secret in that environment's `secrets.required` list so deployment fails
closed if the secret is absent.

List configured secret names without reading their values:

```bash
pnpm --filter @seams/platform exec wrangler secret list
pnpm --filter @seams/platform exec wrangler secret list --env staging
```

## Deployment preflight

1. Confirm the active Worker origins exactly match the provider-console
   allowlists.
2. Confirm the current D1 schema is installed. Existing databases created from
   an older baseline must be upgraded through an approved schema change before
   enabling these providers.
3. Run the migration and integration checks:

   ```bash
   pnpm --filter @seams/platform test:migrations
   pnpm --filter @seams/platform d1:schema:remote:check
   pnpm --filter @seams/platform exec vitest run \
     tests/dropbox-provider-adapter.test.ts \
     tests/dropbox-file-context-webhook.test.ts \
     tests/google-drive-provider-adapter.test.ts \
     tests/provider-callback-authority.test.ts
   pnpm --filter @seams/platform check:types
   pnpm portal:build
   ```

4. The remote schema check probes the current Plan 31 responsibility scopes,
   Plan 33 payment observations, and Plan 34 file-context tables and columns.
   It also rejects stale required-column and provider constraints, missing
   projection triggers or indexes, and foreign-key violations. The production
   deploy command runs this check before publishing the Worker.
5. For an existing remote D1 database, this provider-specific read-only check
   must return no rows:

   ```sql
   SELECT name
   FROM sqlite_master
   WHERE type = 'table'
     AND name IN (
       'onboarding_support_reference',
       'provider_connection_attempt',
       'provider_authorization_state',
       'provider_provisioning_attempt',
       'provider_manifest'
     )
     AND (sql NOT LIKE '%dropbox%' OR sql NOT LIKE '%google_drive%');
   ```

6. Deploy staging first. Complete its browser acceptance before promoting the
   same code revision to production.

## Post-deployment acceptance

### Dropbox

1. Verify the webhook challenge:

   ```bash
   curl -fsS "${SATYR_OAUTH_CALLBACK_ORIGIN}/hook/dropbox?challenge=satyr-dropbox-check"
   ```

   The response must be `satyr-dropbox-check` with HTTP 200.

2. In a disposable organisation workspace, select **Connect Dropbox**.
3. Confirm Dropbox displays the expected environment-specific app name and only
   the three read scopes.
4. Approve the connection and confirm the Portal returns to **Connected**.
5. Grant a test file or folder, run reconciliation, and prove search, bounded
   read, and citation behavior.
6. Edit and remove the test resource, then confirm reconciliation supersedes
   stale projections.

### Google Drive

1. In a disposable organisation workspace, select **Connect Google Drive**.
2. Confirm Google displays the matching environment's branding and only
   `drive.file` access.
3. Approve the connection and confirm the Portal returns to **Connected**.
4. Open Google Picker. Confirm it loads without `redirect_uri_mismatch`, origin,
   API-key, or app-ID errors.
5. Select a test file and prove search, bounded read, and citation behavior.
6. Remove the grant or provider access and confirm stale projections are
   superseded.

No acceptance step should expose access tokens, refresh tokens, client secrets,
authorization codes, or Vault payloads. Verify Vault persistence through
credential references and lifecycle state only.

## Rotation and removal

- Rotate staging and production independently.
- For a client-secret rotation, install the replacement Worker secret in the
  matching environment immediately after creating it at the provider. Verify a
  new OAuth connection and token refresh before revoking the old secret.
- For a Picker API-key rotation, create and restrict the replacement key, update
  `GDRIVE_PICKER_API_KEY`, deploy, verify Picker, then delete the old key.
- Remove obsolete callback URLs and website referrers after an origin cutover
  and after in-flight OAuth attempts have expired.
- Revoke any generated Dropbox access tokens used during development. They are
  unrelated to organisation OAuth and should not remain active.
- If a secret appears in chat, logs, a screenshot, shell history, or Git, treat
  it as compromised and rotate it.

Official references:

- [Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide)
- [Google OAuth for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google Picker for web apps](https://developers.google.com/workspace/drive/picker/guides/web-picker)
- [Google Drive OAuth scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google API-key restrictions](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys)
- [Google OAuth audience and publishing status](https://support.google.com/cloud/answer/15549945)
