# Specs

A spec describes what is built, for one subsystem. A plan describes work that is not
built. [Refactor 17](../refactor-17.md) gives the rules and the reasons.

State on 2026-11-22: step S2 of Refactor 17 has started. A written spec is the
reference for its subsystem, and its source plans are in `docs/history/`. Until a spec
exists, its source documents are the reference.

How a spec is accepted: a writer makes it from its source plans and the code. A second
reader checks each statement against the code, and the writer corrects each fault.
Then `node scripts/move-plan-to-history.mjs <plan>` moves each source plan unchanged to
`docs/history/` and corrects the links to it.

## The layers

```text
surfaces/     portal · slack · email · whatsapp · webhooks · storefront · shop · voice · docs-site
areas/        commerce · cafe · kitchen · inbox · brain · integrations · devices · organisation
foundation/   std · kernel · contracts · tenancy · actor-runtime · authority · connections
              control · agent-tools · agent · conversation · collaboration · ui · testing
```

An import may only go down. `pnpm lint:layers` checks it. `scripts/layers.json` gives
each source file its module.

## How to name a document

- A spec has an id: the code of its folder and its number in the folder, for example
  `KIT-03`. A number is never used again. A new spec takes the next number.
- A new comment in code names a spec id.
- An old comment names a plan number. The table below gives its spec.
  `pnpm lint:plan-numbers` fails when code names a number that the table lacks.
- New work gets a plan in `docs/` with the next number: Plan 97, or Refactor 18.
  When the work is in production, its content goes into a spec.

## The specs

| Id | Spec | Folder | Written from | State |
| --- | --- | --- | --- | --- |
| FND-01 | Tenancy and placement | `foundation/` | `architecture/runtime.md` (data model, placement), Refactor 12, `economics-costs.md` | Not written |
| FND-02 | Actor runtime | `foundation/` | Plan 14, `architecture/runtime.md` (platform layout, actors) | Not written |
| FND-03 | Cases, Sessions and conversations | `foundation/` | Plans 15, 42H and 74, Refactor 9, `architecture/runtime.md` (Case coordination, cues) | Not written |
| FND-04 | Agent harness and model routes | `foundation/` | Plans 28, 73 and 75, `architecture/runtime.md` (harness adapter) | Not written |
| FND-05 | Messages, attachments and context | `foundation/` | Plans 37 and 42G | Not written |
| FND-06 | Identity, policy and approval | `foundation/` | `architecture/security.md` | Not written |
| FND-07 | Information flow | `foundation/` | Plans 27, 27C and 89 | Not written |
| FND-08 | Vault | `foundation/` | Plans 12 and 79 | Not written |
| FND-09 | Agent tools and screen context | `foundation/` | Plans 81 and 87 | Not written |
| FND-10 | Shared drafts | `foundation/` | Plans 40 and 40C | Not written |
| FND-11 | Contracts | `foundation/` | Plan 78 | Not written |
| COM-01 | Commerce domain | `areas/commerce/` | `commerce-domain-architecture.md`, `commerce-monorepo.md`, Plan 22 | Not written |
| COM-02 | Commerce engine | `areas/commerce/` | Plans 76, 76A, 77 and 80 | Not written |
| COM-03 | Providers and the read layer | `areas/commerce/` | Plans 9 and 47, `integrations/shopify.md` | Not written |
| COM-04 | Checkout and payments | `areas/commerce/` | Plans 33, 33C and 33D | Not written |
| COM-05 | Merchant operations | `areas/commerce/` | Plans 16, 23, 31B and 39 | Not written |
| CAFE-01 | Menus, boards and the order queue | `areas/cafe/` | Plan 40B | Not written |
| KIT-01 | Orchestration views | `areas/kitchen/` | Plans 42, 42E and 42F | Not written |
| KIT-02 | Physics and equipment models | `areas/kitchen/` | Plans 42B and 60A, the calibration worksheet | Not written |
| KIT-03 | Recipe workflows | `areas/kitchen/` | Plans 61A, 61E and 84, `workflow-canvas-design-profile.md` | Not written |
| KIT-04 | Costs and margins | `areas/kitchen/` | Plan 86 | Not written |
| INB-01 | One Inbox | `areas/inbox/` | Plan 83 | Not written |
| BRN-01 | Brain | `areas/brain/` | Plans 42J and 42K | Not written |
| INT-01 | Integrations and connectors | `areas/integrations/` | `architecture/integrations.md`, `integrations/google-oauth.md` | Not written |
| DEV-01 | [Devices](areas/devices/01-devices.md) | `areas/devices/` | Plan 85 | Written 2026-11-22 |
| ORG-01 | Onboarding and lifecycle | `areas/organisation/` | `architecture/onboarding.md`, `organisation-setup-flow.md` | Not written |
| ORG-02 | Jev from Seams | `areas/organisation/` | Plan 88 | Not written |
| PRT-01 | The Portal | `surfaces/portal/` | Plan 21, `portal-ui-inventory.md`, `style-guide.md` | Not written |
| VOX-01 | Voice control | `surfaces/voice/` | Plans 82 and 82C, the voice handover | Not written |
| ENG-01 | Decision log | `engineering/` | Plan 3 | Not written |
| ENG-02 | Code and repository | `engineering/` | `code-style.md`, Refactor 10, Plan 92 | Not written |
| ENG-03 | Names | `engineering/` | Plan 91, the names table of `AGENTS.md` | Not written |
| ENG-04 | Testing | `engineering/` | `test-coverage-e2e.md` | Not written |

