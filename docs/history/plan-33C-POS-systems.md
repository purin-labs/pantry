# Plan 33C — Payment Terminal Integrations (POS Systems)

Status: **done — agreed Sandbox scope** · exact-binding certification recorded
and verified on 2026-09-08. Deferred release acceptance remains in
[Plan 33D — Square release acceptance](plan-33D-square-release-acceptance.md).
Update (2026-11-14): Plan 80 step 4 (released 2026-10-27) moved Square OAuth,
payments and Terminal into Underclerk. The Satyr Square path below is a record.
The current Japan Sandbox binding is certified; this does not authorize production payments.
Follow-up (2026-11-16): [Plan 90 — Café Counter Register and POS Payment Adapters](../plan-90-cafe-pos-checkout.md)
extends counter sales with the `CafeOS › Register` screen, menu modifiers, cash
tender, Square Japan `FELICA_ALL` / `QR_CODE`, and GMO `stera` via `shop-gateway`.

Depends on:
[Plan 9 — Commerce Lifecycle Lab](plan-9-commerce-lifecycle-lab.md),
[Plan 19 — Organisation Commerce System](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-19-organisation-commerce-system.md),
[Plan 33 — Merchant-Configurable Production Checkout](plan-33-merchant-configurable-production-checkout.md),
and [Refactor 2 — Statically Compiled Integration Adapters](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/refactor-2.md).

Related operator-surface patterns:
[Plan 31-C — Ecommerce Operations Workbench](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-31C-ecommerce-operations-workbench.md).

Implementation evidence:
[P33B/P33C completion record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-33BC-completion-record.md).
The phase checklist below retains the original acceptance status. Unchecked
release gates are carried into Plan 33D; they have not been waived.

## Outcome

CafeOS merchants can connect a supported payment terminal and collect one
recoverable card-present payment for a Satyr Checkout. Satyr remains
authoritative for products, prices, tax, Cart, Checkout, Order, inventory,
fulfillment, refunds, and merchant receipts. The external provider supplies
only in-person payment processing and verified payment evidence.

Every payment-terminal integration uses the same narrow contract:

```text
Satyr Checkout -> exact payment request -> payment terminal
payment terminal -> verified payment evidence -> Satyr Payment
```

The terminal never creates or edits Satyr products, prices, taxes, Orders,
inventory, fulfillment, or receipt contents. Provider catalogs, provider
orders, provider inventory, provider customers, and register operations remain
outside Satyr's integration boundary.

Square Terminal is the first measured provider. Square Sandbox supports
Terminal checkout simulation through documented test device identifiers. It
does not simulate the Devices API pairing flow. Provider onboarding, payment
execution, replay, observations, and operator surfaces can close before a
physical device is purchased; production device pairing closes with hardware.

## Scope split from Plan 33

Plan 33 remains the merchant-configurable online checkout plan. It owns
published online Checkout profiles, buyer sessions, online payment collection,
pickup and shipping fulfillment, recovery, cancellation, and refunds.

Plan 33C owns:

- the in-person Checkout source and operator authority;
- payment-terminal provider connection and credential lifecycle;
- Satyr-location configuration and active terminal assignment;
- provider-specific device pairing at the provider boundary;
- card-present collection, reconciliation, cancellation, and refund;
- verified terminal payment observations and Payment readback;
- operator-facing receipt recovery;
- terminal health, webhook health, audit evidence, and incident recovery; and
- Sandbox, physical-device, and live-environment certification.

The shared quote, Order, Payment, inventory, authorization, receipt, and replay
contracts remain the single commerce model. Plan 33C adds an exact
`point_of_sale` Checkout source and one card-present collection path.

## Fixed commerce authority

Satyr Commerce is the only commerce authority in this plan. Underclerk owns the
accepted quote and every commercial lifecycle transition. A terminal binding
authorizes payment collection for one exact Checkout amount. It never grants
commerce-system authority.

The runtime does not ingest or synchronize provider catalogs, orders,
fulfillments, customers, or inventory. It does not select Square or another
terminal provider as an organisation commerce system. A merchant can replace its
terminal provider without migrating Satyr commerce records.

Core Checkout and Order logic depends on one provider-neutral in-person payment
port. Provider names and transport shapes terminate inside compiled adapter
boundaries.

## First provider and hardware boundary

