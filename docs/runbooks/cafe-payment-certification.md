# CafeOS payment binding certification

Use this runbook before publishing or activating a CafeOS checkout profile.
Payment authority stays disabled until Platform has an immutable certification
record for the exact organisation, integration account, environment, capability
revision, country, currency, collection mode, and adapter version.

## Published adapter

Square Terminal now has credentialed Japan sandbox adapter evidence; see the
Square section below. This does not enable organisation payment authority or satisfy
the full eight-check certification gate.

The current publishable adapter is Stripe online embedded tokenization for a
Japan merchant charging JPY. GMO-PG, Square online, Stripe Terminal, GMO
face-to-face, and Square Terminal remain compiled provider-neutral binding
branches with unavailable runtime credentials. Do not certify or publish those
branches until their runtime adapter and provider matrix are complete.

## Matrix

One certification run must prove all eight checks:

1. collection success;
2. collection failure;
3. interruption recovery;
4. duplicate delivery or replay;
5. reconciliation;
6. cancellation;
7. refund; and
8. merchant-safe receipt evidence.

The local suites exercise the adapter and authority invariants without provider
credentials:

```bash
pnpm --filter @seams/platform exec vitest run \
  tests/payment-adapters.test.ts \
  tests/cafe-payment-service.test.ts \
  tests/cafe-in-person-payment-service.test.ts \
  tests/payment-observation.test.ts \
  tests/cafe-payment-authority-route.test.ts
```

## Square Terminal Japan sandbox

The provider adapter was exercised against an active Japan/JPY sandbox seller
on 2026-09-06, using Square API version `2026-08-19` and documented simulation
device IDs. [Evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-terminal-sandbox-20260906-jp-3.json)
records a ¥100 capture with Payment readback, recovery after deliberately losing
the accepted creation response, same-checkout idempotent replay, a completed
full refund, developer cancellation, buyer cancellation, and timeout.

Two adapter defects surfaced: Square rejected the 64-character hex idempotency
key, and cancellation compared its derived provider reference to the raw Satyr
attempt ID. Keys now encode the entire SHA-256 digest as 43 base64url characters;
cancellation derives the same reference as creation and reconciliation.
[The first run](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-terminal-sandbox-20260906-jp-1.json) preserves
the cancellation failure and confirms that its refund completed and its checkout
was canceled. The initial rejected create made no payment.

To reproduce, set `SQUARE_SANDBOX_ACCESS_TOKEN` in root `.env.local` and run from
the repository root. Use a unique run ID for an independent matrix; retain the
same ID when recovering an interrupted run. Every request is restricted to the
Square sandbox origin, and the account must contain an active Japan/JPY location.

```sh
pnpm --filter @seams/platform exec esbuild ../../scripts/lab/square-terminal-sandbox.ts --bundle --platform=node --format=esm --outfile=/tmp/satyr-square-sandbox.mjs
node --env-file=.env.local /tmp/satyr-square-sandbox.mjs your-run-id
```

Run IDs contain 1–32 lowercase letters, digits, or hyphens. The runner saves
provider identities and normalized outcomes in `docs/evidence`, excluding tokens
and card details. A `processing` refund is polled to completion before passing.

This runner calls the actual adapter using a sandbox-only credential resolver.
It does not exercise organisation Vault credentials, OAuth connect/rotation/revoke,
live signed webhook delivery, the full POS operator workflow, merchant-facing
receipt delivery, or physical hardware. It never publishes a certification
record. Complete those gates separately before enabling payment authority.

