---
title: Authority and boundaries
description: How Seams Pantry keeps provider authority, agent power, credentials, and safety responsibilities separate.
---

# Authority and boundaries

Pantry coordinates work across systems. It does not silently become the source
of truth for every system it can reach.

## One authority per resource

Each organisation and environment selects one transaction authority for a given
commerce resource:

| State                                                         | System of record                                  |
| ------------------------------------------------------------- | ------------------------------------------------- |
| Products, inventory, orders, and fulfillment                  | The selected Seams Checkout or Shopify system     |
| Normalized provider observations                              | Pantry projections, rebuildable from observations |
| Cases, sessions, proposals, approvals, policies, and receipts | Pantry                                            |
| Payment execution                                             | Stripe or the selected payment provider           |
| Merchant-agent instructions and skills                        | Sous Chef, installed by Platform                  |
| Acceptance journeys                                           | Punter                                            |
| Key custody and signing authority                             | Seams SDK                                         |

There is no dual-write mode. A change of authority increments the authority
revision. Outstanding actions bound to an older revision require rebase.

## Human, agent, and machine actions

Human operators, agent sessions, and future robot adapters use the same typed
boundary:

```text
request identity
  -> organisation and conversation authority
  -> capability and policy decision
  -> approval when required
  -> exact resource and revision
  -> idempotency identity
  -> trusted execution
  -> durable receipt and replayable observation
```

The actor kind changes the source of authority evidence. It does not remove
the resource revision, policy, approval, budget, receipt, or replay checks.

## Credential boundary

Raw provider credentials never enter generated code, prompts, transcripts,
checkpoints, or executor storage. The trusted platform resolves an opaque
credential reference for one authorized operation, injects it into that
operation, and records metadata-only audit state.

The vault rechecks the exact organisation, account, environment, policy rule,
credential generation, and revocation state immediately before decryption.
Missing keys, stale rules, corrupt ciphertext, and ambiguous scope fail
closed.

## Seams SDK boundary

The Seams SDK provides wallet identity, authentication, and signed action approval at
the action boundary. Seams Vault owns provider credentials and organisation ChatGPT
OAuth profiles. Platform-funded Pi access remains deployment-secret-backed
through `OPENROUTER_API_KEY`.

## Robot and safety boundary

Plan 24 introduces a governed robot adapter direction for bakery production.
Pantry may own enrollment, capability grants, task identity, approvals,
telemetry normalization, and receipts. A certified machine's local safety
controller owns emergency stop, guarding, interlocks, speed limits, and safe
stop behavior.

Remote workflow pause is an operating control. It cannot bypass local machine
safety authority. The current runtime has no robot controller or fleet service.

## Provider edge

Provider APIs, webhooks, and external identity claims are untrusted boundary
inputs. Pantry validates and normalizes them once, then passes precise domain
values into core logic. A provider capability gap remains an explicit branch;
the platform does not infer support from a display name, URL, or partial
payload.
