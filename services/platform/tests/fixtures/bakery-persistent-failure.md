# Persistent native failure fixture

`bakery-persistent-failure.json` is an actual Wasm save at 30 simulated seconds.
A weak clamp has dropped the first tray. The baker has just returned. The world
keeps its native failure state, carrier custody, recording packs, and checkpoint.

It comes from:

```sh
PLAN_70_BROWSER_BUNDLE=apps/portal/public/bakery-physics/bundles/64537e6670fb43b33de47c8f4667ea6c6abd256a2e074db8234c795f318cc37e \
  node scripts/production-simulation/verify-recovery-journey.mjs NEW_OUTPUT
```

Copy `NEW_OUTPUT/reference-failure-file.json` only after the recovery journey
passes. Keep the execution bundle named by the fixture in Portal assets.
The 11 October fixture uses execution `aad23dcaafa889f288780fe56fee45eab4180593d2e659854a74b119499273da`.
The fixture contains synthetic simulation data and no credentials.