Square Terminal is the only active payment-terminal provider in the first
release. Phase P33C-0 removes dormant Stripe Terminal, GMO face-to-face, and
Square POS-app-handoff domain branches. The provider-neutral payment port
remains. A later provider adds its branch only when its measured slice supplies
one merchant, location, device, sale, refund, and recovery fixture.

Square Terminal connected mode is controlled by Satyr through Square's Devices,
Terminal, and Payments APIs. Square Register, Square POS catalog and order
operation, and other provider-owned register systems remain outside this plan.

Hardware purchase is a release gate. Earlier phases use a Square Sandbox seller,
Sandbox location, and Square's documented Terminal checkout test device
identifiers. Local deterministic fixtures exercise device-code parsing and
pairing state. A Square Sandbox test device is explicitly modeled as a
simulation target; it is never recorded as a paired physical device.

## General-availability promise

The first generally available release supports:

- one Square merchant account connected through merchant-scoped OAuth;
- a Japan merchant, a Japan location, and JPY transactions;
- exact Satyr-location configuration and one active terminal assignment;
- production device-code pairing for one physical Square Terminal;
- multi-line anonymous or identified in-person Checkouts created by Satyr;
- one `CARD_PRESENT` payment with no provider, device, or payment-method
  fallback;
- idempotent collection, observation, reconciliation, pending-collection
  cancellation, refund, and recovery;
- one normalized Satyr Order, Payment, inventory, and receipt aggregate with
  exact provider payment evidence;
- merchant-safe receipt recovery and operational readback; and
- Sandbox, physical-device, and live-provider certification packets.

Cash tender, cash-drawer control, tipping, split tender, partial authorization,
manual card entry, gift cards, QR payments, e-money, offline Satyr order entry,
provider catalog or order synchronization, loyalty, workforce management,
kitchen display hardware, and arbitrary terminal providers remain outside this
release.

## Authoritative boundaries and invariants

### In-person Checkout source

The operator boundary creates an in-person Checkout through a branch-specific
command. It requires the exact organisation, Satyr merchant, Satyr location, sales
channel, operator identity, Cart revision, quote digest, active terminal
assignment revision, published POS configuration revision, and buyer branch.

```text
buyer = anonymous
      | identified_customer(customer_id)

checkout_source = online(storefront_id, buyer_session_digest, buyer_contact)
                | point_of_sale(satyr_location_id,
                                pos_configuration_revision,
                                operator_identity,
                                terminal_assignment_revision,
                                buyer)
```

Existing online fields do not become optional. Boundary builders create the
exact source branch and shared core logic accepts only the normalized Checkout.
Type fixtures reject fake buyer contacts, fake buyer sessions, online-only
fields on `point_of_sale`, POS-only fields on `online`, and incomplete direct
object construction.

Trusted Platform or Underclerk code resolves the active terminal assignment
from the Satyr location. An operator request cannot submit an arbitrary payment
binding, provider location, or device.

Paid placement constructs the Order origin exhaustively from the Checkout
source. A `point_of_sale` Checkout always produces a `point_of_sale` Order;
existing online placement cannot silently supply the origin.

### POS commercial configuration and fulfillment

Reuse the existing Checkout profile publication and policy machinery with an
exact POS branch. Its immutable published configuration requires the organisation,
merchant, Satyr location, sales channel, supported items and quantity limits,
pricing and tax policy references, pickup policy, cancellation and refund
governance, and receipt presentation policy. Reuse existing policy values and
parsers. Terminal assignment remains a separate binding resolved at collection.

Cart, quote, Checkout, and Order retain the accepted configuration revision.
New publication affects new work only. POS quote and placement resolve this
configuration directly; an active online storefront, online payment binding,
contact, and buyer session are never prerequisites for a POS sale. Source
normalization covers Cart and quote creation as well as Checkout placement.

The first release uses the existing pickup fulfillment lifecycle at the Satyr
location. Capture places the Order and transfers held allocations to it. The
operator confirms handover through the existing pickup-completion command,
which consumes inventory exactly once. Counter handover can follow payment
immediately. Refund alone never restocks handed-over goods; existing governed
return or inventory-adjustment behavior owns that decision.

### Terminal configuration and state

A terminal assignment requires the exact organisation, Satyr merchant, Satyr
location, provider integration account, environment, provider merchant account,
provider location, terminal target, country, currency, transport, adapter
version, and capability revision. Boundary parsers create the assignment from
provider responses, request bodies, and persistence records.

