# Refactor 16 — Step 15 Evidence (Parts 15B and 15C)

Date: 2026-11-27
Branch: `refactor-16-step-15-appliance-reports` (from `origin/dev` at `a51078bb`)
Pinned runtime bundle: `468e95da77e3e1c4c1586f4c74b8a4a5b8cf8c3d5332ec65a52988db71f2a017`
Pinned execution bundle: `5bf61fd606c468c8d9237738d76c325bfd3bdbea4d9f579df119c7406a3d0867`

## 1. Step 15C — Appliance Work as Data and File Split

### 1.1 Replaced 21 repeated recipe functions with one data table

Removed `*ApplianceTask`, `*ApplianceTasks`, and `execute*ApplianceTasks` from:

- `packages/production-simulation/src/recipes/bakery/financier.ts` -> `FINANCIER_APPLIANCE_ROWS`
- `packages/production-simulation/src/recipes/bakery/pie.ts` -> `PIE_APPLIANCE_ROWS`
- `packages/production-simulation/src/recipes/bakery/black-sesame-milk.ts` -> `BLACK_SESAME_APPLIANCE_ROWS` (Plan 61B kept unchanged on hold)
- `packages/production-simulation/src/recipes/bakery/tea.ts` -> `GINGER_BLACK_TEA_APPLIANCE_ROWS`, `GINGER_MILK_TEA_APPLIANCE_ROWS`, `TEA_APPLIANCE_ROWS`
- `packages/production-simulation/src/recipes/bakery/espresso.ts` -> `ESPRESSO_APPLIANCE_ROWS`
- `packages/production-simulation/src/recipes/bakery/pour-over.ts` -> `POUR_OVER_APPLIANCE_ROWS`
- `packages/production-simulation/src/recipes/bakery/bakery-shift.ts` (removed morning-shift wrappers)

One shared table (`packages/production-simulation/src/recipes/bakery/appliance-task-table.ts`) merges all recipe rows (`RECIPE_APPLIANCE_ROWS`) with canonical task-kind rows (`CANONICAL_APPLIANCE_ROWS`) for Plan 84 canvas-edited and custom workflows, exposing `resolveApplianceTaskRow`, `resolveApplianceTaskKind`, `recipeApplianceTask`, and `recipeApplianceTasks` feeding `executeRecipeApplianceTasks`.

`packages/bakery-workflow/src/index.ts` exposes `workflowNodeApplianceTaskKind`, `workflowApplianceTaskKinds`, and `type ApplianceTaskKind` backed by the same resolver.

### 1.2 File size and clone reductions

| File                                                                        | Before (lines) | After (lines) | Notes                                                                                            |
| --------------------------------------------------------------------------- | -------------: | ------------: | ------------------------------------------------------------------------------------------------ |
| `packages/production-simulation/src/recipes/bakery/appliance-execution.ts`  |          3,815 |         1,729 | Removed from `scripts/file-size-ratchet.json`; self-clone removed via `finalizeApplianceAttempt` |
| `packages/production-simulation/src/recipes/bakery/appliance-telemetry.ts`  |              — |         2,498 | Extracted coupled telemetry, acoustic, mass accounting, inspection gates, and facility utilities |
| `packages/production-simulation/src/recipes/bakery/appliance-task-table.ts` |              — |           701 | Unified declarative table and task builder                                                       |
| `areas/kitchen/ui/features/production-run/morning-shift-appliances.ts`      |          3,681 |         3,664 | Deduplicated task lookup via `recipe-appliance-report.ts` (-17 lines after formatting)           |

Ratchet deltas:

- `scripts/file-size-ratchet.json`: 13 -> 12 files over 3,000 lines (`appliance-execution.ts` removed, `morning-shift-appliances.ts` lowered).
- `scripts/clones-ratchet.json`: 736 copies (12,808 lines) -> 734 copies (12,774 lines), 0 new clones.
- `scripts/unused-ratchet.json`: package entry exports with no importer fell cleanly after removing the 21 recipe functions.

### 1.3 Bit-for-bit parity across all seven recipe families

Ran `node scripts/production-simulation/verify-recipe-appliance-wasm.mjs` before and after refactoring and compared all 7 JSON report files with `diff -ru`:

