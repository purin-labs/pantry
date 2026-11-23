# FND-08 — Vault

The Vault keeps the secrets of an Organisation in Purin Pantry: provider tokens, webhook
secrets, model keys, model sign-ins and website sign-ins. Each secret is one AES-256-GCM
row in the regional D1 database, and the root keys are in Cloudflare Secrets Store.
Trusted Platform code gets a secret for one operation, only when the purpose and the
current state of the credential agree. A Vault view, a receipt, a trace and an error
carry no secret. Other records name a secret by its handle (`vault:…`). The Vault page
of the Portal holds website logins and contact profiles for Sous Chef agents. An
Organisation keeps these items in Purin Vault or in one 1Password vault. Agents cannot
read or use an item yet.

## What it does

### Secrets, handles and roots

- A handle names one secret of one Organisation. It matches
  `^vault:[a-z0-9][a-z0-9:_-]*$` (`parseVaultHandle`). A handle alone gives no access.
- A write encrypts the secret with the active root and decrypts the result as a check.
  Then it writes the row. The authenticated data is
  `<organisationId>:<handle>:<keyVersion>`, and the nonce is 12 random bytes.
- A second write to a live handle replaces the ciphertext and sets `rotated_at`. A write
  to a revoked handle fails with `vault_secret_revoked`.
- A fenced write (`storeOrganisationPlacementVaultSecret`) stores the row only while the
  placement of the Organisation is active. A fence that fails gives
  `vault_secret_revoked`, the same code as a revoked handle.
- `storeOrganisationExecutionVaultSecret` is the fenced write of an Actor. It gives
  `organisation_placement_conflict` when the placement is not active.
  `storeSessionExecutionVaultSecret` lets a Session turn store a refreshed file-provider
  token under its turn lease.
- A read fails closed with one of these codes: `vault_handle_unknown`,
  `vault_secret_revoked`, `vault_root_unavailable`, `vault_root_invalid`,
  `vault_ciphertext_invalid` and `vault_plaintext_invalid`.
- The roots are the Secrets Store bindings `VAULT_ROOT_V1` and `VAULT_ROOT_V2`. Each
  root is 32 bytes in base64. `PANTRY_VAULT_ACTIVE_KEY_VERSION` (`v1` or `v2`) selects
  the root for a write. A read uses the root of the version on the row.
- The keyring refuses an unknown active version, a duplicate version, a missing active
  root and key material that is not 32 bytes. The Worker configuration binds
  `VAULT_ROOT_V1` only and sets the active version to `v1`.
- Each write and each read of a live row loads each bound root. If one bound root does
  not load or is not 32 bytes, the write or the read fails (`vault_root_unavailable` or
  `vault_root_invalid`), also for a row of the other version.

