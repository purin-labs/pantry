# INT-01 — Integrations and connectors

An Organisation in Purin Pantry connects outside services in two ways. A built-in
provider, such as Gmail, Slack or Stripe, connects through OAuth (or Meta Embedded
Signup) to the shared Pantry application of that provider. A custom connector connects
the Organisation's own HTTPS JSON API or MCP server with an API key and a reviewed
definition. Both give integration accounts, and grants on them give capabilities to
people and Sous Chef agents. An owner or an admin approves or refuses each custom write.
Providers send callbacks and webhooks to the public origin `https://pantry.purin.io`.
Slack sends its events and interactions to `slack.pantry.purin.io`.

## What it does

### Built-in providers

`PROVIDER_ADAPTERS` (`areas/integrations/server/provider-adapters/catalogue.ts`) is the one
registry of provider behavior. Each entry gives the data classes, the capability IDs, the
connection family, the onboarding adapter, `completeConnection`, `observe`, `remove` and
`manualActionInstruction`. Some shared code still branches on a provider name, for
example for the Gmail product, the Square environment and the form of a supplied secret.
The Shopify module gives its own entry, and the Worker registers it.
`ActiveIntegrationProvider` (`data/integration-provider-directory.ts`) holds ten
providers:

| Provider       | Family          | Data class  | Capability IDs                                | Manual instruction if removal fails           |
| -------------- | --------------- | ----------- | --------------------------------------------- | --------------------------------------------- |
| `airtable`     | OAuth, PKCE     | `records`   | `airtable.api.read`, `airtable.api.write`     | `revoke_airtable_access_in_airtable` (always) |
| `dropbox`      | OAuth, PKCE     | `files`     | `file.read`                                   | `revoke_dropbox_access_in_dropbox`            |
| `gmail`        | OAuth, PKCE     | `mail`      | Mailbox read, reply and operational proposals | `revoke_gmail_access_in_google`               |
| `google_drive` | OAuth, PKCE     | `files`     | `file.read`                                   | `revoke_google_drive_access_in_google`        |
| `notion`       | OAuth           | `records`   | None                                          | `revoke_notion_access_in_notion`              |
| `shopify`      | OAuth           | `commerce`  | From the Shopify module                       | `remove_shopify_app_in_shopify`               |
| `slack`        | OAuth           | `messaging` | Slack message proposal                        | `remove_slack_app_in_slack`                   |
| `square`       | OAuth           | `payments`  | None                                          | `revoke_square_access_in_square`              |
| `stripe`       | OAuth (Connect) | `payments`  | None                                          | `revoke_stripe_access_in_stripe`              |
| `whatsapp`     | Embedded Signup | `messaging` | WhatsApp support read and reply               | `remove_whatsapp_access_in_meta`              |

Airtable removal always returns `manual_action_required`. Gmail asks for one of two
products (`mail/gmail-authorization.ts`): `full_mailbox_pilot` (`gmail.readonly`,
`gmail.compose`) or `send_only` (`gmail.send`). Before a start,
`providerConfigurationIsValid` checks the client ID and secret of the provider.

Discord is not one of these providers and has no integration account. A
`POST /v1/admin/discord-interactions` with `ORGANISATION_ADMIN_TOKEN` stores one
`discord_interaction_install` for an Organisation: the application, the guild and the
public key in the Vault (`data/discord-install.ts`). `/hook/discord/:org` checks the
Ed25519 signature of each interaction with that key.

### Connect, callback and the popup

1. An admin starts a connection. Pantry makes one `provider_connection_attempt`
   (`purpose` `connect`, `reconnect` or `rotate`) and returns the authorization URL. One
   open attempt is allowed for each Organisation, provider and existing account
   (`idx_provider_attempt_open`).
2. `provider_authorization_state` keeps only a hash of the OAuth state. The row binds
   the attempt, Organisation, provider, environment, user, portal subject hash, nonce
   hash and return path, and the PKCE verifier when the family needs one.
