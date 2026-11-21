---
title: Service map
description: The concrete repository layout for the current Seams Pantry runtime and commerce modules.
---

# Service map

```text
pantry/
├── apps/
│   ├── docs/                  # This VitePress application
│   ├── portal/                # Merchant and agent operations UI
│   └── storefront/            # Buyer-facing commerce demos
├── services/
│   ├── platform/              # Control plane, integrations and Sous Chef
│   ├── workspace-executor/    # Heavy execution boundary
│   └── commerce/            # Commerce engine: private commerce authority
├── packages/
│   ├── contracts/             # Provider-neutral contract schemas
│   ├── rendering/             # Shared rendering and output contracts
│   └── bakery-model/          # Kitchen model: recipes, procedures, physics
├── crates/
│   └── workspace-executor/    # Validated workspace execution service
├── docs/                      # Plans, specifications, evidence, runbooks
└── scripts/                   # Local development and acceptance workflows
    └── punter/                # External acceptance
```

## Runtime ownership

| Runtime            | Owns                                                                                  | Communicates through                                             |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Platform           | Organisation control plane, actors, projections, connectors, tools, and orchestration | Worker bindings, queues, D1, Durable Objects, authenticated APIs |
| Commerce engine    | Private commerce authority and merchant-scoped transactions                           | Versioned private API and signed observations                    |
| Punter             | Buyer journeys and acceptance                                                         | Supported storefront and public APIs                             |
| Workspace executor | Bounded heavy execution                                                               | Immutable workspace revisions and validated changesets           |

Sous Chef runs inside Platform; its instructions and skills live in
`services/platform/src/data/merchant-agent-skills.ts`. Punter is a CLI package in
`scripts/punter`, not a deployed service.

The portal and docs apps are browser surfaces. They do not receive private
runtime database access or raw provider credentials.

`services/platform` owns the active harness paths. A
`organisation_subscription` + `openai` route runs Pi with the organisation's ChatGPT
sign-in. The
`organisation_byo` + `openai` route runs Pi with the organisation's purpose-bound OpenAI
API key from Vault. The `platform` + `openai-compatible` route runs Pi in the Worker with
`OPENROUTER_API_KEY`. `AgentSessionActor` retains authoritative history, tools,
checkpoints, budgets, and receipts. The pinned route fails closed and never
switches harnesses; Picocodex is retired.
