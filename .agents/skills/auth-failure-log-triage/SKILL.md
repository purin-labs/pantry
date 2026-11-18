---
name: auth-failure-log-triage
description: "Investigate Seams Pantry authentication, OAuth, credential, permission, and provider failures using scoped Cloudflare runtime evidence and current connection state. Use for reported 401, 403, 503, or failed credential resolution."
---

# Auth failure log triage

Inspect runtime evidence before changing a credential or permission. A status
code alone does not identify the failing authority.

## Locate the failure

Resolve the environment, organisation, provider account, Case or Session, request
identifier, and time window from the report. Ask only for identifiers needed
to locate the failure. Inspect the selected deployment profile and the existing
Worker logs or configured Cloudflare observability surface.

`services/platform/src/observability.ts` defines structured trace records.
Correlate the ingress request with Connector, Case, Session, gateway, and provider
records. Use retained logs for past failures; a live tail only captures new events.
Read [the observability contract](../../../docs/architecture/onboarding.md#onboarding-operations-and-observability)
and the relevant [operational runbook](../../../docs/runbooks/onboarding-operations.md).

VictoriaLogs is usable only when the affected deployment explicitly exports
its logs there. Exploratory clients in `tools/infra/` do not establish that
connection. An empty query does not prove that the runtime is healthy.

## Identify the authority

Distinguish these failure boundaries:

- provider OAuth grant, scope, expiry, revocation, or account mismatch;
- Pantry membership, capability grant, policy, or information-flow denial;
- Vault credential lifecycle, generation, or purpose mismatch;
- pinned inference funding, allowance, or provider transport failure;
- provider availability, timeout, or unresolved external effect.

Compare the observed error with the owning adapter and current connection state.
Follow [Vault operations](../../../docs/runbooks/vault-operations.md) for credential
recovery. Read [Runtime architecture: harness adapter (was Spec 4)](../../../docs/architecture/runtime.md#harness-adapter) for the three pinned
inference routes. Recovery must preserve the selected funding authority.

## Report and recovery

Report the environment, time window, sanitized identifiers, observed failure,
source of evidence, and smallest supported correction. Preserve uncertainty
when no matching evidence is available. Never print tokens, authorization
headers, raw provider bodies, or secret values.

Do not rotate credentials, broaden grants, reconnect accounts, resend an
uncertain provider write, or change funding routes solely from a status code.
Use the user's authorized recovery scope and the existing reconciliation path.
