# Plan 61E — Combined preparation and café service shift

Execution requirement: extend the [browser execution contract](plan-42B-mujoco-workcell-simulation.md#workflow-execution-contract).
Run supported physics through the shared Rust/MuJoCo Wasm worker and show results
in the existing Three.js views. Do not add a Python or standalone CLI recipe flow.
Browser integration and repeatable E2E evidence are required for recipe acceptance.

Status: **The bounded financier/espresso shift is released and production-verified. The full four-recipe morning shift (E1–E5) is implemented and Wasm-verified ([evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-morning-shift.md)). Physical calibration and unattended server execution remain separate increments.** Since 2026-10-30 the baseline is the [optimised shift](#baseline-scenario-the-optimised-shift): day-before mise en place, barista and baker roles and order priority serve all 20 drink orders within 900 s.
Created: 2026-10-05.

The [six-hour evidence correction](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-six-hour-evidence.md)
records the explicit six-hour preset, accepted inventory receipts, stock-driven
replenishment dispatch (`close-arrivals`), cross-shift stock carryover, measured
resource use, and trace paths. Its local acceptance replaces the earlier
synthetic percentile and trace scores. Physical calibration remains open.

Depends on: [60A equipment](plan-60A-bakery-equipment-models.md),
[61A financiers](plan-61A-financier-workflow.md),
[61B sesame milk](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61B-black-sesame-milk-workflow.md),
[61C black tea](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61C-ginger-black-tea-workflow.md) and
[61D milk tea](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61D-ginger-milk-tea-workflow.md).

## First increment — financiers and espresso

The user authorized a small combined café demonstration on 18 October 2026.
This increment uses one financier load and two espresso orders by default.
A bakery worker and a dedicated barista operate independently under one logical clock.
The second worker is a simulated resource. No second user login is required.

The existing financier recipe provides ingredient quantities, transfers, bake review,
cooling, a sampled piece, packing review and clean-up. These process durations remain assumed.
The selected Linea Classic S or Eagle One executes espresso through the shared Rust/MuJoCo controller.
The machine starts preheated. No new grinder or coffee preparation model belongs to this increment.

Reuse the current persistent engine, portable saves, shared archive and restored execution hosts.
A saved run preserves orders, material quantities, resource occupancy, quality decisions and native checkpoints.
A closed browser does not continue computation automatically. Continuation starts when a saved run reopens.
This increment does not introduce an unattended server daemon.

Acceptance compares uninterrupted execution with a new native process after an interrupted extraction.
Use two financier loads for the fault journey and reject the second load.
Verify 72 g served espresso, seven packed financiers and eight rejected financiers.
Verify that a repeated quality decision creates no repeated output.
Retain the input, saved checkpoints, final quantities and browser evidence.

The [local acceptance receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/cafe-shift-20261018.md) records the completed increment.

- [x] Compose financiers and espresso through the existing engine and workspace.
- [x] Preserve material, quality decisions and machine state through process replacement.
- [x] Complete the browser shift and verify a fresh-page save/reopen.
- [x] Keep long-shift recordings within the existing saved-run budget.
- [x] Release this increment and verify both machine selections and shared recovery in production.

The [production acceptance receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/cafe-shift-release-20261019.md) closes this bounded increment on 19 October 2026.
Both machine selections finish the café shift. Shared saves preserve held decisions and completed output through a page reload.
Unattended execution follows the [Plan 70A host decision](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70A-production-engine.md#next-increment--unattended-execution).

The broader four-recipe scenario below remains a separate increment.

## Outcome

Compose the four recipe workflows into one morning shift. Compare staffing,
preparation start times and shared equipment using the same logical clock.
Explain late orders through actual reservations, deadlines and held materials.

Reuse the [Plan 70 shared production engine](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70A-production-engine.md),
recipe adapters and native skills. Follow [61A's shared integration boundary](plan-61A-financier-workflow.md#shared-integration-for-plans-61ae).
This plan owns combined recipe composition and acceptance. Keep one scheduler
and one owner for each recipe's state.

The [Plan 70 delivery ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-70.md#current-delivery-ledger) owns platform
integration priority. Its recurring cold-cell campaign can proceed before these
recipes. This combined shift starts after all four individual recipe journeys pass.

## Baseline scenario: the optimised shift

The baseline runs the shop the way a café-pâtisserie does. Every customer
drink order must be served within 900 s of its arrival, and the journey
asserts zero late orders.

Products and orders:

- The shop's products ([financiers](recipes/financiers.md#shop-flavours),
  [pies](recipes/pies.md)): one eight-cavity load of each financier flavour
  (hazelnut, coffee, matcha, black sesame), each from its own batter batch,
  with two reusable moulds and four cooling grids.
- Six steak and pepper pies and six beef bourguignon pies, two trays of three
  of each type that bake together at the pie oven setting.
- Twelve sesame-drink orders from 3,000 s, two two-serving batches each of
  ginger black tea and ginger milk tea, two espressos and two pour-overs.

Day-before mise en place ([bar recipes](recipes/bar-mise-en-place.md)): the
previous afternoon's run (13:00, one baker, 3 h 52 min) makes two sesame
concentrate batches, one ginger decoction for each tea batch, the shortcrust
and both pie fillings, and holds them in the Hoshizaki refrigerator. The
engine has no inventory that carries between runs, so the morning opens with
these lots as stock with stated provenance. The journey runs the afternoon
scenario and checks that it makes exactly these quantities and that each lot
stays inside its hold (48 h; 72 h for the meat fillings). The morning keeps
the fresh work: financier batter and bakes, pie assembly and baking, and the
drinks.

Roles and dispatch:

- Two workers. The barista alone takes customer orders; the baker runs
  production. A barista who helps production cannot leave a started task
  when an order arrives, so the baseline keeps the barista on the bar.
- Order priority at task boundaries: straining first, then the steps that
  bring a drink to the customer, then clearing the bar, then production.

Bar equipment, from the bottleneck data: three milk jugs, two tea strainers,
four saucepans, a bar scale and a two-zone bar induction unit separate from
the kitchen's, and milk tea cups warmed with the espresso machine's hot water
during the simmer.

Kitchen: one kitchen hob zone, one oven, the scale, one heated milk mixer, one
cooling bath, bounded refrigerator positions, one wash area and one qualified
native handling cell.

The equipment counts are scenario inputs, not a purchase recommendation.
Choose exact arrival offsets before acceptance and retain them with the evidence.

## Scheduling rules

1. Every workflow refers to the same shared equipment instances.
2. Passive holding retains vessel and storage occupancy until a declared release.
3. Stirring, straining, transfer and cleaning reserve worker attention.
4. Extraction deadlines continue while workers and equipment are busy.
5. Native attempts retain their exact material, model, tool and predecessor identities.
6. Failed or uncertain movement holds custody and affected resources.
7. Independent tasks continue when their prerequisites and resources permit.
8. A recipe change creates a reviewed revision and requires affected evidence again.

Use the existing deterministic dispatch policy and expose its ordering decisions.
Do not introduce optimization or automatic recipe substitutions in this plan.
Use the engine's shared logical clock and bounded native advances. Browser compute
order cannot change accepted production times or resource ownership.

Optional sesame roasting and the pie bake compete with financier baking.
Different oven settings (financier 170 °C, pies 200 °C, sesame roast) need
explicit changeover and readiness steps. Never place the two recipes into
one shared oven cycle solely because physical tray space remains.

Human transfers between native fixtures must identify the source, destination,
material and custody result. Model-local pose state cannot establish global travel.
Use declared human-transfer times where a shared measured floor layout is absent.

## Ablations

Each ablation removes one lever of the optimised shift and keeps everything
else. Each reports its drink waits, late orders, tea rejections and shift
completion, and must still make every product.

| Ablation                  | Change                                                          |
| ------------------------- | --------------------------------------------------------------- |
| Without day-before prep   | The morning makes the concentrate, decoctions, dough and fillings |
| One worker                | One worker runs the bar and production                          |
| No station roles          | Two workers share every task                                    |
| No order priority         | Customer-order steps dispatch like production work              |
| Original bar equipment    | Two pans, one jug, one strainer, kitchen scale and hob, cups in pan A |

The [evidence page](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-morning-shift.md) records the numbers.

## Implementation increments

- [x] **E1 — Composition:** place all four recipes and arrivals in one shared run.
- [x] **E2 — Contention:** reconcile worker, equipment, utensil, storage and cleaning reservations.
- [x] **E3 — Native integration:** execute the accepted recipe skills with shared cell/tool occupancy and explicit handoffs.
- [x] **E4 — Comparisons:** preserve immutable baseline and variant inputs with comparable results.
- [x] **E5 — Acceptance:** execute the faulted morning shift and reopen it in a fresh session.

The [four-recipe morning shift acceptance report](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-morning-shift.md) records the completed E1–E5 verification and controlled comparisons.

## Acceptance journey

Run the previous afternoon's mise en place first and check its outputs
against the morning's opening stock. Start financier butter browning, pie
assembly and tea orders close enough to compete for the oven and workers, and
admit twelve sesame-drink orders one minute apart against the day-before
concentrate.

During the shift, reject the coffee financier tray and interrupt the native
cold-carrier transfer of the first financier tray. Save the run while that
transfer remains unresolved and reopen it. Resume through the existing
checkpoint/evidence boundary, then complete service with an explicit
disposition for any missed tea deadline.

Verify that unaffected work can continue. Rejected financiers remain outside
saleable output. Held concentrate cannot serve orders. Native interruption does
not duplicate stock, erase vessel occupancy or release the tool prematurely.

Then run the ablations. Use the same input observations and fault points
where applicable. Retain per-task evidence
so another engineer can explain every changed completion time.

## Results and artifact

Report order waiting time, completion time, late orders against supplied targets,
saleable financiers by flavour, packed pies by type, drink servings, waste by
reason and unresolved work.
Show worker occupancy, equipment occupancy and the cause of each material delay.
Separate assumed timings, measured observations and MuJoCo results in all views.

Extend existing E2E campaigns. Add no unit tests. Store each campaign in a fresh
directory under `output/acceptance/plan-61E/`, with:

- Baseline and comparison scenarios, recipe revisions and exact arrival schedules.
- Model/controller hashes, native requests, recordings and recovery checkpoints.
- Accepted saved runs and read-back results from a fresh session.
- Quantity balances, reservations, order results and comparison tables.
- Browser screenshots, machine-readable results and exact rerun commands.

Add a durable report under `docs/evidence/`. Run relevant types, portal build,
native/browser checks and saved-run E2E coverage. Preserve existing access rules.

Software completion establishes a repeatable combined simulation. Operational
capacity claims require measured production data and separate validation runs.
Physical dispatch remains under [Plan 24](plan-24-cafeos-bakery-automation.md).
