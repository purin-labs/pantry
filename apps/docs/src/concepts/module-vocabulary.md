---
title: Module vocabulary
description: The Lowerarchy names for the commerce responsibilities of Purin Pantry and their current homes.
---

# Module vocabulary

The Lowerarchy names make responsibility legible. They describe ownership
independently from package layout and deployment.

| Module              | Human meaning                                          | Current implementation home                                                          | Runtime boundary                      |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------- |
| Commerce engine     | Coordinates transactional commerce                     | `services/commerce`                                                                | Independent service and database      |
| Contracts           | Defines shared commerce language                       | `packages/contracts`                                                                 | Compiled into Pantry and consumers   |
| Sous Chef           | Operates the merchant business                         | `areas/commerce/server/data/merchant-agent-skills.ts` and Pantry agent configuration           | Pantry runtime                       |
| Commerce Read Layer | Records projections, queries, and operational history  | OrganisationActor projections and CommerceGraphReader sources in `workers/platform` | Pantry runtime                       |
| Punter              | Buys and proves the system through acceptance journeys | `scripts/punter`                                                                     | CLI and CI harness                    |

Pantry hosts the organisation control plane, provider connections, Cases, agent
sessions, approvals, tools, merchant console, Sous Chef behavior, and the Commerce
Read Layer. The commerce engine or Shopify remains the selected commerce authority.

## Boundary rule

A named module becomes a separate deployment only when its authority, scaling,
security, or release lifecycle requires that boundary. Components communicate
through authenticated versioned APIs and signed events. They never import
another runtime's database or private source.

## Why the names matter

The vocabulary prevents two common mistakes:

- treating a projection as a second writer; and
- treating a product role as a deployment requirement.

Use the [service map](/reference/service-map) for the concrete repository
layout.
