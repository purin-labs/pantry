---
name: qa
description: "Verify Seams Pantry operator journeys in Kitchen, Café and Commerce through Portal or Slack, durable actors, and commerce boundaries. Use for stack QA, smoke tests, or deployment acceptance."
---

# Seams Pantry QA

Prove the requested operator journey in the selected environment. Report local,
provider Sandbox, production, and simulated-machine evidence separately.

Read [the E2E coverage guide](../../../test-coverage-e2e.md) and the owning plan's
acceptance gates. The active runtime is Cloudflare Platform, Portal, the commerce engine
(`services/commerce`), and the Pi harness on the route-selected model.

## Choose the journey

Use an existing journey that crosses the affected boundaries. Suitable paths include:

- a Slack or Portal request, an authorized commerce read, and final receipt delivery;
- a saved Kitchen run, an operator edit, native simulation, interruption, and restore;
- inventory receiving, purchasing, or an order exception with governed resolution;
- provider onboarding, revocation, and a denied read after access removal.

For complex features, choose a medium-to-hard scenario with recovery or denied
authority. Reuse existing acceptance fixtures and runners. A service health
response alone cannot establish the operator journey.

## Execute and verify

1. Record the commit, environment, exact organisation, requester, and test data.
2. Run the narrowest relevant E2E or browser journey.
3. Check accepted Actor state, the domain result, and the final visible receipt.
4. Verify recovery does not duplicate a provider effect or user-facing delivery.
5. Save a repeatable artifact with commands, inputs, result identifiers, and limits.

Use authenticated controls and the current pinned inference route. Missing
funding authority must fail that route. Preserve information-flow restrictions
through the final destination and replay.

Run `pnpm --filter @purin-labs/platform test:e2e` for the Platform E2E suite. Lifecycle
changes also require `test:onboarding-closure`. Commerce lifecycle changes
require `test:commerce-lab` and the lab reset, seed, scenario, and verify sequence
listed in the repository guide. Confirm the selected local lab before resetting it.

A live Slack journey may post only within the target authorized by the task.
Use local E2E fixtures when no live target is authorized. Do not deploy, purchase
hardware, charge money, or issue physical robot commands as an incidental QA step.

## Report

State PASS, FAIL, or PARTIAL for the requested scope. Include the artifact,
repeatable command, observed result, and unresolved gate. Never include secrets
or private customer content in evidence.

Use [Slack liveness](../../../docs/runbooks/slack-liveness.md),
[Vault operations](../../../docs/runbooks/vault-operations.md), and the
[observability contract](../../../docs/architecture/onboarding.md#onboarding-operations-and-observability)
for failures. Optional external telemetry services require an established
connection to the affected deployment.
