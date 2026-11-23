# WhatsApp development sandbox

Applies to [Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md) Phase 0. It
covers the deterministic local/CI sandbox that is already implemented and the
free Meta live sandbox, which needs values and dashboard actions only a person
with Meta account access can supply.

## Deterministic sandbox (implemented, no credentials needed)

Run it with the ordinary suite:

```bash
pnpm --filter @purin-labs/platform exec vitest run tests/whatsapp-webhook.test.ts tests/whatsapp-connector.test.ts tests/whatsapp-send.test.ts tests/whatsapp-persistence.test.ts tests/whatsapp-harness-tools.test.ts tests/whatsapp-retention.test.ts tests/whatsapp-gateway.test.ts tests/whatsapp-provider.test.ts tests/whatsapp-lifecycle.test.ts tests/whatsapp-operator-notice.test.ts
```

What it contains:

- `tests/whatsapp/fixtures.ts` — sanitized text, non-text, status, malformed,
  and signature fixtures. Synthetic identifiers and synthetic customer text
  only; signatures are computed at test time from a fixture-only app secret,
  so no secret value is committed.
- `tests/whatsapp/fake-graph.ts` — a fake Graph API injected at the same
  `fetcher` boundary production uses. It can return accepted, rejected,
  server-error, network-failure, timeout, and 200-without-message-id outcomes,
  plus signup, provider-managed and finite token lifetimes, discovery, and
  subscription responses.
- `tests/whatsapp/environment.ts` — a development organisation with one connected
  phone number, an assigned agent, a published policy, and an open conversation window.
- Controllable time: every test passes `now` explicitly, so debounce, proposal
  expiry, the 24-hour service window, and envelope trimming are exercised
  without waiting.
- `tests/whatsapp-retention.test.ts` — runs the whole loop, then dumps every
  D1 table and every Connector table and asserts the probe strings are absent,
  and that logs and traces never carry them.
- `tests/whatsapp-lifecycle.test.ts` — revoke, the credential-generation fence over an
  in-flight proposal, erasure releasing the global phone-number claim, and the
  operator surface: takeover, direct human reply, return to agent, close, and
  the Case panel proving no provider credential reaches it.
- `tests/whatsapp-operator-notice.test.ts` — the notify half of
  `pause_and_notify`: one notice per cause per published policy, copy that
  never quotes the customer, and quiet degradation when the organisation has no
  destination or no usable credential.

Domain code contains no sandbox lifecycle, special provider id, test
credential, or behavior flag. The fake ends at the HTTP boundary.

### Cue-routing acceptance matrix

The deterministic sandbox covers both Cue dispositions. Provider delivery uses
`tests/whatsapp/fake-graph.ts`, while the workerd end-to-end suite verifies the
organisation policy boundary and both relevance decisions.

| Case                         | Cue disposition             |  Agent turn | First outbound message                   | Slack follow-up                                                                         |
| ---------------------------- | --------------------------- | ----------: | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Relevant customer question   | `agent_reply_now`           | Exactly one | The assigned agent's immediate reply     | Read the active Case, then approve and send one exact follow-up                         |
| Irrelevant customer question | `acknowledge_without_agent` |        Zero | The configured automatic acknowledgement | Read the active Case and disposition, then approve and send one exact substantive reply |

Both cases must prove one admitted inbound receipt, one active Case, one first
outbound provider receipt, Slack visibility of the original question, one
operator-approved Slack response, delivery-state convergence, and no duplicate
provider send after webhook, tool, or approval replay.

## Free Meta live sandbox (vertical slice and cleanup passed)

Dashboard access is established. The stable Worker callback, app webhook
subscription, and test-WABA app subscription were verified on 2026-08-27. On
2026-09-03 the live test-number path received two customer texts, created one
Case, exposed the retained conversation to the assigned agent and Slack scope,
sent one approved reply through the former Pantry System User credential, recorded a
Meta message id, and converged through `sent` and `delivered` status webhooks.
The recipient confirmed the reply in WhatsApp. The Case-close drill then set a
production `closed_at`, reduced the account to zero open Cases, and returned no
customer or reply messages after a fresh portal load. Content-free receipts and
proposal lifecycle metadata remain. The organisation-token runtime is ready, while
the existing production test connection stays on its legacy credential until a
replacement is proven. On 2026-09-04, Embedded Signup returned no WABA grant;
**Edit settings** showed that Seams KK cannot onboard customers yet. Pantry
stored no organisation credential and left the working connection unchanged. The
remaining live-sandbox work is an Embedded Signup cutover and controlled
credential-revocation recovery drill after Meta approval. See the
[checkpoint note](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-32-meta-webhook-checkpoint-2026-08-27.md)
and [signup drill](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-32-meta-embedded-signup-drill-2026-09-04.md).

### Values to place in `workers/platform/.dev.vars`

Never print, commit, or copy these into fixtures.

| Variable                             | Where it comes from                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `WHATSAPP_APP_ID`                    | Meta development app → App ID                                                             |
| `WHATSAPP_APP_SECRET`                | Meta development app → Settings → Basic → App Secret                                      |
| `WHATSAPP_VERIFY_TOKEN`              | Any high-entropy string you choose; the same value goes in the Meta webhook configuration |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | Facebook Login for Business → configuration id for the Embedded Signup config             |

Customer business tokens are created by Embedded Signup and stored encrypted
in the organisation Vault. They do not belong in `.dev.vars` or Wrangler secrets.