3. The provider sends the browser to `GET /v1/control/providers/:provider/callback`.
   The callback consumes the state one time and stores the hash of the code. A repeated
   callback returns the attempt. Another code fails with `provider_state_replayed`.
4. The callback page holds no credential and has a strict CSP (`default-src 'none'`).
   Every second it sends `pantry.provider-attempt.completed` to `window.opener` at the
   exact portal origin and on the `BroadcastChannel` `pantry-provider-attempt`, which
   works when Cross-Origin-Opener-Policy cuts the opener. It closes after
   `pantry.provider-attempt.ack`. With no opener and no ack after 4 s, it goes back to
   the Portal. The Portal listener (`features/integrations/provider-authorization.ts`)
   acknowledges each valid message from its own origin, also for an attempt that it did
   not start. It handles each attempt ID one time and reads the server state again, so
   a lost message loses no progress.

```text
created -> authorizing -> callback_received -> provisioning -> connected
any open state -> cancelled | failed | expired
```

### Provisioning, accounts and observation

- `provider_provisioning_attempt` (`running`, `succeeded`, `failed_retryable`,
  `failed_terminal`) runs the phases `discovering_identity`, `persisting_credential`,
  `discovering_accounts`, `reconciling_webhooks`, `discovering_resources`,
  `verifying_connection` and `finalizing`. Each phase writes one
  `provider_provisioning_receipt` before it advances, and a retry resumes from the
  receipts. The credential is stored before an account becomes active.
- `provider_connection` is the shared grant. `integration_account` is each provider
  resource of the grant, with its capability set and its audience and retention
  policies. A reconnect or a rotation that returns another provider account ID fails
  with `provider_account_ineligible` (`verifyExistingAccountIdentity`). An account or a
  mailbox that is already claimed fails with `provider_account_already_claimed`.
- An observation writes `provider_manifest_observation` (`healthy`, `degraded`,
  `blocked`, `observation_unsupported`) against `provider_manifest`. An unhealthy result
  moves an `active` account to `degraded`. A healthy result clears only the reason
  `provider_manifest_unhealthy` (`provider-lifecycle/observation.ts`). Slack, Stripe,
  Square, Dropbox, Google Drive and Shopify observe; the others are unsupported.
- A discovery read makes a `provider_resource_snapshot`. Before Pantry stores an access
  grant on a Dropbox or Google Drive resource, `validateFileGrantTarget`
  (`context/files/grant-validation.ts`) reads the resource from the provider again. A
  resource that it cannot read fails with `provider_resource_not_accessible`.
- At most one built-in account for each provider and environment is the default. A
  change writes `provider_default_account_history`. A custom account is never default.

### Reconnect, rotation, disable and removal

- **Reconnect** and **rotate** start a new attempt for the same account. The old
  credential stays in use until the new generation is proven.
- A `disabled` account whose connection is `revoked`, as after the archive cleanup and
  a restore (ORG-01), reconnects through a new `provider_connection` with credential
  generation 1 (`accountAllowsCredentialMutation`, `createConnectedIntegration`). A new
  connect of the same provider account does the same. The account keeps its
  `integration_account_id`, so its settings and a commerce system selection stay. The
  revoked connection stays as history. Any other `revoked` connection does not
  reconnect. A supplied secret works
  only for `airtable`, `notion`, `stripe` and `shopify`; another provider gets
  `422 credential_rotation_provider_unsupported`. It stores a new
  `provider_credential_generation`, verifies it, switches the one `active` generation
  and revokes the old one (`integrations/contract/credential-cutover.ts`).
- **Disable** sets the account to `disabled` before it answers. Ingress, egress, tools
  and readiness stop at once. Provider cleanup is a separate job.
- **Removal** needs a disabled account that is not in use and has no open attempt
  (`data/account-removal.ts`). A default account is refused
  (`integration_account_is_default_for_provider`), unless it is a mailbox. Removal
  writes a `provider_account_tombstone` with a hash of the provider account ID.
