# Plan 60A — Bakery equipment models for recipe simulation

Status: **Simulation phase complete, accepted by the user on 17 October 2026. The eleven appliance models pass polish and prototype mechanical acceptance. Reference gaps are accepted limits. Physical calibration and robot load qualification are deferred.**

Update (2026-11-14): the MuJoCo 4.0.0 runtime and the shop equipment models are in production since the release of 11 November 2026. The Pie Pastry Bench model (`87166a7b4`) is in production since 14 November 2026 (satyr-edge `70693f99`). The pastry shells in the Maruzen oven and the dough press on the pastry bench are in production since 14 November 2026 (satyr-edge `7e8454a3`, ref `refs/backup/released-2026-11-14-plan-86-phases-7-8`).
Created: 2026-10-05.

Scope reviewed: **2026-10-17**. This plan owns equipment geometry, interfaces,
collision models and mechanical acceptance. Recipes belong to Plans 61A–E.
Factory execution belongs to Plan 70. Multi-user review and production release
acceptance do not gate this equipment plan. Physical calibration remains deferred
at the user's request.

## Phase closure — 17 October 2026

The user accepted the current simulation scope without exact manuals or additional
measurements. No further model work is required to close this phase.
Acceptance includes 123 timestep comparisons, eight rack-motion comparisons,
46 shared rest frames, 4,422 moved poses and the 36-job browser washer journey.

Missing manuals, supplied-unit revisions, conflicting dimensions and estimated
hidden interfaces remain documented limits. Acceptance does not establish their
physical accuracy. Unchecked items below are deferred follow-up work, not phase
completion gates. Revisit them when suitable references or measurements become
available, or before a separate physical deployment. Procurement and recipe
qualification remain outside this completed simulation phase.

The implementation is committed in `28302bf57` on `dev`. This closure does not
authorize or record a production deployment.

The [mechanical acceptance review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-mechanical-acceptance.md)
maps each appliance to its evidence and remaining reference gaps. The
[execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md) records completed
Rust/browser integration and removal of Python prototype controllers.

## Coffee-machine extension — 18 October 2026

The Linea Classic S and Eagle One simulation extension is complete.
The original eleven-appliance closure above remains unchanged.

- [x] Complete both models and their shared Rust/MuJoCo controls.
- [x] Verify machine selection in scheduled espresso production.
- [x] Commit, push and deploy the coffee-machine implementation.
- [x] Verify both production workflows and shared save/reopen journeys.
- [x] Restore historical rehearsals through their retained controllers and visuals.

See the [production acceptance receipt](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/coffee-machines-release-20261018.md).
Reference gaps remain accepted. Physical calibration and robot load qualification remain deferred.

## Single-dose coffee grinders extension — 26 October 2026

Four single-dose coffee grinder prototypes (`option-o-lagom-casa`,
`timemore-bricks-01s`, `fellow-opus-2` and `miicoffee-df64-gen2`) extend the
equipment set to seventeen models.

- [x] Complete Blender visual `.glb` and MuJoCo `scene.xml` / `native.xml` assets for all four grinders.
- [x] Wire all four grinders into the shared Rust controller (`crates/bakery-native`), including motor interlocks, grind dial presets, purge actuators and free dosing-cup handling.
- [x] Pass the repeatable mechanical campaign (`87/87` paired recordings across nominal and half timesteps, including `36` grinder comparisons and `134/134` rest frames across 17 models).
- [x] Wire grinder selection and 3D workcell rendering into the Portal Bakery Shift and Combined Café Shift workspaces (`apps/portal`), verified locally (`output/acceptance/plan-60A/20261027-cafe-shift-grinders-browser/report.json`) and on the deployed production Worker (`output/acceptance/plan-60A/20261027-cafe-shift-grinders-production/report.json`).
- [x] Deploy the four-grinder release to production (`satyr-edge` `705c194b-890f-4c2c-b579-17022eb80793`, `satyr-code-mode-sandbox` `fffa0952-57cf-4548-a5cd-67d7652deb0e`, `satyr-model-exit` `e6975385-ad4d-4c01-9293-44d845dac0c2`, `satyr-chatgpt-exit` `affdf773-b87c-45ad-88af-d200cfccc581`, `satyr-vault-onepassword` `9ad8a689-6e06-438b-b2fd-98ed5177fde7`, `satyr-slack-ingress` `1214e9b2-c9b8-4303-9a6c-a6bd75627d75`).