Provider references: [sandbox device scenarios](https://developer.squareup.com/docs/devtools/sandbox/testing),
[Terminal checkout](https://developer.squareup.com/reference/square/terminal-api/create-terminal-checkout),
and [Refund Payment](https://developer.squareup.com/reference/square/refunds-api/refund-payment).

## Stripe sandbox

Run the credentialed acceptance only against a disposable Stripe test account.
The test creates small JPY PaymentIntents, confirms one success and one decline,
cancels one intent, refunds part of the successful payment, replays provider
operations, and proves recovery after a simulated transport interruption.

Configure and export these values outside the repository:

- `PANTRY_WORKER_URL` — the deployed Worker base URL. HTTPS is required except
  for a local loopback URL;
- `UNDERCLERK_BASE_URL` — the deployed Underclerk public and service API base
  URL;
- `PANTRY_CAFE_ORGANISATION_ID` — the CafeOS organisation whose current account is being
  certified;
- `PANTRY_CAFE_MERCHANT_ID` — the merchant owned by that organisation;
- `PANTRY_CAFE_STOREFRONT_ID` — the activated storefront, or omit it to use
  `storefront_cafe`;
- `ORGANISATION_ADMIN_TOKEN` — the organisation-admin bearer token for the Worker;
- `PANTRY_CAFE_STRIPE_TEST_ACCESS_TOKEN` — an account-scoped `sk_test_`
  OAuth access token;
- `PANTRY_CAFE_STRIPE_TEST_PUBLISHABLE_KEY` — the matching `pk_test_` key; and
- `PANTRY_CAFE_STRIPE_TEST_ACCOUNT_ID` — the exact `acct_` identity represented
  by the development candidate returned by the Worker;
- `UNDERCLERK_SERVICE_TOKEN` — the service token used only to read and, when
  necessary, replenish the disposable acceptance inventory;
- `PANTRY_FAULT_INJECTION_TOKEN` — the acceptance-only token for the deployed
  queue interruption point;
- `SLACK_BOT_TOKEN` — a bot token that can read the configured receipt channel;
  and
- `PANTRY_CAFE_SLACK_CHANNEL_ID` — the channel that receives the merchant-safe
  payment receipt.

These acceptance-only values are separate from `STRIPE_CONNECT_CLIENT_SECRET`,
which remains the platform OAuth application secret. Never replace the OAuth
application secret with a connected-account access token.

Then run the complete gate:

```bash
pnpm cafe:accept
```

The gate runs the local acceptance phases first. It then uses the activated
public storefront to create and confirm one Stripe test PaymentIntent, recover
the exact placed Order, consume the configured queue interruption point, and
poll Slack for the resulting receipt. The receipt must name the
same Order and Payment while excluding provider references and credentials.
The gate passes that validated receipt evidence directly into the live Stripe
matrix; operators do not construct `PANTRY_CAFE_RECEIPT_EVIDENCE` by hand.

The live matrix reads
`/v1/admin/cafe-payment-certification?organisationId=...` and requires one development
Stripe candidate whose `acct_` identity matches
`PANTRY_CAFE_STRIPE_TEST_ACCOUNT_ID`. It uses that exact binding for the closed
eight-check matrix, includes the validated receipt in the evidence digest,
and POSTs the packet to `/v1/admin/cafe-payment-certification`. A final GET must
find the immutable record and certified payment authority. Retain the CI run
or provider export that produced the digest. Never place API keys, card data,
client secrets, provider session references, or webhook secrets in the packet.

## Inspect and record

The acceptance test performs the candidate GET, packet POST, and final readback
automatically. For a manual inspection, read the candidate binding with:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer ${ORGANISATION_ADMIN_TOKEN}" \
  "${PANTRY_WORKER_URL}/v1/admin/cafe-payment-certification?organisationId=${PANTRY_CAFE_ORGANISATION_ID}"
```

The response must expose exactly one current development Stripe binding with
`collection: "embedded_tokenization"`, `country: "JP"`, and
`currency: "JPY"`; its `providerAccountId` must equal the dedicated test
account. Submit evidence with that exact binding and the exact closed matrix
below only when performing the packet operation manually:

```json
{
  "schemaVersion": "satyr.cafe-payment-binding-certification.v1",
  "organisationId": "organisation_example",
  "testRunId": "stripe_sandbox_example",
  "paymentBinding": {
    "provider": "stripe_online",
    "account": {
      "integrationAccountId": "integration_example",
      "providerAccountId": "acct_example",
      "environment": "development",
      "capabilityRevision": 1,
      "country": "JP",
      "currency": "JPY"
    },
    "collection": "embedded_tokenization"
  },
  "adapterVersion": "stripe_online@2026-03-25.dahlia",
  "matrixVersion": 1,
  "checks": [
    "collection_success",
    "collection_failure",
    "interruption_recovery",
    "duplicate_delivery",
    "reconciliation",
    "cancellation",
    "refund",
    "receipt"
  ],
  "evidenceDigest": "0000000000000000000000000000000000000000000000000000000000000000",
  "certifiedAt": "2026-08-31T00:00:00.000Z"
}
```

POST the completed packet to `/v1/admin/cafe-payment-certification` with the
organisation-admin bearer token. The operation is idempotent by organisation and test-run
identity. Reusing that identity with different evidence returns a conflict.
Successful recording immediately resynchronizes Underclerk payment authority.

The final GET must show:

- `paymentAuthority.state` is `certified`;
- `paymentAuthority.paymentBinding` equals the tested binding;
- the packet appears under `certifications` with `certifiedBy: "organisation_admin"`
  and a server `recordedAt` timestamp; and
- `paymentAttempts.overdueIndeterminate` and
  `paymentAttempts.expiredCollection` are zero before activation.

Any integration-account update changes the capability revision and invalidates
the old packet automatically. An adapter-version change also requires a new
matrix run.

## Production certification

Production uses the same matrix and an exact production binding. Use a
merchant-scoped production account, real permitted payment method, production
webhook delivery, and provider refund evidence. A human operator must review
the provider dashboard, receipt, webhook delivery, and refund before recording
the production packet. The automated sandbox test does not perform a live card
charge.

Do not activate a production checkout profile until the admin readback reports
the production binding as certified.

## Incident response

The readback summarizes payment attempts by lifecycle. For
`overdueIndeterminate > 0`, stop profile activation, preserve the binding and
idempotency identity, and run reconciliation against the original provider
reference. Never create a replacement charge. For `expiredCollection > 0`, let
the buyer request a fresh quote and session; do not reuse the expired provider
session. A changed account or adapter version requires recertification before
authority can be enabled again.