- `provider_account_cleanup` moves through `pending_provider_cleanup`,
  `running_provider_cleanup`, `retry_scheduled`, `manual_action_required` and
  `completed`. After five attempts or a permanent failure, it is
  `manual_action_required` with the instruction code of the provider.
- The 15-minute cron (`integration-gateway.ts`) runs, for each Organisation, the repair
  of an interrupted credential cutover, the cleanup jobs and the observations.

### Custom connectors

One compiled adapter (`areas/integrations/server/custom-connectors/`) runs a reviewed
definition. A definition holds no code, packages, credentials, callbacks or
authorization decisions. The API key goes to the remote service, so the approval of a
destination is a trust decision. Pantry enforces the declared request contract, but it
cannot prove that the service is honest or has no side effects. The account and each
named operation are the access boundary.

`parseCustomConnectorDefinition` (`definition.ts`) accepts exactly these fields:

| Field                 | Content                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `schemaVersion`       | Literal `1`                                                                    |
| `name`, `description` | Plain text, at most 80 and 500 characters                                      |
| `origin`              | HTTPS origin on port 443, with no credentials, path, query or fragment         |
| `authentication`      | `bearer`, `basic_api_key` (the key is the user name) or `header` with a `name` |
| `documentation`       | 1 to 16 `{ url, sha256 }` references                                           |
| `operations`          | 1 to 20 operations with unique IDs                                             |
| `identity`            | An operation, fixed arguments, `accountIdPointer`, `displayNamePointer`        |
| `limits`              | Lower values for the platform ceilings only                                    |

- An operation `id` matches `[a-z][a-z0-9_]{0,47}`; `connect`, `disconnect`, `remove`,
  `rotate` and `test` are reserved. `effect` is `read`, `external_record_create` or
  `external_record_update`.
- A write needs a `retryPolicy`: `single_attempt`, or `provider_idempotent` with a
  `header` of at most 64 characters on a REST operation. The admin who approves
  confirms from the documentation that the service applies one write for each key.
- A header cannot control routing, framing, cookies or transport (`host`, `cookie`,
  `content-type`, `proxy-*`, `x-forwarded-*`, `cf-*` and others). The idempotency
  header cannot be `authorization` or the authentication header.
- REST (`kind: "rest"`) has `method` (`GET` or `POST`), `pathTemplate` and input or
  constant bindings that match the placeholders exactly. MCP (`kind: "mcp"`) has a
  fixed `endpointPath` and a `toolName` (`mcp.ts`). Each MCP call lists the tools over
  Streamable HTTP, checks that the reviewed tool exists and calls it.
- An object schema needs `additionalProperties: false`. References, composition and
  patterns are refused. The adapter keeps only the declared response properties
  (`response-projection.ts`). A missing field or a wrong type fails with
  `custom_connector_response_contract_changed`. The response of each operation lists 1
  to 10 distinct 2xx `successStatuses`.
- `pagination` is `none` or `cursor`. One call reads one page. The cursor is signed and
  bound to the exact account, revision, binding, credential generation and operation.

**Review.** Revision content is immutable (`revisions.ts`). An edit writes a new
revision with a compare-and-swap on the head. The review path is
`draft -> validated -> approved -> retired`, or `validated -> rejected`. An owner or an
admin approves an exact digest, and the approval records the user, time, origin and
effects. An owner or an admin can instead reject a validated revision with a reason. A
rejected revision is final: it cannot be approved or set up. Retirement needs the exact
list of accounts with an unrevoked binding of the revision. It changes only the
revision, so the bindings and receipts stay. A later read fails with
`custom_connector_read_stale`, and a later approval or run of a write fails with
`custom_connector_write_stale`.

**Setup.** One workflow (`setup.ts`) serves `new_account`, `rotate_account`,
`upgrade_account` and `resume_account`.

```text
awaiting_credential -> credential_stored -> testing -> verified -> committed
testing -> failed; verified -> testing (a retest)
any open state -> cancelled | expired
```