Pairing, assignment, and observed health use separate closed states:

```text
pairing_attempt = open | paired | expired | cancelled
assignment      = active | retired
observed_health = unknown | available | unavailable

terminal_target = sandbox_simulated(test_device_id)
                | paired_physical(provider_device_id)
```

Square production pairing codes expire after five minutes. An expired or
cancelled attempt never creates an assignment. A paired device cannot silently
move between organisations, Satyr locations, or provider locations. Replacement
creates a new assignment revision and retires the prior assignment for new
payment attempts. Existing attempts remain bound to their original revision for
recovery.

Device-health diagnostics never grant, revoke, or move payment authority.
Health readback includes observation time and source. Unknown, stale, or
unavailable diagnostic health is advisory; collection eligibility uses exact
assignment, certification, credentials, and durable collection ownership. A
provider execution rejection becomes a typed unavailable outcome. An ambiguous
transport outcome remains recoverable and cannot be classified as no charge.
The absence of an active physical assignment represents an unpaired terminal;
there is no persistent `unpaired` lifecycle state.

One unresolved collection owns a physical terminal at a time. Acquire ownership
atomically with the persisted payment attempt before submitting to Square. The
key includes environment, provider account, and physical device identity, so an
assignment revision change cannot evade exclusivity. Sandbox ownership also
includes the organisation because documented test device IDs are shared simulations.
A competing Checkout receives `terminal_busy` with an authorized recovery
reference. Reload, disconnect, elapsed time, and assignment retirement never
release ownership. Release follows reconciled provider completion or confirmed
non-capture; preserve any remaining commercial-placement recovery separately.

### Provider connection

Terminal-provider credentials remain in the Vault boundary and resolve only for
the exact organisation, integration account, environment, provider account, purpose,
adapter version, and capability revision. OAuth start, callback, refresh,
revocation, and removal use the shared compiled provider lifecycle. The portal
never receives access or refresh tokens.

The first Square release requests only these OAuth scopes:

- `DEVICE_CREDENTIAL_MANAGEMENT`;
- `DEVICES_READ`;
- `MERCHANT_PROFILE_READ`;
- `PAYMENTS_READ`; and
- `PAYMENTS_WRITE`.

The Payouts page later added `PAYOUTS_READ`, to show when Square's money
reaches the seller's bank.

Orders, Catalog, Inventory, Customers, Loyalty, and Workforce scopes are
excluded. Provider discovery normalizes only the merchant account, supported
environment, payment locations, currency, devices, and terminal capabilities.
`DEVICES_READ` supplies device discovery and diagnostic readback. Existing
connections missing that scope require the shared scope-upgrade/reconnect flow.

### Checkout preparation and terminal request

Before contacting the terminal, Satyr creates and persists the Cart, quote,
Checkout, inventory allocations, and payment attempt. The terminal request
binds the organisation, merchant, Checkout revision, quote digest, amount, currency,
provider account, provider location, terminal assignment revision, device,
payment binding, adapter version, capability revision, collection deadline, and
idempotency identity.

The provider receives the payable amount and a bounded receipt summary. It has
no authority to revise line items, prices, tax, inventory, fulfillment, or
Order identity.

Square provider identifiers are derived deterministically at the boundary and
persisted with their Satyr identity mapping. The Square idempotency key is at
most 64 characters and the Square `reference_id` is at most 40 characters.
Replays use the exact persisted values. Identifiers are never truncated.

Before dispatch, persist the exact request payload or immutable reconstruction
inputs and digest, provider idempotency key, reference mapping, assignment, and
terminal ownership. Model submission in progress and submission outcome unknown
without requiring a provider checkout ID. A timeout, unreadable response, or
crash before local recording retains the same attempt and ownership.

Recovery first uses authenticated matching observations or provider inquiry.
An identical request may be replayed only within the pinned provider version's
documented idempotency semantics and while execution remains authorized; persist
that replay limit with the attempt. Once the collection deadline passes, use
read-only recovery and cancellation of any discovered checkout. Never mint a
new key to resolve uncertainty. If safe replay or lookup is unavailable, move
to manual investigation while preserving the unresolved collection lock.

The first Square request pins this collection profile:

```text
payment_type                                  = CARD_PRESENT
payment_options.autocomplete                  = true
payment_options.accept_partial_authorization  = false
device_options.tip_settings.allow_tipping     = false
provider_order_id                             = absent
```

