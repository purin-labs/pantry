# Plan 79 — Agent Vault: Logins, Secure Notes, Cards and 1Password

Status (2026-10-27): phases 1 and 2 and the API keys tab are in production
since the release of 2026-10-25 (source `1c8b7b1b3`), with the
`satyr-vault-onepassword` Worker. The live check with a real 1Password service
account is open. On 2026-10-25 the owner widened the
scope: payment cards (Satyr expects PCI DSS verification soon), secure
notes, and 1Password as a store that people can choose instead of Satyr. A
secure note is a general secret that agents use like a login (owner's words,
2026-10-25: "Treat them like login items, just more general"). The owner
accepted the defaults of D6–D8 on 2026-10-25. Phases 3 to 6 are not started.

## Result in one paragraph

Satyr Vault can hold website logins and contact profiles with no change to its
encryption, key rotation, backup or revocation. Three parts are new: item
records with a Portal page, an agent browser that fills a saved login without
the model seeing it, and a store interface with two implementations: Satyr
Vault and 1Password. An Organisation chooses its store; the page, the agents
and the fill rules are the same for both. Cards go live in production only
after the PCI DSS verification (D1).

## Problem

Agents cannot work on websites that have no API: supplier portals, wholesale
shops, delivery platforms and marketplace seller pages. The operator must sign
in and do the work by hand. The vault stores only provider credentials, and the
Portal shows it only as a "Vault" line inside each connected account.

The reference is the Grok Bot vault of 2026-10-24: one page that lists logins,
cards and contact info, and a sign-in sheet that the bot raises mid-task, with
"Never shown to your Bot. Only filled on ads.google.com".

## What exists and stays

| Part                                                           | Where                                              | Use in this plan                                    |
| -------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| AES-256-GCM rows bound to organisation, handle and key version | `credential-vault/crypto.ts`, table `vault_secret` | Stores login secrets unchanged                      |
| Root rotation, backup, restore, revocation                     | `root-rotation.ts`, `backup.ts`, `service.ts`      | Covers the new rows with no change                  |
| Purpose-bound resolvers, no generic resolve                    | `*-resolution.ts`                                  | Add one resolver: `resolveWebsiteLoginForFill`      |
| Host-bound injection rules                                     | `credential_ref.host_pattern`, `InjectionRule`     | Same idea for origins of a login                    |
| External source boundary                                       | `external-import.ts`, `onepassword.ts` (Connect)   | Keep for provider keys; add a live 1Password source |
| APAC containers with internet egress                           | `custom-connector-fetch-container.ts`, Plan 75     | Pattern for the browser container                   |
| Capability policy: enabled, approval required, disabled        | `organisation_capability_policy`                   | Policy for the new browser and fill capabilities    |
| Approval modal in context                                      | Memory rule: access prompts, not the Access page   | The sign-in request sheet                           |

The execution contract stays true: raw credentials never enter generated code,
prompts, transcripts or executor storage.

## Decisions (accepted 2026-10-24)

**D1. Payment cards.** Accepted 2026-10-24 as "no cards"; reversed by the owner
on 2026-10-25: Satyr stores cards and expects PCI DSS verification soon. Card
storage and card fill stay off in production until that verification passes.
Development and test environments may use test card numbers only. See D6.

**D2. Contact info and the model.** Recommendation: the model may read contact
profiles (name, company, address, phone, invoice registration number). Agents
already read order addresses, and agents need these values to write emails and
forms. Cost: one new IFC source. Logins stay hidden in all cases. Default:
visible to the model, under its own IFC label.

**D3. 1Password mode.** Recommendation: a live link with a 1Password service
account. Satyr stores the service account token and item references, reads an
item at fill time and keeps no copy. The existing Connect import needs a Connect
server that the operator hosts, which a café will not run. Default: live link.

**D4. Browser placement.** Recommendation: our own container in APAC with
Chromium and Playwright. Cloudflare Browser Rendering marks every request as
bot traffic and does not let us pick a region; Plan 75 showed that a site can
refuse Worker egress and accept a container. Default: own container.

**D5. Approval for a fill.** Recommendation: approval for the first fill of an
item in each Case, then no approval for the rest of that Case. Cost: one tap
per task. Owners can set an item to "always ask" or "never ask". Default: as
recommended.