- The attempt pins the revision, digest, environment, target and user before it takes a
  key. Rotation accepts an `active`, `degraded` or `reauth_required` account, upgrade an
  `active` one and resume a `disabled` one (`setup-target.ts`).
- The key enters only the `credential` route and goes to the Vault as a candidate. The
  answer holds no value, handle or fingerprint. **Test connection** runs only the
  identity operation (`setup-execution.ts`). Only the verified identity, the display
  name and the result-schema digest stay. If a rotate, upgrade or resume setup tests
  another identity, the test fails with `custom_connector_account_identity_mismatch`.
- Commit (`accounts.ts`) needs an admin, an approved revision, a verified test and the
  expected versions. One D1 batch activates the generation, writes the binding, makes
  the connector `active` and increments `configuration_version`. A connected identity
  fails with `custom_connector_account_already_connected`. Commit makes no grant.
- **Disable** (`lifecycle.ts`) disables the connector, its accounts, bindings and
  connections. **Resume** makes the connector `active`; its accounts stay disabled until
  a `resume_account` setup commits. **Remove** needs a disabled connector with no
  unrevoked binding (`custom_connector_cleanup_required`).

**The Portal drawer** (`features/integrations/custom-connectors.tsx` and
`custom-connector-connect.tsx`) has no steps. **Review definition** saves a draft and
validates it. The drawer then shows the destination, each operation and the API key
field together. One **Approve** press sends the routes in order: `validate` for a
draft, `approve` with the origin and the effects that the drawer showed, and, with a
key, the setup, `credential`, `test` and `commit`. Each route keeps its own check, and
the first refusal stops the press. A setup that stops stays in the address
(`setupAttempt`), and the next press finishes it. **Replace API key**, **Reconnect** and
**Use reviewed version** run the same setup with the key in place.

**Reads.** A grant on a `custom_connector_operation` names the account, connector,
revision, digest and operation. `grants.ts` makes one tool for each granted operation:
`cc_` and 60 characters of a digest of the capability key, so a definition cannot
replace a built-in tool. Too many operations fail with
`custom_connector_catalog_limit_exceeded`. A read (`execution.ts`) checks the catalog
again (`custom_connector_read_stale`), the grant, the binding and the lease. It decides
the outbound information-flow sink before the request (`custom_connector_flow_denied`).
The result carries the source label of the exact account, revision and operation.

**Credentialed transport.** `CustomConnectorFetchContainer`
(`crates/custom-connector-fetch`), one for each Organisation at its location hint,
sends every credentialed request. `egress.ts` resolves the host over DoH and refuses an
address that is not public (`destination_not_public`). The Rust client pins the host to
that address, keeps the TLS check and uses HTTP/1.1 with no proxy, redirect
(`redirect_denied`), retry or compression. A body that echoes the key fails with
`credential_exposed`.

### Writes of a custom connector and the refusal route

1. A Sous Chef agent calls the `cc_` tool of a write operation. The call makes a
   proposal in the action ledger with a `custom_connector` authority. The authority pins
   the revision, digest, binding revision, credential generation, operation, canonical
   input, resource identity and provider effect identity, so a rotation stops a queued
   approval.
2. A viewer reads the preview with `GET …/actions/:nonce`. An owner or an admin sees the
   write in the list of decisions that wait, and decides:
   - `POST …/approval` needs a Google step-up grant for this nonce and a control session
     less than 10 minutes old. Otherwise the answer is `401 approval_step_up_required`.
     If the digest of the grant no longer matches the ledger action, the answer is
     `409` with the same code.
   - `POST …/rejection` is the refusal route. Its body is exactly
     `{ "reason": "merchant_declined" }`. It needs no step-up, because it changes
     nothing outside Pantry. The ledger moves the write to `rejected`, and it never
     runs. A viewer gets `403`, and a body with no reason gets `422`.
