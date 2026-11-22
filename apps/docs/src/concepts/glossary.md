---
title: Glossary
description: Terms used across Purin Pantry and the Lowerarchy commerce modules.
---

# Glossary

### AgentSessionActor

The durable actor that owns one agent's accepted history, checkpoints, turns,
budget, and event stream inside a Case.

### BakeryTask

One bakery operation in a production schedule or a native workcell run, such as
a process step, a transfer, or a handoff. It belongs to bakery orchestration and
is unrelated to a Case or a HarnessTask.

### Case

The provider-neutral body of related work. A Case owns shared context,
assignments, accepted proposals, and its durable output outbox.

### CaseContextCollection

A record that relates selected evidence and Cases concerning the same matter,
such as a purchase request, its supplier emails, and a delivery exception. It
stores references and relationship metadata. Source owners keep the content,
and linking evidence grants no access. `OrganisationActor` stores collections.

### CaseContextDiscovery

The optional feature that finds permitted candidate evidence, evaluates whether
it concerns the same matter, and proposes or attaches it to a
CaseContextCollection. Connectors schedule it and `OrganisationActor` owns its
configuration, evaluation records, and relationship review.

### ConnectorActor

The durable actor that admits provider ingress, owns delivery and retry state,
and settles provider receipts.

### Conversation window

WhatsApp's provider grouping for one customer's active support exchange. It
bounds when a reply may be sent. It is not a CaseContextCollection.

### Commerce authority

The selected transactional system of record for an organisation's commerce facts,
such as Purin Checkout or Shopify.

### Commerce Read Layer

The rebuildable projections, commerce queries, search, and operational
history of Pantry. Older plans call it Blotter.

### Contracts

The shared commerce language and contract definitions implemented in
`packages/contracts`. Older plans call this role Lexicon.

### Harness

The route-selected agent runtime behind `AgentSessionActor`'s common adapter.
`organisation_subscription` + `openai` uses Pi with the organisation's ChatGPT
sign-in. `organisation_byo` + `openai` uses Pi with the organisation's
Vault-encrypted OpenAI API key. `platform` + `openai-compatible` uses Pi with
Purin-funded OpenRouter access. A route stays fixed for its session and never
falls back to another funding authority. Picocodex is retired.

### HarnessTask

Work that an agent harness identifies or continues, carried by `HarnessTaskId`
and `HarnessTaskContinuation`. It belongs to the harness and session components.

### Organisation

The customer isolation scope. An Organisation owns membership, roles, shared
configuration, credentials, budgets, and placement. `OrganisationActor` holds
its organisation-wide state. Users, merchants, shops, workspaces, provider
accounts, and Cases are separate concepts within it.

### Punter

The independent buyer and acceptance harness in `scripts/punter` that exercises
the system through supported storefront and commerce journeys.

### Purin Pantry

The bakery operating system: governed operations for café and bakery
production and commerce. Its product areas include Kitchen, Café, and Commerce.

### Purin Checkout

The built-in commerce that people see: checkout pages, the QR order page, and
the Register. The commerce engine in `services/commerce` runs it.

### Sous Chef

The merchant-principal agent behavior: operating work through the Cases,
tools, policies, and approvals of Pantry. Its instructions and skills live in
`areas/commerce/server/data/merchant-agent-skills.ts`. Older plans call it Urk.

### Workspace executor

The on-demand heavy execution boundary. It materializes an immutable workspace
revision, returns artifacts and a validated changeset, and owns no durable
commerce or Case state.