Quote expiry prevents starting a new collection. At admission, persist a local
collection deadline bounded by the remaining quote lifetime and pin the accepted
commercial quote. Square's current `deadline_duration` reference is deprecated
and describes automatic cancellation of `PENDING` checkouts; it does not bound
capture for `IN_PROGRESS` checkouts. Do not use it as a hard capture cutoff.
Verify timeout behavior for the pinned API version in the provider packet.

At the local deadline, stop new collection dispatch, request cancellation of a
known pending/in-progress checkout, and reconcile the result. Keep inventory
allocations and the accepted quote while a submitted payment can still capture.
Local expiry or a cancellation request alone never releases them. Confirmed
non-capture permits release through the existing Checkout cancellation path.
Reconciliation continues after quote expiry and always records late money
movement, including capture received after a cancellation race.

### Verified capture and commercial completion

A completed Terminal checkout is payment evidence requiring Payment readback.
Satyr requires exactly one provider payment identity and retrieves the Square
Payment before accepting capture. The verified Payment must agree with the
bound merchant account, location, terminal checkout, payment method, status,
currency, quoted total, zero tip, and absence of partial authorization.

The accepted result records the provider checkout reference, provider payment
reference, terminal assignment revision, device, requested amount, verified
captured total, currency, lifecycle observation, and provider timestamps.
Retries return the original collection or reconciliation result. An
indeterminate response stays recoverable and never authorizes another charge.

After verified capture, Satyr creates the Order, transfers or consumes the
Checkout inventory allocations, records the Payment, and emits receipt and
fulfillment state. The Order origin is `point_of_sale`. This sequence is one
idempotent placement boundary.

Verified late capture completes placement against the pinned quote and retained
allocations. Persist capture evidence before attempting commercial placement.
A crash or transient placement failure leaves a durable captured-but-unplaced
attempt for idempotent recovery. If placement is permanently impossible, expose
the exact captured Payment for an authorized compensating refund or manual
investigation, even when no Order exists. A captured amount that fails binding
verification also requires a recorded financial exception and investigation;
it cannot disappear as a parser error or authorize another charge. Compensation
uses the shared refund authority and original Payment identity. Its uncertainty
remains durable until resolved.

Satyr's receipt is the commercial record. A Square-printed or Square-presented
payment slip is provider presentation and cannot alter the Satyr Order or
receipt.

The first receipt delivery path is an authenticated operator browser print view
of the Satyr receipt. The operator can print or save it through the browser and
reopen the same receipt after reload using the Order reference. Reprints retain
the original receipt identity and financial facts and record a reissue audit
event. Anonymous buyers require no contact details. The view contains only the
commercial receipt fields and masked payment evidence. Square terminal printing
remains a separate payment slip; printing the Satyr receipt on that device and
public receipt links are deferred. Browser print completion is not proof that
paper was delivered.

### Payment observations

Terminal webhooks terminate at versioned parsers. An observation retains the
provider delivery identity, provider merchant account, application identity
when supplied, terminal checkout identity, payment identity, amount, currency,
location, device, provider lifecycle, and observation time.

Webhook delivery is signed, organisation-routed, deduplicated by provider event
identity, and replayable. A changed payload under a settled delivery identity is
a conflict. Before an observation advances capture, its identities must match
the persisted binding and payment attempt and Satyr must read and verify the
Payment. Catalog, order, inventory, customer, and fulfillment payload fields are
discarded at the provider boundary.

Reconciliation repairs webhook gaps through the provider Payment or Terminal
checkout API. Diagnostic observations never substitute for authoritative
Payment verification.

### Cancellation and refund

Three operations remain distinct:

1. **Cancel pending terminal collection.** Satyr calls the exact adapter
   cancellation operation for a pending or in-progress Terminal checkout, then
   reconciles because completion can race with cancellation.
2. **Cancel Satyr Order.** After capture and placement, Plan 33 governance owns
   Order cancellation and its inventory consequences.
3. **Refund captured Payment.** Satyr references the original verified Payment
   and converges provider and Satyr refund evidence on one durable result.

The adapter does not use Square's dismiss operation as generic cleanup because
dismissal can capture an authorized payment. Every cancellation and refund has
its own idempotency identity, replay behavior, and race tests.

### Retention, recovery, and terminal failure