- `diff -ru /tmp/r16-s15-before /tmp/r16-s15-after`: **0 bytes difference** across:
  - Plan 61A Financier: 28 tasks, 6 appliances
  - Plan 61B Black Sesame Milk: 26 tasks, 8 appliances
  - Plan 61C Ginger Black Tea: 12 tasks, 3 appliances
  - Plan 61D Ginger Milk Tea: 23 tasks, 3 appliances
  - Plan 61E Morning Shift: 291 tasks, 12 appliances
  - Plan 61E Fault & Checkpoint-Restore: 5 faults, 5 cascades, 291 shift tasks

Ran `node scripts/production-simulation/verify-canvas-appliance-report.mjs` (65.8 s) covering the remaining three standalone recipe families plus Plan 84 canvas recipes:

| Journey case                                    | Tasks | Appliances | Key verification                                                                                                                                                                 |
| ----------------------------------------------- | ----: | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone Pie                                  |    41 |          7 | `weigh`, `mixer`, `hob`, `chiller`, `pastry-bench`, `oven`, `dishwasher`                                                                                                         |
| Standalone Espresso (Linea)                     |     1 |          1 | `la-marzocco-linea-classic-s-2g` (`d0d6ae60`)                                                                                                                                    |
| Standalone Espresso (Eagle One)                 |     1 |          1 | `victoria-arduino-eagle-one-2g` (`08881a5f`)                                                                                                                                     |
| Standalone Pour-Over workflow                   |     4 |          4 | `weigh`, `grinder`, `hob`, `dishwasher`                                                                                                                                          |
| Plan 84 Canvas-Edited Financier                 |    29 |          6 | Edited `brown-butter` (360 s), added wait + duplicate `bake-2` (`load-hazelnut-a#0/bake-2`); `load-hazelnut-b#0/bake` marked at risk while schedule task stayed `completed` (D3) |
| Custom Canvas Workflow (`canvas-tasting-batch`) |     5 |          5 | Non-built-in workflow id mapped via canonical task kinds (`weigh`, `planetary-mix`, `oven-bake`, `chiller`, `dishwasher`)                                                        |

## 2. Step 15B — Portal Kitchen Run View Appliance Physics Report

### 2.1 Implementation

- `areas/kitchen/ui/features/production-run/recipe-appliance-report.ts`: runs recipe appliance checks on a dedicated background `ExecutionWorker` via `{ kind: "appliance-run", file }` (resetting every 15 tasks without re-fetching model packs), leaving the primary execution worker responsive for Save, History, and Controls.
- `areas/kitchen/ui/features/production-run/appliance-physics-report.tsx`: renders the **Appliance physics report** in `ProductionResults` (check count, appliance count, at-risk count, peak draw, first-pass yield, at-risk callout with gate telemetry, and per-task check table with checkpoint digests).
- Propagated `atRisk` across `OvenWorkspace`, `ProductionResults`, `ProductionOverview` / `ProductionActivityTrace`, `OvenLogistics`, `SelectedOvenTask` (Inspector), `OvenTaskViews` (Workflow cards + Timeline tracks), and the top summary pill.
- Enforced D3: a failed appliance check marks its task as **At risk** (`data-at-risk="true"`) while the schedule task remains `completed` (`data-kind="completed"`).

### 2.2 Browser verification

Ran `scripts/production-simulation/verify-appliance-report-browser.js` against the live Portal Kitchen page (`factory-acceptance.html`, WebGL, 20.0 s):

- Completed a 2-load Financier run through the Wasm execution worker (`6680.000 s`).
- Verified the automatic MuJoCo appliance physics report rendered in **Results**: `28 checks`, `6 appliances`, `2 at risk` (`hazelnut-preparation-batches#0/store-batter` chiller exit `23.848 °C` vs `2.0..18.0 °C`; `load-hazelnut-b#0/bake` middle-rear hotspot Maillard `0.4823` vs `0.015..0.350`), peak draw `9490 W`, first-pass yield `46.7%`.
- Verified `load-hazelnut-b#0/bake` stayed `completed` while displaying `At risk` in Results, Logistics Task activity trace, Logistics task table, Inspector (`SelectedOvenTask`), Workflow cards, Timeline tracks, and the summary pill.
- Visually inspected all rendered screenshots.
