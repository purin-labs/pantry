---
title: Bakery automation
description: Kitchen orchestration in Purin Pantry, recipe simulation, and the planned physical production boundary.
---

# Bakery automation

Kitchen coordinates production within Pantry. Operators and agents work through
Portal and Slack. A workflow canvas, resource timeline, and spatial bakery view
show the same run, tasks, equipment, materials, and accepted results.

## Available software and planned work

| Scope                                                                                               | Status and owner                                                                      |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Financier finishing, saved scenarios, native cold-tray simulation, and fault handling               | Bounded Plan 42/42B software accepted                                                 |
| Chat control and shared orchestration, including two independent cells and simulated human transfer | Selected Plan 42E/F local scope complete                                              |
| Automatic saved context and view control                                                            | Plan 42G production Pi/Codex acceptance passed                                        |
| Chat forks                                                                                          | Plan 42H local acceptance passed; integrated file and production release gates remain |
| Equipment models                                                                                    | Plan 60A in progress                                                                  |
| Full financier preparation, sesame milk, ginger teas, and combined café shift                       | Plans 61A–E draft; implementation and calibration pending                             |
| Physical robot enrollment and dispatch                                                              | Plan 24 planned; no physical controller or fleet service                              |

The release ledger in `docs/evidence/plan-42-release-readiness.md` owns current
acceptance limits. Successful simulation establishes software behavior only.
Use the [plans index](/reference/plans) to locate each owning document.

## Production and commerce

The intended loop starts with demand and available stock. Recipe work reserves
workers, equipment, vessels, and storage. Quality checks determine accepted yield
and packaging release. Packing consumes packaging stock and records saleable
quantities, rejects, and lot identity. Commerce records govern sale and fulfillment.

Existing commerce contracts support ingredients, packaging, lots, production
batches, and shipments. A complete automatic link from a Kitchen run to those
records remains work to verify. Simulated completion cannot create physical stock.

## Authority

Pantry owns task identity, exact revisions, grants, policy, approvals, budgets,
accepted results, and receipts. The selected commerce authority owns inventory,
orders, payments, and fulfillment facts.

For future physical integration, certified machines and local safety controllers
own motion, emergency stop, guarding, interlocks, and safe-stop behavior. A remote
workflow request cannot bypass those controls.

Plan 24 begins with one typed adapter in shadow and approval modes. Enrollment,
capability checks, and current operator authority must pass before dispatch.
An uncertain outcome holds affected work until trusted evidence resolves it.
Duplicate commands must resolve to the original task and receipt.

## Acceptance

Use the [first operating path](/guides/first-operating-path) to connect production
and commerce. Record exact scenario inputs and repeatable artifacts. Keep local
software, provider Sandbox, production service, and physical measurements separate.
Physical acceptance includes local intervention, disconnect recovery, duplicate
delivery, exact-revision checks, and terminal receipt reconciliation.
