# Satyr services

The `services/` tree contains independently owned runtime and commerce
components. Deployment proximity does not permit shared databases or private
source imports.

| Component    | Responsibility                                                                                             | Runtime boundary                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `platform`   | HTTP control plane, Slack ingress, OAuth, onboarding, state, queues, gateways, and container orchestration | Cloudflare Worker                     |
| `underclerk` | Private catalog and transactional commerce authority                                                       | Independent service and database      |
| `shop-voice` | Speech-to-text for Portal voice control, on a Mac in the shop                                              | Python service on the shop Mac        |
| `shop-gateway` | Connects a shop's kitchen devices to Satyr with one outbound socket (Plan 85)                               | Rust program on a shop computer       |

Urk runs inside Platform; Punter lives in `scripts/punter`.

The browser portal lives in `apps/portal`. Shared implementation packages live
in `packages/`.

## Commerce module vocabulary

The Lowerarchy names describe responsibilities independently from physical
layout:

| Module              | Current home                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| Underclerk          | `services/commerce`                                                                |
| Contracts           | `packages/contracts`                                                                 |
| Urk                 | `services/platform/src/data/merchant-agent-skills.ts` and the Satyr agent runtime               |
| Commerce Read Layer | OrganisationActor projections and CommerceGraphReader sources in `services/platform` |
| Punter              | `scripts/punter`                                                                     |

Only a measured runtime requirement creates a new deployment boundary.

## Dependency rules

- Components communicate through authenticated versioned HTTP APIs and signed
  events.
- Components never import another component’s database or internal source.
- Satyr–Underclerk private API clients are generated into
  `packages/underclerk-client`.
- Punter uses public APIs and published contract packages only.
- Every deployable component owns its migrations, secrets, health checks, and
  deployment lifecycle.