Satyr persists provider checkout and payment identities as soon as they are
known; unknown submission recovery uses the pre-dispatch record above. Square
Terminal checkout records are available for a limited provider retention
window, currently 30 days. Long-term recovery uses Satyr evidence and the
Payments API. Indeterminate attempts are surfaced and reconciled well before
that deadline.

After the provider retention deadline, an unresolved attempt moves to an
explicit manual-investigation state. It never triggers another collection.

The first release requires provider-confirmed collection evidence. An absent or
ineligible assignment fails before dispatch. A provider-confirmed execution
rejection returns typed unavailability; an accepted request awaiting an offline
device remains pending until reconciled cancellation or completion. Diagnostic
health alone cannot settle a payment. Satyr does not create an assumed Payment
or queue an unbounded card-present retry.

## Certification model

The existing payment-binding certification boundary is generalized from its
Stripe Online-only shape to the exact active payment-binding branch, adapter
version, environment, merchant account, location, terminal target, currency,
and capability revision. This plan reuses the existing certification store and
workflow; it does not create a parallel terminal certification system.

Every scenario records its evidence source and exact tested binding:

| Evidence source            | Required coverage                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deterministic fixture      | Malformed/mismatched evidence, multiple payment IDs, partial authorization, webhook replay/conflict/reordering, capture around expiry, both submission crash windows, placement failure, two-browser ownership, and retention/replay-window exhaustion |
| Square Sandbox             | Documented test-device success/cancellation/timeout, Payment readback, supported refunds, OAuth isolation, signed webhook admission, inquiry, and the operator walking sale                                                                            |
| Physical production device | Pairing/expiry/replacement, real card payment and cancellation, offline behavior, interruption, refund, receipt agreement, and revocation/reconnect                                                                                                    |

Fixtures never count as proof of provider or hardware behavior. Record Sandbox
scenario IDs, amount/currency limits, API version, and provider limitations.
Races that cannot reliably be induced live use deterministic evidence, with
supported live observations recorded separately.

Certification uses the existing store and proceeds in two explicit scopes:

1. Certify one disposable organisation's exact Sandbox binding with candidate adapter
   evidence for successful collection, Payment readback, replay, and refund.
   This minimum packet permits only that Sandbox binding's walking sale.
2. Activate that same binding and demonstrate the P33C-3 walking sale before
   expanding the matrix. Record the runtime evidence in the existing workflow.
3. Complete the fixture and Sandbox matrix before the hardware purchase gate.
4. For production, run candidate probes against the actual merchant's account,
   location, and physical device. Record the full applicable matrix and exact
   binding before production activation; then run the activated runtime canary.

A disposable-organisation packet never certifies another organisation. Shared adapter
fixtures may be referenced by digest, but each binding needs its own account,
location, target, currency, version, and capability evidence. Replacement device
or account changes require new binding certification before collection. Replay
of historical attempts stays pinned to their original binding. Unchanged
adapter evidence may be reused; repeat pairing and payment/recovery probes for
the replacement target. Failed runtime canaries stop new collection and keep
reconciliation available. There is no generic uncertified activation bypass.

## Phase structure

### P33C-0 — Contract cleanup and in-person authority

Lock Satyr as the sole commerce authority and Square Terminal server-controlled
mode as the first payment provider. Remove dormant Stripe Terminal, GMO
face-to-face, and Square POS-app-handoff branches. Preserve one provider-neutral
in-person payment port.

Define the `point_of_sale` Checkout source, anonymous and identified buyer
branches, the POS commercial configuration and Cart/quote path, branch-specific
Order origin, terminal target, terminal assignment, pairing attempt, observed
health, terminal collection ownership, payment attempt, cancellation, refund,
and observation identities. Include submission-unknown and captured-but-unplaced
states with their required recovery evidence. Add boundary parsers and static fixtures for invalid
source, organisation, location, device, amount, currency, environment, adapter, and
capability combinations.

Exit gate: an operator can construct one valid in-person Checkout command;
invalid combinations fail at the single boundary or compile time; provider
commerce data cannot enter the terminal contract; and no inactive terminal
provider branch remains in the domain.

### P33C-1 — Square connection lifecycle

Add Square to the compiled provider catalogue and shared onboarding lifecycle.
Implement merchant-scoped OAuth, callback validation, Vault persistence, token
refresh, revocation, remote cleanup, payment-capability discovery, and the exact
`DEVICE_CREDENTIAL_MANAGEMENT`, `DEVICES_READ`, `MERCHANT_PROFILE_READ`, `PAYMENTS_READ`, and
`PAYMENTS_WRITE` scopes. Keep Sandbox and production credentials isolated.