3. `POST …/execute` runs a signed write. It checks the grant, the information-flow sink
   and the binding again, takes the lease and then resolves the credential (`writes.ts`).
   The commerce routes answer `404` for the nonce of a custom write.
4. The outcome is `confirmed` (with a `custom_connector_write_receipt`),
   `failed_before_send` or `indeterminate`. After a request may have started, a timeout,
   a lost answer or an unreadable success is `indeterminate`. Nothing goes again
   automatically.
5. A `provider_idempotent` write sends `pantry-<SHA-256 of the ledger idempotency key>`
   in its header on each attempt. For such a write, `POST …/retry` on an `indeterminate`
   action sends it again with the same key. A retry of a `single_attempt` write answers
   `409 custom_connector_retry_unsupported`.
6. `POST …/reconcile` needs `expectedState: "indeterminate"`, the digest, the effect
   identity, an outcome (`confirmed`, `failed` or `indeterminate`) and operator evidence.
   An agent cannot declare its own outcome.

**Drafts in Portal chat.** Portal chat can draft a connector
(`custom-connectors/authoring.ts`). One turn has at most eight steps
(`MAX_CONVERSATION_STEPS` in `chat/turn/run.ts`): replies, documentation reads through
the credential-free link path, and definitions that the real parser checks. Approval,
the key, the test and the commit stay human steps. A key never enters chat or a prompt.

## Contracts

- Regional D1 (`workers/platform/migrations-regional/0001_current_schema.sql`).
  `foundation/connections` owns `integration_account` and the attempt, state,
  provisioning, connection, generation, default, observation, resource and webhook
  `provider_*` tables. `areas/integrations` owns the four `custom_connector*` tables,
  `provider_account_cleanup`, `credential_rotation` and `discord_interaction_install`.
  `areas/organisation` owns `provider_account_tombstone` (`scripts/layers.json`).
- Global D1 (`workers/platform/migrations-global/0001_current_schema.sql`).
  `areas/organisation` owns `provider_manifest`.
- `provider_connection`: `source_kind` (`built_in`, `custom_api`), `auth_mode`
  (`shared_pantry_app`, `api_key`, `webhook_secret`), `granted_scopes`, the Gmail
  `authorization_product`, and `lifecycle` (`connecting`, `active`, `reauth_required`,
  `disabled`, `revoked`). `integration_account.lifecycle`: `connecting`,
  `pending_activation`, `active`, `degraded`, `reauth_required`, `disabled`, `revoked`.
- `custom_connector.lifecycle`: `draft`, `active`, `disabled`, `removed`. D1 triggers
  enforce the review and setup transitions. `CustomConnectorFetchContainer`
  (`custom-connectors/fetch-container.ts`) is named by the Organisation ID.
- Modules: `provider-adapters/`, `provider-workflows/`, `provider-lifecycle/` and
  `integrations/contract/` (the public provider contracts). Portal:
  `areas/integrations/ui/features/integrations/`, with the client
  `custom-connector-api.ts`.

Connection routes (`control/routes/integrations.ts`) are under
`/v1/control/organisations/:id`, except the callback:

| Route                                                                                         | Role          | Purpose                                           |
| --------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------- |
| `POST /providers/:provider/start`                                                             | Admin         | Make an attempt; return the authorization URL     |
| `GET /provider-attempts/:a`; `POST …/cancel`                                                  | Viewer; admin | Read or cancel an attempt                         |
| `GET /v1/control/providers/:provider/callback`                                                | The provider  | Consume the state; continue provisioning          |
| `GET /accounts`; `GET /accounts/:id/resources`                                                | Viewer        | Accounts; discovered resources                    |
| `POST /accounts/:id/disable`, `/reconnect`, `/rotate`, `/default-for-provider`                | Admin         | Account lifecycle                                 |
| `POST /accounts/:id/credential-rotations`, `/revoke-credential`; `GET /credentials`           | Admin         | Supplied secret; revoke; the credential inventory |
| `GET /accounts/:id/file-resources`, `/google-drive-picker-config`; `POST …/resources/refresh` | Admin         | Files, Drive Picker settings, a new discovery     |
| `DELETE /accounts/:id`                                                                        | Admin         | Remove a disabled, unused account                 |
| `GET /slack-routing`, `POST …/dm-selection`; `PUT …/channels/:ch`, `POST …/disconnect`        | Viewer; admin | Slack routing                                     |