See the [26 October 2026 grinder section in mechanical acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-mechanical-acceptance.md#single-dose-coffee-grinders--26-october-2026).
Reference gaps remain accepted. Physical calibration and robot load qualification remain deferred.

## Commercial 1-burner countertop gas stove — 28 October 2026

The [Rinnai RSB-150PJ](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/rinnai-rsb-150pj/README.md) (`rinnai-rsb-150pj`, product code `51-7234`) adds a standard Japanese commercial single-burner countertop gas stove (`業務用1口ガスコンロ`, City Gas `13A` `5.23 kW` / LP Gas `4.07 kW`, `330 × 325 × 111 mm`) prototype:

- [x] Archive official Rinnai `1:5` scale engineering drawing (`外観図`), instruction manual (`取扱説明書`), and component photography in `docs/equipment/rinnai-rsb-150pj/`.
- [x] Build and inspect the Blender 5.2 visual model (`330 × 325 × 111 mm` overall envelope, stamped stainless-steel top deck with sunken drip basin, dark grey painted lower chassis with 4 rubber feet, removable 6-prong porcelain-enameled trivet, `Ø75 mm` forged brass burner head with inner/outer flame ports, thermocouple flame-failure probe and piezo electrode, push-and-turn rotary ignition knob, and right-side swiveling `Ø9.5 mm` gas hose barb) in `assets/bakery-mujoco/rinnai-rsb-150pj/`.
- [x] Build and verify the MuJoCo `hob.xml`, `scene.xml`, `native.xml`, and active-state combustion/safety trace (`assets/bakery-mujoco/rinnai-rsb-150pj/active-state-evidence/report.json`).

## Starter 100 V commercial induction hotplate — 27 October 2026

The [Panasonic KZ-CK1402](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/panasonic-kz-ck1402/README.md) (`panasonic-kz-ck1402`) adds a Japan single-phase `100 V AC` (`50/60 Hz`, `1,400 W`) commercial countertop induction hotplate prototype:

- [x] Archive official Panasonic product specifications, photographs, and the `'21/8` 1/5 scale engineering drawing (`外形寸法図`) in `docs/equipment/panasonic-kz-ck1402/`.
- [x] Build and inspect the Blender 5.2 visual model (`304 × 345 × 54 mm` envelope, `296 × 286 mm` black crystallized glass plate, 7 articulated touch keys, cooling fan, and detachable magnetic breakaway power cord) in `assets/bakery-mujoco/panasonic-kz-ck1402/`.
- [x] Build and verify the MuJoCo `hob.xml`, `scene.xml`, `native.xml`, and 7-stage active-state trace (`assets/bakery-mujoco/panasonic-kz-ck1402/active-state-evidence/report.json`).

## Undercounter 100 V commercial cube ice maker — 27 October 2026

The [Hoshizaki IM-35P](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/hoshizaki-im-35p/README.md) (`hoshizaki-im-35p`, succeeding `IM-35M-2`) adds a Japan single-phase `100 V AC` (`50/60 Hz`, `175/195 W`, natural refrigerant `R600a`) undercounter closed-cell jet-spray cube ice maker prototype:

- [x] Archive official Hoshizaki product specifications, open-door photograph, and 1/10 scale engineering drawings (`D41369`, `2025-02-20`, and `D27883` `IM-35M-2`) in `docs/equipment/hoshizaki-im-35p/`.
- [x] Build and inspect the Blender 5.2 visual model (`500 × 450 × 800 mm` envelope, `764 mm` open-door depth, bottom-hinged bin door, pull-out Raku-Eco air filter, 30-cell evaporator grid, actuator-motor water plate, double-lever bin switch, power switch, and removable sanitary ice scoop) in `assets/bakery-mujoco/hoshizaki-im-35p/`.
- [x] Build and verify the MuJoCo `appliance.xml`, `scene.xml`, `native.xml`, GLB rest-frame alignment (`0.029 µm`, `0.000000 rad`), and 7-stage active-state trace (`assets/bakery-mujoco/hoshizaki-im-35p/active-state-evidence/report.json`).

## Blender polish follow-up

- [x] Pilot the polish checks on the Quiet One, including cover-wall probes and denser motion samples.
- [x] Apply exported-mesh checks to the other ten appliances and repair collapsed geometry.
- [x] Validate the new checks with faulty model copies and preserve required part names and attachment transforms.
- [x] Examine fixed-camera comparisons and all eleven actual exports in Three.js.
- [x] Repeat native acceptance and rebuild the browser bundle. Verify the complete washer sequence through production workers.
- [x] Make mesh checks reproducible from Git and verify moved frames across 22 modeled joints.
- [x] Review additional manufacturer sources and record conflicting revisions.
- [x] Assess physical interfaces against those sources. No new source establishes a revised hidden fit.
- [ ] **Deferred:** Obtain exact manuals, supplied-unit revisions and missing interface dimensions listed in the reference records.

The [polish evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-60A-blender-polish.md) records the model changes,
repeatable checks, visual comparisons and remaining optical/reference limits.
Physical calibration and robot load qualification remain deferred.

## Outcome and plan family

The initial four-model batch contains two induction hobs, one refrigerator
and one planetary mixer. The selected follow-ups extend it to eleven appliances,
including the existing oven. Deliver matching Three.js and MuJoCo assets. Prioritize
real appliances with Japanese sales and service routes. The two hobs are selected;
the refrigerator and mixer below complete the selected reference batch.

| Plan                                                              | Owns                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **60A — this plan**                                               | Equipment references, visual geometry, collision geometry, joints, tooling and mechanical acceptance |
| [61A — Financiers](plan-61A-financier-workflow.md)                | Full preparation and finishing, plus the first shared recipe integration                             |
| [61B — Black sesame milk](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61B-black-sesame-milk-workflow.md) | Concentrate production, cooling, storage and drinks on demand                                        |
| [61C — Ginger black tea](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61C-ginger-black-tea-workflow.md)   | Ginger simmer, heat-off extraction and immediate straining                                           |
| [61D — Ginger milk tea](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-61D-ginger-milk-tea-workflow.md)     | Two-pan preparation, extraction and milk finishing                                                   |
| [61E — Combined café shift](plan-61E-combined-cafe-shift.md)      | Shared equipment, workers, cleaning and incoming orders                                              |

This batch supplies part of the equipment for Plans 61A–E. Their remaining
smallwares, carriers and drink appliances stay deferred. Completing this batch
does not establish that a complete recipe can execute.

## Existing foundation

The [asset register](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/README.md) separates available geometry from
equipment with active scheduling behaviour. The active scene currently uses
tables, the Maruzen oven and a cooling rack. The library also includes a scale,
probe, mixer, refrigerator, blender, ice machine, sink and dishwasher.

The [browser execution contract](plan-42B-mujoco-workcell-simulation.md#workflow-execution-contract) owns workflow execution.
The shared Rust controller runs with MuJoCo as Wasm in a browser worker. Three.js
shows its recorded motion through WebGL. Existing standalone appliance lab results
are model-development evidence. They do not establish Portal workflow integration.
Python may prepare assets and analyze evidence; do not add Python workflow runners.
Extend the shared Rust controller and browser path for new appliances.
[Plan 42F](plan-42F-general-orchestration.md) supplies one scheduler, explicit
resource instances and bounded simulated human handoffs. Extend those paths.
Do not create another scheduler, asset catalogue service or physics runtime.

Use the current Maruzen asset for the initial scene. Preserve its identity and
the separate recipe oven configuration. A reference oven does not establish the
oven used for the successful recipe trial.

## Next Blender batch — Japan sourcing, 2026-10-05

The [four-appliance reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/plan-60A-reference-pack.md) contains
downloaded drawings, CAD, manuals, photographs and orthographic PNGs. Use its
revision notes and unresolved dimensions before detailed modeling.

The four tasks below record the initial batch; their visual prototypes exist.
The broader research later in this document is a deferred reference backlog.
Generic utensils, pots and pans
need no commercial product reference and are outside this appliance batch.

| Task                 | Proposed exact reference                                     | Japan sourcing and reason                                                                                                                  | Blender / MuJoCo work                                                                                                        |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A2.1 — Induction hob | **Maruzen MIH-02C**                                          | Japanese product line; single-phase 200 V, 2 kW. Preferred physical hob candidate. Official dimensioned drawing available.                 | Cabinet, glass plate, knob, feet, support surface and cooking-zone placement site.                                           |
| A2.2 — Induction hob | **Vollrath Mirage Pro 59500P**                               | Retain the requested US 120 V, 60 Hz model. Japanese supply and local service for this exact SKU remain unverified.                        | Separate model with its own controls, envelope and support surface. Inspect listed CAD before reconstruction.                |
| A3 — Refrigerator    | **Hoshizaki RT-120SNJ**                                      | Current Japanese counter refrigerator: 243 L, single-phase 100 V, 50/60 Hz; 1,200 × 600 × 800 mm. Local sales-office route is documented.  | Cabinet, two doors and handles, shelves, feet, controls, door joints and accessible storage sites.                           |
| A4 — Planetary mixer | **Hobart HL200, Japanese-supplied countertop configuration** | Hobart Japan explicitly lists this 18.9 L mixer for pastry and bakery shops. Local sales/service and Japanese PDF/DWG drawing links exist. | Audit existing HL200 geometry; model bowl, support/lift, swing-out action, guard and interchangeable beater/whip separately. |

Dimensions use width × depth × height in millimetres. Product-page listings establish
a sales route, without confirming stock, lead time or a delivered quotation.
The Vollrath stays in the model queue even if Maruzen is the practical purchase.
Its US electrical specification must remain explicit.

### Refrigerator recommendation

Use the [Japanese RT-120SNJ](https://www.hoshizaki.co.jp/p/f-refrigerator/table/rt-120sn/)
for the first ingredient-storage model. It covers milk, butter, eggs and sealed
concentrate containers in a compact preparation area. Its [archived drawing D38190](equipment/hoshizaki-rt-120snj/specifications/dimensioned-drawing.pdf)
provides the interior, shelves, door swing and 352 mm effective width per door.
The exact J-series operator/installation manual remains missing.

Source through the [Hoshizaki Japan sales-office network](https://www.hoshizaki.co.jp/f/demand_eig_search.php).
The earlier RT-126MC-S is an overseas reference. The Japanese RT-120SNJ now leads
this batch because it has a documented domestic product and support route.
This is a representative commercial choice; exact-model bakery adoption has not
been quantified.

A dedicated tray refrigerator is a separate requirement. The
[Hoshizaki Baker M 550 L DR](https://hoshizaki-europe.com/product/baker-m-550-l-dr-refrigerator/)
accepts 400 × 600 mm bakery trays, but this search has not established Japanese
supply or service for that European model. Keep it deferred. Do not add bakery
rails to the RT-120SNJ or assume that a 600 × 400 mm carrier fits its openings.
Qualify each storage container against the selected interior and door clearance.

### Planetary mixer shortlist

A planetary mixer rotates the tool while moving it around the bowl. This batch
models that mechanism and its loading interfaces. Mixing quality remains a
separate recipe process.

| Candidate                      | Evidence and sourcing                                                                                                                                                                                                                                                                                                                                                   | Decision                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hobart HL200**               | [Hobart Japan product page](https://www.hobart.co.jp/製品/フードマシン/ミキサー/default-32e36550c2a2e2a19f6bca3365c97686/hl200) lists bakery applications, 18.9 L bowl, manual lift, swing-out bowl, guard, beater and whip. Japanese installation PDF and DWG links are present. [Japanese service](https://www.hobart.co.jp/サービス/ホバートサービス) is documented. | Preferred first model: local sales route, useful mechanisms, strong references and an existing visual asset to improve.                             |
| **AICOH Mighty S20 / MS-20**   | [Japanese manufacturer](https://aicohsha.co.jp/mixer/vertical-mixer/ms/) describes its 19–31 L family as popular with bakeries and pastry shops. MS-20 has a 19 L bowl, 545 × 790 × 1,445 mm body, approximately 287 kg mass and three-phase 200 V supply. An [official outline drawing](https://aicohsha.co.jp/wp-content/uploads/2020/03/MS-20.pdf) is available.     | Strong domestic floor-mixer alternative if the scenario represents a production bakery. Keep outside the four-model batch unless it replaces HL200. |
| **AICOH Mighty S15S / MS-15S** | [Manufacturer page](https://aicohsha.co.jp/?p=2309) gives a 12 L bowl, single-phase 100 V, 493 × 655 × 874 mm body and approximately 80 kg mass.                                                                                                                                                                                                                        | Smaller domestic alternative when a confirmed 100 V appliance is the priority. Despite its name, the published bowl capacity is 12 L.               |

These are established commercial product families. Manufacturer descriptions
support bakery suitability; they do not establish independent market-share rankings.

**HL200 baseline:** the downloaded [Japanese installation drawing](equipment/hobart-hl200/specifications/installation-jp.pdf),
dated 2026-05-11, specifies single-phase 100 V, 50/60 Hz, 85.7 kg and
524 × 599 × 737 mm. Use this countertop configuration and the matching DWG.
Generic webpage electrical/mass fields conflict with that drawing. Preserve the
conflict in the source record and confirm the supplied unit before calibration.
The archived US manual and parts catalogue remain qualified mechanism references.

**Vollrath dimension gap:** its specification labels width as 14¼ inches and
35.6 cm. These values disagree. The page also gives a different mass from the
specification. The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/vollrath-59500p/README.md) records
these gaps. Its downloaded CAD now passes inspection, but inconsistent trace
widths and undeclared units prevent exact width qualification. A matched revision
or unit measurement must resolve collision width and mass.

The current financier working batch is approximately 755 g before evaporation.
A commercial bowl's nominal capacity does not establish its minimum effective
batch. Preserve the hand-mixing recipe until powered mixing is qualified. A larger
production batch needs an explicit recipe change and observed mixing results.

### Reference intake before modeling

- [ ] **Deferred:** Archive the exact regional drawing, manual and photographs for each selected appliance.
- [x] Retrieve the Japanese HL200 drawing/DWG and the RT-120SNJ drawing.
- [ ] **Deferred:** Confirm the supplied HL200 revision and resolve Vollrath width/mass discrepancies.
- [x] Record source dimensions separately from assumed hinge axes, masses and friction in the appliance reference packs and model guides.
- [ ] **Deferred:** Confirm local inspection/demo access, service, spare parts and lead time before purchase.
- [ ] **Deferred:** Capture open-door/guard, interior and underside views when public references are incomplete.

No supplier has been contacted and no purchase has been made. Existing references
remain indexed in the [specification archive](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/specifications/README.md).

## Deferred appliance reference backlog — 2026-10-05

Research scope: real appliances with useful manufacturer geometry references.
Generic utensils, pots, pans, bowls, bottles, cooling baths and carrier inserts
can use standard authored geometry. Their dimensions still belong in each model.
The recipe-specific Matsunaga mould remains a measured-fit exception.

The following are modeling candidates. They are not confirmed purchases or
calibrated machine models. Dimensions use millimetres and width × depth × height
unless stated otherwise. Regional variants retain separate identities.

### New appliances and blender qualification

| Role                           | Candidate and published dimensions                                          | Reference material found                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Modeling decision                                                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Induction hob                  | **Maruzen MIH-02C**, 300 × 450 × 120. Ceramic plate 275 × 300.              | [Manufacturer product family](https://www.maruzen-kitchen.co.jp/product/warmer-all/ih-stove/item-ih_rtcs_030/) and [official dimensioned drawing](https://www.maruzen-kitchen.co.jp/pdf/syouninzu/MIH-02C.pdf). Drawing identifies controls, feet, filter, materials and 10.5 kg total mass.                                                                                                                                                                                                                                                                                           | Preferred new geometry reference. Build cabinet, top plate, control knob and feet. This is the 200 V, 2 kW configuration.                                                                                 |
| Induction hob alternative      | **Vollrath Mirage Pro 59500P**, approximately 356 × 387 × 76.               | [Official page](https://www.vollrathfoodservice.com/products/countertop-equipment/cooking-equipment/induction-ranges/mirage-countertop-induction-ranges/59500p) lists specification, manual, front/plan/side CAD and a Revit RFA file. Specification and manual already exist in our archive.                                                                                                                                                                                                                                                                                          | Strongest discovered CAD route. The page describes light-duty use. Preserve its US 120 V identity. The three archived DWGs pass inspection. RFA geometry remains uninspected; width/mass conflicts remain open. |
| Sesame grinder                 | **Waring WSG60**, 165.1 × 215.9 × 292.1 according to the dimensioned sheet. | [Product](https://www.waring.com/3-cup-spice-grinder/WSG60.html), [dimensioned sheet](https://www.waring.com/on/demandware.static/-/Sites-waring-master/default/dwe66c1032/pdf/specSheet/wsg60-waring-commercial-3-cup-electric-wet-dry-power-grinder-spec-sheet-082119.pdf), [parts diagram](https://www.waring.com/on/demandware.static/-/Sites-waring-master/default/dwaa3e974c/WSG60/WSG60%20REV01.pdf) and [manual](https://www.waring.com/on/demandware.static/-/Sites-waring-master/default/dw8000100d/pdf/manual/WSG60-Spice-Grinder-Series-Instruction-Booklet-20210615.pdf). | Preferred grinder candidate because it supports wet/dry blends and removable bowls. Model base, bowl, cover and locking interface separately. Sesame performance at 50–75 g remains unmeasured.           |
| Heated milk mixer              | **Severin SM 3587 Spuma 700 Plus**, 195 × 155 × 250.                        | [Official product page](https://severin.com/de-de/ernaehrung-und-zubereitung/kaffee-fruehstueck/milchaufschaeumer/induktionsmilchaufschaeumer-spuma-700-plus/) provides dimensions, multiple photographs, manual and datasheet links.                                                                                                                                                                                                                                                                                                                                                  | Candidate for a real removable-jug model. Published 500 W, 700 ml capacity and selectable temperatures within 45–65°C. Exact 62–64°C control, sesame mixing and repeated café service remain unconfirmed. |
| Heated milk mixer alternative  | **Breville Milk Cafe BMF600XL**, approximately 162.6 × 190.5 × 264.2.       | [Official product page](https://www.breville.com/en-us/product/bmf600) and [illustrated manual](https://assets.breville.com/BMF600/BMF600_USCM_IB_K26_LR.pdf).                                                                                                                                                                                                                                                                                                                                                                                                                         | Good geometry reference for base, jug, lid, ingredient cap and removable discs. The manual limits the appliance to household use. Keep it as a modeling reference, with café suitability unresolved.      |
| Production blender alternative | **Vitamix Vita-Prep 3**, approximately 191 × 222 × 508.                     | [Official product page](https://www.vitamix.com/us/en_us/products/commercial/vita-prep-3) and [illustrated operating manual](https://www.vitamix.com/media/catalog/product/file/Vita-Prep-and-Vita-Prep3-Owners-Manual_1.pdf).                                                                                                                                                                                                                                                                                                                                                         | Commercial food-preparation candidate with documented hot-liquid handling and a removable container. Qualify the recipe and container before replacing the existing Quiet One reference.                  |

**Grinder drawing conflict:** Waring's product page gives width 8.5 inches and
depth 6.5 inches. Its dimensioned sheet labels width 6.5 inches and depth 8.5
inches. Use the sheet as the provisional geometry basis and retain the conflict
until measurement or a matched revision resolves it. Do not silently combine them.

The WSG60 manual limits continuous operation to 2 minutes 30 seconds. Its
published wet/dry capability supports candidacy, without proving the recipe's
sesame texture, minimum effective load or grinding duration.

**Milk-heater timing gap:** Breville's manual describes several drink cycles in
minutes and recommends cooling the jug between cycles. The recipe's 45–60 second
estimate is unverified for these appliances. Measure a complete 76 g concentrate
plus 210 g milk cycle, including jug turnaround, before setting service capacity.

**Milk-heater availability alternative:** [HENDI 209097](https://www.hendi.eu/no/electric-milk-frother-393428.html)
has multiple photographs, an illustrated manual and an
[exploded parts drawing](https://hendi.xcdn.nl/FD/-/209097_Rev_V01.pdf).
It lists 200 × 167 × 250 in length × width × height order, a 130 mm jug diameter,
300 ml frothing capacity and 600 ml heating capacity. Its manufacturer page marks
it **out of assortment**. Retain it as a historical geometry reference only.

**Blender qualification:** the Vita-Prep manual allows hot ingredients within its
stated limits and requires a low-speed start. It also limits processing time for
oil-based mixtures after circulation begins. Resolve whether that constraint
applies to this sesame formulation before adopting its 90–120 second blend step.
Nominal container capacity alone does not establish usable capacity for thick food.

### Existing appliance references to reuse

| Role                    | Existing real-appliance reference                     | Evidence and remaining model work                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oven                    | **Maruzen MBCO-5E**, nominal cabinet 900 × 800 × 705  | [Official catalogue](https://www.maruzen-kitchen.co.jp/product/catalog/catalog_pdf/bakery-patisserie.pdf) and our [reference archive](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/maruzen-mbco-5e/README.md). GLB and MJCF already exist. Reuse cabinet, door and rails. Preserve existing distinctions between nominal dimensions and projections.                                                                                                                                                                     |
| Current blender         | **Vitamix The Quiet One 36019**                       | Our [archived specification](equipment/specifications/cafe/vitamix-quiet-one-36019-specification.pdf) records enclosure dimensions and open-lid height. The [official commercial FAQ](https://www.vitamix.com/us/en_us/commercial/resources/frequently-asked-questions) identifies compatible containers. Retain the visual asset while qualifying the exact container, lid, operating limits and hot sesame process.                                                                 |
| Service refrigerator    | **Hoshizaki RT-126MC-S**                              | [Official dimensioned drawing](https://hoshizaki.com.hk/wp-content/uploads/2022/04/RT-126MC-S_Drawing.pdf) and [family manual](https://hoshizaki.com.hk/wp-content/uploads/2022/04/Instruction-Manual_A-fit-UNDERCOUNTER_RTFT-MC-S-Series.pdf). Use the 1,200 × 600 footprint. Pin regional leg height and door configuration. Existing milk-fridge geometry needs comparison against this exact reference.                                                                           |
| Bulk refrigerator       | **Hoshizaki Premier K 70 L DR**                       | [Official page](https://hoshizaki-europe.com/product/premier-k-70-l-dr-refrigerator/) lists a 690 × 848 × 1,950 body and 2,080–2,130 height with legs. Add door/shelf mechanics only as needed. The [other family sheet](https://pim-docs.hoshizaki-europe.com/production/Refrigeration/Gastronomy/Cabinets_insulated_door/Reach_in/Refrigerator/2_1_GN_deep/181702010/Spec_sheet/PREMIER_K_70.pdf) lists 920 depth. Resolve the envelope discrepancy before detailed clearance work. |
| Ingredient scale        | **OHAUS Ranger 3000 R31PE6, Japanese item 30031769**  | The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/ohaus-ranger-3000/README.md) records the Japanese LED version and domestic sourcing. Drawing: body 311 × 327 × 117 mm W×D×H, pan 300 × 225 mm. The webpage reverses the body width/depth labels. A detailed [Blender prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/ohaus-ranger-3000/README.md) exists; the [native lab](../scripts/bakery-mujoco/service-labs.md) now verifies weighing, tare and gross overload.                                                |
| Temperature instrument  | **Milesight TS301 with SP11-AF10-125-150 food probe** | [Official datasheet](https://resource.milesight.com/milesight/iot/document/ts30x-datasheet-en.pdf) describes a 4 mm diameter, 100 mm needle and 1.5 m cable. Reuse the instrument reference. Detailed flexible-cable mechanics are unnecessary for the first recipe workflows.                                                                                                                                                                                                        |
| Ice supply, if included | **Scotsman EC 47 / ECM 47 AS**                        | [Official specification](https://www.scotsman-ice.it/library/spec-sheets/gourmet/ec-47/ec-47-en?v=12-05-2022-13-38) and existing ice-machine asset. Preserve the selected variant and the archived 386 × 600 × 645 body reference. Qualify bin access and door travel. A measured initial ice supply can serve the first scenario.                                                                                                                                                    |
| Dishwasher              | **Winterhalter UC-L, standard body**                  | [Japanese reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/winterhalter-uc-l/README.md) and [Blender prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/winterhalter-uc-l/README.md). Cabinet 600 × 603 × 820–855 mm; handle-inclusive depth 657 mm; open depth 1,034 mm. Separate door and 500 × 500 mm rack. Domestic electrical options are documented; the [native lab](../scripts/bakery-mujoco/service-labs.md) now verifies assumed washing states and door/drain fault recovery.                                     |

Use one refrigerator where the scenario permits shared storage. The two references
cover existing asset choices and do not require two new appliances. The sink,
tables and storage containers can remain standard authored models for this research.

### Optional appliances already represented

- **Hobart HL200 Legacy+ mixer:** [manufacturer operator resources](https://www.hobartcorp.com/hl200-operator-resources)
  include a parts catalogue, manual and specification. Hobart also links a
  [CAD/Revit library](https://www.hobartcorp.com/resources-hobart).
  Keep the existing visual asset. Add bowl lift, guard and attachment mechanics
  only if powered mixing enters the financier workflow. Model-specific CAD files
  were not inspected during this search.
- **IRINOX EasyFresh Next S:** the [official R290 drawing](https://www.irinoxprofessional.com/media/6952/d-1/t-file/EF_NEXT_S_R290_EN_R01.pdf)
  provides cabinet, door swing, clearances and foot options. Reuse the existing
  blast-chiller asset if a later cooling scenario selects it. The initial sesame
  workflow retains its ice bath.

No additional tea-specific machine is required by the two recorded tea methods.
They use the shared hob. Espresso machines, coffee grinders and proofers remain
outside this recipe set.

### Reference limitations

The initial four-model batch has visual prototypes. The user requested continued
appliance modeling on 2026-10-06. Additional visual prototypes now include the
Waring WSG60, Vitamix Quiet One, OHAUS R31PE6, Severin SM 3587 and Winterhalter UC-L.
Chiller modeling and the corresponding process simulation remain pending.

Photographs and dimensions are sufficient for an exterior reconstruction with
declared assumptions. Detailed mating geometry, hinge axes, component masses,
inertias and friction still need drawings or measurements. Public CAD/Revit
availability does not establish a simulation-ready articulated model.

The four active appliances have a [downloaded reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/plan-60A-reference-pack.md).
The deferred research below does not certify supplier availability. Earlier
documents remain indexed in the [specification archive](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/specifications/README.md).

## Recipe equipment requirements — handoff to Plans 61A–E

The table records the original recipe equipment requirements. It does not track
their current implementation status. The selected appliance prototypes above
now exist. Each consuming recipe plan owns its smallwares and process integration.

“Mechanical” below means contact, support, clearance or articulated movement.
Heating, cooking, grinding quality and sanitation use explicit process steps.

| Equipment                                | Existing basis                                                                | Deliverable and mechanical scope                                                                                                             | First consumer       |
| ---------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Induction hob                            | Proposed reference, no library model                                          | Visual controls, pan support surface, named cooking zone and placement bounds. One independently reserved zone initially.                    | 61A                  |
| Saucepan and removable lid               | Proposed pan reference, no library model                                      | Separate bodies, open interior, handle clearance, empty and loaded mass profiles. Add a resting surface beside the hob.                      | 61A, then 61B–D      |
| Mixing bowl, whisk and spatula           | Smallwares absent                                                             | Bowl support/contact geometry and simple utensil visuals. Manual mixing remains a timed task.                                                | 61A                  |
| Matsunaga eight-cavity mould             | Working recipe identifies the mould                                           | Measured external shape, cavity layout, rim and support surfaces. Preserve the approximately 11 mm depth as unconfirmed until measured.      | 61A                  |
| Carrier tray and wire cooling grid       | 600 × 400 mm tray and trolley exist                                           | Reuse tray geometry where actual fit permits. Add a separate wire grid for demoulded pieces. Record mould-to-carrier placement.              | 61A                  |
| Sesame spice grinder                     | Espresso grinder exists for a different use                                   | New grinder body, removable cup/lid and loading space. Grinding remains a process duration.                                                  | 61B                  |
| Blender assembly                         | Quiet One visual asset exists                                                 | Qualify the selected vessel and operating limits. Add container, lid, seating and removal geometry as needed.                                | 61B                  |
| Heated milk mixer                        | [SM 3587 visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/severin-sm-3587/README.md) | Base, removable jug, lid and serving clearance. Heating and texture remain process assumptions or measurements.                              | 61B                  |
| Cooling bath and shallow container       | Ice-machine visual exists                                                     | Two distinct vessels, support geometry and receiving capacity. Ice quantity and cooling progress remain process state.                       | 61B                  |
| Concentrate containers                   | No library model                                                              | Two bottles or covered wide-mouth containers, each carrying a target 380 g of concentrate. Measure volume, tare and lid geometry separately. | 61B                  |
| Tea preparation and serving kit          | Smallwares absent                                                             | Knife, board, strainer, measuring jug, serving pot and cups. Model strainer support and placement clearances.                                | 61C–D                |
| Scale, probe, refrigerator and wash sink | Visual assets exist                                                           | Reuse visuals. Add only needed contact surfaces, shelves, doors and named placement sites.                                                   | All                  |
| Handling carrier and tool interface      | FR10 tray clamp exists                                                        | Qualify the existing clamp for the selected carrier. Add a vessel-support insert only where a recipe needs vessel transport.                 | All native transfers |

Use distinct instances of reusable equipment. Milk tea requires two pans at the
straining boundary. A pan on an unpowered hob still occupies that location.

The planetary mixer is in the active model batch; its use in the financier
recipe remains optional. Blast-chiller and espresso branches remain deferred.
The first financier workflow uses hand mixing. The first sesame workflow still
requires the dedicated heated mixer and ice bath listed in the deferred backlog.

## Model and evidence contract

MuJoCo supplies articulated dynamics and contact simulation through an XML model
format called MJCF. See the official [overview](https://mujoco.readthedocs.io/en/stable/overview.html)
and [modeling guide](https://mujoco.readthedocs.io/en/stable/modeling.html).

For these plans, fluid flow, heat transfer, evaporation, mixing quality, extraction
and baking chemistry are outside the mechanical model. A filled vessel uses an
explicit rigid payload approximation. Its recording must disclose that assumption.
Successful carrier motion cannot establish spill-free transport of real liquid.

Each model needs:

- A source record with dimensions, photographs, model identity and measurement date.
- Clear labels for measured, manufacturer-specified and assumed values.
- Mass, centre of mass, inertia, contact surfaces and friction assumptions.
- A GLB for Three.js and matching MJCF bodies with non-colliding visual meshes.
- Separate simple collision shapes that preserve openings and support surfaces.
- Named placement and grasp sites, with position and orientation tolerances.
- A reproducible authoring source and rebuild command using the existing toolchain.
- Fingerprints through the existing asset packaging and request identity path.

Keep metres, kilograms, seconds and radians as the source units. Document the
existing conversion between MuJoCo's Z-up frame and Three.js presentation.
Check joints and placement sites after export, including lids and removable jugs.

Pin each native attempt to its model, controller, payload and layout. Preserve
full integration state between connected skills in the same model. A transfer
between different models requires an explicit custody boundary and new setup.

Changes in contents occur at declared process boundaries. Record the new payload
profile before starting a mechanical attempt. Do not silently change body mass
or reset poses during an accepted native sequence.

## Delivery increments for the selected appliances

The [Rust/browser execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md)
records the completed shared execution work:

- [x] Run all eleven appliance controllers through the existing Rust executable and browser Wasm worker.
- [x] Integrate appliance runs with the shared canvas and saved-run system.
- [x] Remove Python prototype controllers. Retain Python for asset authoring and evidence inspection.
- [x] Support bowl removal, reseating and tool exchange for both planetary mixers in the [combined native appliance lab](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/combined-bakery/README.md).
- [x] Drive appliance displays and indicators from recorded controller state.
- [x] Couple ingredient mass and temperature to vessel weight, heat capacity and motor load through the [ingredient-load model](../scripts/bakery-mujoco/ingredient-loads.md).
- [x] Preserve batch properties through portion transfers and recovery.
- [x] Prepare the [appliance calibration procedure](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/appliance-calibration-procedure.md). Physical coefficients remain assumptions until measurements are available.

Four bounded recipe rehearsals share the appliance instances and retain native
checkpoints, material custody and recorded cold-tray recovery.
These local acceptance sequences do not complete the production recipe plans or Plan 70.

- [x] Add preheating, thermostat control, door-open heat loss, a pausable baking timer and passive cooldown to the [Maruzen MBCO-5E lab](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/maruzen-mbco-5e/active-states.md).
- [x] Verify oven interruption, temperature recovery, completion and power loss while the free tray stays supported.

Thermal coefficients and oven control behavior remain explicit assumptions.

### A1 — Pin references and reuse useful geometry

- [x] Complete available public reference intake for the two hobs, refrigerator and mixer. Inspect the four archived DWGs; retain exact-manual and revision gaps explicitly.
- [x] Inspect existing fridge and HL200 authoring sources before replacing geometry; the model guides record the resulting replacements.
- [x] Preserve exact model and regional identity in each reference pack.
- [x] Classify the eleven assets as mechanical prototypes with bounded simulation evidence. None has physical qualification.

### A2 — Build both induction hobs

- [x] Author separate Blender sources and GLB/MJCF exports for MIH-02C and 59500P.
- [x] Model visual controls, support planes, provisional contact envelopes and one cooking zone each.
- [x] Use a standard test pan to verify native support, removal, reseating and supported misalignment through the shared Rust controller.
- [x] Record heat settings as process state; contact simulation does not prove heating.
- [ ] **Deferred:** Calibrate thermal behavior, collision dimensions, control limits and handling tolerances against real equipment.

The [MIH-02C Blender visual model](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/maruzen-mih-02c/README.md)
is complete as of 2026-10-06. It includes a textured ceramic plate, separate controls,
adjustable-foot groups, removable filter and an illustrative cable route.
Export inspection checks the published body and plate dimensions, embedded texture,
control movements, filter removal and a centred 200 mm pan support reference.
The Blender pan check uses surface rays. The companion MuJoCo lab adds dynamic
support and assumed heating. Exact control limits and physical calibration remain pending.
The [Vollrath 59500P visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/vollrath-59500p/README.md)
uses a provisional 355.6 mm width. The drawing's conflicting 361.95 mm inch value
remains unresolved. Its current photographic graphics, sloped controls, encoder,
front ventilation and underside fan guard have separate visual geometry.
The model includes six review renders and repeatable GLB inspection with a
260 mm pan reference. The separate [MuJoCo labs](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/induction-pan/README.md)
use a free 200 mm pan for contact, heating, timer, removal and fault journeys.
Vollrath follows the documented short-removal continuation and ten-minute timeout.
Maruzen uses an explicit removal-fault assumption because its exact manual is missing.
The native acceptance does not resolve Vollrath's width conflict or establish thermal calibration.

### A3 — Build the Japanese refrigerator

- [x] Model RT-120SNJ exterior, accessible interior, shelves and both door assemblies.
- [ ] **Deferred:** Match door axes, opening limits and handles to the selected references.
- [x] Define four prototype storage sites from the modeled shelf geometry; full usable-opening qualification remains pending.
- [x] Demonstrate native placement/retrieval of a covered test container and contact-driven door obstruction recovery.
- [x] Keep cabinet and assumed container temperature in explicit process state, with an energy ledger.

The [Blender visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/hoshizaki-rt-120snj/README.md)
includes an articulated GLB, packed drawings and five review renders. The export
inspection verifies dimensions, door animation, interior access rays and shelf
removal. Door axes, handle profiles and preview limits remain estimates.
The [native physics lab](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/hoshizaki-rt-120snj/active-states.md)
records storage on left and right shelves, retrieval, obstructed closure and temperature recovery.
Hinge forces, effective opening, shelf load ratings and thermal calibration remain pending.

### A4 — Build the planetary mixer

- [x] Pin the Japanese HL200 drawing and inspect available authoring assets.
- [x] Separate bowl, bowl support, guard, lift, tool carrier, beater and whip.
- [ ] **Deferred:** Preserve bowl and tool mating geometry; these are appliance-specific parts.
- [ ] **Deferred:** Match guard movement, bowl travel and tool motion to the selected manual.
- [x] Represent US family guard/bowl operating interlocks and blocked starts in the bounded native lab; Japanese revision confirmation remains pending.
- [x] Demonstrate prototype bowl removal, reseating, tool exchange, lift/guard movement and operation through fresh Rust processes.

The [HL200 Blender visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/hobart-hl200/README.md)
uses the Japanese installation drawing dated 2026-05-11. The earlier conceptual
colour models were absent from the available workspace. The new source includes
separate tool exports, five packed references and seven review renders.
Export inspection verifies the envelope, hollow bowl, access movements and tool swap.
Sampled visual clearance checks pass for the selected preview movements.
The 20 mm lift preview and other motion limits remain estimates.
The [native planetary lab](../scripts/bakery-mujoco/planetary-lab.md) verifies all speed settings,
timer pause/resume, guard and bowl interruptions, coast-down and mechanical stall recovery.
The shared Rust attachment journey also verifies coupling rejection and tool
exchange. Exact physical travel, mating geometry and measured gearing remain pending.
Recipe acceptance belongs to the consuming recipe plan.

A scripted joint demonstration establishes model mechanics. The current tray tool
does not establish robotic door opening, guard operation or bowl handling.
Robot execution needs a qualified tool/controller extension and its own evidence.
Manual actions can use the existing explicit simulated-human handoff.

### A4.1 — Japanese bakery floor mixer follow-up

Added on 2026-10-06 after the request for a more typical bakery planetary mixer.
Use the **AICOH Mighty S30 / MS-30**, standard panel and manual lift, as the
production-bakery visual reference. Retain the HL200 as the countertop reference.
This adds one model to the original four-appliance batch.

The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/aicoh-ms-30/README.md) records the selection and
manufacturer evidence. AICOH describes the family as popular with bakeries and
pâtisseries. Independent market-share ranking remains unverified.

- [x] Archive the manufacturer's drawing, catalogue and detail photographs.
- [x] Build the frame, enclosure, bowl, guard, handwheel and separate tools in Blender.
- [x] Inspect exported dimensions, bowl removal, tool replacement and named pivots.
- [ ] **Deferred:** Confirm full lift travel, guard stops, tool engagement and drive ratios.
- [x] Implement native carrier/tool rotation, bowl/tool collision shapes and bounded interlock/stall journeys with explicit assumptions.
- [ ] **Deferred:** Calibrate physical contacts, operating behavior and recipe dynamics against the supplied appliance.

The [model deliverables](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/aicoh-ms-30/README.md) include
the editable source, three GLBs, five renders and repeatable export inspection.
The 120 mm lowering and 180° guard rotation are visual estimates.
The [native planetary lab](../scripts/bakery-mujoco/planetary-lab.md) records speed changes,
guard/bowl interruptions and stall recovery. Its gear ratio and dynamic parameters remain unmeasured.
The exact operator manual remains unavailable; timer and bowl-interlock behavior are lab assumptions.

### A4.2 — Waring WSG60 recipe grinder follow-up

Added on 2026-10-06 after the request to proceed with the next appliance.
The selected hob, refrigerator and mixer batch has visual prototypes, so this
increment starts the next appliance in the recipe backlog.

The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/waring-wsg60/README.md) includes the manufacturer
specification, operator manual, current parts drawing and six product images.
The [Blender model](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/waring-wsg60/README.md) separates the
bowl, blade, clear cover, couplings, controls and storage lid.

- [x] Archive manufacturer dimensions, parts and photographic references.
- [x] Build the Blender source, assembly GLB and reusable bowl/lid exports.
- [x] Inspect exported cover access, bowl removal and sampled blade clearance.
- [ ] **Deferred:** Resolve the width/depth conflict against a matched physical unit or drawing revision.
- [ ] **Deferred:** Confirm Japanese supply/service or select a domestic purchasing alternative.
- [x] Implement native blade drive, bowl contacts, cover interruption, pulse and 150-second cutoff; record jam recovery.
- [ ] **Deferred:** Calibrate mechanics and qualify sesame performance.

The drawing's 165.1 × 215.9 × 292.1 mm envelope remains provisional.
The product page and 2025 graphic swap width and depth. Preserve the US 120 V
identity. Cover motion, mating geometry and component masses remain uncalibrated.

### A4.3 — Vitamix Quiet One follow-up

Selected explicitly by the user on 2026-10-06.
The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/vitamix-quiet-one/README.md) identifies US 36019 / VM0145,
the twist-lock enclosure and the 48 oz Advance container.
The [Blender prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/vitamix-quiet-one/README.md) separates
the door, frame, container, lid, plug, two-arm blade and controls.

- [x] Archive manufacturer specifications, operator manual, assembly diagrams and photographs.
- [x] Build the editable Blender source, assembly GLB and reusable container export.
- [x] Inspect sampled door opening, container removal, vessel access and blade clearance.
- [ ] **Deferred:** Resolve the older standalone container drawing against the photographed assembly.
- [ ] **Deferred:** Confirm Japanese supply and service for the selected configuration.
- [x] Implement native jar-pad contacts, blade dynamics, bounded access fixtures and timed/pulse control with explicit assumptions.
- [x] Verify blocked starts, cover/jar interruptions, coast-down, mechanical jam and reset in a recorded native journey.
- [ ] **Deferred:** Calibrate mating geometry, mass, inertia, RPM mapping and operating behavior against the exact appliance.
- [ ] **Deferred:** Qualify the exact container and operating process for the sesame recipe.

The overall appliance follows the 215.9 × 271.78 × 457.2 mm drawing envelope.
Internal fits, the 105° door preview and container dimensions remain estimates.
The source model remains US 120 V. Shared appliance playback uses this GLB.
The [shared Rust handling journey](../scripts/bakery-mujoco/verify_rust_handling.py)
adds free jar placement, rejected coupling away from the base and reseating.
Coupling geometry and placement tolerances remain assumptions. Fluid and acoustic
behavior remain outside this mechanical prototype.

### A4.4 — Ingredient-scale follow-up

Selected by the user on 2026-10-06. The Japanese **OHAUS Ranger 3000 R31PE6,
item 30031769**, replaces the US R31P6 as the active ingredient-scale reference.
The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/ohaus-ranger-3000/README.md) includes Japanese
manufacturer documents, panel drawings and domestic supplier links.

- [x] Archive the Japanese specification, manual and visual references.
- [x] Build the Blender source, assembly GLB and reusable stainless-pan export.
- [x] Check the load surface, sampled pan/support removal, feet and controls.
- [ ] **Deferred:** Calibrate mating surfaces, foot adjustment and load-cell mechanics.
- [x] Implement native contact-based weighing, stable readings, tare, zero and gross overload in a recorded standalone journey.
- [ ] **Deferred:** Calibrate sensor dynamics. The shared appliance rehearsal already includes weighing; full recipe behavior belongs to Plans 61A–E.

The [visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/ohaus-ranger-3000/README.md) follows
the drawing's 311 × 327 × 117 mm body and 300 × 225 mm pan.
The earlier body width/depth conversion was reversed. The webpage's axis labels
still conflict with the dimensioned drawing. The model follows the drawing.
The display and Japanese keypad follow the LED photographs and Japanese manual.
Shared appliance playback uses this Japanese scale GLB.

### A4.5 — Heated milk mixer follow-up

Selected by the user on 2026-10-06. The **Severin SM 3587 Spuma 700 Plus**
uses the existing Plan 60A reference. The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/severin-sm-3587/README.md)
contains the official manual, datasheet, photographs and regional limits.

- [x] Archive manufacturer specifications and removable-part references.
- [x] Build Blender source, assembly GLB and standalone jug assembly.
- [x] Check sampled removal, jug access, selector motion and saved animation.
- [ ] **Deferred:** Verify physical fits, component masses and collision geometry.
- [x] Implement standalone MuJoCo stirrer dynamics, assumed heating, completion and fault/restart states.
- [ ] **Deferred:** Calibrate heating, mixing, temperature control and recipe behavior against the real appliance.

The [visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/severin-sm-3587/README.md) follows
195 × 155 × 250 mm. Its removable jug, lid, ingredient insert, serrated stirrer
and heating cover remain separate. Japanese supply and 100 V compatibility are
unverified. The manual describes domestic or similar use. Café duty, sesame mixing
and exact 62–64°C control remain unresolved.

The [active-state lab](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/severin-sm-3587/active-states.md)
adds heating and cold mixing with native rotor motion. Acceptance exercises
completion, jug removal, a friction-induced stall, explicit restart, cancellation
and fill limits. The temperature model, motor parameters and removal thresholds
are explicit assumptions. Fluid dynamics remain outside this mechanical model.
Plan 61B owns the consuming recipe integration.

### A4.6 — Winterhalter UC-L follow-up

Selected by the user on 2026-10-06. The standard **Winterhalter UC-L** follows
the Japanese brochure and manufacturer product photographs. The
[reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/winterhalter-uc-l/README.md) includes Japanese technical
data, the Japanese manual, dimensioned views and local sales/service details.

- [x] Archive Japanese manufacturer references and regional distinctions.
- [x] Build Blender source, assembly GLB and a separate 500 × 500 mm rack.
- [x] Check sampled door motion, rack transfer, spray-field rotation and saved animation.
- [ ] **Deferred:** Measure joints, interfaces, component masses and service connections.
- [x] Implement native door/rack/spray mechanics and assumed fill, heating, wash, drain and rinse states with recorded fault recovery.
- [x] Load removable HL200 parts into the rack and preserve dirty/clean state through door and drain interruptions in Rust.
- [ ] **Deferred:** Calibrate operating parameters and qualify chemical dosing and cleaning effectiveness. Full recipe integration belongs to Plans 61A–E.

The [visual prototype](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/winterhalter-uc-l/README.md) uses a
600 × 603 × 820 mm cabinet. The handle increases closed depth to 657 mm.
The open-door depth is 1,034 mm. A 404 mm opening sits above the 328 mm loading plane.
The rack wire pattern and internal fits are estimates. Australian SKU 013V0078 is
an appearance reference, not the Japanese ordering code. Shared appliance
playback uses the detailed UC-L GLB.

### A4.7 — OPTION-O LAGOM casa single-dose conical burr grinder follow-up

Added on 2026-10-24 from the Inter-Christine Japan product listing (`lagom-casa`,
SKU `000000000405`, imported by R&D ESPRESSO Co., Ltd.) and official OPTION-O
documentation. The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/option-o-lagom-casa/README.md)
archives the Quick Start Guide, Safety Manual, Japanese and manufacturer product
pages, 16 reference images and SHA-256 manifest.

- [x] Archive Japanese distributor and manufacturer specifications, manuals and studio photographs.
- [x] Build the Blender 5.2 source, assembly GLB (`90 × 215 × 275 mm`), standalone magnetic catch-cup GLB and standalone Mizen 65CL outer burr carrier GLB.
- [x] Verify envelope bounds, fault-injected envelope rejection, `Z = 0` foot contact plane, stepless hopper dial rotation, tool-less hopper/carrier removal, 360° conical burr rotation, chute clicker stroke, side button press and chamber/cup interior rays in [`inspect_lagom_casa.py`](../scripts/bakery-mujoco/inspect_lagom_casa.py).
- [x] Implement native MuJoCo mechanics (`appliance.xml`, `scene.xml`, `native.xml`) and verify magnetic catch-cup self-centering, stepless grind adjustment (`+15` Filter to `+8` Espresso), auto-grind start and torque-sensed auto-stop, spring-return chute clicker purge (`< 0.1 g` retention), 90-second continuous duty cutoff and 10-second button-hold empty-chamber torque recalibration in [`active-states.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/option-o-lagom-casa/active-states.md).
- [ ] **Deferred:** Calibrate physical thread pitch, magnetic force-displacement curve, planetary motor current/torque telemetry and bean comminution particle distribution against an instrumented unit.

### A4.8 — TIMEMORE Bricks 01S compact conical burr grinder follow-up

Added on 2026-10-24 from the COFFEE LAB KOMAMEYA Japan listing
(`timemore-bricks-01s-black`) and TIMEMORE Japan official specification
(SKU `IF11120316`). The [reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/timemore-bricks-01s/README.md)
archives Japanese distributor and manufacturer specifications, 15 reference
photographs and SHA-256 manifest.

- [x] Archive Japanese distributor and manufacturer specifications and studio photographs.
- [x] Build the Blender 5.2 source, assembly GLB (`102 × 150 × 286 mm`), standalone magnetic catch-cup GLB and standalone S2C-040-EI outer burr carrier GLB.
- [x] Verify envelope bounds, fault-injected envelope rejection, `Z = 0` foot contact plane, 150-click rotatable hopper dial motion, tool-less lid/hopper/carrier removal, 360° S2C-040-EI conical burr rotation, rotary fines knocker rotation, side power button press and chamber/cup interior rays in [`inspect_bricks_01s.py`](../scripts/bakery-mujoco/inspect_bricks_01s.py).
- [x] Implement native MuJoCo mechanics (`appliance.xml`, `scene.xml`, `native.xml`) and verify magnetic catch-cup self-centering, 150-click stepped grind adjustment (`7.0` Pour-Over to `2.0` Espresso), `450 RPM` `18.0 g` grind and stop, spring-return rotary fines knocker purge (`< 0.15 g` retention), `60 s` thermal duty cutoff, foreign-object burr stall protection and tool-less maintenance in [`active-states.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/timemore-bricks-01s/active-states.md).
- [ ] **Deferred:** Calibrate physical detent torque, rotary knocker spring stiffness, `150 W` DC motor current telemetry and S2C-040-EI particle size distribution against an instrumented unit.

### A4.9 — Fellow Opus 2 conical burr grinder follow-up

Added on 2026-10-24 from the 0141Coffee Japan listing (`pid=193720631`),
Inter-Christine Co., Ltd. official Japanese distributor specification (`fs-og2`,
model `OP02AANA`) and Fellow product documentation. The
[reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/fellow-opus-2/README.md) archives Japanese and
manufacturer specification pages, 17 product photographs and SHA-256 manifest.

- [x] Archive Japanese retailer, distributor and manufacturer specifications and studio photographs.
- [x] Build the Blender 5.2 source, assembly GLB (`130 × 206 × 267 mm`), standalone magnetic catch-cup GLB and standalone 48 mm 6-star outer burr carrier GLB.
- [x] Verify envelope bounds, fault-injected envelope rejection, `Z = 0` foot contact plane, side worm-gear knob and upper scale ring motion, tool-less lid/hopper/carrier removal, 360° 6-star conical burr rotation, front timer button press and chamber/cup interior rays in [`inspect_opus_2.py`](../scripts/bakery-mujoco/inspect_opus_2.py).
- [x] Implement native MuJoCo mechanics (`appliance.xml`, `scene.xml`, `native.xml`) and verify magnetic catch-cup self-centering, side worm-gear grind adjustment (`6.0` Filter to `2.0` Espresso), `400 RPM` timed grind with torque-sensed early auto-stop and anti-static ionizer (`< 0.1 g` retention), `30/60/90/120 s` multi-press timer selection, foreign-object stall protection, `120 s` duty cutoff and tool-less maintenance in [`active-states.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/fellow-opus-2/active-states.md).
- [ ] **Deferred:** Calibrate worm-gear reduction backlash, magnetic catch-cup force curve, `300 W` gearmotor torque telemetry and 48 mm 6-star particle size distribution against an instrumented unit.

### A4.10 — MiiCoffee DF64 II (Gen 2, V2.6) single-dose 64 mm flat burr grinder follow-up

Added on 2026-10-25 from the official MiiCoffee product listing
(`miicoffee.shop/products/mii-df64-single-dosing-coffee-grinder`, SKU
`Mii-DF64ii-Black`, hardware revision `V2.6`) and the 2-page DF64 II instruction
manual (`df64ii-use-manual.pdf`). The
[reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/miicoffee-df64-gen2/README.md) archives the product
HTML/JSON, FAQ, PDF manual, 12 high-resolution studio photographs and SHA-256
manifest.

- [x] Archive MiiCoffee product specifications, instruction manual PDF and studio photographs.
- [x] Build the Blender 5.2 source, assembly GLB (`130 × 225 × 300 mm`), standalone `58 mm` 6063 aluminum dosing-cup GLB and standalone 3-lug `64 mm` upper flat burr carrier GLB.
- [x] Verify envelope bounds, fault-injected envelope rejection, `Z = 0` foot contact plane, stepless chrome dial collar rotation, silicone bellows compression puff, tool-less walnut lid/bellows/upper-burr-carrier removal, 360° `64 mm` flat burr rotation, lower-right metal power button press and throat/cup interior rays in [`inspect_df64_gen2.py`](../scripts/bakery-mujoco/inspect_df64_gen2.py).
- [x] Implement native MuJoCo mechanics (`appliance.xml`, `scene.xml`, `native.xml`) and verify two-prong holder fork dosing-cup seating, stepless chrome dial adjustment (`70.0` Filter to `15.0` Espresso), manual-enforced finer-adjustment guard when beans are loaded (`finer_running_guard`), `1,400 RPM` `64 mm` flat-burr grind with plasma ionizer and 3 silicone bellows puffs (`< 0.1 g` retention), foreign-object stall protection, `90 s` continuous duty thermal cutoff and tool-less maintenance in [`active-states.md`](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/assets/bakery-mujoco/miicoffee-df64-gen2/active-states.md).
- [ ] **Deferred:** Calibrate stepless collar thread pitch, wave-spring preload curve, `250 W` AC induction motor slip-torque curve and `64 mm` flat-burr particle size distribution against an instrumented unit.

### A5 — Mechanical acceptance

Run a repeatable journey for each appliance in the real MuJoCo runtime. Include
blocked pan placement, refrigerator door obstruction and an invalid mixer start.
Retain the same process/robot boundary in the portal and native evidence.

- [x] Demonstrate prototype support during vessel placement, loaded storage and washer rack movement in the recorded journeys.
- [x] Reject closed access, occupied slots and invalid couplings. Reject motor starts away from the base and suppress hob heat without pan support.
- [x] Require the UC-L rack to finish extension and stop before part access. Reject rack commands while a part is held.
- [x] Resume the eleven appliance sequences in a fresh process with the same contents and integration state.
- [x] Compare nominal and half-timestep runs. All 123 paired recordings pass in the fresh supported-rack campaign.
- [x] Resolve the UC-L beater's final-position mismatch with the guided horizontal rack fixture. The retrieval difference is 0.000846 mm against the unchanged 5 mm limit.
- [x] Verify sampled loaded UC-L rack travel. All eight motion comparisons pass, with a maximum difference of 0.3074 mm. Free vertical rack handling remains outside the native fixture.
- [x] Rebuild the browser bundle and verify loaded rack travel, access rejection and retrieval through 19 fresh production Web Workers.
- [x] Inspect the shared GLB/native body frames at rest and retain the existing support/access geometry checks. Continuous surface fit remains unqualified.
- [x] Confirm that the existing nominal cold-tray transfer still loads and completes with the current controller.

Set tolerances from actual fit before acceptance. Keep assumed prototype dimensions
visible until drawings or measurements resolve them.

## Verification artifact and completion

Extend the existing native/browser acceptance scripts. Add no unit-test suite.
Keep one fresh output directory per campaign under `output/acceptance/plan-60A/`.
Each campaign must retain inputs, asset hashes, recordings, checkpoints, renders,
numeric results and exact rerun commands. Add a durable report under
`docs/evidence/` with artifact locations and remaining measurement gaps.

The original batch and selected follow-ups now provide eleven reviewable appliance
prototypes with repeatable mechanical journeys. Those implementation and acceptance
tasks are complete. Unchecked tasks retain exact-reference, sourcing, measurement
and physical qualification gaps. Physical calibration remains deferred.
Deferred recipe equipment is outside this batch. A photorealistic render alone
does not close mechanical acceptance. Physical robot dispatch remains under
[Plan 24](plan-24-cafeos-bakery-automation.md).