Exit gate: two organisations can connect distinct Square Sandbox sellers, refresh and
revoke their credentials, and prove that neither organisation can resolve the other's
payment authority. The connection has no commercial-data scope.

### P33C-2 — Location configuration and terminal targets

Discover Square payment locations and persist exact provider resource
references. Add Satyr-location configuration, deterministic device-code
fixtures, pairing-attempt parsing, expiry, replacement, retirement, and
provider-health parsing fixtures.

Use the typed `sandbox_simulated` target with Square's documented test device
identifiers for Sandbox Terminal checkouts. Do not call or claim to simulate
Square Devices API pairing in Sandbox. Reserve `paired_physical` for the live
device-code flow in P33C-6. Square documents Sandbox `ListDevices` and `GetDevice`
test resources; exercise those supported reads separately. Simulation never
proves physical pairing or availability. A simulated target reports `unknown`
physical health; any synthetic readback is labelled as Sandbox evidence.

Exit gate: an operator selects one Satyr location and Square Sandbox location,
activates one simulated target, replays configuration safely, replaces it with
a new assignment revision, and observes stable `unknown` health without
duplicate resources or authority changes.

### P33C-3 — Certified Sandbox payment lifecycle

Replace the Square adapter's unpublished credential resolver with the exact
organisation-scoped resolver. Implement deterministic provider identifiers, Terminal
checkout creation, Payment readback, signed observations, reconciliation,
pending-collection cancellation, and refund.

First record the minimum exact Sandbox packet defined above, activate that
Sandbox authority, and demonstrate a minimal operator browser path: select
items, quote, collect, place the Order, confirm pickup handover, print/reopen the
receipt, and refund once. Reuse P33C-4's final components for this path. Do this
before broadening the certification matrix or building the operations dashboard.

Then complete the source-labelled matrix. Exercise success, buyer
cancellation, timeout, terminal unavailable, duplicate request, cancellation
racing completion, webhook replay and conflict, reconciliation, refund, wrong
location, wrong device, amount mismatch, currency mismatch, tip mismatch,
partial authorization, multiple payment identities, provider retention recovery,
late capture after expiry, unknown submission before any provider ID is saved,
crash after response before persistence, captured-but-unplaced recovery, and
two operators competing across reload and assignment replacement.

Exit gate: one accepted Checkout produces one Terminal collection, one verified
Payment, and one immutable certification packet. Every replay returns the
original identities. No failure selects another provider, device, payment
method, or commercial amount. The activated end-to-end canary passes through
the certified binding.

### P33C-4 — Operator Checkout and receipt operation

Complete the operator-facing Checkout path demonstrated in P33C-3: publish the
POS commercial configuration, select supported Satyr items and
quantities, select anonymous or identified buyer, review the Satyr-calculated
total, resolve the location's active terminal assignment, collect the exact
amount, observe the verified result, and recover, cancel, or refund through the
appropriate Satyr lifecycle. Expose terminal-busy and unresolved-payment states,
explicit pickup handover, and authenticated browser receipt printing/reissue.

Reuse the shared quote, Order, Payment, inventory, authorization, audit, and
replay boundaries. Do not force online storefront, contact, or buyer-session
fields into the in-person branch.

Exit gate: a multi-line café Checkout settles once, records a `point_of_sale`
Order, applies Satyr's exact inventory effects, produces a merchant-safe Satyr
receipt, survives a browser reload, and completes an exact refund. An anonymous
Checkout contains no fabricated buyer identity.

### P33C-5 — Portal operations and recovery control

Expose Square connection health, Satyr and provider location mapping, terminal
target and assignment revision, pairing status where applicable, observed
health, adapter and capability revision, payment-webhook freshness, unresolved
payments, provider retention deadline, manual-investigation state, and
certification status.

Exit gate: a merchant can configure the complete Sandbox path without editing
code. An operator can identify and recover an expired configuration, revoked
credential, stale payment webhook, cancellation race, or indeterminate payment
without viewing secrets or buyer-private data.

### P33C-6 — Physical-device and live certification

Purchase and pair a Square Terminal through a production device code. Run the
physical-production rows of the evidence matrix with small merchant-owned
amounts and planned refunds. Record fees and provider limitations; refunds do
not imply that every cost is reversible. Reference fixture/Sandbox evidence for
scenarios that cannot be induced safely or reliably on hardware.

