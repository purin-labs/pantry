---
title: Integrations
description: How Purin Pantry connects Slack, commerce authorities, payment providers, and model execution.
---

# Integrations

Pantry treats every integration as a typed boundary with explicit identity,
credential scope, lifecycle, observations, and receipts.

## Communication: Slack

Slack is the primary operator surface. An organisation owns one workspace connection
and selects a destination such as `#cafe-ops`. Signed events resolve to the
organisation, exact destination, membership, policy, ConnectorActor, CaseActor, and
delivery receipt in that order.

Slack owns provider delivery. Pantry owns the Case output identity and settles
the exact output after Slack returns its native receipt.

## Communication: WhatsApp

New WhatsApp customer texts become temporary support Cases. The assigned agent
can read the active Case, propose a reply, or request a human handoff. Every
agent-written response waits for exact approval and remains inside Meta's
24-hour customer-service window.

An explicitly granted Slack conversation can ask its Sous Chef agent to summarize
active WhatsApp Cases. Closing a Case removes the stored transcript and reply
plaintext while preserving content-free receipts and lifecycle metadata.

Follow the [WhatsApp customer support guide](/guides/whatsapp-customer-support)
to run the complete manual test.

## Commerce: Purin Checkout or Shopify

The organisation selects one commerce system:

- **Purin Checkout** runs on the built-in commerce engine and owns private
  catalog, inventory, checkout, order, payment, fulfillment, and shipment
  facts.
- **Shopify** remains authoritative for a Shopify-backed organisation while selected.

Pantry projects normalized observations and submits governed actions. It never
maintains a dual-write path.

## Payment: Stripe

Stripe is a payment connection, not an organisation commerce authority. Payment
attempts bind to the selected order or checkout revision and reconcile through
typed receipts and provider observations.

## Model and workspace execution

`AgentSessionActor` uses the route pinned in the session contract. The
`organisation_subscription` + `openai` route runs Pi with the organisation's ChatGPT
sign-in. The `platform` +
`openai-compatible` route runs Pi with the Purin `OPENROUTER_API_KEY`. Missing or
exhausted authority fails that route; no automatic fallback occurs. The Actor
retains authority over history, budgets, bounded tools, checkpoints, and
delivery. Linux-heavy work materializes an immutable workspace revision in the
on-demand executor and returns artifacts plus a validated changeset.

Raw provider credentials never enter model prompts, generated code, or executor
storage. See [Authority and boundaries](/concepts/authority-and-boundaries).

## Adding an integration

1. Define the provider-neutral identity, capability, lifecycle, action, and
   observation types.
2. Normalize external responses once at the adapter boundary.
3. Bind every action to organisation, account, environment, authority revision,
   policy, approval, and idempotency identity.
4. Return a durable receipt and signed or authenticated observation.
5. Add replay, duplicate delivery, interruption, and revocation evidence.

The integration is ready only when its failure and recovery states are visible
to operators.