## Decisions (accepted 2026-10-25)

**D6. Card security codes (CVV).** Recommendation: Satyr never stores a CVV.
PCI DSS requirement 3.3.1 forbids keeping sensitive authentication data after
authorization, also encrypted; the exception is for card issuers, and Satyr is
not one. A Satyr-stored card holds the number, expiry and cardholder name. At a
fill, the person types the CVV in the request sheet, or Satyr reads it from
1Password when the card is a 1Password item; it is used once and not kept.
Cost: one prompt for each card payment with a Satyr-stored card. Default: no
CVV storage.

**D7. Where the store choice applies.** Recommendation: one store for each
Organisation, with a "Move items" step between stores. A store for each item
makes every list, fill and receipt ask "which store" and doubles the failure
paths. Cost: an Organisation cannot keep some items in each store, except
during a move. Default: one store for each Organisation.

**D8. Order of the next phases.** Recommendation: the store interface and
1Password first, because the owner named it most important and every later
item kind must work on both stores. Then secure notes, then cards, then the
agent browser and fill. Cost: agents use the Vault later than in the first
plan. Default: as recommended.

## Design

### Items

A new D1 table `vault_item` holds the visible record. Secrets stay in
`vault_secret`.

- `kind`: `website_login` or `contact_profile` (`card_reference` is reserved
  for D1).
- `label`, `origins` (exact `https` origins; a subdomain wildcard only when the
  owner sets it), `username`, `vault_handle`, `generation`, `revision`,
  creator and times. Phase 4 adds the `source` and the external reference.
  A removed item has no row: removal deletes the row and revokes its secret.
- A new `VaultSecret` kind `website_login` holds `username`, `password` and an
  optional `totpSeed`. A changed password gets a new generation handle, as
  provider credentials do today.
- A contact profile is not a secret. Its fields live in `vault_item` as a typed
  JSON body, with the IFC label from D2.
- Contracts go in TypeBox in the owning TypeScript package (Plan 78).

### Portal: Settings → Vault

One list and a side drawer (memory: Portal layout preference).

- Tabs with counts: All, Logins, Contact info.
- A row shows an icon, the label or site, and the username hint. A 1Password
  item shows a source badge.
- The drawer shows the origins, the source, the last change and the fill
  receipts: which agent, which Case, which origin, who approved, and when.
- Actions: Add, Replace password (new generation), Edit origins, Remove
  (`revokeCredential`). Nobody can reveal a saved password, also the owner.
  The page says "Never shown to agents. Only filled on <origin>."
- Only owners and admins can add, change or remove items. All members can see
  the list.

### Sign-in request sheet

When an agent needs a login that the vault does not have, it calls
`vault.request_login` with the site and a reason. The Portal chat shows a sheet
like the Grok one: the site name, username, password, the check box "Save to
the Satyr vault", and the line "Never shown to your agent. Only filled on
<origin>". The value goes from the Portal to the Platform and the vault. It
never enters chat, the Case, Pi history or a log.

In Slack, the agent posts a button that opens the sheet in the Portal. Slack
never collects a secret, because Slack keeps modal values.

### Agent browser

- `AgentBrowserContainer`: Chromium and Playwright on Node, `constraints.regions`
  APAC, location hint `apac-ne`, one container for each active session,
  `sleepAfter` five minutes, no persistent profile.
- Pi capabilities: `browser.open`, `browser.read` (text and accessibility tree),
  `browser.screenshot`, `browser.act` (click, type, select), `browser.close`.
  The Actor admits each call, as it does for Code Mode.
- Cost estimate, to check against the current Containers price page: a 4 GiB
  instance costs about US$0.04–0.07 for each active hour, so a five-minute task
  costs less than US$0.01.
- A CAPTCHA, an SMS code or a device prompt stops the task. The agent asks the
  person to finish that step. Satyr never solves a CAPTCHA.

### Fill

`vault.list_items` returns labels, origins and username hints only.
`vault.fill_login` takes an item ID and the field references from the last
`browser.read`.

1. The Actor checks the capability policy and D5 approval.
2. `resolveWebsiteLoginForFill` checks that the item is active and that the
   organisation and the Case may use it.
