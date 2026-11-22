# Handoff: Kitchen appliances, 3D stations and appliance preview, 18 November 2026

This file records the state of [Plan 60A](../history/plan-60A-bakery-equipment-models.md), the 24-appliance Portal inspector and the 3D station bindings in `~/Dev/purin-labs/pantry` after the [Plan 92](../history/plan-92-new-pantry-repository.md) cutover.

## Result

All 24 Kitchen and Café appliances pass Blender 5.2 visual checks, MuJoCo 3.x and 4.0 physics checks, `pnpm portal:build`, all 25 `@seams/portal` Node 24 tests, and the five Kitchen 3D browser journeys in `~/Dev/purin-labs/pantry`. Only physical shop calibration waits.

## What is in `pantry`

- **24 polished 3D and MuJoCo packages (`assets/bakery-mujoco/`).** Every package keeps 1:1 meter scale, manifold visual meshes, calibrated MuJoCo inertia and joints, inspection reports, and Cycles `AgX` softbox renders in R2 (`repo-binaries.json`). The latest pass rebuilt `hitachi-r-hws47xl`, `hoshizaki-rt-120snj`, `maruzen-mbco-4me`, `option-o-lagom-casa`, `vitamix-quiet-one` and `waring-wsg60`, and added `victoria-arduino-e1-prima`.
- **Shared Blender 5.2 build helpers (`scripts/bakery-mujoco/`).** `appliance_surface_kit.py` builds shared brushed-metal textures, ORM maps, planar decal sheets and softbox studio lights. `victoria_arduino_kit.py` builds shared Eagle-family profiles and hardware.
- **24-appliance Portal inspector (`apps/portal/src/dev/`).** `appliances-preview-catalog.ts` (`APPLIANCE_CATALOG`) and `appliances-preview.tsx` (`apps/portal/appliances-preview.html`) load all 24 models in Single 3D Lab, 1:1 Scale Lineup and Studio Sheet views.
- **3D Kitchen station and mixer bindings (`apps/portal/src/features/`).**
  - `workflow-simulator/spatial/factory-stations.ts` (`loadStation`) binds internal GLB child nodes (`kpl_planetary`, `kpl_whip`, `kpl_finger_guard`, `wsg_cover`, `wsg_blade`, `tqo_enclosure_door`, `tqo_blade`, `mbco4_door`, `mbco4_fan`, `ucl_door`, `ucl_wash_rack`, `casa_burr_cone`, `sm3587_stirrer` and `ranger_weighing_pan`) instead of nine standalone accessory GLBs.
  - `production-run/financier-batter/financier-batter-scene.ts` (`FinancierBatterScene`) binds the Kenmix `KPL9000S` nodes and sizes the procedural batter mesh to fit inside the 6.7 L bowl.
- **Node 24 native TypeScript relative imports (`packages/control-api` and `packages/commerce-query-sqlite`).** Relative `.ts` specifiers in `packages/control-api/src/` (33 files) and `packages/commerce-query-sqlite/src/` (2 files) keep explicit `.ts` extensions so plain Node 24 tests such as `apps/portal/src/features/workflow-simulator/schedule.test.mjs` load `@seams/control-api` without a bundler.

## Verified on 19 November 2026

- `pnpm --filter @seams/portal test`: 25 of 25 Node 24 tests pass.
- `pnpm lint:appliance-registry`, `pnpm lint:physics-bundle`, and all 247 SHA-256 digests in `assets/bakery-mujoco/fr10-workcell/native/assets.json` match after `node scripts/repo-binaries.mjs fetch`.
- Browser journeys (`node scripts/production-simulation/run-journeys.mjs`): `scene-host-browser` (33.9 s), `scene-lighting-browser` (20.1 s), `cafe-shift-grinders-browser` (17.9 s), `live-appliance-move-browser` (35.6 s) and `recipe-workflow-browser` (165.9 s, all eight recipes including `financier-batter`) pass on WebGL (`5 passed, 0 failed` in 273.4 s).

## Remaining work

1. **Physical hardware calibration and cobot load qualification (deferred).** Real-shop thermal, acoustic and cobot payload calibration under [Plan 60A](../history/plan-60A-bakery-equipment-models.md) and [Plan 24](../plan-24-cafeos-bakery-automation.md) wait until physical shop hardware is on site.
2. **Keep pinned workcell files unchanged during future R2 cleanups.** If a future cleanup changes or removes files under `assets/bakery-mujoco/`, keep every path listed in `assets/bakery-mujoco/fr10-workcell/native/assets.json` byte-identical unless you regenerate and re-pin the workcell trajectories.
