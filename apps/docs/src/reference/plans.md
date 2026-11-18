---
title: Plans and decisions
description: Current product plans, runtime contracts, acceptance evidence, and deferred work.
---

# Plans and decisions

This site explains the current operating model. Repository plans define exact
scope and acceptance. Specifications define runtime contracts. Dated evidence
records what a particular run proved.

## Active product map

| Document                                                                                                   | Scope and status                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `docs/plan-21-cafeos-ux-foundation.md`                                                                     | Accepted product language and Portal foundation                                          |
| `docs/plan-22-commerce-capabilities-and-storefront-demos.md` and `docs/plan-23-flavored-export-catalog.md` | Accepted café, pâtisserie, packaged-goods, and export commerce                           |
| `docs/plan-31B-supplier-and-purchasing-operations.md` and `docs/plan-47-connected-inventory-views.md`      | Purchasing and inventory operations                                                      |
| `docs/plan-33-merchant-configurable-production-checkout.md` and `docs/plan-33C-POS-systems.md`             | Checkout and Square counter sales; external release limits remain explicit               |
| `docs/plan-39-urk-merchant-agent-parity.md`                                                                | Failed-payment and delayed-order attention brief; mock-order acceptance passed           |
| `docs/plan-42-bakery-workflow-simulator.md` and `docs/plan-42B-mujoco-workcell-simulation.md`              | Accepted bounded orchestration, native cold-workcell simulation, and task-bound evidence |
| `docs/plan-42E-chat-canvas-parity.md` and `docs/plan-42F-general-orchestration.md`                         | Completed selected local control and shared orchestration scope                          |
| `docs/plan-42G-automatic-context-loading.md` and `docs/plan-42H-thread-forking.md`                         | Context loading accepted in production; fork file/release gates remain                   |
| `docs/plan-60A-bakery-equipment-models.md`                                                                 | Equipment models in progress                                                             |
| `docs/plan-61A-financier-workflow.md` through `docs/plan-61E-combined-cafe-shift.md`                       | Draft recipe preparation and combined service workflows                                  |
| `docs/plan-24-cafeos-bakery-automation.md`                                                                 | Planned physical enrollment, dispatch, and reconciliation                                |
| `docs/plan-40-product-description-drafting.md` and `docs/plan-40B-collaborative-menu-editor.md`            | Accepted product drafting and the proposed collaborative menu editor                     |
| `docs/plan-91-seams-atelier-rename.md`                                                                     | The Seams Pantry rename: display names, code names, and the names that stay              |

`docs/evidence/plan-42-release-readiness.md` separates accepted software,
deferred conveniences, broader release checks, and physical calibration.
Simulation and provider Sandbox acceptance do not establish physical readiness.

## Runtime and security

| Document                                                                                            | Owns                                                     |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `docs/plan-3-decisions.md`                                                                          | Current authority map and architectural decisions        |
| `docs/plan-14-actor-runtime-architecture.md` and `docs/plan-15.md`                                  | Actor ownership, recovery, and coordinated work          |
| `docs/architecture/runtime.md#harness-adapter`                                                      | Three pinned Codex/Pi inference authorities              |
| `docs/architecture/security.md#vault-policy-and-revocation` and `docs/runbooks/vault-operations.md` | Credential lifecycle and purpose-bound resolution        |
| `services/platform/src/policy/information-flow/README.md`                                           | Protected context, authorization, and output integration |
| `docs/commerce-domain-architecture.md` and `docs/commerce-monorepo.md`                              | Commerce contracts, authority, and source ownership      |

## Evidence and deferred work

Use `docs/evidence/` for dated acceptance artifacts and `docs/runbooks/` for
operator procedures. The E2E coverage guide is `test-coverage-e2e.md`.
`docs/blocked-deferred-tasks.md` records external blockers and deferred proposals.
Those proposals create no active implementation requirement.

The short Plan 48 withdrawal record remains the authority for its closed scope.
Historical completion records remain evidence; they do not override current plans.