## Old plan numbers

"Mentions" is the count in source code on 2026-11-20. A row with "The archive" names a
plan that is only in
[the archive](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs).
Refactors 1 to 8 are also the numbers of the items of Refactor 15.

| Old number | Now | Document | Mentions |
| --- | --- | --- | ---: |
| Plan 3 | ENG-01 | [plan-3-decisions.md](../plan-3-decisions.md) | 0 |
| Plan 9 | COM-03 | [plan-9-commerce-lifecycle-lab.md](../plan-9-commerce-lifecycle-lab.md) | 0 |
| Plan 12 | FND-08 | [plan-12-policy-governed-harness-secrets-vault.md](../plan-12-policy-governed-harness-secrets-vault.md) | 5 |
| Plan 13 | The archive | — | 4 |
| Plan 14 | FND-02 | [plan-14-actor-runtime-architecture.md](../plan-14-actor-runtime-architecture.md) | 0 |
| Plan 15 | FND-03 | [plan-15.md](../plan-15.md) | 6 |
| Plan 16 | COM-05 | [plan-16-merchant-console-commerce-operations.md](../plan-16-merchant-console-commerce-operations.md) | 3 |
| Plan 19 | The archive | — | 7 |
| Plan 21 | PRT-01 | [plan-21-cafeos-ux-foundation.md](../plan-21-cafeos-ux-foundation.md) | 21 |
| Plan 22 | COM-01 | [plan-22-commerce-capabilities-and-storefront-demos.md](../plan-22-commerce-capabilities-and-storefront-demos.md) | 10 |
| Plan 23 | COM-05 | [plan-23-flavored-export-catalog.md](../plan-23-flavored-export-catalog.md) | 4 |
| Plan 24 | A plan | [plan-24-cafeos-bakery-automation.md](../plan-24-cafeos-bakery-automation.md) | 6 |
| Plan 25 | The archive | — | 31 |
| Plan 25B | The archive | — | 7 |
| Plan 27 | FND-07 | [plan-27-ifc.md](../plan-27-ifc.md) | 0 |
| Plan 27B | The archive | — | 1 |
| Plan 27C | FND-07 | [plan-27C-simple-information-flow.md](../plan-27C-simple-information-flow.md) | 50 |
| Plan 28 | FND-04 | [plan-28-organisation-codex-oauth.md](../plan-28-organisation-codex-oauth.md) | 0 |
| Plan 29 | The archive | — | 1 |
| Plan 30 | The archive | — | 11 |
| Plan 31 | The archive | — | 3 |
| Plan 31B | COM-05 | [plan-31B-supplier-and-purchasing-operations.md](../plan-31B-supplier-and-purchasing-operations.md) | 0 |
| Plan 32 | The archive | — | 10 |
| Plan 33 | COM-04 | [plan-33-merchant-configurable-production-checkout.md](../plan-33-merchant-configurable-production-checkout.md) | 17 |
| Plan 33C | COM-04 | [plan-33C-POS-systems.md](../plan-33C-POS-systems.md) | 2 |
| Plan 33D | COM-04 | [plan-33D-square-release-acceptance.md](../plan-33D-square-release-acceptance.md) | 0 |
| Plan 34 | The archive | — | 2 |
| Plan 35 | The archive | — | 3 |
| Plan 35B | The archive | — | 1 |
| Plan 37 | FND-05 | [plan-37-typed-messages-and-attachments.md](../plan-37-typed-messages-and-attachments.md) | 16 |
| Plan 39 | COM-05 | [plan-39-urk-merchant-agent-parity.md](../plan-39-urk-merchant-agent-parity.md) | 2 |
| Plan 40 | FND-10 | [plan-40-product-description-drafting.md](../plan-40-product-description-drafting.md) | 38 |
| Plan 40B | CAFE-01 | [plan-40B-collaborative-menu-editor.md](../plan-40B-collaborative-menu-editor.md) | 291 |
| Plan 40C | FND-10 | [plan-40C-multiplayer-module.md](../plan-40C-multiplayer-module.md) | 4 |
| Plan 40D | The archive | — | 43 |
| Plan 41 | The archive | — | 2 |
| Plan 42 | KIT-01 | [plan-42-bakery-workflow-simulator.md](../plan-42-bakery-workflow-simulator.md) | 5 |
| Plan 42B | KIT-02 | [plan-42B-mujoco-workcell-simulation.md](../plan-42B-mujoco-workcell-simulation.md) | 0 |
| Plan 42C | The archive | — | 2 |
| Plan 42D | The archive | — | 7 |
| Plan 42E | KIT-01 | [plan-42E-chat-canvas-parity.md](../plan-42E-chat-canvas-parity.md) | 2 |
| Plan 42F | KIT-01 | [plan-42F-general-orchestration.md](../plan-42F-general-orchestration.md) | 14 |
| Plan 42G | FND-05 | [plan-42G-automatic-context-loading.md](../plan-42G-automatic-context-loading.md) | 1 |
| Plan 42H | FND-03 | [plan-42H-thread-forking.md](../plan-42H-thread-forking.md) | 0 |
| Plan 42J | BRN-01 | [plan-42J-brain.md](../plan-42J-brain.md) | 28 |
| Plan 42K | BRN-01 | [plan-42K-brain-ui.md](../plan-42K-brain-ui.md) | 0 |
| Plan 46 | The archive | — | 4 |
| Plan 47 | COM-03 | [plan-47-connected-inventory-views.md](../plan-47-connected-inventory-views.md) | 1 |
| Plan 48 | The archive | — | 1 |
| Plan 50 | The archive | — | 32 |
| Plan 50A | The archive | — | 10 |
| Plan 52 | The archive | — | 2 |
| Plan 53 | The archive | — | 21 |
| Plan 54 | The archive | — | 5 |
| Plan 54B | The archive | — | 1 |
| Plan 55 | The archive | — | 9 |
| Plan 55C | The archive | — | 2 |
| Plan 55F | The archive | — | 6 |
| Plan 56 | The archive | — | 5 |
| Plan 57 | The archive | — | 1 |
| Plan 60A | KIT-02 | [plan-60A-bakery-equipment-models.md](../plan-60A-bakery-equipment-models.md) | 4 |
| Plan 61 | The archive | — | 1 |
| Plan 61A | KIT-03 | [plan-61A-financier-workflow.md](../plan-61A-financier-workflow.md) | 16 |
| Plan 61B | The archive | — | 6 |
| Plan 61C | The archive | — | 17 |
| Plan 61D | The archive | — | 17 |
| Plan 61E | KIT-03 | [plan-61E-combined-cafe-shift.md](../plan-61E-combined-cafe-shift.md) | 28 |
| Plan 70 | The archive | — | 36 |
| Plan 70B | The archive | — | 6 |
| Plan 70C | The archive | — | 3 |
| Plan 70E | The archive | — | 2 |
| Plan 71 | The archive | — | 24 |
| Plan 72 | The archive | — | 10 |
| Plan 73 | FND-04 | [plan-73-model-exit-worker.md](../plan-73-model-exit-worker.md) | 20 |
| Plan 74 | FND-03 | [plan-74-side-cases.md](../plan-74-side-cases.md) | 67 |
| Plan 74B | The archive | — | 19 |
| Plan 75 | FND-04 | [plan-75-chatgpt-exit-container.md](../plan-75-chatgpt-exit-container.md) | 13 |
| Plan 76 | COM-02 | [plan-76-standalone-underclerk.md](../plan-76-standalone-underclerk.md) | 71 |
| Plan 76A | COM-02 | [plan-76A-shopify-parity.md](../plan-76A-shopify-parity.md) | 33 |
| Plan 77 | COM-02 | [plan-77-underclerk-modular-core.md](../plan-77-underclerk-modular-core.md) | 132 |
| Plan 78 | FND-11 | [plan-78-contracts-in-typescript.md](../plan-78-contracts-in-typescript.md) | 155 |
| Plan 79 | FND-08 | [plan-79-agent-vault.md](../plan-79-agent-vault.md) | 19 |
| Plan 80 | COM-02 | [plan-80-underclerk-multi-tenant-backend.md](../plan-80-underclerk-multi-tenant-backend.md) | 85 |
| Plan 81 | FND-09 | [plan-81-agent-portal-control.md](../plan-81-agent-portal-control.md) | 51 |
| Plan 82 | VOX-01 | [plan-82-portal-voice-control.md](../plan-82-portal-voice-control.md) | 68 |
| Plan 82B | A plan | [plan-82B-ambient-voice.md](../plan-82B-ambient-voice.md) | 0 |
| Plan 82C | VOX-01 | [plan-82C-speech-engines.md](../plan-82C-speech-engines.md) | 68 |
| Plan 83 | INB-01 | [plan-83-one-inbox.md](../plan-83-one-inbox.md) | 18 |
| Plan 84 | KIT-03 | [plan-84-general-workflow-canvas.md](../plan-84-general-workflow-canvas.md) | 32 |
| Plan 85 | DEV-01 | [plan-85-device-fleet-page.md](../history/plan-85-device-fleet-page.md) | 29 |
| Plan 86 | KIT-04 | [plan-86-bakery-costs-and-margins.md](../plan-86-bakery-costs-and-margins.md) | 9 |
| Plan 87 | FND-09 | [plan-87-screen-context.md](../plan-87-screen-context.md) | 89 |
| Plan 88 | ORG-02 | [plan-88-satyr-funded-jev.md](../plan-88-satyr-funded-jev.md) | 65 |
| Plan 89 | FND-07 | [plan-89-outside-written-content.md](../plan-89-outside-written-content.md) | 32 |
| Plan 90 | A plan | [plan-90-cafe-pos-checkout.md](../plan-90-cafe-pos-checkout.md) | 15 |
| Plan 91 | ENG-03 | [plan-91-seams-atelier-rename.md](../plan-91-seams-atelier-rename.md) | 39 |
| Plan 92 | ENG-02 | [plan-92-new-pantry-repository.md](../plan-92-new-pantry-repository.md) | 12 |
| Plan 93 | A plan | [plan-93-clean-cutover.md](../plan-93-clean-cutover.md) | 6 |
| Plan 94 | A plan | [plan-94-purin-labs-organisation.md](../plan-94-purin-labs-organisation.md) | 4 |
| Plan 95 | A plan | [plan-95-pantry-own-accounts.md](../plan-95-pantry-own-accounts.md) | 0 |
| Plan 96 | A plan | [plan-96-gemini-models.md](../plan-96-gemini-models.md) | 0 |
| Refactor 1 | The archive | — | 6 |
| Refactor 2 | The archive | — | 5 |
| Refactor 3 | The archive | — | 11 |
| Refactor 5 | The archive | — | 15 |
| Refactor 6 | The archive | — | 8 |
| Refactor 7 | The archive | — | 7 |
| Refactor 8 | The archive | — | 4 |
| Refactor 9 | FND-03 | [refactor-9.md](../refactor-9.md) | 39 |
| Refactor 10 | ENG-02 | [refactor-10.md](../refactor-10.md) | 38 |
| Refactor 11 | The archive | — | 11 |
| Refactor 12 | FND-01 | [refactor-12.md](../refactor-12.md) | 10 |
| Refactor 13 | The archive | — | 4 |
| Refactor 14 | The archive | — | 5 |
| Refactor 15 | The archive | — | 163 |
| Refactor 16 | A plan | [refactor-16.md](../refactor-16.md) | 92 |
| Refactor 17 | A plan | [refactor-17.md](../refactor-17.md) | 0 |