| Secret kind                | Content                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bearer`                   | One token, for example a model key or the 1Password service account token                                                                                                    |
| `expiring_bearer`          | One token and its expiry time                                                                                                                                                |
| `header`                   | One header name and its value                                                                                                                                                |
| `oauth_tokens`             | An access token, a refresh token and an expiry (`expires` or `provider_managed`)                                                                                             |
| `oauth_client_credentials` | A client id and a client secret                                                                                                                                              |
| `opaque_profile`           | One text in a named format: `codex_auth_json_v1`, `codex_device_authorization_v1`, `chatgpt_agent_profile_v1`, `chatgpt_agent_sign_in_v1` or `commerce_square_connection_v1` |
| `website_login`            | The username and the password of a Vault item                                                                                                                                |

### Resolution by purpose

`credential-vault/index.ts` exports no function that returns a secret from a handle
alone. `verifyStoredVaultSecret` and `verifyRestoredVaultBackup` decrypt from the
Organisation id and the handle, and they return `true`. A resolver returns the secret
only when the current rows agree. Each resolver reads those rows before the decrypt,
apart from the Slack resolvers.

| Purpose                    | Resolver                                                                                                                                                                                                                                               | What must be true                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider action            | `authorizeProviderActionResolution`, then `resolveProviderActionCredential`                                                                                                                                                                            | An `executing` action ledger entry with a valid flow binding. The Organisation and its onboarding are active. The account, the provider, the environment and the active generation agree. The second function checks the generation again                                                                                                                                                                                                  |
| Provider webhook           | `resolveProviderWebhookCredential`                                                                                                                                                                                                                     | A `live` webhook with the same signing secret handle and generation, on an active account, connection and generation                                                                                                                                                                                                                                                                                                                       |
| Discord interaction        | `resolveDiscordInteractionVerificationCredential`                                                                                                                                                                                                      | An active installation that holds the same public key handle                                                                                                                                                                                                                                                                                                                                                                               |
| Provider connection        | `resolveActiveProviderConnectionCredential`, `resolveProviderManifestCredential`                                                                                                                                                                       | An active connection and generation that hold the handle. The manifest read also accepts a `degraded` account and an Organisation in `configuring` or `activating`                                                                                                                                                                                                                                                                         |
| Surface installation       | `resolveSurfaceInstallationCredential`                                                                                                                                                                                                                 | An active installation of an active Organisation. Its bot token handle is the credential of an active account, connection and generation                                                                                                                                                                                                                                                                                                   |
| Slack bot token            | `resolveActiveSlackThreadCredential`; `readSlackThreadCredentialRoute`, then `resolveRoutedSlackThreadCredential`; `resolveActiveSlackOrganisationCredential`; `resolveSlackHealthCheckCredential`; `resolveActiveSlackPhysicalInstallationCredential` | An active `slack_installation` in the global database. The thread resolvers and the Organisation resolvers also need an active `slack_organisation_connection` there, and an active `integration_account` of an active Organisation in the regional database. A thread also needs its `slack_thread_case_pin` row. The health check also accepts a `degraded` account. These resolvers read no `provider_connection` row and no generation |
| Model key                  | `resolveOrganisationModelCredentialForRoute`                                                                                                                                                                                                           | An `organisation_byo` route of the same provider. Its `byoKeyRef` is the live `credential_ref` handle for the host of that provider                                                                                                                                                                                                                                                                                                        |
| Account removal            | `resolveAccountRemovalCredential`                                                                                                                                                                                                                      | A cleanup row in `pending_provider_cleanup`, `running_provider_cleanup` or `retry_scheduled` that lists the handle                                                                                                                                                                                                                                                                                                                         |
| Revocation at the provider | `resolveCredentialRevocationSecret`                                                                                                                                                                                                                    | An account and a connection that are not `revoked`. The connection holds the handle                                                                                                                                                                                                                                                                                                                                                        |

- One Organisation holds the Slack bot token for each Organisation that uses the
  workspace. `slack_installation.credential_organisation_id` names it, and the Slack
  resolvers read the token from the regional database of that Organisation. A connect
  makes the new Organisation the owner when the owner has no active connection in the
  workspace (`slackInstallationOwnerIsLive`).
- When the scope of the caller holds the token, `resolveRoutedSlackThreadCredential`
  starts the account check and the decrypt together, and the caller reads the placement
  fence. The other Slack paths read the placement fence after the decrypt, for each
  Organisation that they use. Each path returns the token only when each check passes.
- `storeOrganisationModelCredential` gives each model key a new handle
  `vault:<organisation>:<provider>:model:<uuid>`. One batch writes its `credential_ref`
  row (name `model`, one fixed host, `inject_as`) and revokes the old secret. The
  providers are `openai`, `anthropic` (prefix `sk-ant-`) and `google`.
  `resolveCurrentOrganisationModelCredential` reads the current key with no route.
- Other modules call `resolveVaultHandle` or `resolveVaultSecretRow` in `service.ts`
  directly: custom connectors, the Jev key, the ChatGPT and Claude sign-ins, and Slack
  ingress. Each one takes the handle from its own current record first: a connector
  credential binding, a connection row, a sign-in attempt row or a Slack thread route.
- A refused provider action or provider webhook writes a `credential_access_denial` row
  (purpose, reason code) and the trace `vault.resolution_denied`. The other resolvers
  return the error and write no row.

### Revocation and credential commands

- `revokeCredential` closes one credential in one batch on the primary: the generations,
  the webhooks, the accounts and the connections of the handle, its `credential_ref`
  rows and its `vault_secret` row. The same batch writes one
  `credential_revocation_operation` receipt (`committed`). A handle has one receipt, so
  a retry returns that receipt.
- Then `activateRevocationPolicy` publishes the Organisation policy again and moves the
  receipt to `policy_activated`, with the policy version and the latency. Pantry pushes
  nothing to a Session, so the receipt records zero consumers.
- Each read checks `revoked_at` on the row that it reads. After the commit, a read on
  the primary fails with `vault_secret_revoked`, also for a Session that started before
  the revocation. A read uses the database or the database session of its caller.
- `secret-revocation.ts` gives prepared statements. Another module puts one into its own
  batch, so that its change and the revocation commit together.
- An admin has three credential commands. The inventory gives metadata: accounts,
  generations, the state and the key version of each Vault row, rotations and
  revocations. A rotation takes a replacement secret for `airtable`, `notion`, `stripe`
  or `shopify`, validates it and activates a new generation. A revoke of an `active`
  default account of a provider needs a replacement account
  (`default_account_replacement_required`), apart from a mailbox account. For each
  other account, a replacement in the request gets
  `default_account_replacement_invalid`.

### Root rotation, the retained-root check and backup

1. An operator makes the target root the active version and deploys.
2. A `support_admin` starts a job with the source version. One job can be `pending`,
   `running` or `paused` at a time. The other states are `completed` and `failed`. A
   start refuses a source that is the active version (`rotation_source_matches_target`)
   and a source root that is not bound (`rotation_source_root_unavailable`).
3. Each step takes 1 to 100 rows from all bound regional databases, revoked rows also.
   It decrypts a row with the source root, encrypts it with the target root and
   verifies a decrypt. A step runs only on a `pending` or `running` job, a pause only
   on `running` and a resume only on `paused`. Another state gets
   `rotation_state_conflict`.
4. The update applies only if the key version, the nonce and the ciphertext are still
   the values that the step read. A row that already has the target version counts as
   skipped.
5. The job completes when no row has the source version. A failed job stays as a record
   with one code: `active_key_version_changed`, `source_root_unavailable`,
   `target_root_unavailable`, `ciphertext_invalid`, `verification_failed` or
   `persistence_conflict`. The operator starts a new job.

- The retained-root check decrypts each `vault_secret` row, revoked rows also. It reads
  each database in pages in key order and keeps only counts, so it has no row limit. It
  gives the row count for each key version and the status `passed` or `failed`. A finding is
  `referenced_vault_root_unavailable`, `retained_vault_ciphertext_invalid` or
  `retained_vault_plaintext_invalid`. The runbook requires this check before an
  operator removes a root.
- `backup.ts` makes an envelope (`pantry.vault-backup.v1`) of `vault_secret`,
  `vault_root_rotation_job`, `credential_ref` and `credential_revocation_operation`,
  with a SHA-256 digest. The export function receives no key binding. The import
  refuses a wrong digest, a key version that the keyring cannot read and a target that
  has Vault rows for the Organisation.

### Alert signals

The scheduled reconciliation (cron `*/15 * * * *`) ends with the Vault alert sweep
(`sweepVaultAlerts` in `alerts.ts`). The sweep reads each regional database and writes nothing.
It sends a `traceWarn` for each signal that is not zero.

| Trace                                      | Condition                                                                            | Constant                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `vault.alert.unknown_key_version_rows`     | A live row has a key version that the keyring cannot read                            | —                                                               |
| `vault.alert.stale_superseded_generations` | A superseded generation is older than 1 hour                                         | `STALE_GENERATION_ALERT_MS`                                     |
| `vault.alert.stuck_credential_rotations`   | A rotation is `pending_verification` or `verified` for more than 15 minutes          | `STUCK_ROTATION_ALERT_MS`                                       |
| `vault.alert.failed_credential_rotations`  | A rotation that started within the last 24 hours failed                              | `FAILED_ROTATION_WINDOW_MS`                                     |
| `vault.alert.delayed_restrictions`         | A revocation is `committed`, with no policy activation, for more than 5 s            | `RESTRICTION_LATENCY_ALERT_MS`                                  |
| `vault.alert.restriction_latency_breaches` | An activated revocation took more than 5 s. The trace also carries the target of 3 s | `RESTRICTION_LATENCY_ALERT_MS`, `RESTRICTION_LATENCY_TARGET_MS` |

The sweep also counts the denials of the last 24 hours (`DENIAL_WINDOW_MS`). It sends
no trace for this count.

### Vault items

- An item is a `website_login` or a `contact_profile`.
- A login has a label, 1 to 5 websites, a username and a password. A website is an exact
  `https` origin with a dotted host name. `normalizeVaultOrigin` refuses `http`, an IP
  address, a local name and a URL with credentials.
- A contact profile has a full name, a company, an email, a phone, an address and a tax
  or invoice registration number. It is not a secret. Its fields are in `vault_item`.
- In Purin Vault, the username and the password are one `website_login` secret with the
  handle `vault:website_login:<itemId>:generation_<n>`. **Replace sign-in** stores a new
  generation. One batch points the item to it and revokes the old secret.
- **Remove** revokes the secret and deletes the item row in one batch.
- Each command names the revision that the person saw. A stale revision gets
  `vault_item_revision_conflict`. Each item write carries the placement fence.
- No response carries a password. Pantry has no route that gives a saved password to a
  person, an owner included.

### The 1Password store

- An admin pastes the token of a 1Password service account. If the token reaches one
  vault, Pantry uses that vault. If it reaches more, Pantry asks for a choice and stores
  nothing before the choice.
- Pantry stores the token as a `bearer` secret
  (`vault:onepassword_service_account:<id>`) and one `vault_store` row. This token is
  the only 1Password secret in Purin Vault. A new connection revokes the old token in
  the batch that writes the row, and only when the row now names the new token. If a
  placement change refuses the row, Pantry revokes the new token and keeps the old one.
- While 1Password is connected, each new item goes to 1Password. The list shows the
  1Password items first, then the Purin Vault items. A command goes to the store that
  holds the item: a Purin Vault id has 32 hex digits, a 1Password id has 26 characters.
- A login is a 1Password Login with the `username` and `password` fields and one
  `ExactDomain` website for each origin. A contact profile is an Identity with the
  section "Purin Pantry contact". Items that Pantry writes carry the tag "Purin Pantry".
- The list shows a Login that has a username, and an Identity that has a full name in
  that section.
- **Remove** archives the item in 1Password, where a person can restore it.
- The revision of a 1Password item is its 1Password `version`. A remove reads a fresh
  list for the revision check.
- **Move** tries at most 10 items in one request. The source goes only after the target
  accepts the copy: Pantry revokes its sign-in, or archives the 1Password item. The
  answer gives the moved count and the remaining count, and the person moves again.
- An item that cannot move stays where it is, and the move goes on with the next item.
  A move to Purin Vault leaves a 1Password login that has no `https` website, and the
  remaining count leaves it out. It also leaves a login whose secret 1Password does not
  give. A move to 1Password leaves a Pantry item whose sign-in Pantry cannot read, and
  that item does not count against the 10.
- **Disconnect** revokes the token and deletes the `vault_store` row. The items stay in
  1Password.
- The Platform Worker keeps the 1Password list for 30 s in memory. Each write clears it.
  `GET …/vault/store` never calls 1Password.
- If 1Password does not answer, the store view has `reachable: false`, and the list
  shows the Purin Vault items only.
- The Worker `pantry-vault-onepassword` runs the 1Password SDK (`@1password/sdk`
  0.5.0). It has no route, no storage and no credential. It keeps a signed-in client in
  memory for 10 minutes under the SHA-256 hash of the token. Its invocation logs are
  off.

### The Vault page and the history

- **Settings → Vault** has one list, a search and a side drawer. The tabs are All,
  Logins, Contact info and API keys.
- The drawer of a login shows its websites, its username and the date of the saved
  password. It says "Never shown to agents or people. Only filled on" the website.
- An owner or an admin sees **Add**, **Edit**, **Replace sign-in** and **Remove**. Other
  members read the list and the history.
- The API keys tab is for owners and admins. It lists, read-only, the credentials of
  the credential inventory and the Organisation's own model key. The drawer of a row
  links to Integrations, where a person adds, replaces or revokes the key.
- The link opens the page of the integration for the model key and for the 10 providers
  in `ROUTED_PROVIDERS` (`keys.ts`). For another provider, for example a custom
  connector, it opens Integrations with no integration selected.
- A store line opens the **Connect 1Password** drawer or the store drawer, with the move
  and disconnect actions. The 1Password card on Integrations shows the same connect
  form and the same store details.
- A password and the 1Password token go through `controlSecretMutation`. The Portal
  stores no retry copy of that request body.
- Each add, edit, sign-in replacement, removal, move, connect and disconnect writes one
  `vault_item_event` row with the item, the store, the person and the time. The read
  does not name the person.
- The drawer of an item shows its newest 50 events. The details of a connected
  1Password store show the newest 50 events of the Vault, in the store drawer and on
  the Integrations card. Only an owner or an admin opens these details, so another
  member sees only the history of an item in the Portal.

## Contracts

| Table                             | Database | Content                                                                                                                             |
| --------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `vault_secret`                    | Regional | One encrypted secret: handle, key version, `AES-GCM-256`, nonce, ciphertext, `created_at`, `rotated_at`, `revoked_at`               |
| `credential_ref`                  | Regional | Provider, name, handle, host pattern, `inject_as`. The policy snapshot reads it                                                     |
| `credential_revocation_operation` | Regional | The receipt of a revocation: `committed` or `policy_activated`, with counts                                                         |
| `credential_access_denial`        | Regional | A refused read: purpose, reason code, handle, time                                                                                  |
| `external_vault_import`           | Regional | The receipt of an import from an external source: `active` or `revoked`                                                             |
| `vault_item`                      | Regional | One Purin Vault item: kind, label, origins, username, contact, handle, generation, revision                                         |
| `vault_store`                     | Regional | The connected 1Password vault and the handle of its token                                                                           |
| `vault_item_event`                | Regional | The history: `item_added`, `item_edited`, `sign_in_replaced`, `item_removed`, `item_moved`, `store_connected`, `store_disconnected` |
| `vault_root_rotation_job`         | Global   | One root rotation job: versions, state, cursor, counts, failure code                                                                |

The Vault has no table in Actor SQLite. The baselines are
`workers/platform/migrations-regional/0001_current_schema.sql` and
`workers/platform/migrations-global/0001_current_schema.sql`.

Routes under `/v1/control/organisations/:id` (`control/routes/vault.ts`,
`control/routes/integrations/credentials.ts`):

| Route                                          | Role   | Purpose                                                       |
| ---------------------------------------------- | ------ | ------------------------------------------------------------- |
| `GET /vault/items`                             | Viewer | The items of both stores and the store view                   |
| `POST /vault/items`                            | Admin  | Add a login or a contact profile                              |
| `POST /vault/items/:item/commands`             | Admin  | `edit_login`, `replace_sign_in`, `edit_contact`, `remove`     |
| `GET /vault/store`                             | Viewer | Where the items are, with no 1Password call                   |
| `POST /vault/store`                            | Admin  | `connect_onepassword`, `disconnect_onepassword`, `move_items` |
| `GET /vault/events`                            | Viewer | The newest 50 events, for one item with `?itemId=`            |
| `GET /credentials`                             | Admin  | The credential inventory (`pantry.credential-inventory.v1`)   |
| `POST /accounts/:account/credential-rotations` | Admin  | Rotate with a replacement secret                              |
| `POST /accounts/:account/revoke-credential`    | Admin  | Revoke the credential of an account                           |

The `/vault` routes refuse a request with these codes:

| Status | Codes                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| 404    | `vault_item_not_found`                                                                                             |
| 409    | `vault_item_revision_conflict`, `vault_item_limit_reached`, `vault_store_not_connected`, `vault_store_auth_failed` |
| 422    | `vault_item_invalid`, `vault_store_invalid`, `vault_store_vault_unknown`                                           |
| 429    | `vault_store_rate_limited`                                                                                         |
| 503    | `vault_item_store_failed`, `vault_store_unavailable`, `vault_unavailable`                                          |

Operator routes (`control/routes/operators.ts`, `gateway/admin/actor-registry.ts`):

| Route                                                 | Authority                         | Purpose                                  |
| ----------------------------------------------------- | --------------------------------- | ---------------------------------------- |
| `POST /v1/control/operator/vault/root-rotations`      | `support_admin`                   | Start a job: `{"sourceVersion":"v1"}`    |
| `GET /v1/control/operator/vault/root-rotations/:id`   | `support_admin`                   | Read a job                               |
| `POST …/root-rotations/:id/step`, `/pause`, `/resume` | `support_admin`                   | Run a step with `limit`, pause or resume |
| `GET /v1/admin/vault-root-closure`                    | Bearer `ORGANISATION_ADMIN_TOKEN` | The retained-root check                  |

- `foundation/authority/credential-vault/` is in the module `foundation/authority`
  (`scripts/layers.json`). Its files: `service.ts` (store, read, revoke), `crypto.ts`,
  `keyring.ts`, `domain.ts`, the resolvers (`*-resolution.ts`), `secret-revocation.ts`,
  `root-rotation.ts`, `root-closure.ts`, `backup.ts`, `alerts.ts`, `items.ts`,
  `stores.ts`, `external-import.ts` and `onepassword.ts`.
- `workers/platform/src/vault-onepassword/` is the 1Password store Worker: `worker.ts`,
  `handler.ts` and `protocol.ts`. Its operations are `list_vaults`, `list_items`,
  `create_item`, `update_item`, `archive_item` and `read_secret`. Its profile is
  `workers/platform/wrangler.vault-onepassword.jsonc`.
  `scripts/vault-onepassword-worker.mjs` prepares the SDK loader, checks and deploys it
  before the Platform Worker.
- `packages/control-api/src/vault.ts` (`@purin-labs/control-api`) holds the TypeBox
  schemas, the parsers and `normalizeVaultOrigin`.
- `areas/integrations/ui/features/vault/` holds the page. The preview is
  `apps/portal/vault-preview.html`.
- Worker bindings: `VAULT_ROOT_V1`, `VAULT_ROOT_V2`, `PANTRY_VAULT_ACTIVE_KEY_VERSION`
  and the service binding `VAULT_ONEPASSWORD`.
- The Vault has no agent tool and no capability in
  `foundation/authority/authorization/capability-catalogue.ts`.
- Operator procedures:
  [the Vault operations runbook](../../runbooks/vault-operations.md).

## Rules and limits

| Action                                            | Viewer, operator | Admin, owner | Agent |
| ------------------------------------------------- | ---------------- | ------------ | ----- |
| See the items, the store and the history          | Yes              | Yes          | No    |
| See a saved password or the 1Password token       | No               | No           | No    |
| Add, edit or remove an item; replace a sign-in    | No               | Yes          | No    |
| Connect or disconnect 1Password; move items       | No               | Yes          | No    |
| See the API keys tab and the credential inventory | No               | Yes          | No    |
| Rotate or revoke a provider credential            | No               | Yes          | No    |

A refused role on an Organisation route gets 404. A root rotation needs the
`support_admin` role and gets 403 (`support_admin_role_required`) without it.

| Limit                                               | Value                                     | Constant                                               |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Items in Purin Vault for one Organisation           | 200                                       | `VAULT_ITEM_LIMIT`                                     |
| Websites of a login                                 | 1 to 5. A 1Password view shows 20 at most | `VAULT_ORIGIN_LIMIT`                                   |
| Label, username, password                           | 80, 254 and 1,024 characters              | In `vault.ts`                                          |
| 1Password token                                     | 8,192 characters                          | In `vault.ts`                                          |
| Request body of a Vault route                       | 16,384 bytes                              | `VAULT_ITEM_BODY_LIMIT`                                |
| Items in one move request                           | 10                                        | `MOVE_BATCH`                                           |
| 1Password list in memory                            | 30 s                                      | `LIST_LIFETIME_MS`                                     |
| Signed-in 1Password client in memory                | 10 minutes                                | `CLIENT_LIFETIME_MS`                                   |
| Model key                                           | 20 to 4,096 characters                    | `MODEL_API_KEY_MIN_LENGTH`, `MODEL_API_KEY_MAX_LENGTH` |
| Rows in one rotation step                           | 1 to 100                                  | `MAX_ROTATION_BATCH_LIMIT`                             |
| Rows that the retained-root check reads at one time | 500, then the next page                   | `RETAINED_VAULT_PAGE_ROWS`                             |
| 1Password Worker script                             | One Wasm module, 6 MiB compressed         | `MAXIMUM_COMPRESSED_BYTES`                             |

- **Retention.** A revoked `vault_secret` row stays, with its ciphertext. No scheduled
  work deletes `vault_secret` rows, history rows or receipts.
- **End of an Organisation.** The archive cleanup revokes each live secret and each
  `credential_ref`, apart from the Slack installation tokens. The purge moves such a
  token to an Organisation that still uses the workspace, or it revokes the
  installation. Then the purge erases `vault_secret`, `vault_item`, `vault_store`,
  `vault_item_event`, `credential_ref` and `external_vault_import`. It keeps
  `credential_access_denial` and `credential_revocation_operation`
  (`data/purge-catalogue.ts`).
- **No plaintext outside one operation.** A view, a receipt, a trace and an error carry
  ids, counts and reason codes. The inventory carries no nonce and no ciphertext. A
  D1 copy alone cannot decrypt a secret, because the roots are not in D1.
- **Information flow.** No agent reads a Vault item, so a contact profile has no source
  label. A password and a token enter only in the request that saves them.
- **Cards.** The Vault stores no payment card. `vault_item.kind` accepts only
  `website_login` and `contact_profile`.
- **1Password.** Pantry sends the stored token with each operation to the 1Password
  store Worker. With it, the Worker lists, creates, updates and archives the items of
  the connected vault, and `read_secret` returns the username and the password of a
  login. Pantry does not use Purin Vault in its place when 1Password does not answer.
- **Out of scope:** a personal vault for each member, a live browser view for a person,
  passkeys and customer-managed keys for Purin Vault. The model key that Purin funds
  (`OPENROUTER_API_KEY`) stays a Worker secret. `DATA_ENCRYPTION_ROOT` (FND-02) is a
  different root.
- **Neighbours.** FND-01 owns the two databases and the placement fence. FND-04 owns the
  model routes and sign-ins that store their secrets here. FND-06 owns the policy
  snapshot that reads `credential_ref`, and the Session pin
  (`organisation_policy_superseded`). FND-07 owns source labels. FND-09 owns agent
  tools. INT-01 owns provider connections, `provider_credential_generation`,
  `credential_rotation` and custom connectors. ORG-01 owns archive and purge. ORG-02
  owns the Jev key. The commerce engine (COM-02) keeps its own keys.

## Open work

- **Agent use (Plan 79 phases 5 and 6).** The code has no agent browser container, no
  browser capability and no tool `vault.list_items`, `vault.fill_login` or
  `vault.request_login`. It has no fill resolver, no origin check at a fill, no approval
  for each Case, no fill receipt and no sign-in request sheet. `read_secret` serves the
  move only.
- **Secure notes (phase 3)** are not built.
- **Payment cards (phase 4)** are not built: no `payment_card` kind and no
  `VAULT_CARDS_ENABLED` switch. Plan 79 keeps card storage and card fill off in
  production until the PCI DSS verification passes. Pantry must never store a CVV.
- A login has no one-time code seed. A website cannot be a subdomain wildcard.
- Pantry keeps no reference row for a 1Password item. A person cannot choose the store
  for a new item while 1Password is connected.
- The list omits an Identity that a person made in the 1Password app, and each other
  1Password category.
- A history row has no Case, and the read does not name the person.
- Plan 79 requires one journey with a real 1Password service account from the deployed
  Worker. The E2E journey uses a fake client behind the real handler.
- No route and no script calls the backup export, the backup import, the external
  import (`importExternalVaultSecret`, the 1Password Connect adapter) or
  `vaultRootVersionRemovalStatus`. Tests call them.
- The keyring knows `v1` and `v2`. A third root needs a code change.
- Only provider actions and provider webhooks write a denial receipt. The purpose
  `harness` has no writer.
- No E2E journey calls the root rotation routes or the two credential commands.
- Plan 12 requires one rehearsal of the runbook in a separate Cloudflare environment
  before the first live root rewrap or restore.

## Sources

- [Plan 12](../../history/plan-12-policy-governed-harness-secrets-vault.md) and
  [Plan 79](../../history/plan-79-agent-vault.md). Where a plan differs from the code, this
  spec follows the code.
- In the archive:
  [Plan 13](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-13-cloudflare-cutover.md),
  which completed the move from the old credential sources.
- [The security architecture](../../architecture/security.md#vault-policy-and-revocation):
  the section "Vault, policy and revocation".
- E2E journeys in `workers/platform/tests/e2e/`:
  - Items and stores: `vault-items.test.ts` and `vault-onepassword.test.ts`, with
    `vault-support.ts` and the fake 1Password client in `onepassword-network.ts`.
  - The retained-root check over more than 1,000 rows in two regional databases:
    `vault-root-closure.test.ts`. The alert for a failed rotation:
    `vault-alerts.test.ts`.
  - Root rotation in two regional databases: `regional-onboarding.test.ts`
    (`regional-execution-support.ts`).
  - Vault rows in provider journeys: `providers-connection.test.ts`,
    `providers-webhooks.test.ts` and `provider-removed-access.test.ts`.
- Other tests in `workers/platform/tests/`: `credential-vault-*.test.ts`,
  `vault-canary-probe.test.ts` and `credential-lifecycle.test.ts`.