Custom connector routes (`control/routes/custom-connectors.ts` and its folder) are under
`/v1/control/organisations/:id/custom-connectors`. Viewers read metadata and the write
preview. Owners and admins make every change, with the control session, CSRF,
idempotency and a mutation receipt. A connector, revision or setup change also checks
the configuration version. A write-action route (approval, rejection, execute, retry,
reconcile) does not. Errors are `401` (`approval_step_up_required`), `403`
(`custom_connector_write_forbidden`), `404`, `409`, `422` or `503`. A provider body
never becomes error text.

| Route                                                                                        | Purpose                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /`, `POST /`; `GET /:c`, `DELETE /:c`                                                   | List, make a draft; detail, remove                    |
| `POST /:c/disable`, `/:c/resume`, `/:c/revisions`                                            | Lifecycle; a new revision on the head                 |
| `POST /:c/revisions/:r/validate`, `/approve`, `/reject`, `/retire`                           | Review an exact digest                                |
| `POST /:c/setup-attempts`, `GET …/:a`; `POST …/:a/credential`, `/test`, `/commit`, `/cancel` | Setup                                                 |
| `GET /:c/actions/:nonce`; `POST …/approval`, `/rejection`                                    | Preview; decide a write (the one decide call, FND-06) |
| `POST /:c/actions/:nonce/execute`, `/retry`, `/reconcile`                                    | Run, send again, reconcile                            |

| Capability (`authorization/capability-catalogue.ts`)                        | Target                       | Policy modes                |
| --------------------------------------------------------------------------- | ---------------------------- | --------------------------- |
| `custom_connector.draft`: a bounded draft for an admin request              | Platform                     | Enabled, disabled           |
| `custom_connector.read`: one approved read on an exact account and revision | `custom_connector_operation` | Enabled, disabled           |
| `custom_connector.write`: propose one approved write                        | `custom_connector_operation` | Approval required, disabled |
| `integration.discovery.read`: redacted connection metadata                  | Platform                     | Enabled, disabled           |
| `airtable.api.read`, `airtable.api.write`: Airtable inside a granted base   | `provider_resource`          | Enabled, disabled           |

| Agent tool (`agent-tools/integrations/integrations.ts`) | Capability                   | Effect   | What it does                                         |
| ------------------------------------------------------- | ---------------------------- | -------- | ---------------------------------------------------- |
| `integration_list`                                      | `integration.discovery.read` | Read     | Connection metadata, never provider content          |
| `airtable_api_read`                                     | `airtable.api.read`          | Read     | Discover granted bases, then read schema and records |
| `airtable_api_write`                                    | `airtable.api.write`         | Receipt  | Write inside a granted base; no blind retry          |
| `cc_<digest>`                                           | `custom_connector.read`      | Read     | One granted read operation (`catalog-tools.ts`)      |
| `cc_<digest>`                                           | `custom_connector.write`     | Proposal | One granted write, which waits for a decision        |

## Rules and limits

| Action                                                                               | Viewer and operator | Admin and owner | Agent                                 |
| ------------------------------------------------------------------------------------ | ------------------- | --------------- | ------------------------------------- |
| See accounts, attempts, resources, Slack routing                                     | Yes                 | Yes             | `integration_list` metadata           |
| Select the Organisation for the person's own Slack DMs, with a linked Slack identity | Yes                 | Yes             | No                                    |
| Start, cancel, reconnect, rotate, disable or remove a connection                     | No                  | Yes             | No                                    |
| See the credential inventory and file resources                                      | No                  | Yes             | No                                    |
| See custom connectors and a write preview                                            | Yes                 | Yes             | No                                    |
| Review a revision, enter a key, commit a setup                                       | No                  | Yes             | Draft only (`custom_connector.draft`) |
| Read through a custom connector                                                      | No                  | No              | With a grant on the operation         |
| Approve (with step-up) or refuse a custom write                                      | No                  | Yes             | Never its own                         |
| Execute, retry or reconcile a custom write                                           | No                  | Yes             | No                                    |

| Limit                                             | Value                                | Constant                                                                               |
| ------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| OAuth state                                       | 10 minutes; 2 hours for Stripe       | `SHORT_PROVIDER_STATE_TTL_MS`, `STRIPE_PROVIDER_STATE_TTL_MS`                          |
| Resource cursor, page                             | 10 minutes, 50 rows                  | `CURSOR_TTL_MS`, `PAGE_SIZE` (`data/provider-resource.ts`)                             |
| Cleanup lease, retry wait, attempts               | 2 minutes; 30 s to 1 hour; 5         | `PROVIDER_CLEANUP_LEASE_MS`, `…_RETRY_BASE_MS`, `…_RETRY_MAX_MS`, `…_MAX_ATTEMPTS`     |
| Setup attempt, key, test sample                   | 30 minutes, 16,384 characters, 8 KiB | `CUSTOM_CONNECTOR_SETUP_TTL_MS`, `MAX_CREDENTIAL_CHARACTERS`, `MAX_TEST_PREVIEW_BYTES` |
| Revision rejection reason                         | 1 to 500 characters                  | `CUSTOM_CONNECTOR_REJECTION_REASON_MAX_LENGTH`                                         |
| Definition; operations per connector, per catalog | 256 KiB; 20, 64                      | `CUSTOM_CONNECTOR_LIMITS`: `definitionBytes`, `operations`, `catalogOperations`        |
| Schema depth, properties, enum values             | 8, 64, 50                            | `schemaDepth`, `schemaProperties`, `enumValues`                                        |
| Arguments, body; wire, decoded, result            | 32 KiB, 64 KiB; 1 MiB, 1 MiB, 64 KiB | `argumentBytes`, `bodyBytes`, `wireBytes`, `decodedBytes`, `modelResultBytes`          |
| One attempt, one call, cursor                     | 15 s, 30 s, 10 minutes               | `attemptTimeoutMs`, `invocationTimeoutMs`, `cursorLifetimeMs`                          |
| DoH answer                                        | 5 s                                  | `DOH_TIMEOUT_MS` (`egress.ts`)                                                         |
| Approval session age; reconcile evidence          | 10 minutes; 1 to 2,000 characters    | Literals in `control/routes/custom-connectors/write-actions.ts`                        |

### The public origin and the provider callbacks

The Platform Worker `pantry` has one custom domain, `pantry.purin.io`
(`workers/platform/wrangler.jsonc`). `PANTRY_PUBLIC_ORIGIN` and
`PANTRY_OAUTH_CALLBACK_ORIGIN` are `https://pantry.purin.io` in production and
`https://localhost:3003` locally. A provider redirect URI is
`<PANTRY_OAUTH_CALLBACK_ORIGIN>/v1/control/providers/<provider>/callback`. A Shopify
webhook address uses `PANTRY_PROVIDER_INGRESS_ORIGIN` first; only the local profile sets
it, for a webhook tunnel. A change of an origin or a callback path is a release of its
own: add each new callback at each provider first (Plan 91, Plan 93).