3. The container checks that the top-level page and the frame of each field are
   on an origin of the item. Otherwise it refuses with `vault_origin_mismatch`.
4. The container types the values through Playwright. The secret goes from the
   Platform to the container in the request body and is not stored.
5. From then on, `browser.read` and `browser.screenshot` mask password fields
   and every filled field.
6. The Platform writes a receipt with item, generation, origin, session, Case,
   approver and time. Pi history holds the item ID and the receipt only.

### One store interface, two stores

The Platform has one interface, `VaultStore`, with `list`, `create`,
`command` and `resolveForFill`. Phase 1 code becomes `SatyrVaultStore`.
`OnePasswordVaultStore` is new. The routes, the Portal page, the agent tools
and the fill rules call the interface and do not know the store.

| Satyr item kind   | 1Password category | Fields that Satyr uses                           |
| ----------------- | ------------------ | ------------------------------------------------ |
| `website_login`   | Login              | websites, username, password, one-time code      |
| `contact_profile` | Identity           | name, company, email, phone, address, tax number |
| `secure_note`     | Secure Note        | title, purpose, secret text, websites            |
| `payment_card`    | Credit Card        | cardholder, number, expiry, CVV (read only, D6)  |
| API keys tab      | API Credential     | listed only; Integrations keeps its own keys     |

- **Connect.** An owner creates a 1Password service account with read and
  write access to one shared vault, for example "Satyr", and pastes its token
  in Settings → Vault. The token is a `bearer` row in Satyr Vault. This is the
  only 1Password secret that Satyr stores.
- **Choose.** The page then offers "Store new items in: Satyr / 1Password"
  (D7). With 1Password chosen, Add, Edit and Remove write to 1Password, and
  the list reads that vault. Satyr keeps a reference row in `vault_item` for
  each item (`store`, 1Password vault and item ID, a cached title and kind),
  so receipts and agent permissions do not depend on a live read. It keeps no
  secret value.
- **Move.** "Move items to 1Password" copies each Satyr item, reads it back to
  verify it, then revokes the Satyr secret. The reverse move works the same
  way. This follows the credential migration steps in the Vault API reference.
- **Fill.** `resolveForFill` reads the one item at fill time and keeps no copy.
- **Runtime.** A spike checks first that the 1Password JavaScript SDK runs in a
  Worker. If it does not, store calls go through one small APAC container, as
  in Plan 75.
- **Limits.** A Teams account allows 1,000 reads and 100 writes an hour for
  each service account and 5,000 requests a day. The page caches the list for
  30 seconds. A café uses tens of fills a day.
- **Failure.** An item that someone archived or moved in 1Password fails with
  `external_item_unavailable`. A revoked token marks the store as disconnected
  on the page; Satyr does not fall back to its own store.
- **Honest limit.** The service account token can decrypt the shared vault. A
  Platform compromise could still read that vault while the token is valid. The
  1Password store narrows the exposure to one vault and keeps the keys and
  revocation under the owner's control.

### Secure notes

A secure note holds a secret that is not a login or an API key, such as a
supplier account PIN, a door code, a licence key or a recovery code. It works
like a login item:

- **Fields.** A name, a purpose that agents and people read ("Door code for
  the Ginza delivery entrance"), the secret text (up to 16 KB) in the store,
  and optional exact `https` websites where agents may fill it.
- **Agents.** Agents list notes by name and purpose and use the secret by
  reference, through the same capability policy, approval (D5), receipts and
  audit log as a login. The secret never enters a prompt, a transcript, Pi
  history or a log. A note with websites is filled only on those origins, as a
  login is. A note without websites can go only into a typed field of a Satyr
  action that names the note, never into model text.
- **People.** As with a password, nobody can read the secret after it is
  saved. Owners and admins replace it or remove it.
- **Storage.** A new secret kind `secure_note` in the Satyr store, with a new
  generation for each replacement; the Secure Note category in 1Password.
- **Limit.** Agents can use every note. A wallet recovery phrase in a note is
  therefore within reach of an agent's fill; keep such phrases out of the
  Vault.

### Payment cards

A `payment_card` item has a label, cardholder name, number, expiry month and
year, and an optional billing contact profile. The list and drawer show the
brand and last four digits only (PCI DSS masking). The number lives in the
store as a secret; the CVV never lives in the Satyr store (D6). A production
switch `VAULT_CARDS_ENABLED` stays off until the PCI DSS verification passes;
with it off, the page hides cards and the routes refuse them.

### Audit log

Every add, change, remove, move and fill writes a `vault_item_event`
row: item, kind of event, person or agent, Case, and time. The drawer shows the
item's events. This answers the audit point of the Grok Enterprise Vault
article (2026-10-23).

## Phase 1 as built

- **Storage.** Table `vault_item` in the regional database (combined and
  regional baselines). A login's username and password are one
  `website_login` secret with the handle
  `vault:website_login:<item>:generation_<n>`. A new sign-in stores a new
  generation and revokes the old one in the same batch. Each write carries
  the placement fence. At most 200 items for each Organisation.
- **Routes.** `GET` and `POST /v1/control/organisations/:id/vault/items`, and
  `POST …/vault/items/:item/commands` with `edit_login`, `replace_sign_in`,
  `edit_contact` and `remove`. Each command names the expected revision.
  Members read; owners and admins write. A refused role gets 404, as on every
  control route. No response carries a password.
- **Contract.** TypeBox schemas in `@satyr/control-api` (`vault.ts`), with
  `normalizeVaultOrigin` for the exact-origin rule.
- **Portal.** Settings → Vault: tabs with counts, one list, a side drawer for
  details, Add, Edit, Replace sign-in and Remove. Passwords travel through
  `controlSecretMutation`, so no retry intent stores them. Development
  preview: `/vault-preview.html` (`?scenario=empty|viewer|failing`,
  `?theme=dark`).
- **Purge.** An Organisation purge deletes its `vault_item` rows.
- **Evidence.** `tests/e2e/vault-items.test.ts` passed on 2026-10-24: an
  `http` site is refused, the login is stored encrypted and resolves for a
  fill, a member reads but cannot add, a stale concurrent edit is refused, a
  new sign-in revokes the old generation, removal revokes the sign-in, and no
  response carries a password.
- **Before release.** Apply `services/platform/scripts/plan-79-vault-item-d1-patch.sql`
  to each regional database. Without it, the page answers 503.
- **Not in phase 1.** Agents cannot read or use items yet. Contact profiles
  have no IFC label yet; phase 2 adds it with the first agent read (D2).

## API keys tab as built (2026-10-25)

A read-only "API keys" tab for owners and admins lists the credentials that
Integrations stored and the Organisation's own model key: name, service,
type, status and date. It reads the existing credential inventory, which holds
metadata only. Each key links to its page in Integrations, which stays the
place to add, rotate or revoke it. Members see a short note instead.

## Phase 2 as built (2026-10-25)

- **SDK spike.** The 1Password JavaScript SDK 0.5.0 runs its core as a 14 MB
  Wasm module (4.2 MB compressed) and sends its HTTP through the global
  `fetch`. Its Node loader reads the module with `fs`, which a Worker lacks.
  With a prepared loader that takes the imported module instead, the core
  runs in local workerd and reaches token parsing. A call to 1Password's
  servers needs a real service account token and is not proven yet.
- **1Password store Worker.** `satyr-vault-onepassword`
  (`wrangler.vault-onepassword.jsonc`, `src/vault-onepassword/`), placed near
  AWS Tokyo, no credential, no storage, invocation logs off. The Platform
  reaches it through the service binding `VAULT_ONEPASSWORD` and posts one
  operation with the Organisation's token. `pnpm --filter satyr-edge
vault-onepassword:check` prepares the loader, checks the profile and
  limits the script to one Wasm module and 6 MB compressed (now 4.3 MB). It
  deploys before the Platform Worker.
- **Store layer.** `credential-vault/stores.ts` chooses the store for each
  operation. Table `vault_store` holds the connected vault and the token's
  handle; the token is a `bearer` row in Satyr Vault. New items go to the
  connected store. The list shows 1Password items first, then Satyr items,
  and caches the 1Password list for 30 seconds. Removal archives a 1Password
  item. Move items copies up to 10 items for each request and removes the
  source only after the copy: a Satyr sign-in is revoked, a 1Password item is
  archived. Disconnect revokes the token and leaves the items in 1Password.
- **Mapping.** A login is a 1Password Login with `username` and `password`
  fields and exact-domain websites. A contact profile is an Identity with a
  "Satyr contact" section. Items that Satyr writes carry the tag "Satyr".
  Identity items made in the 1Password app without that section are not
  listed yet.
- **Audit log.** Table `vault_item_event` records each add, edit, sign-in
  replacement, removal, move, connect and disconnect. Members read it on the
  item drawer and on the store drawer.
- **Portal.** A store line above the list, a "Connect 1Password" drawer with
  a vault choice, a store drawer with Move and Disconnect, a "1Password" mark
  on items, and a History list. Preview: `/vault-preview.html` (the token
  `ops_preview` connects; `ops_two` reaches two vaults;
  `?scenario=onepassword` starts connected).
- **Integrations.** A 1Password card under "Browse apps" opens the same
  connect form and store details as the Vault page; a connected vault also
  shows under "Connected apps". The card's status reads `GET …/vault/store`,
  which answers from Satyr and never calls 1Password; the panel and its item
  list load only when someone opens the card. The SDK itself runs only in
  the 1Password store Worker, which imports it on its first request. The integrations preview fakes the store
  routes with the same tokens.
- **Evidence.** `tests/e2e/vault-onepassword.test.ts` passed on 2026-10-25
  with a fake 1Password client behind the real handler: a refused token
  stores nothing, a token for two vaults asks to choose, an app-made item is
  listed, new items go to 1Password, a move there revokes Satyr sign-ins, a
  stale edit is refused, removal archives, a move back restores sign-ins in
  Satyr, disconnect keeps the items in 1Password, the audit log records each
  step, and no response carries a password or the token.
- **Before release.** Apply `scripts/plan-79-vault-store-d1-patch.sql` to
  each regional database. Run one journey with a real service account token
  from the deployed Worker: Plan 75 showed that a provider can refuse Worker
  egress. If 1Password refuses it, the same handler moves into a container.

## Phases

1. **Items and page.** Done (phase 1 and the API keys tab).
2. **Store interface and 1Password.** Done, except the live journey with a
   real service account.
3. **Secure notes** on both stores, with agent use from phase 5.
4. **Payment cards** on both stores, behind `VAULT_CARDS_ENABLED`.
5. **Browser and fill.** The browser container, the browser capabilities,
   `vault.list_items`, `vault.fill_login`, masks, approval and receipts.
6. **Request sheet.** `vault.request_login` in Portal chat and the Slack
   button.

## Acceptance

One E2E journey with a fake supplier portal on a test host:

- An agent opens the portal, finds no login, and raises the sheet. The test
  saves a login through the sheet. The agent signs in and prepares a draft
  order.
- The password does not appear in Pi history, the Case, the Slack message,
  `browser.read` output, screenshots or Worker logs.
- A look-alike origin refuses the fill. A removed item refuses the fill.
- A second Case asks for approval again.
- The journey writes a repeatable evidence file.

Before release, one journey on a real site with a real login, and one with a
real 1Password service account.

## Risks

- A page can tell the agent to go to another site and sign in. The origin check
  stops the fill.
- A compromised page on a correct origin can read what Satyr types. This is
  the same risk as a person who signs in by hand, and it is accepted.
- Sites can block datacentre addresses. The agent then hands the step to the
  person.

## Out of scope

Personal vaults for each member, a live browser view for the person, passkeys,
and customer-managed keys for the Satyr store (the 1Password store is the
answer for customer-held keys).

## Sources

- [1Password service account rate limits](https://developer.1password.com/docs/service-accounts/rate-limits)
- [1Password Secure Agentic Autofill](https://1password.com/blog/closing-the-credential-risk-gap-for-browser-use-ai-agents)
- [Cloudflare Browser Rendering FAQ](https://developers.cloudflare.com/browser-rendering/faq)
- [Grok's Secure Vault explained (Basenor, 2026-10-23)](https://www.basenor.com/blogs/news/groks-secure-vault-explained-what-it-stores-and-who-gets-it)