The certification packet covers:

1. five-minute device-code expiry, pairing, retirement, and replacement;
2. collection success and buyer cancellation;
3. device offline or unavailable behavior;
4. interruption and duplicate delivery;
5. Payment readback, webhook verification, and reconciliation;
6. pending-collection cancellation racing completion;
7. refund;
8. Checkout, Order, Payment, inventory, and receipt identity agreement; and
9. credential revocation and reconnect.

Exit gate: Sandbox, physical-device, and live-environment packets exist for the
exact merchant account, Satyr location, provider location, physical device,
currency, adapter version, and capability revision published to the organisation.

## Implementation surface

Reuse the existing provider lifecycle and payment boundaries. The expected
areas are:

- `packages/contracts` for the in-person Checkout source, Square connection,
  location, terminal target and assignment, pairing attempt, cancellation, and
  payment-observation contracts;
- `services/platform/src/provider-adapters` and provider workflows for Square
  OAuth, payment-capability discovery, refresh, revocation, and cleanup;
- `services/platform/src/payment-adapters` for the Square Terminal adapter,
  organisation-scoped credential resolver, Payment readback, cancellation, and
  provider identifier mapping;
- `services/platform/src/cafe-payment-service.ts` for exact authority,
  collection, observation, reconciliation, cancellation, refund, and recovery
  orchestration;
- the existing payment-binding certification data boundary for active binding
  branches and exact adapter versions;
- `services/underclerk` for in-person Checkout, `point_of_sale` Order placement,
  Payment, receipt, and inventory persistence;
- `apps/portal` for connection, location mapping, assignment, in-person
  Checkout, health, recovery, and certification surfaces; and
- focused Platform, Underclerk, portal, commerce-lab, Sandbox, and physical-
  device acceptance tests.

Implementation extends the established Square Terminal adapter and shared
provider lifecycle directly. It introduces no provider catalog sync, second
commerce system, speculative device framework, parallel certification store,
or inactive provider workflow.

## Implementation status

A phase is ticked only when its amended exit gate passes. Several phases have
their software complete but their gate unmet, because the gate requires a
provider run, hardware, or a decision. Those are listed as software-complete
rather than done, so the distinction stays visible.

- [x] P33C-0 — contract cleanup and in-person authority
- [ ] P33C-1 — Square connection lifecycle · software complete; gate needs two
      distinct Sandbox sellers. Distinct-seller isolation deferred by the user
      on 2026-09-08. The second organisation connected successfully through the migrated
      callback, but authorized the same Japan seller; this does not close the
      distinct-seller gate. Both connections remain intact
- [x] P33C-2 — location configuration and terminal targets · the portal bound
      the Japan Sandbox location to a source-labelled simulated target, replaced
      the assignment through revision 4, refreshed locations and devices,
      retired the active target, reactivated a new assignment, and returned the
      same assignment identity for an exact runtime configuration replay
- [ ] P33C-3 — certified Sandbox payment lifecycle · adapter, derived
      identifiers, exclusivity, Payment readback, and certification store done;
      Japan Sandbox adapter matrix passed on 2026-09-06; the portal canary and
      real credential/resource refresh passed on 2026-09-07. App-owned webhook
      registration, per-account Vault signing keys, exact-URL ingress, and
      operator readback are implemented. On 2026-09-08, the portal registered
      the path-scoped `square-sandbox-webhook.seams.sh` subscription through a
      named Cloudflare Tunnel, rejected an unsigned probe, and durably admitted
      the PENDING, IN_PROGRESS, and COMPLETED notifications from an actual
      Sandbox checkout. The distinct active AU/AUD Sandbox merchant
      `MLB5XP163XKP5` and location `LMY8YZSZNWYZS` were verified read-only with
      their isolated credential. Connecting that seller to a second Satyr
      organisation and proving cross-organisation payment authority are deferred by the user
      as of 2026-09-08. Exact-binding certification was recorded as
      `square-jp-binding-20260908` for capability revision `1788817935700`;
      immutable replay and the current portal counter readback passed. See
      [certification packet](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-exact-binding-packet-20260908.json),
      [provider evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-terminal-sandbox-20260906-jp-3.json)
      and [portal canary evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-portal-counter-sale-20260908.json)