| Path on `https://pantry.purin.io`                                 | Provider                                        | Owner          |
| ----------------------------------------------------------------- | ----------------------------------------------- | -------------- |
| `/v1/control/providers/:provider/callback`                        | The ten providers                               | This spec      |
| `/slack/install`, `/slack/install/start`                          | Slack app install                               | This spec      |
| `/v1/control/auth/google/callback`                                | Google sign-in                                  | FND-06         |
| `/hook/stripe/connect`, `/hook/stripe/:org`                       | Stripe Connect and account events               | COM-03, COM-04 |
| `/hook/shopify/:org`                                              | Shopify webhooks                                | COM-03         |
| `/hook/commerce/:org`                                             | The commerce engine                             | COM-01         |
| `/hook/email/google`, `/hook/whatsapp`                            | Gmail watch through Pub/Sub; WhatsApp Cloud API | INB-01         |
| `/hook/dropbox`, `/hook/discord/:org`                             | Dropbox file change; Discord interaction        | This spec      |
| `/slack/events`, `/slack/interactions` on `slack.pantry.purin.io` | Slack, to the Slack ingress Worker              | FND-03         |

**Google.** One client ID serves sign-in, Gmail and Drive in the `local` and `production`
profiles. `GOOGLE_OIDC_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_ID` and `GDRIVE_OAUTH_CLIENT_ID`
name it in the Worker vars, and each has its own `*_CLIENT_SECRET` secret.
`GDRIVE_PICKER_APP_ID` is the project number, and `GDRIVE_PICKER_API_KEY` is a secret.
The Google console holds the client name, the key limits and the redirect URIs;
[Google OAuth clients](../../../integrations/google-oauth.md) lists them. A Gmail or
Drive token stays bound to its client, so a new client ID needs a reconnect.

