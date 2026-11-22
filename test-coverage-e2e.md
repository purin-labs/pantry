# Pantry E2E coverage and acceptance

Documentation reconciled: 2026-10-06. This guide identifies current runners and
acceptance boundaries. It records no new test execution or production acceptance.

## Runtime and sources

Platform E2Es run the Worker and Durable Objects in Workerd, Cloudflare's local
Worker runtime. The configuration includes `tests/e2e/**/*.test.ts`, runs files
serially, and disables automatic retries. It provides local bindings and explicit
provider fixtures. Optional live harness acceptance uses separately selected inputs.

Use these sources to determine the actual suite and CI behavior:

- [Platform E2E configuration](services/platform/vitest.e2e.config.ts)
- [E2E runtime bindings](services/platform/tests/e2e/wrangler.jsonc)
- [Platform commands](services/platform/package.json)
- [Pantry CI workflow](.github/workflows/pantry.yml)
- [Commerce CI workflow](.github/workflows/commerce-components.yml)
- [Test maintenance guide](services/platform/tests/AGENTS.md)

The original August four-family/eight-execution budget is historical. The current
suite includes later bakery, inventory, chat, attachment, access, and regional
journeys. Avoid fixed test counts or timing claims that lack a dated run artifact.

## Representative behavior coverage

| Boundary                                            | Existing journey or acceptance owner                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack admission, Case execution, and final delivery | [Slack Actor journey](services/platform/tests/e2e/slack-actor-journey.test.ts)                                                                                               |
| Provider connection and signed ingress              | [Connections](services/platform/tests/e2e/providers-connection.test.ts), [webhooks](services/platform/tests/e2e/providers-webhooks.test.ts)                                  |
| Authorized capability discovery                     | [Discovery journey](services/platform/tests/e2e/slack-discovery-journey.test.ts)                                                                                             |
| Attachments and reconstruction after replacement    | [Attachment journey](services/platform/tests/e2e/slack-attachment-journey.test.ts), [isolated restore journey](services/platform/tests/e2e/slack-attachment-restore.test.ts) |
| Inventory operations                                | [Inventory E2E](services/platform/tests/e2e/inventory-operations.test.ts), Plan 47                                                                                           |
| Saved Kitchen runs and authority                   | [Bakery runs](services/platform/tests/e2e/bakery-runs.test.ts)                                                                                                               |
| Chat completion                                     | [Portal finalization](services/platform/tests/e2e/portal-chat-finalization.test.ts), Plans 45/45A                                                                            |
| Native bakery execution and recovery                | [Native runner guide](crates/bakery-native/README.md), [release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md)                                                          |
| Buyer checkout, pickup, and export                  | [Punter](scripts/punter/README.md), commerce lab, Plans 22/23/33                                                                                                             |

This table locates coverage. A file's existence does not establish a passing run.
Each plan retains its release, provider, and physical acceptance limits.

## Choose the smallest useful verification

Reuse the owning feature's behavior journey. For a complex change, exercise a
medium-to-hard scenario with interruption, conflicting revisions, or denied
access. Verify the final domain state and visible receipt. Avoid duplicate tests
that only mirror implementation details or freeze incidental source structure.

Static fixtures remain appropriate for domain states that TypeScript must reject.
Follow the repository's required checks when shared lifecycle types change.

Run the Platform E2E suite with:

```bash
pnpm --filter @purin-labs/platform test:e2e
```

For a focused journey after building the media module:

```bash
pnpm --filter @purin-labs/platform contracts:media
pnpm --filter @purin-labs/platform exec vitest run --config vitest.e2e.config.ts tests/e2e/bakery-runs.test.ts
```

Onboarding or lifecycle changes also require:

```bash
pnpm --filter @purin-labs/platform test:onboarding-closure
```

Commerce lifecycle changes require the existing lab sequence. Confirm the selected
local lab environment before resetting its data:

```bash
pnpm --filter @purin-labs/platform test:commerce-lab
pnpm lab:reset
pnpm lab:seed
pnpm lab:scenario
pnpm lab:verify
```

Use `pnpm lint:ifc-boundaries` plus allowed/denied E2E acceptance for a new
protected source. This checks information-flow control: source restrictions must
remain attached to derived content and govern its final destination.

## Repeatable artifacts

At the end of acceptance, retain the command, commit, environment, scenario
inputs, exact result identifiers, and observed outcome. Existing bakery and
Punter runners produce reports described in their guides. For a runner without
a report artifact, save its sanitized output and a short reproduction record.
Do not commit credentials, private customer content, or unbounded provider logs.

A useful bakery integration scenario combines a financier gift order, rejected
pieces, a packaging shortage, and an interrupted agent turn. Verify exact lot,
run, approval, movement, and fulfillment identities as each integration lands.
This is a proposed acceptance target. It does not claim the complete automatic
physical production loop is implemented.

## Acceptance levels and open gates

- Local fixtures prove behavior under controlled provider and runtime inputs.
- Provider Sandbox runs prove the exercised provider binding and scenario.
- Production runs prove the exact deployed path, grants, and funding route.
- Native simulation proves the modeled mechanical workflow and fault behavior.
- Physical calibration and robot dispatch require separately observed evidence.

Missing or exhausted inference authority fails the pinned route. A test that
silently selects another funding route cannot prove recovery.

[Plan 37](docs/history/plan-37-typed-messages-and-attachments.md) retains its attachment
collection-audit gate. [Plan 33D](docs/history/plan-33D-square-release-acceptance.md)
retains deferred seller-isolation and physical/live certification.
[The Kitchen release ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md)
retains integrated file, production release, calibration, and physical limits.
Later documentation edits do not close these gates.
