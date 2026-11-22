---
name: creating-tools
description: "Build Purin Pantry provider integrations and agent capabilities through the Platform adapter, authorization, and Tool Host boundaries. Use for a new API integration or production agent tool."
---

# Creating tools

Production agent tools are typed Platform capabilities. Start from the nearest
existing provider adapter and capability. The top-level `tools/` directory holds
exploratory integrations outside the production runtime.

## Find the owning boundary

Read [the tool contract](../../../docs/architecture/integrations.md#capabilities-and-tools) and
[the provider connection contract](../../../docs/architecture/integrations.md#provider-connections).
Inspect the matching code in:

- `services/platform/src/provider-adapters/` for provider behavior and lifecycle;
- `services/platform/src/authorization/capability-catalogue.ts` for capability definitions;
- `services/platform/src/agent-tools/` (one `defineTool` per tool, `registry.ts`, and `catalog/` for selection and calls) for model-facing exposure;
- `services/platform/src/integration-gateway.ts` for governed provider execution;
- `services/platform/src/credential-vault/` for purpose-bound credential resolution.

For a merchant-configured REST or MCP connection, first inspect
[Integration architecture: custom API connectors (was Spec 14)](../../../docs/architecture/integrations.md#custom-api-connectors) and the existing
`services/platform/src/custom-connectors/` boundary. Reuse that path when it fits.

## Implement the capability

1. Define the exact bakery, café, or commerce operation and its owning authority.
2. Parse provider responses and request bodies once into precise internal types.
3. Register the capability through the existing adapter and catalog path.
4. Resolve credentials inside trusted provider code for the exact authorized purpose.
5. Preserve live authorization, approval, stable effect identity, and receipt reconciliation.
6. Expose bounded results through the existing Tool Host.

Use [the information-flow guide](../../../services/platform/src/policy/information-flow/README.md)
when a capability introduces protected context or an output. Preserve source
restrictions through summaries, errors, replay, and delivery. Generated code,
prompts, transcripts, and executor storage receive no provider credentials.

An exploratory Python client remains outside production until it has a reviewed
Platform integration. The SDK's `secret()` returns an opaque placeholder. It
does not select an environment variable or contact a secrets sidecar.

## Verify

Use the owning adapter's existing behavior coverage and an E2E journey for a
new cross-boundary capability. Include an allowed and denied journey for a new
protected source. Save repeatable commands and sanitized receipts or artifacts.
Run the relevant type checks and `pnpm lint:ifc-boundaries` when applicable.
Provider writes, live payments, deployment, and external messages require the
scope authorized by the user. Fixtures do not establish live provider acceptance.