- **Information flow** (FND-07): `custom_connector.write` and `airtable.api.write` are
  other-service capabilities. Internal content needs approval, also when the person's
  role can read it. Internal content that came from the same integration account and
  resource as the write needs no approval.
- **Secrets**: a client secret never goes into Portal variables, Git or documents. A
  connector key never goes into a prompt, a transcript or generated code.
- **Out of scope**: model route sign-ins (FND-04), the merchant binding of the commerce
  engine (COM-02) and payments (COM-04).
- **Neighbours**: FND-03 (Slack ingress, Connectors), FND-05 (the link reader), FND-06
  (sign-in, the action ledger, step-up), FND-08 (credential values), FND-09 (the tool
  and capability catalogues), FND-01 (placement), COM-03 (Shopify, Square and Stripe
  commerce), INB-01 (mailbox and WhatsApp use), ORG-01 (readiness; still a plan).

## Open work

- Custom connectors have no OpenAPI import and no per-account rate or concurrency limit.
- `workers/platform/wrangler.jsonc` has only the `local` and `production` profiles.
  Staging has no Wrangler profile.
- [Google OAuth clients](../../../integrations/google-oauth.md) records these settings
  outside the code. Google has not verified the Gmail scopes, so a Gmail or Drive
  connect shows the "unverified app" screen and counts against the 100-user cap. The
  local Gmail push topic has no subscription. Separate clients for each environment and
  a dedicated administrative Google account do not exist.
- [Plan 91](../../../history/plan-91-seams-atelier-rename.md) records that the Meta (WhatsApp)
  registration keeps its old name and addresses until Meta's business verification
  passes, and that its Graph API answers "API access blocked".

## Sources

- [Integration architecture](../../../architecture/integrations.md) and
  [Google OAuth clients](../../../integrations/google-oauth.md). Where they differ from
  the code, this spec follows the code. Background:
  [Plan 91](../../../history/plan-91-seams-atelier-rename.md) (the provider registrations) and
  [provider callback origins](../../../runbooks/provider-callback-origins.md).
- Archive plans that the sources name (they give no evidence links):
  [Plan 29](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md)
  and
  [Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md).
- E2E journeys in `workers/platform/tests/e2e/`: `providers-connection.test.ts`
  (with the archive, cleanup, restore and reconnect of a selected shop),
  `providers-webhooks.test.ts`, `provider-removed-access.test.ts`,
  `custom-connector-review.test.ts`, `custom-connector-fetch-placement.test.ts`,
  `remote-mcp.test.ts` (REST and MCP reads, approved writes, the refusal route and the
  idempotent retry), `airtable-exit-approval.test.ts` and
  `airtable-session-origin.test.ts`.
