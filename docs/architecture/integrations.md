# Integration architecture

This document describes how provider traffic enters Pantry, how agents reach
providers through typed capabilities, how an Organisation connects a built-in
provider, and how it adds its own API as a custom connector. It describes the
code as built. Commerce behavior belongs to Commerce; see
[the Commerce spec](../../services/commerce/docs/spec.md).

| Replaces                                                   | Section                                           |
| ---------------------------------------------------------- | ------------------------------------------------- |
| Spec 5 — Integration Gateway and Connector Ingress         | [Ingress gateway](#ingress-gateway)               |
| Spec 10 — Capabilities, Provider Actions, and Tool Gateway | [Capabilities and tools](#capabilities-and-tools) |
| Spec 12 — Provider Connection and Provisioning             | [Provider connections](#provider-connections)     |
| Spec 14 — Custom API Connector Definitions and Execution   | [Custom API connectors](#custom-api-connectors)   |

Related: [Security architecture](./security.md) (egress, Vault, action
ledger, approval), [Onboarding architecture](./onboarding.md), the
[IFC integration guide](../../foundation/authority/policy/information-flow/README.md),
and provider setup for [Shopify](../integrations/shopify.md),
[Google OAuth](../integrations/google-oauth.md),
[OAuth configuration](../deployment/organisation-integration-oauth-configuration.md),
[Drive and Dropbox](../deployment/google-drive-dropbox-credentials.md) and
[Slack distribution](../deployment/slack-public-distribution.md).

This document uses the Actor names of `AGENTS.md`. The Durable Object classes
are `ConnectorDO`, `CaseDO`, `SessionDO` (`AgentSessionActor`) and
`OrganisationDO` in [`actors/`](../../services/platform/src/actors/).

## Ingress gateway

The Integration Gateway is the public provider boundary of the Platform Worker
([`integration-gateway.ts`](../../services/platform/src/integration-gateway.ts),
[`gateway-routing/`](../../services/platform/src/gateway-routing/)). It
verifies a provider request, parses it once into a typed record, resolves the
Organisation and the integration account, and hands durable work to an Actor
or a Queue. Raw bodies and provider SDK objects stop at that parser.

The gateway owns no conversation, Case history, agent session, provider cursor
or delivery retry state. `ConnectorActor` owns ingress deduplication, Case
routing and addressed delivery. `CaseActor` owns Case context, assignments,
accepted proposals and the output outbox. Direct authenticated APIs, such as
Portal chat, address `CaseActor` without a Connector.

| Path                                     | Source                             | Handling                                      |
| ---------------------------------------- | ---------------------------------- | --------------------------------------------- |
| `/slack/events`                          | Slack Events API                   | Connector admission before acknowledgement    |
| `/slack/interactions`                    | Slack button clicks                | Platform Worker verifies and answers          |
| `/slack/install`, `/slack/install/start` | Slack OAuth install                | Slack installation flow                       |
| `/hook/stripe/connect`                   | Stripe Connect platform endpoint   | routed by the event `account` field           |
| `/hook/stripe/:org`                      | Stripe account webhook             | signature, then account resolution            |
| `/hook/shopify/:org`                     | Shopify webhook                    | HMAC, then canonical delivery or refresh      |
| `/hook/square/:org`                      | Square Terminal webhook            | signature, then terminal state                |
| `/hook/commerce/:org`                  | Commerce merchant webhook        | signature, then a queued feed read            |
| `/hook/email/google`                     | Gmail watch through Google Pub/Sub | `email.change.v1` on the event Queue          |
| `/hook/dropbox`                          | Dropbox file change                | signature, then a file reconciliation hint    |
| `/hook/whatsapp`                         | WhatsApp Cloud API                 | WhatsApp Case ingress                         |
| `/hook/discord/:org`                     | Discord interaction                | signed interaction                            |
| `/v1/control/providers/...`              | provider OAuth callback            | [Provider connections](#provider-connections) |

### Slack ingress

```text
Slack request to /slack/events
  -> Slack ingress Worker: verify with its copy of the signing secret,
     resolve the thread route, ConnectorActor accepts -> acknowledge
  -> otherwise the Platform Worker: verify with the authoritative secret,
     resolve Organisation, account and person, admit the message,
     ConnectorActor.acceptCaseWork -> acknowledge, or 503
  -> ConnectorActor starts the work -> CaseActor.acceptTrigger
```

The Slack ingress Worker
([`slack-ingress/handler.ts`](../../services/platform/src/slack-ingress/handler.ts))
loads only this path, so a message reaches its Connector sooner. It refuses
nothing; the Platform Worker decides every request that it does not complete.
Both call `decideSlackCaseAtConnector`
([`slack/connector-ingress.ts`](../../services/platform/src/slack/connector-ingress.ts)).
A timestamp more than 300 seconds old is rejected. The Worker acknowledges
only after `ConnectorActor` stores the work; otherwise it answers
`503 slack_event_not_durable` and Slack retries. The Connector alarm recovers
expired leases and scheduled retries. A fresh mention root creates a
deterministic Case; a thread follow-up resolves the same Case. Forward Events
API delivery is the context source, not an implicit history backfill.

### Queued ingress and commerce webhooks

Work that needs no answer in the request goes to `EVENT_Q` (`pantry-events`) or
`CUE_Q` (`pantry-cues`). Each module owns its message types (`queue-messages.ts`
in `commerce/`, `shopify/`, `schedules/` and `mail/`, and
`slack/case-command-message.ts`).
[`ingress-queue.ts`](../../services/platform/src/ingress-queue.ts) holds the
union of the `EVENT_Q` messages and picks the parser. The types are
`slack.case_command.v1`, `commerce.delivery.v1`,
`shopify.commerce_refresh.v1`, `commerce.outbox_reconcile.v1`,
`email.change.v1` and `agent_schedule.dispatch.v1`. Consumers parse each body
again. Retries reuse deterministic delivery and observation identities, so
at-least-once delivery has one effect.

A commerce webhook binds the event to one active provider connection and
credential generation before it parses the body. Shopify catalog and inventory
payloads enter canonical delivery directly
([`shopify-connector.ts`](../../services/platform/src/shopify-connector.ts)).
An Order body is incomplete, so the boundary queues
`shopify.commerce_refresh.v1` with the exact Organisation, account, shop,
webhook and Order GID; the consumer fetches that Order and uses the mapper of
the initial sync. A Commerce merchant posts every event to
`/hook/commerce/:org`
([`commerce-webhooks.ts`](../../services/platform/src/commerce-webhooks.ts)).
The post carries no change: a valid signature, less than five minutes old,
queues a feed read. The feed stays the truth, and a one-minute reconcile covers
a lost post. Accepted events update rebuildable Platform projections and may
create Cue matches. The provider or Commerce stays authoritative.

### Addressing, idempotency and attachments

A Connector ingress record carries the Organisation, Connector, integration
account, provider, environment, native event identity, typed payload, times,
verified principal, correlation identity and attachment references.

A `ConnectorAddress`
([`types/ConnectorAddress.ts`](../../packages/contracts/src/types/ConnectorAddress.ts))
is an immutable destination: `slack` (thread reply with `threadTs`),
`slack_channel`, `email_thread` or `whatsapp_conversation`. `CaseActor`
copies it into each outbox entry. `ConnectorActor` delivers from that copy and
reads no mutable Case state during the effect. A Slack answer streams with
`chat.startStream`, `chat.appendStream` and `chat.stopStream`
([`slack-stream.ts`](../../services/platform/src/slack-stream.ts)). Each part
waits for the information-flow check of its destination. The provider receipt
settles the exact outbox entry.

- `connector_ingress` in `ConnectorActor` SQLite has a unique
  `native_event_id`. A repeat returns the accepted Case as `duplicate`. The
  same identity with other content fails with `connector_ingress_conflict`.
- `connector_delivery` has a unique `idempotency_key`. A retry keeps one
  provider idempotency identity.
- A repeated provider callback returns its existing attempt or receipt.
- Attachments are checked for metadata and size, then stored as
  Organisation-scoped, content-addressed R2 objects under
  `attachments/<organisation>/`. Records carry references, not bytes
  ([`stored-attachment.ts`](../../services/platform/src/stored-attachment.ts)).
  The harness gets an attachment only after Case and session authorization.

An invalid signature or OAuth state is rejected before any side effect. An
unknown or inactive account creates no Case. A malformed or oversized payload
gets a bounded typed rejection. A Case admission failure records the Connector
outcome and creates no session.

A new provider adds a boundary parser, a workflow in the
[compiled provider catalogue](#compiled-provider-catalogue), discovery, the
canonical ingress mapping and, if it delivers output, a `ConnectorAddress`
branch with receipts. The gateway loads no provider code at run time.

## Capabilities and tools

Agents and generated code reach providers only through typed capabilities.
`AgentSessionActor` owns the accepted tool catalog, the tool-call budget,
private history and the turn. The Harness Tool Host
([`embedded-harness-tool-host.ts`](../../foundation/agent/actors/embedded-harness-tool-host.ts),
[`agent-tools/`](../../services/platform/src/agent-tools/registry.ts))
parses arguments and runs the trusted handlers. `OrganisationActor` owns the
action ledger. A Connector delivers. It is not a tool executor and not a
commerce source of truth.

| Class                    | Examples                                     | Execution                        |
| ------------------------ | -------------------------------------------- | -------------------------------- |
| Commerce read            | products, inventory, orders, fulfillment     | trusted handler over projections |
| Workspace read or change | query, product folder update                 | trusted workspace boundary       |
| Case operation           | proposal, follow-up, side Case, permission   | typed Actor RPC                  |
| Message read             | current attachment, authored link            | message tools                    |
| Governed provider effect | cancel, publish, price, payout, custom write | action ledger and approval       |
| Connector delivery       | Slack, email or WhatsApp output              | `ConnectorActor`                 |
| Bounded composition      | filter, join, aggregate, branch              | Code Mode                        |
| Heavy execution          | Linux filesystem work                        | `WorkspaceExecutorContainer`     |

### Catalog and admission

`CAPABILITY_KEYS` in
[`capability-catalogue.ts`](../../foundation/authority/authorization/capability-catalogue.ts)
is the closed list of capability identities, such as `message.link.read`,
`integration.discovery.read`, `commerce.order.cancel` and
`custom_connector.read`. Each built-in provider declares the capability IDs
that its connection supplies. Grants target a capability and a resource
(`AccessGrantTarget`, a TypeBox schema in
[`access-control.ts`](../../packages/contracts/src/access-control.ts)).

The session tool catalog is an immutable set of model-visible definitions and
trusted handlers. Its `toolCatalogDigest` is bound to the session checkpoint.
The catalog is the intersection of the agent's
requirements, the subject's grants, the Organisation policy, the assignment
scope and the healthy integration capabilities. A tool name, argument,
instruction or playbook cannot widen it.

Before a handler runs, trusted code checks the session, lease, catalog,
budget, resource scope, policy, grant, approval and credential generation.
Then the session commits one capability claim. A direct call and each nested
Code Mode call use the same claim.

### Message tools

`inspect_message_attachment` (`message.attachment.inspect`) reads bounded text
or metadata from one attachment of the current turn. `read_message_link`
(`message.link.read`) fetches one public HTTP(S) link that the author wrote
([`message-tools.ts`](../../foundation/agent/actors/message-tools.ts)).
An attachment from another message, or a URL that the model composed, is
refused before any read.

The link reader
([`message-link-reader.ts`](../../services/platform/src/message-link-reader.ts))
sends no credential or cookie. It resolves the host over DoH, refuses
non-public addresses, revalidates each redirect and bounds the body.
`MessageLinkFetchContainer` pins the request to the validated address. The
receipt records the origin and a path digest, never the query or fragment.

### Commerce reads and governed actions

Commerce reads use Platform's commerce projections (the Commerce Read Layer),
which Commerce and Shopify feed. Results are bounded and
sensitivity-classified. Raw payloads, SDK clients, SQL and credentials are not
available to the harness. Commerce tools resolve the selected `CommerceSystem`
([`organisation-commerce-system.ts`](../../foundation/connections/data/organisation-commerce-system.ts)):
`builtin_commerce` (a Commerce merchant binding) or `shopify`. Each read and
action binds that system and its revision.

A provider mutation starts as a typed proposal, such as
`commerce_propose_action`. `OrganisationActor` records the normalized
parameters in the ledger
([`action-ledger.ts`](../../foundation/authority/actors/action-ledger.ts));
see [Action ledger](./security.md#action-ledger) and
[Approval](./security.md#approval). `ActionAuthority` is `commerce_system`,
`integration_account` or `custom_connector`.

`CommerceActionRequest`
([`commerce-actions.ts`](../../services/platform/src/commerce-actions.ts))
lists the commerce actions, and each source supports a subset
([`harness-commerce-proposal.ts`](../../services/platform/src/actors/harness-commerce-proposal.ts)):
`commerce` supports `publish_catalog_listing`, `cancel_order`,
`attach_tracking` and `adjust_offer_price`; `shopify` supports `cancel_order`.
[`commerce-provider-execution.ts`](../../services/platform/src/commerce-provider-execution.ts)
runs an approved action through `@commerce/client`, or through
[`shopify-action-execution.ts`](../../services/platform/src/shopify-action-execution.ts)
for the Shopify cancel. The handler gets the canonical connection authority,
the normalized parameters and the stable effect identity. Browser and model
input cannot supply a host, credential, account or environment.

A rejected proposal is terminal and gets no effect identity. Settlement
stores the receipt and refreshes the projection, which is the visible result.
A Case summary after an action is a delivery receipt only.

### Code Mode

Code Mode composes capability calls within one assignment. Pi is the only
harness. A Pi script runs in the QuickJS VM of the `CodeModeSandbox` Worker
([`code-mode-sandbox/worker.ts`](../../services/platform/src/code-mode-sandbox/worker.ts),
[`wrangler.code-mode-sandbox.jsonc`](../../services/platform/wrangler.code-mode-sandbox.jsonc)),
and the reservation records the placement `cloudflare_sandbox_worker`. The
sandbox has no credential, database, storage, route or outbound binding. A
script reaches a capability only through the exchange that the Session Actor
passes in. Without the `CODE_MODE_SANDBOX` binding, a script is refused before
admission.

Generated code cannot allocate an executor, call itself, create a child
session, get credentials or Actor bindings, use the network, install packages,
query D1, or approve or settle its own effects. Pi owns the replay of a script
and the order of its calls. Pantry owns admission, the lease, the deadline,
capability claims, the source check of each result, receipts, settlement and
delivery
([`code-mode-admission.ts`](../../foundation/agent/actors/code-mode-admission.ts)).
One script runs in an accepted turn.

After a process loss, the next runtime generation binds the reservation to its
new lease at `CodeModePlatformGovernorActor` and at the Organisation. The
script resumes only after both confirm. Pi gives each recorded result to the
script again, and `authorizeSources` checks its sources first. The deadline,
admission digest and counted calls do not change. An in-flight call runs again
only when a repeat is safe
([`pi-tool-replay.ts`](../../foundation/agent/actors/pi-tool-replay.ts)).
Reads, Kitchen surface commands, `codemode`, `tool_search` and named
proposals run again from any caller. `commerce_propose_action` and
`commerce_propose_plugin` run again only from a script, and the owner returns
the first proposal. Every other call waits for an operator.

If the sandbox fails or changed, or another catalog or policy admitted the
execution, the script settles as failed and the turn continues. If the
reservation expired or an owner refuses the new lease, the turn ends and both
owners release the reservation.

### Heavy execution and tool errors

`WorkspaceExecutorContainer`
([`workspace-executor-container.ts`](../../foundation/agent/workspace-executor-container.ts))
materializes an immutable workspace revision and runs the accepted task with
`enableInternet = false`. It returns content-addressed artifacts, measured
usage and a `ValidatedProductFolderChangesetV1`.
[`workspace-execution-coordinator.ts`](../../services/platform/src/actors/workspace-execution-coordinator.ts)
checks that the changeset names the same Organisation, workspace and base
revision before
[`workspace-revision-store.ts`](../../foundation/agent/workspace-revision-store.ts)
accepts a new revision. The released executor keeps no session, Case,
credential or provider authority.

Tool results carry typed, bounded errors. Provider bodies never become error
text, and audit records hold no credentials.

## Provider connections

This section covers the built-in providers. Model route sign-ins and the
Commerce merchant binding have their own flows.
[`provider-lifecycle/`](../../services/platform/src/provider-lifecycle/)
owns attempts, provisioning and observation.
[`data/integration-account.ts`](../../foundation/connections/data/integration-account.ts)
owns the connected identity. The Vault owns credential values.
[`provider-workflows/`](../../services/platform/src/provider-workflows/) own
provider sequencing, and
[`provider-adapters/`](../../services/platform/src/provider-adapters/) own
URLs, requests and parsers. Shared code accepts only provider-neutral results.

### Compiled provider catalogue

`PROVIDER_ADAPTERS` in
[`provider-adapters/catalogue.ts`](../../services/platform/src/provider-adapters/catalogue.ts)
is the only behavioral registry. Each entry declares its data classes,
capability IDs, connection family, onboarding adapter, `completeConnection`,
`observe`, `remove` and `manualActionInstruction`. Shared code has no
provider-name dispatch. `ActiveIntegrationProvider` is the union of ten
providers:

| Provider       | Family          | Removal; manual instruction if it fails                             |
| -------------- | --------------- | ------------------------------------------------------------------- |
| `airtable`     | OAuth, PKCE     | always manual: `revoke_airtable_access_in_airtable`                 |
| `dropbox`      | OAuth, PKCE     | token revoke                                                        |
| `gmail`        | OAuth, PKCE     | Google grant revoke; `revoke_gmail_access_in_google`                |
| `google_drive` | OAuth, PKCE     | Google token revoke                                                 |
| `notion`       | OAuth           | token revoke; `revoke_notion_access_in_notion`                      |
| `shopify`      | OAuth           | provider cleanup; `remove_shopify_app_in_shopify`                   |
| `slack`        | OAuth           | `apps.uninstall`; `remove_slack_app_in_slack`                       |
| `square`       | OAuth           | provider cleanup; `revoke_square_access_in_square`                  |
| `stripe`       | OAuth (Connect) | provider cleanup; `revoke_stripe_access_in_stripe`                  |
| `whatsapp`     | Embedded Signup | unsubscribe the app from the WABA; `remove_whatsapp_access_in_meta` |

Deployment configuration and account state still decide if a provider is
usable; `configurationIsValid` checks the application configuration before a
start. Observation returns current evidence or `observation_unsupported`. It
cannot report a connection healthy from stored configuration alone.

### Connection routes

Routes are in
[`control/routes/integrations.ts`](../../services/platform/src/control/routes/integrations.ts),
under `/v1/control/organisations/:organisationId` unless shown. The patterns
accept only the ten providers.

| Method   | Path                                                       | Purpose                                         |
| -------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `POST`   | `/providers/:provider/start`                               | create an attempt; return the authorization URL |
| `GET`    | `/provider-attempts/:attemptId`, `POST` `.../cancel`       | read or cancel an attempt                       |
| `GET`    | `/v1/control/providers/:provider/callback`                 | consume the callback; continue provisioning     |
| `GET`    | `/accounts`                                                | list provider accounts                          |
| `POST`   | `/accounts/:id/disable`                                    | disable an account at once                      |
| `POST`   | `/accounts/:id/reconnect`, `/rotate`                       | authorize again for the same account            |
| `POST`   | `/accounts/:id/credential-rotations`, `/revoke-credential` | rotate to a supplied secret; revoke             |
| `POST`   | `/accounts/:id/default-for-provider`                       | make the account the provider default           |
| `GET`    | `/accounts/:id/resources`, `/file-resources`               | discover resources (`POST .../refresh`)         |
| `DELETE` | `/accounts/:id`                                            | remove a disabled, unused account               |

Slack channel routing has its own routes under `/slack-routing`. Custom
connectors use [their own routes](#custom-connector-routes).

### Attempt, OAuth state and browser completion

Each browser authorization has one server-created
`provider_connection_attempt` with `purpose` `connect`, `reconnect` or
`rotate`. One open attempt is allowed for each Organisation, provider and
existing account. D1 `CHECK` constraints make each state carry exactly its
own fields.

```text
created -> authorizing -> callback_received -> provisioning -> connected
any open state -> cancelled | failed | expired
```

Each state adds its own fields, for example `provider_state_id`,
`provisioning_phase`, `integration_account_ids` or `failure_reason_code`.
`connected`, `cancelled`, `failed` and `expired` are terminal.

`provider_authorization_state` stores the state as a hash, bound to the
attempt, Organisation, provider, environment, user, portal subject hash and
return path, with the PKCE verifier when the family needs one. The state is
consumed once, with the hash of the callback code, and is invalidated by
cancellation and completion. It lives 10 minutes
(`SHORT_PROVIDER_STATE_TTL_MS`), or 2 hours for Stripe Connect account
selection (`STRIPE_PROVIDER_STATE_TTL_MS`,
[`authorization.ts`](../../foundation/connections/provider-adapters/authorization.ts)).
A repeated callback returns the terminal attempt. A different code after
consumption fails with `provider_state_replayed`. A valid callback after the
portal session expired can still finish provisioning.

The callback page has a strict CSP and holds no credential. Once a second, it
sends `pantry.provider-attempt.completed` to `window.opener` (exact portal
origin) and on the `BroadcastChannel` `pantry-provider-attempt`, which works
when Cross-Origin-Opener-Policy severs the opener. It closes after
`pantry.provider-attempt.ack`. The portal listener
([`pages/settings.tsx`](../../apps/portal/src/pages/settings.tsx)) ignores
unknown attempt IDs and refreshes the server projection. Completion depends on
the server attempt, so a lost message loses no progress.

### Connection and account identity

`provider_connection` records the shared grant: `source_kind` (`built_in` or
`custom_api`), provider, environment, `provider_subject_id`, `auth_mode`
(`shared_pantry_app`, `api_key` or `webhook_secret`), credential generation,
`granted_scopes` and, for Gmail, the `authorization_product` (`standard`,
`full_mailbox_pilot` or `send_only`). Its lifecycle is `connecting`, `active`,
`reauth_required`, `disabled` or `revoked`.

`integration_account` records each provider resource of the grant, with its
`capability_set`, `audience_policy`, `retention_policy` and
`is_default_for_provider`. Its lifecycle is `connecting`, `pending_activation`,
`active`, `degraded`, `reauth_required`, `disabled` or `revoked`. A built-in
account is unique on
`(organisation_id, provider, provider_account_id, account_kind)` and keeps its
identity across reconnect and rotation. An account or mailbox that is already
claimed fails with `provider_account_already_claimed`.
`provider_credential_generation` holds each generation as `staged`, `active`,
`superseded`, `revoked` or `failed`, with one `active` generation for each
connection.

### Provisioning and observation

`provider_provisioning_attempt` (`running`, `succeeded`, `failed_retryable`,
`failed_terminal`) runs these phases:

```text
discovering_identity -> persisting_credential -> discovering_accounts
  -> reconciling_webhooks -> discovering_resources -> verifying_connection
  -> finalizing
```

Each phase writes one `provider_provisioning_receipt` before it advances, and
a retry resumes from the receipts. The credential is stored before an account
becomes active. A failed attempt leaves no account active.

`provider_manifest` holds the desired state for each provider, version and
environment: required and optional scopes, webhook registrations and discovery
capabilities. An observation writes `provider_manifest_observation` with
`healthy`, `degraded` (missing optional capabilities and repair actions),
`blocked` (reason code) or `observation_unsupported`. An unhealthy observation
moves an `active` account to `degraded`, and a healthy one clears it.
`observation_unsupported` changes nothing
([`observation.ts`](../../services/platform/src/provider-lifecycle/observation.ts)).

Provider notes:

- **Slack** authorizes the shared Pantry application. Event subscriptions belong
  to that application, not to each Organisation. The server validates the
  channel selection.
- **Shopify** normalizes the `*.myshopify.com` domain. Each webhook topic keeps
  a matching JSON subscription, updates one stale subscription, or creates a
  new one; more than one match fails with `shopify_registration_invalid`.
  Missing required scopes block activation.
- **Stripe** uses one Connect endpoint for each mode (`/hook/stripe/connect`)
  and routes events by connected account. Onboarding creates no endpoint for
  each account. Verification checks that the endpoint exists, is enabled and
  matches the live mode.
- **WhatsApp** activates only an owner-selected phone number.
  [Plan 29](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29-organisation-agent-email-mailboxes.md) owns Gmail
  mailbox use and [Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md) WhatsApp
  messages.

### Discovery and the default account

A discovery query creates a `provider_resource_snapshot`
([`provider-resource.ts`](../../foundation/connections/data/provider-resource.ts)).
Each `provider_discovered_resource` has a canonical ID, provider IDs, a label,
an access state, a provider revision and a kind. A `provider_resource_cursor`
is stored as a hash, bound to the Organisation, account, snapshot and query,
and expires. Before the portal stores a selected resource, the server reads it
again, checks ownership and access, and records the provider revision.

At most one account for each provider and environment has
`is_default_for_provider = 1`. The field names Pantry's default, not a provider
concept. A change through `default-for-provider` is a serialized mutation. It
writes `provider_default_account_history` with the new `configuration_version`
and invalidates [readiness](./onboarding.md#readiness). The previous default
stays connected.

### Reconnect, rotation, disable and removal

- **Reconnect** keeps the account's bindings and its last healthy credential
  until the new generation is proven.
- **Rotation** stores a new generation, verifies it, switches the active
  generation in one step and revokes the old one
  ([`provider-credential-cutover.ts`](../../services/platform/src/provider-credential-cutover.ts)).
- **Disable** sets the account to `disabled` before it returns. Ingress,
  egress, tools and activation dependencies stop at once. Provider cleanup is
  asynchronous and visible.
- **Removal** needs a disabled account that is not the default, is not in use
  and has no open attempt
  ([`account-removal.ts`](../../areas/organisation/server/data/account-removal.ts)).
  It writes a `provider_account_tombstone` with a hash of the provider account
  ID.

`provider_account_cleanup`
([`cleanup-reconciliation.ts`](../../services/platform/src/provider-lifecycle/cleanup-reconciliation.ts))
moves through `pending_provider_cleanup`, `running_provider_cleanup`,
`retry_scheduled`, `manual_action_required` and `completed`. A job runs under a
two-minute lease, and retries back off from 30 seconds to one hour. After five
attempts or a permanent failure, it becomes `manual_action_required` with the
provider's instruction code.

Reason codes such as `provider_scope_missing` or
`provider_webhook_unhealthy` come with a retry, settings or reconnect action,
or a support correlation ID. Provider error text stays in redacted
diagnostics.

## Custom API connectors

An Organisation can connect its own HTTPS JSON API or MCP server. One compiled
adapter runs reviewed, Organisation-owned operation definitions
([`custom-connectors/`](../../services/platform/src/custom-connectors/)). A
definition is data and schemas. It cannot contain code, packages,
credentials, callbacks or authorization decisions.

Built: format v1 with REST and MCP, review, account setup, granted reads,
approved writes with a single attempt or a provider idempotency key, the
fetch container, connector lifecycle, Portal chat drafting and revision
rejection. Open: OpenAPI import and per-account rate and concurrency limits.

### Trust model and records

An admin reviews the destination and the operation semantics against the
service documentation. Pantry enforces the declared request contract. It cannot
prove that a remote service is honest, complete or free of side effects. The
service receives the API key, so destination approval is a real trust
decision. The connected account and each named operation are the access
boundary. There is no generic row, folder or team filter, so prefer
provider-restricted keys. A custom connector has source kind `custom_api`; its
service name never enters the built-in provider union.

| Record                                       | Content                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `custom_connector`                           | `lifecycle` (`draft`, `active`, `disabled`, `removed`), `head_revision`                     |
| `custom_connector_revision`                  | authoring and canonical documents with digests, review state, approval                      |
| `custom_connector_setup_attempt`             | pinned revision and digest, target kind, lifecycle, candidate credential, verified identity |
| `custom_connector_account_binding`           | accepted revision and digest, binding revision, credential generation, connector default    |
| `provider_connection`, `integration_account` | `source_kind` and `provider` `custom_api`, `auth_mode` `api_key`                            |
| access grant / action ledger                 | `custom_connector_operation` target / `custom_connector` authority                          |

Every join and foreign key binds the Organisation and the connector, and
bindings are unique per connector, so unrelated services never share a
namespace. A custom account cannot be the provider default.

### Definition format v1

`parseCustomConnectorDefinition`
([`definition.ts`](../../services/platform/src/custom-connectors/definition.ts))
accepts exactly these fields:

| Field                 | Content                                                                         |
| --------------------- | ------------------------------------------------------------------------------- |
| `schemaVersion`       | literal `1`                                                                     |
| `name`, `description` | bounded plain text                                                              |
| `origin`              | canonical HTTPS origin on port 443; no credentials, path, query or fragment     |
| `authentication`      | `{ kind: "bearer" }`, `{ kind: "basic_api_key" }` or `{ kind: "header", name }` |
| `documentation`       | `{ url, sha256 }` references                                                    |
| `operations`          | non-empty list of uniquely named operations                                     |
| `identity`            | operation, fixed arguments, `accountIdPointer`, `displayNamePointer`            |
| `limits`              | lower values for the platform ceilings only                                     |

`basic_api_key` sends the key as the username with an empty password. A header
name is stored in lower case. Headers that control routing, framing, cookies or
transport are refused, such as `host`, `cookie`, `content-type`, `forwarded`,
`proxy-*`, `x-forwarded-*` and `cf-*`. A key in a query, path, body or
definition is not supported. The identity pointers must select a string or
integer account ID and a string display name in the projected schema, so a
service without a stable authenticated account identity is not supported.

An operation has `id`, `description`, `effect`, `inputSchema`, `transport`,
`response` and `pagination`. An `id` matches `[a-z][a-z0-9_]{0,47}`;
`connect`, `disconnect`, `remove`, `rotate` and `test` are reserved. `effect`
is `read`, `external_record_create` or `external_record_update`. Both writes
need a `retryPolicy`, and an update names its `resourceIdentityInput`. The
policy is `{ kind: "single_attempt" }` or, for a REST operation only,
`{ kind: "provider_idempotent", header }`. The header is a valid name of at
most 64 characters, stored in lower case. It cannot be `authorization`, the
authentication header or a header that the authentication rules refuse. The
admin who approves the revision confirms from the service documentation that
the service applies one write for each key. The canonical JSON and its SHA-256 digest cover every
field that affects execution.

### Transport, schemas and pagination

- **REST** (`kind: "rest"`) has `method`, `pathTemplate`, `pathBindings`,
  `queryBindings` and `bodyBindings`. `GET` needs `bodyBindings: null`. `POST`
  sends a top-level JSON field map. Other methods are refused.
- **Bindings** are `{ kind: "input", field }` or `{ kind: "constant", value }`.
  Path and query values must be scalar. Path bindings must match the
  whole-segment placeholders exactly. Query names that differ only by case are
  refused. There is no expression language.
- **MCP** (`kind: "mcp"`) has a fixed `endpointPath` and a bounded `toolName`
  ([`mcp.ts`](../../services/platform/src/custom-connectors/mcp.ts)). Each call
  connects over Streamable HTTP, lists the tools, checks that the reviewed tool
  exists and calls it. A `tools/call` must match the reviewed name and the
  digest of the admitted arguments. Every MCP request uses the fetch
  container.

Schemas use `object`, `array`, `string`, `integer`, `number`, `boolean`,
`null`, `enum` and `const`. Objects need `additionalProperties: false`;
strings and arrays need length bounds. An optional input must accept `null`.
References, composition and patterns are refused.

`response` has 1 to 10 2xx `successStatuses`, a `resultPointer`, an
`outputSchema` and a `classification` (`CommerceSensitivity`). The adapter
projects only the declared properties, recursively, then validates them
([`response-projection.ts`](../../services/platform/src/custom-connectors/response-projection.ts)).
Extra fields never reach the agent or the preview. A missing field or wrong
type fails with `custom_connector_response_contract_changed`.

`pagination` is `none` or `cursor` (an optional string input and a
`nextCursorPointer` to a string). One invocation reads one page and counts as
one call. The returned cursor is signed, bound to the Organisation, account,
connector, revision, digest, binding revision, credential generation and
operation, and expires after 10 minutes. There is no automatic page loop.

| `CUSTOM_CONNECTOR_LIMITS` ([`limits.ts`](../../services/platform/src/custom-connectors/limits.ts)) | Ceiling                |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| Canonical definition                                                                               | 256 KiB                |
| Operations per connector / in one catalog                                                          | 20 / 64                |
| Schema depth / properties / enum values                                                            | 8 / 64 / 50            |
| Model arguments / outbound JSON body                                                               | 32 KiB / 64 KiB        |
| Wire bytes / decoded response / model result                                                       | 1 MiB / 1 MiB / 64 KiB |
| One attempt / whole invocation (the turn deadline can shorten them)                                | 15 s / 30 s            |

### Review, setup and commit

Revision content is immutable
([`revisions.ts`](../../services/platform/src/custom-connectors/revisions.ts)).
An edit writes a new revision with a compare-and-swap on the head. The review
path is `draft -> validated -> approved -> retired`, and validation errors stay
on the draft. Only an owner or admin approves; approval records the digest,
user, time, origin and effects. The drafting agent cannot approve or change its
own grants. An owner or admin can instead reject a validated revision
(`validated -> rejected`) with a reason of 1 to 500 characters. A rejected
revision is final: it cannot be approved or set up, and the corrected
definition is a new revision on the head. Retirement closes new execution against every binding of the
revision but keeps receipt history.

One setup workflow serves `new_account`, `rotate_account`, `upgrade_account`
and `resume_account`
([`setup.ts`](../../services/platform/src/custom-connectors/setup.ts)):

```text
awaiting_credential -> credential_stored -> testing -> verified -> committed
testing -> failed;  verified -> testing (explicit retest)
any open state -> cancelled | expired (after 30 minutes)
```

The attempt pins the revision, digest, environment, target and user before it
receives a key. An existing-account target needs the exact account and binding
revision. Rotation accepts an `active`, `degraded` or `reauth_required`
account, upgrade an `active` one and resume a `disabled` one, so rotation or
upgrade cannot resume a disabled account
([`setup-target.ts`](../../services/platform/src/custom-connectors/setup-target.ts)).
The key enters only the `credential` route and goes to the Vault as a
candidate; the response has no value, handle or fingerprint. **Test
connection** runs only the fixed identity probe
([`setup-execution.ts`](../../services/platform/src/custom-connectors/setup-execution.ts)).
The live response may show up to 8 KiB of projected sample to the operator.
Only the verified identity, display name and result-schema digest persist.

Commit needs an admin, an approved revision, a verified test, the matching
identity and the expected versions
([`accounts.ts`](../../services/platform/src/custom-connectors/accounts.ts)).
In one D1 batch it activates the candidate generation, writes the binding,
marks the connector `active` and increments the onboarding
`configuration_version`. A rotation revokes the old generation in the same
cutover. A failure before commit leaves the old account usable. The same
identity for the same connector and environment fails with
`custom_connector_account_already_connected`. A rotation or upgrade that
verifies another account fails with
`custom_connector_account_identity_mismatch`. A connection creates no grants,
and grants name an exact revision, so an upgrade does not carry them over.

[`lifecycle.ts`](../../services/platform/src/custom-connectors/lifecycle.ts):
**Disable** sets the connector, its accounts, bindings and connections to
`disabled`. **Resume** makes the connector `active`; its accounts stay disabled
until a `resume_account` setup commits. **Remove** needs a disabled connector
with no unrevoked binding (`custom_connector_cleanup_required`). It revokes
staged keys, cancels open attempts and makes the connector `removed` and
immutable.

### Grants and execution

| Capability               | Authority                                                    |
| ------------------------ | ------------------------------------------------------------ |
| `custom_connector.draft` | write a bounded draft for an authorized admin request        |
| `custom_connector.read`  | one approved read operation on an exact account and revision |
| `custom_connector.write` | propose one approved write; execution needs human approval   |

A `custom_connector_operation` grant holds the capability, account, connector,
revision, digest and operation. The Organisation capability policy stays the
ceiling. [`grants.ts`](../../services/platform/src/custom-connectors/grants.ts)
compiles catalog entries from the effective grants. A tool name is `cc_` plus
a digest of the capability key, so a definition cannot replace a built-in
tool. More than 64 operations fail with
`custom_connector_catalog_limit_exceeded`, and a collision with
`custom_connector_catalog_collision`. A new grant appears in the next turn's
catalog. Model arguments hold only operation inputs, so a guessed account ID
cannot redirect a tool.

A read
([`execution.ts`](../../services/platform/src/custom-connectors/execution.ts))
compiles the catalog again and fails with `custom_connector_read_stale` if the
accepted entry is gone. It checks the grant revision, the binding and the
lease. It decides the outbound information-flow sink before any request,
because a read can carry protected data (`custom_connector_flow_denied`). It
resolves the current credential, builds the request from the bindings, sends
it through the fetch container and rechecks authority on the response. The
result gets the source label of the exact account, revision and operation.
A response cannot revive cancelled or revoked work.

### Credentialed transport

A Worker cannot pin a validated address and still verify the TLS host name, so
`CustomConnectorFetchContainer`
([`crates/custom-connector-fetch`](../../crates/custom-connector-fetch/)), one
for each Organisation at its location hint, sends every credentialed request.
The Worker side
([`custom-connector-egress.ts`](../../services/platform/src/custom-connector-egress.ts))
resolves A and AAAA records over DoH, refuses the name if any answer is not
public (`destination_not_public`), keeps the absolute deadline, and only then
builds the secret-bearing request. The Rust client revalidates the address,
pins the reviewed host to it, keeps Host, SNI and certificate checks, and
disables proxies, redirects, retries, referrers, HTTP/2 and compression. It
uses a monotonic deadline, enforces streamed wire and decoded limits, and
returns only the status, content type and body. A body that echoes the
credential, also in standard or URL-safe base64, fails with
`credential_exposed`. A redirect fails with `redirect_denied`.

The key goes only to the reviewed origin. A new origin or authentication
scheme needs a new credential.

### Writes and reconciliation

A write needs `post_json` or MCP transport
([`writes.ts`](../../services/platform/src/custom-connectors/writes.ts)).
`CustomConnectorActionAuthority` in the ledger pins the revision, digest,
binding revision, credential generation, operation, canonical input, resource
identity and provider effect identity, so a rotation invalidates a queued
approval.

Under `/custom-connectors/:id/actions/:nonce`, a viewer can `GET` the preview
(account, operation, origin, path and fields). An admin can `POST /approval`,
`/execute`, `/retry` and `/reconcile`. Execution rechecks the payload and authority,
takes the lease and then resolves the credential. The outcome is `confirmed`
(with a `custom_connector_write_receipt`), `failed_before_send` or
`indeterminate`. After a request may have started, a timeout, cancellation,
lost response, lease loss or unreadable success is `indeterminate`, and nothing
is resent automatically. A `provider_idempotent` write sends
`pantry-<SHA-256 of the ledger idempotency key>` in its header; the value is
the same for every attempt of the action and names no internal account. The
fetch container sends it only on a REST request. For such a write an admin
can `POST /retry` on an `indeterminate` action: the ledger accepts
`provider_idempotent_replay` evidence only for this policy, and the request
goes out again with the same key. A retry of a `single_attempt` write answers
`409 custom_connector_retry_unsupported`. Reconciliation needs `expectedState: "indeterminate"`, the digest,
the effect identity, an outcome (`confirmed`, `failed` or `indeterminate`) and
up to 2,000 characters of operator evidence. An agent cannot declare its own
outcome. Changed arguments need a new proposal.

### Authoring in Portal chat

Portal chat can draft a connector
([`chat/application.ts`](../../services/platform/src/chat/application.ts),
[`authoring.ts`](../../services/platform/src/custom-connectors/authoring.ts)).
A turn has at most eight model steps: replies, documentation reads through the
credential-free link path, and new or revised definitions. The real parser
checks each definition, and errors return to the model. Approval, the key, the
test and the commit stay human steps. Keys never enter chat or prompts.

### Custom connector routes

Paths are under `/v1/control/organisations/:organisationId/custom-connectors`
([`control/routes/custom-connectors.ts`](../../services/platform/src/control/routes/custom-connectors.ts);
portal client
[`custom-connector-api.ts`](../../apps/portal/src/features/integrations/custom-connector-api.ts)).
Mutations use the control session, CSRF, idempotency, the configuration version
fence and the mutation receipt. Reads are `no-store`. Viewers read metadata.
Owners and admins make every change.

| Path                                                                     | Methods and purpose               |
| ------------------------------------------------------------------------ | --------------------------------- |
| `/`                                                                      | `GET` list; `POST` create a draft |
| `/:id`                                                                   | `GET` detail; `DELETE` remove     |
| `/:id/disable`, `/:id/resume`                                            | `POST` connector lifecycle        |
| `/:id/revisions`                                                         | `POST` new revision on the head   |
| `/:id/revisions/:revision/validate`, `/approve`, `/retire`               | `POST` review an exact digest     |
| `/:id/setup-attempts`, `/:id/setup-attempts/:attempt`                    | `POST` start; `GET` read          |
| `/:id/setup-attempts/:attempt/credential`, `/test`, `/commit`, `/cancel` | `POST` setup steps                |
| `/:id/actions/:nonce`, `/approval`, `/execute`, `/reconcile`             | write actions                     |

Errors map to `404` (unknown), `422` (invalid or mismatch), `503` (transport)
and `409` (other conflicts). Provider bodies never become errors.