### Actions to perform in Meta's dashboard

1. [x] Create a **separate Meta development app** and add the WhatsApp product.
       Meta provisions a test WABA and a test business phone number at no charge.
2. [x] Add up to five **stable, team-controlled** recipient numbers. Meta's current
       test UI treats those five slots as fixed once added, so do not add customer
       or disposable numbers.
3. [x] Create the Facebook Login for Business configuration for Embedded Signup and
       record its configuration id.

### Worker and callback setup

`wrangler.jsonc` declares the non-secret application bindings and required
secret names. Keep local values in the gitignored `.dev.vars`; use
`workers/platform/scripts/whatsapp-dev.sh` for a local Worker. Install the
two genuine secrets (`WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN`) with
Wrangler for the deployed Worker.
Deploy non-secret binding changes only from a clean, reviewed worktree.

0. Apply the schema to the local D1 once, or every webhook 500s on
   `no such table: whatsapp_phone_number_account`:
   `pnpm exec wrangler d1 execute DB --local --file=migrations/0001_current_schema.sql`
1. [x] Install the two application secrets on the deployed `pantry` Worker.
2. [x] Save
       `https://pantry.purin.io/hook/whatsapp` as the Meta callback,
       verify it with `WHATSAPP_VERIFY_TOKEN`, and subscribe `messages`.
3. [x] Subscribe the Seams app to the test WABA and confirm it through
       `/{waba-id}/subscribed_apps`.
4. [x] In the portal, **select** the discovered phone number. Embedded Signup
       enumerates every number on the granted WABA, but discovery claims nothing:
       until an owner selects one, the number routes no webhooks and cannot be
       bound or enabled. Selection is where the global phone-number claim is taken,
       so a number another organisation still answers for rejects here — and rejects
       alone, without stopping the rest of the connection.
5. [x] Assign an agent, publish an ingress policy, and enable processing. Each is a
       separate owner action; a connected number starts disabled.
6. [x] Send a text from a verified recipient to the test number and run the
       inbound-text, proposal, approval, reply, and status path. These checks passed
       on 2026-09-03.
7. [x] Close the live test Case and verify its conversation window is terminal, its active
       envelope is unavailable, and no customer or reply plaintext remains in
       terminal Pantry storage. Verified on 2026-09-03 through the production
       conversation window projection, zero-open-Case account state, and a fresh content-free
       conversation read.
8. [ ] After Meta permits signup, complete Embedded Signup and prove the organisation
       credential, WABA subscription, and one fresh inbound message. Keep the
       legacy connection intact until these checks pass.
9. [ ] Complete a second known-good signup result, revoke the first organisation
       credential and remove the WABA subscription once, then complete fresh signup
       and prove a new provider connection plus one fresh inbound message.
10. Keep the stable Worker callback. Clear only a temporary Quick Tunnel URL
    used for local debugging.

### Evidence to capture

Sanitize before checking anything into `tests/whatsapp/fixtures.ts`.

- The observed Graph API versions: runtime calls pin `v23.0`; Meta saved the
  webhook field subscriptions at `v26.0` during the 2026-08-27 checkpoint.
- Raw webhook bodies for one text message, one delivery status, and one
  non-text message, with identifiers and content replaced.
- The exact permission list Meta reports on the customer business token.
- The token lifetime Meta shows and what `debug_token` returns: `expires_at = 0`
  is a provider-managed `bearer`; a finite positive value is an
  `expiring_bearer`.
- The response Meta returns to the asset-removal call.
- What Meta does after an ambiguous send: whether a status webhook still
  arrives for a POST that timed out, and whether any client-supplied
  correlation value is echoed back.

## The three external gates

These remain open. Each needs the live sandbox plus a Tech Provider
conversation with Meta; none can be answered from this repository.

1. **Embedded Signup and funding.** Can an organisation complete Pantry's Tech
   Provider flow and activate its WABA without Pantry sharing a credit line?
   If Meta requires Pantry's credit line, stop production onboarding and report
   the gate as failed. This build implements no credit-sharing path.
2. **Credential and permissions.** Confirm the production customer business
   token flow, app subscription removal, rotation behavior, and the minimum App
   Review / Advanced Access permissions. This build requests
   `whatsapp_business_management`, `whatsapp_business_messaging`, and
   `business_management` — exactly what the implemented onboarding and
   messaging paths exercise.
3. **Ambiguous sends.** Confirm Meta's timeout and status-webhook behavior
   after a message POST. Correctness here does not depend on the answer: an
   unprovable outcome is `send_indeterminate`, the Case is fenced, and an
   operator resolves it explicitly.

## Rotating an organisation credential

Use **Reconnect WhatsApp** for the affected organisation. Embedded Signup exchanges
the new customer business token, validates its provider-managed or finite
lifetime, stores it in the organisation Vault, and advances the connection credential
generation. Proposals frozen against the previous generation refuse to send
with `authority_moved`;
an operator re-approves them under the new generation.

After full revocation, use **Connect WhatsApp** for a fresh signup. Pantry keeps
the stable phone-number account identity, creates a new provider connection,
and leaves the revoked connection and credential generations terminal.

Rotating `WHATSAPP_APP_SECRET` remains a separate Platform deployment. It does
not replace or advance organisation credentials.

Prepare App Review with the
[WhatsApp Meta review package](whatsapp-meta-review-package.md).
