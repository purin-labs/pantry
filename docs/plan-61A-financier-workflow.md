# Plan 61A — Complete financier preparation and MuJoCo handling

Execution requirement: extend the [browser execution contract](plan-42B-mujoco-workcell-simulation.md#workflow-execution-contract).
Run supported physics through the shared Rust/MuJoCo Wasm worker and show results
in the existing Three.js views. Do not add a Python or standalone CLI recipe flow.
Browser integration and repeatable E2E evidence are required for recipe acceptance.

Status: **In progress. Preparation, operator inspection, quantities and shared save/reopen pass local acceptance. Native cold-carrier handling is built (A4, 24 October 2026). Complete intake, agent commands, native recipe views, deployment of shared saves and calibration remain pending.**
Created: 2026-10-05.
Depends on: [Plan 60A](plan-60A-bakery-equipment-models.md), financier equipment subset.

## Outcome

Simulate ingredients becoming saleable financiers through one BakeryOS run.
Include preparation, baking, demoulding, cleaning and packing. Bind a measured
mould or its carrier to a bounded cold MuJoCo handling sequence.

Use the [working financier recipe](recipes/financiers.md). Its successful result
does not confirm exact oven settings, bake duration, portion mass or total yield.

## Recipe boundary

- Weigh 180 g butter before browning. Record the resulting mass without topping it up.
- Mix 100 g almond flour, 100 g wheat flour and 195 g sugar with one flavour's
  mix-in in place of the vanilla: the shop's hazelnut, coffee, matcha or black
  sesame financier ([shop flavours](recipes/financiers.md#shop-flavours)).
  Each flavour is its own batch; clean the bowl between flavours.
- Add 180 g unwhipped egg whites, then the liquid browned butter.
- Use the eight-cavity Matsunaga mould and the stated 75–80% cavity fill depth.
- Start with one tray per bake. Record the actual oven, mode, setting and rack position.
- Treat 180°C conventional or 170°C convection as suggested settings awaiting confirmation.
- Treat 12–15 minutes as the first inspection window. Completion needs an explicit outcome.
- Cool in the mould for 2–3 minutes before demoulding.
- Keep the ten-minute crumb check separate from readiness for packaging.
- Add batter rest only when the selected recipe run includes it. No fixed 90-minute prerequisite applies.

Remove the 24-pieces-per-tray assumption from this recipe's definition. Derive
piece count from actual mould count, cavities filled and rejected pieces.
Multi-tray baking remains a separate, uncalibrated scenario until measured.

## Shared integration for Plans 61A–E

Use [Plan 70's shared production engine](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70A-production-engine.md) in
`packages/production-simulation`. Preserve [Plan 42F's accepted orchestration](plan-42F-general-orchestration.md)
through that owner. TypeScript owns the procedure, logical clock, resources and
accepted results. Extend the existing Rust controller for mechanical work.
The browser uses the shared Rust/MuJoCo build where supported.

Recipe adapters compile named recipes and resources into that engine. The complete
financier rehearsal already uses this boundary. Move remaining finishing-only
consumers to the complete recipe, then remove their replaced paths.
Do not add a general recipe language or another scheduler.

The [Plan 70 delivery ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70.md#current-delivery-ledger) owns shared-engine
priority. Its recurring two-cell campaign can proceed before recipe acceptance.
Plans 61A–E own recipe semantics and acceptance. The combined café shift follows
the four individual recipe journeys.

Required shared changes:

1. Represent pans, bowls, moulds and storage positions as distinct resource instances.
2. Reserve equipment for its full occupancy, including passive cooling and waiting.
3. Reserve workers for attended steps, transfers, inspection and cleaning.
4. Carry material identity, quantity, location and disposition through accepted steps.
5. Separate process observations or assumptions from accepted MuJoCo recordings.
6. Preserve those states through Stop, retry, save, reopen and reviewed recipe changes.

Normalize recipe inputs and saved records once at their boundaries. Use precise
domain unions for process, custody, cleanliness and acceptance states. Require
branch-specific evidence and identity. Use exhaustive switches and existing shared
helpers. Add static type fixtures for invalid combinations and broad-spread escapes
when changing these shared types. Recoverable failures use explicit result variants.

The native attempt fingerprint must include the recipe/workflow revision and
relevant material, tool, layout and predecessor state. A changed mould or payload
requires new preparation and evidence. Replaying a recording cannot settle a task.

Keep import conversion at persistence boundaries. Remove obsolete internal paths
as the shared adapter replaces them. Preserve existing access and information-flow
restrictions on saved runs, attached source material and replay.

## Workflow and evidence

| Stage                   | Resources and state                                   | Evidence boundary                                                  |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Weigh ingredients       | Worker, scale, bowls and ingredient quantities        | Timed manual work with recorded masses                             |
| Brown butter            | Worker, pan and hob                                   | Attended process, browned mass and observed completion             |
| Mix batter              | Worker, bowl, whisk and spatula                       | Manual process with retained residue and batter mass               |
| Prepare and fill moulds | Worker, moulds, scale and table                       | Cavity count, filled mass and mould identity                       |
| Preheat oven            | Oven                                                  | Explicit process prerequisite that can overlap preparation         |
| Load, inspect and bake  | Oven, mould/carrier and worker at handling/inspection | Thermal duration and completion remain recipe process evidence     |
| Cool and demould        | Mould, worker, wire grid and rack space               | Explicit demoulding and mould release                              |
| Cold handling           | Qualified carrier, tool, arm, source and destination  | Contact-based MuJoCo attempt after an explicit cold-ready boundary |
| Inspect and pack        | Worker, packing station and containers                | Accepted piece count, reject count and packaging release           |
| Wash and return         | Worker, sink and used smallwares                      | Cleaning completion makes resources available again                |

The first native skill carries a cold mould carrier or a cold finished-product
carrier between qualified supports. Select one profile during equipment intake.
Track its actual payload. An oven-access rehearsal uses a separately labeled cold
fixture and cannot provide the recipe's bake result.

Pouring butter, dispensing batter, robotic demoulding and hot robot handling remain
manual process steps in this increment. They require separate tooling and material
evidence before native execution can replace those steps.

## Implementation increments

These rows distinguish accepted rehearsal coverage from full recipe acceptance.
No complete A1–A6 gate is closed by the current rehearsals.

| Scope                    | Accepted coverage                                                                                                  | Remaining acceptance                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| A1 — Recipe intake       | Validated assumed masses, durations and named moulds; nominal equipment intake                                     | Complete mould/carrier geometry and operator intake for oven identity, observed masses and assumptions.                 |
| A2 — Shared resources    | Preparation, vessel occupancy, storage, cleaning and material dispositions in the shared engine                    | Connect these states to operator input and the accepted mechanical route.                                               |
| A3 — Complete production | Three-load rehearsal from weighing through packing, with operator decisions, retained lot identity and mould reuse | Complete observed process intake and native recipe handling.                                                            |
| A4 — Native handling     | Persistent cold `persistent-rack/1` carrier transfer bound to the complete financier recipe after `crumb-check` + `pack-ready`, with in-flight Wasm checkpoint restore and mould-profile validation ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-cold-carrier-handling.md)) | Physical geometry qualification and observed payload calibration. |
| A5 — Shared views        | Primary Recipes entry, operator decisions, quantities and shared task projections in the existing execution panel  | Deploy shared saves; complete agent commands and native recipe views.                                                   |
| A6 — Acceptance          | Headless and browser-worker rehearsal packets with mass balance and fresh-host restore                             | Complete the recipe journey below, including native handling and operator integration, with a portable evidence packet. |

### Implementation progress and remaining integration

The [11 October preparation increment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-ingredient-preparation.md)
implements a bounded part of A1/A2 on `dev`. Individual ingredient weighing,
butter browning, mixing, batter storage, cleaning and vessel return use the shared
engine. Two batches reuse one pan and bowl. Mass and custody survive interruption,
worker replacement and a full batter-storage buffer. Inputs and process outcomes
are explicit assumptions; the fragment produces intermediate batter only.
Its browser journey uses the existing retained execution worker through the
development preview. Recipe selection and editing in the operator workspace
remain open. This increment closes no complete A1–A6 gate.

The [three-load mould cycle](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-mould-cycle.md) now connects that
preparation to individual cavity filling, baking, assumed inspections, demoulding,
manual cleaning and packing. Two named moulds serve three loads. One rejected
load and one crumb sample leave 15 packed pieces with a complete mass balance.
One cooling grid delays the third load until packing releases it. Five fresh-host
reopen points match the browser results. Inspections are authored assumptions;
live observations, operator views and native cold handling remained open at that increment.

The [operator inspection increment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-operator-inspections.md)
replaces pre-authored accept/reject outcomes with commands during execution.
The primary Recipes entry prepares the complete financier run in the existing
execution panel. Bake and packing decisions bind to the definition, task, held
lots and control revision. The same panel shows recorded observations and quantities.
A browser reload and local file reopen preserve a pending inspection. Six
subsequent decisions produce 15 packed pieces, eight rejects and one sample.
Process masses and durations remain assumptions. This increment adds no native
recipe handling or shared cloud save. No complete A1–A6 gate is closed.

The [shared-save increment](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-shared-saves.md) now uses the existing
Platform archive and review panel. Local Workerd and browser journeys verify
lost-response recovery, viewer access, revocation and explicit continuation.
The shared copy remains immutable. Large native archives, persistent agent
commands and production deployment remain open. This closes the bounded
recipe save integration, without closing A4 or full A6 acceptance.

The current [financier adapter](../packages/production-simulation/src/recipes/bakery/financier.ts)
still includes a finishing rehearsal that starts with a `rested-batter` lot
measured in pieces. It creates one carrier for
each tray group. The [schedule](../packages/production-simulation/src/recipes/bakery/schedule.ts)
derives output from `piecesPerTray`. These are finishing-rehearsal inputs.
They do not establish preparation, ingredient mass, cavity occupancy or mould reuse.

Complete the remaining integration through the existing adapter and engine:

1. Complete operator intake for the selected oven program, recipe revision,
   observed masses and named moulds. Recipe selection, load count, grid count
   and bake duration already use the complete compiler. Keep observed inputs
   distinct from assumptions.
2. Deploy the accepted shared-save path and admit authorized persistent agent
   commands. Preserve its run, task, recipe revision, material binding and
   duplicate-command rules.
3. Connect the qualified cold carrier to the existing native route and recovery
   boundary. Preserve recipe mass, piece count and custody through each attempt.
4. Connect recipe handling to the existing synchronized native views.
   Remove the superseded finishing path when its consumers use the complete recipe.

Retain the implemented cavity counts, `milligram` balances and mould occupancy
through filling, baking, cooling and demoulding. Cleaning remains a prerequisite
for mould reuse. Extend those behaviors without adding parallel quantity state.

Reuse the engine's lots, resource claims, storage positions and command receipts.
Extend the existing command and persistence boundaries for recipe observations.
Do not introduce another scheduler or a separate recipe execution service.
Cooking observations remain separate from Rust/MuJoCo mechanical evidence.

Use this deterministic mass example for the first synthetic acceptance fixture.
All quantities except the working formula are **test assumptions**. This example
does not establish a usable portion mass, yield, bake loss or packaging criterion.
The example uses the hazelnut financier: 40 g of the almond flour becomes
roasted hazelnut flour, plus 20 g chopped roasted hazelnut.

| Boundary     | Test input or result                       | Retained or exiting quantity           |
| ------------ | ------------------------------------------ | -------------------------------------- |
| Weigh        | Hazelnut formula                           | 775 g total ingredients                |
| Brown butter | 180 g becomes 158 g                        | 22 g evaporation                       |
| Mix          | 753 g enters the bowl                      | 745 g batter and 8 g residue           |
| Fill         | Three loads, each with eight 25 g portions | 600 g filled and 145 g retained batter |
| Bake         | Each 200 g load becomes 188 g              | 564 g baked and 36 g evaporation       |
| Inspect      | Reject the middle eight-piece load         | 188 g rejected and 376 g accepted      |
| Crumb check  | Remove one assumed 23.5 g piece            | 23.5 g inspection sample               |
| Pack         | Release the remaining accepted pieces      | 15 pieces, 352.5 g                     |

The final mass balance is 775 g: 352.5 g packed, 188 g rejected, 23.5 g sampled,
145 g retained, 8 g residue and 58 g evaporation. Piece counts reconcile as
24 baked, eight rejected, one sampled and 15 packed. Measurement difference and
spill are explicitly zero in this fixture. Use two mould instances across the
three loads. Reuse the first mould only after demoulding and cleaning.

Geometry intake and cold-carrier qualification remain open. Keep the existing
cold oven proxy labelled as a rehearsal until the selected mould/carrier passes
the required fit, payload and native-attempt checks. No increment is closed by
this implementation outline.

The [11 October mould intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/matsunaga-financier-8p/README.md) records
the manufacturer's current nominal dimensions and manual-care instructions.
The preliminary footprint fits the existing carrier model. Exact geometry,
loaded stability and native handling remain unverified. Use explicit assumptions
for the synthetic journey; preserve physical calibration as a separate gate.
Mould cleaning uses the manual-care route. The current references establish no
Winterhalter cycle for this coated mould.

## Acceptance journey

Use at least three baking loads and two reusable eight-cavity moulds. Configure
one hob, one oven, limited wire-grid space and an explicit worker count.

1. Delay oven readiness after batter preparation starts.
2. Bake one tray at a time and require inspection before bake completion.
3. Reject one tray through an explicit simulated inspection result.
4. Demould, clean and reuse a mould for a later load.
5. Interrupt a cold native transfer after pickup, then resume its checkpoint.
6. Attempt to accept evidence prepared for a different mould profile and reject it.
7. Save and reopen the run before completing packing.

Verify that accepted, rejected, retained and lost quantities reconcile at each
boundary. Include evaporation and an explicit measurement difference where needed.
No rejected pieces enter saleable output. No mould is refilled before release.
No worker or equipment instance occupies two exclusive tasks simultaneously.
The delayed oven and native interruption must propagate to affected completion times.

Use real native/browser execution for mechanical steps and explicit synthetic
process observations for cooking. Do not imply that synthetic inspection proves quality.

## Verification and closure

Extend existing E2E journeys without adding unit tests. Run relevant type checks,
the portal build and native/browser acceptance for changed execution paths.
Changes to source admission also require IFC boundary lint and an allowed/denied journey.

Retain the scenario, recipe revision, assumed/measured inputs, native requests,
checkpoints, recordings, accepted run, quantity report and browser screenshots.
Store each campaign under `output/acceptance/plan-61A/` in a new directory.
Add a durable `docs/evidence/` report with exact commands and expected outcomes.

Close software acceptance when a fresh process can reproduce and reopen this
journey. Record physical calibration as a separate pending gate until observed
production data supports the timings, payload and release criteria.
