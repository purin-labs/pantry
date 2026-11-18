---
title: Concepts
description: The ownership, authority, commerce, and execution ideas that shape Seams Pantry.
---

# Concepts

Pantry coordinates a merchant's operating work without becoming an accidental
second source of truth. The platform owns identity, Cases, agent sessions,
governed actions, projections, and receipts. The selected commerce authority
owns commerce facts. Provider adapters terminate external shapes at a typed
boundary.

## The core model

| Concern                              | Pantry's role                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Identity and organisation boundaries | Authenticate the operator, resolve organisation ownership, and bind work to an organisation revision. |
| Conversation and work                | Admit provider input into a ConnectorActor and CaseActor.                                             |
| Agent execution                      | Run durable AgentSessionActors through a harness-neutral adapter.                                     |
| Commerce                             | Read rebuildable projections and submit typed, governed actions to the selected authority.            |
| Safety and policy                    | Check exact revisions, approvals, budgets, credentials, and capabilities before execution.            |
| Operations                           | Deliver progress and receipts through Slack and the operator portal.                                  |

## Design principles

1. Every durable fact has one named writer.
2. Provider payloads terminate in adapters and become precise internal types.
3. A Case is the canonical body of related work; a Slack thread is one view of
   that Case.
4. Agent sessions own history and checkpoints. Replaceable executors own
   compute and no durable domain state.
5. High-impact actions use typed policy, authorization, approval, receipt, and
   replay boundaries.
6. Projections are rebuildable from authoritative observations.
7. Credentials remain opaque outside the trusted platform operation that uses
   them.

## Reading order

- [Architecture](/concepts/architecture) for the component and deployment map.
- [Runtime request flow](/concepts/runtime-request-flow) for the durable work
  sequence.
- [Commerce domain](/concepts/commerce-domain) for the merchant-native model
  of Pantry.
- [Authority and boundaries](/concepts/authority-and-boundaries) for policy,
  providers, credentials, and future machine actions.
- [Module vocabulary](/concepts/module-vocabulary) for Lowerarchy ownership
  names.
- [Glossary](/concepts/glossary) for the terms used across the repository.
