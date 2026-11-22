---
name: tool-health-smoke
description: "Check Purin Pantry production capability discovery, provider connection readiness, and authorized read execution. Use for tool health or integration connectivity checks; use qa for a complete operator journey."
---

# Tool health smoke

Check capabilities through the same Platform boundaries used by the agent.
A Python CLI inventory does not describe the production tool catalog.

## Scope

Use the requested environment, organisation, connected accounts, and requester.
For an all-tools request, inventory capabilities visible to that requester.
Separate configured capabilities, authorized capabilities, and capabilities
whose provider connectivity was actually exercised.

Read [integration discovery](../../../docs/runbooks/integration-discovery.md)
and [the tool contract](../../../docs/architecture/integrations.md#capabilities-and-tools).
The production catalog is defined in
`foundation/authority/authorization/capability-catalogue.ts` and exposed through
`services/platform/src/agent-tools/` (`registry.ts` and `catalog/selection.ts`).

## Run

1. Read connection lifecycle and readiness through existing authenticated controls.
2. Verify discovery under the requester's actual grants.
3. Exercise an existing bounded read for each selected connected provider.
4. Record unavailable, denied, disconnected, and untested capabilities separately.
5. Trace failures through the owning adapter, gateway, and Vault boundary.

Use an existing provider readiness probe where available. Do not invent a
universal `health` method or expose write capabilities just to test connectivity.
A missing read grant is a denied result; it is not proof of provider failure.
Live writes need an authorized acceptance journey with an exact target and receipt.

## Evidence

Report the environment, requester scope, provider/account identifiers, capability,
result, and sanitized receipt or error. Save the commands or request sequence
needed to repeat the check. Never include credentials or customer content.

Use PASS only for the exercised scope. Use PARTIAL when required accounts,
grants, or live evidence are unavailable. State concrete failures separately.
Return the report in the current conversation. Post elsewhere only when authorized.