- [x] P33C-4 — operator Checkout and receipt operation · an actual portal
      multi-line sale completed quote, collection, capture, `point_of_sale`
      Order, exact inventory commit, handover, receipt reopen/print, and full
      refund reconciliation in Square Sandbox; exact authenticated collection
      and reconciliation replays returned the original Checkout, payment
      attempt, Terminal checkout, Payment, and Order identities
- [ ] P33C-5 — portal operations and recovery control · connection, resource
      refresh, terminal assignment, unresolved-payment recovery, after-sale,
      receipt, webhook configuration, credential-health, and webhook-freshness
      controls are implemented; the externally reachable subscription passed
      with actual signed delivery, and the Cloudflare scheduled handler ran
      successfully afterward. Scheduled Square observation now refreshes and
      persists rotated OAuth authority, verifies payment resources, and gives
      reconnect guidance for revoked or missing-scope credentials in isolated
      fixtures. The account lifecycle proof preserves the Square merchant and
      connection identities through reauthorization, disable/reconnect, and
      active rotation while superseding each prior credential generation. The
      real Wrangler scheduled handler now binds Cloudflare `fetch`, refreshed
      the stored Seams KK OAuth pair in place, verified Square resources, and
      durably recorded `healthy` / `provider_identity_verified` while keeping
      the account, connection, and webhook active. Portal-initiated OAuth
      rotation reached connected at credential generation 4. The migrated
      callback also connected the second organisation successfully. The remaining
      acceptance gaps are tracked in Plan 33D
- [ ] P33C-6 — physical-device and live certification · blocked on hardware

## Hardware purchase gate

Do not purchase hardware until P33C-0 through P33C-3 pass against Square
Sandbox. This gate covers the software payment lifecycle and typed simulation
target; it does not claim production device pairing has passed.

Purchase a Square Terminal that Square currently documents as compatible with
Terminal API connected mode in the merchant's country. A provider-owned register
or general POS appliance is outside this integration contract.

The purchase decision records the exact country availability, supported payment
methods, network requirements, accessories, return window, and Terminal API
compatibility verified from current Square documentation at purchase time.

## Provider documentation gates

Implementation and certification verify current Square behavior against:

- [Connect a Square Terminal to a POS application](https://developer.squareup.com/docs/terminal-api/integrate-square-terminal);
- [Take one-off payments](https://developer.squareup.com/docs/terminal-api/square-terminal-payments);
- [Create Terminal checkout](https://developer.squareup.com/reference/square/terminal-api/create-terminal-checkout);
- [Get Terminal checkout](https://developer.squareup.com/reference/square/terminal-api/GetTerminalCheckout); and
- [Dismiss Terminal checkouts and refunds](https://developer.squareup.com/docs/terminal-api/dismiss-checkouts-and-refunds).

The 2026-09-05 review also checked the
[TerminalCheckout deadline contract](https://developer.squareup.com/reference/square/objects/TerminalCheckout),
[GetDevice scope requirement](https://developer.squareup.com/reference/square/devices-api/get-device),
and [Sandbox device-read and checkout support](https://developer.squareup.com/docs/devtools/sandbox/testing).
Use the specific API reference and measured evidence when guide wording is
broader or older than an endpoint's documented support.

External limits and capabilities are reverified during implementation and again
before hardware purchase. Provider documentation is evidence for adapter
constraints; persisted Satyr contracts remain the runtime authority.

## Completion gate

Plan 33C is complete when a merchant can connect Square without code, map one
Satyr location to one exact Square location and physical terminal, complete and
recover a multi-line in-person Checkout, reconcile its Order, Payment,
inventory, cancellation or refund, and receipt evidence exactly once, and
review Sandbox, physical-device, and live certification for the published
terminal capability. Satyr remains authoritative for every commercial fact
throughout the path.

Closure also requires demonstrated recovery from both submission crash windows,
late capture at local expiry, and interrupted placement; exclusive terminal use
across two operator sessions; the pinned POS policy and explicit pickup handover;
and browser receipt delivery/reissue for an anonymous buyer. Certification
records distinguish fixture, Sandbox, and physical evidence and certify the
actual activated organisation binding.

## Retained design question

The September implementation handoff left one representation question open:
whether a counter sale should store a full point-of-sale configuration reference
or retain location plus `posConfigurationRevision`. The recorded implementation
uses location and revision to identify the configuration. This question creates
no additional Sandbox release gate and authorizes no schema change.
