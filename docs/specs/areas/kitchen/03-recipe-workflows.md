# KIT-03 — Recipe workflows

A recipe workflow is the task graph of one recipe in the production engine of Kitchen,
in Purin Pantry. Each recipe compiler makes a `CompiledScenario`, and one importer makes
a typed document from it: steps, arrows and decision branches. A person sees the graph
beside the recipe's animation, edits it in a shared draft, runs the draft beside the
applied revision and applies it as a new immutable revision. A Sous Chef agent reads the
applied workflow and the findings of its last run, and it proposes a change. Only the
approval of the person who asked writes the revision. `compileDraft` and the engine's
admission decide if a graph can run. A revision is simulation data: it has no authority
over stock, orders or a device. The recipes are the financier, the café drinks, the
pies and the combined café shifts.

## What it does

### The recipes

| Recipe                            | Compiler in `recipes/bakery/`                                                  | What the run holds                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Financier                         | `financier-production.ts`, `financier-preparation.ts`, `financier-flavours.ts` | Weighing, browning, mixing, eight-cavity moulds, bakes with an inspection, cooling, demoulding, cleaning, packing |
| Latte, siphon                     | `latte.ts`, `siphon.ts`                                                        | Real prerequisites and `assumed` durations. The latte shot and the milk are two arms that join at the pour        |
| Black sesame milk                 | `black-sesame.ts`                                                              | Grind, blend, concentrate and the cold carrier                                                                    |
| Ginger black tea, ginger milk tea | `ginger-black-tea.ts`, `ginger-milk-tea.ts`                                    | Pan staging and an inspection with two arms                                                                       |
| Savoury pies                      | `pie.ts`                                                                       | Assembly and bake of one pie type                                                                                 |
| Café shift                        | `cafe-shift.ts`                                                                | One to three financier loads and espresso orders, a baker and a barista on one clock                              |
| Morning and six-hour shifts       | `bakery-shift.ts`, `mise-en-place.ts`, `shift-preset.ts`                       | Four financier flavours, two pies and the drinks                                                                  |

- **Financier.** The four flavours are `hazelnut`, `coffee`, `matcha` and
  `black-sesame` (`FINANCIER_FLAVOURS`). Each flavour is its own batter batch of the
  brown-butter base with its mix-ins. A mould has 8 cavities, and the default is two
  moulds (`mould-a`, `mould-b`). Masses use `milligram` balances. A mould is filled again
  only after demoulding and cleaning. An operator decides each bake and pack inspection
  during the run. The decision binds the definition, the task, the held lots and the
  control revision.
- **Cold handling.** A native step carries the cold `persistent-rack/1` carrier after the
  crumb check and the pack release. `bindFinancierCells` (`financier-native.ts`) binds
  each cold-tray request to a `persistent-rack/1` cell and refuses an incompatible cell.
  The recipe parser accepts only the mould profile `matsunaga-financier-8p`. A save made
  during a transfer reopens and runs on. KIT-02 owns the cell, the attempt and the
  recording.
- **Café shift.** `parseCafeShiftRecipe` accepts at most 3 financier loads. The espresso
  machine is the Linea Classic S or the Eagle One, through the shared Rust/MuJoCo
  controller.
- **Morning and six-hour shifts.** `morningShiftRecipeInput` and
  `sixHourShiftRecipeInput` give the presets. Both have two workers, day-before mise en
  place, station roles and order priority. The six-hour preset is 21,600 s
  (`SIX_HOUR_SHIFT_SECONDS`), with two financier waves 75 minutes apart.
- **Mise en place.** `compileAfternoonPrep` compiles the run of the day before, which
  starts 18 hours before the shift (`AFTERNOON_PREP_START_SECONDS_BEFORE_SHIFT`). It makes
  the sesame concentrate, the ginger decoctions, the shortcrust and the pie fillings.
  `extractCarryoverMiseEnPlace` moves the released lots into the opening stock of the
  next shift. It refuses a lot that passes its hold: 48 h, and 72 h for the meat fillings.
- **Shift levers.** The shift input can turn off each lever of the baseline:
  `miseEnPlace` (`day-before`, `same-morning`), `workers` (1 or 2), `stationRoles`,
  `orderPriority`, `milkJugs`, `strainers`, `barScale` and `cupWarming`. Other inputs are
  `demandPreset`, `shiftBreakPolicy`, `walkSpeedPreset`, `mouldCount`,
  `coolingGridSlots` and `reorderThresholdUnits`. The Portal form is
  `bakery-shift-author.tsx`, with the scopes `bounded`, `morning-shift` and
  `six-hour-shift`.
- **Shift results.** `shift-metrics.ts` measures waits, late orders, output, waste and
  resource use. `compareShiftCohort` takes a list of completed shift reports and gives
  the minimum, median and maximum of each metric. It compares explicit variants; it is
  not a population estimate.

### The workflow document

- `importScenario` makes a `bakery_workflow.v1` document (`WORKFLOW_DOCUMENT_SCHEMA`)
  from any `CompiledScenario`. A label comes from a label table, or from the task key.
- A document holds `title`, `recipe`, `scenario`, `world` (products, destinations,
  resources, storages, carriers, cells, stock), `demand` (limits, arrivals,
  dependencies, availability) and `workflows`. Each workflow has nodes and edges.
- A node is a `step` with a task body. The body is the engine task without its key and
  prerequisites, because the edges supply them. An edge from an inspection carries the
  branch `accept` or `reject`; another edge has `null`.
- `lowerWorkflowDocument` gives the `CompiledScenario` back. An unedited document lowers
  to the digest of its compiler.
- `parseWorkflowDocument` is the persistence boundary. The schema checks the shape, the
  engine reader (`readScenario`) checks each body, and a branch must match the task's
  condition.
- An imported document is a snapshot. After an edit, it does not follow its compiler.

### The page

The recipe views of the Production page (KIT-01 owns the page) show the graph. The
views are siphon, latte, black sesame, ginger tea, the three financier stages, the café
shift and the pastry bench. The engine workspace shows a `compiled` source with no fixed
animation.

- The view has three surfaces: Factory (the 3D scene), Workflow (the graph) and Split.
  Split moves between 30 % and 68 %, and it hides at 840 px or less. The browser
  storage of each viewer keeps the Split position. It is 48 % when no position is kept.
- The graph component is `RecipeWorkflowGraph`. A step is 176 × 68 px on a grid of
  248 × 108 px (`packages/bakery-workflow/src/layout.ts`). A chain wraps after five
  ranks. Zoom is 40 % to 150 %.
- A large recipe opens as an overview of its workflows. This happens when it has more
  than 64 steps (`LARGE_RECIPE_STEPS`) and more than one workflow. A select opens one
  workflow.
- The tools are Select, Pan, Add step, Add wait, Add decision, Undo and Redo. The draft
  group has Run draft (or Run proposal) and Apply. A selected step opens the Step details
  panel. Each wire edit also works from the panel fields. At 640 px or less, the graph
  is a list.
- The look follows `docs/workflow-canvas-design-profile.md`. The port hues are local
  values in `recipe-workflow-graph.css`, one for each step kind.

For every step, a person can change the name, the priority, the earliest start and the
steps that it needs ("This step needs"). Each kind adds its own fields:

| Step kind       | Executor     | A person can also change                                      |
| --------------- | ------------ | ------------------------------------------------------------- |
| Work            | `attended`   | Seconds, workers, start and finish places                     |
| Wait or process | `declared`   | Seconds                                                       |
| Machine         | `batch`      | The program, from those that its machine declares             |
| Robot           | `native`     | The skill, from the skills of the same cell in this recipe    |
| Decision        | `inspection` | The rule: a person, scripted outcomes, or a measurement range |

Every step can take and lose arrows. A new work step gets the first worker of the world.

### The shared draft

- Each recipe and each set of its inputs has one workflow id, from `recipeWorkflowId`:
  the recipe name and 16 hex characters of a digest. The pattern is
  `^[a-z0-9][a-z0-9-]{0,127}$`.
- The first person who can apply and opens a recipe with no revision applies the
  compiled recipe as revision 1. Before that, a viewer gets a local draft that nobody
  can apply.
- The draft starts from the applied revision. It is a `workflow_draft` room (FND-10) in
  the Organisation Actor, with the roots `nodes`, `edges` and `positions`. Each entry is
  one whole value, so the later write wins for one step.
- A viewer reads the room. An operator, an admin and the owner edit it.
- The room checks the identity of the person and the execution state of the
  Organisation when it opens. If no revision is applied, it refuses with
  `bakery_workflow_not_found` (404).
- A draft can hold a cycle or a missing prerequisite. Only `compileDraft` refuses it,
  before a run or an apply. Each problem names its step when the engine names one.
  `compileDraft` also refuses a work step with no worker, a step that a branch arrow and
  a path outside that branch both reach, and a step inside an arm that cannot skip.
- When a revision changes or a proposal is staged, the room sends `revision_changed`,
  and open pages read the workflow again.

### Decisions and branches

- A person draws arrows only. `compileDraft` sets each guard by the arm rule. If every
  path to a step passes one branch arrow, the step is inside that arm. A step that both
  arms reach is a join, and it has no guard. It starts when each prerequisite is
  completed or skipped.
- A later decision is deeper, so its guard replaces an earlier one. A decision inside an
  arm skips with that arm.
- A step inside an arm can only be work, a wait or a decision. It cannot move a tray,
  release a lot, or run a robot or a machine.
- An inspection with no rule stops the run in `awaiting-inspection` until a person
  decides. A `scripted` rule gives the outcome for each arrival, and the last outcome
  repeats. A `measurement` rule accepts when an earlier measured lot of the same
  instance is inside its range.
- Each rule outcome writes a `decision-taken` event. A replay reads the event and does
  not decide again.
- Cycles stay refused (`cyclic_tasks`). A decision has two outcomes.

### Run, compare and apply

- Run draft (`recipe-draft-run.ts`) runs the applied revision and then the draft, in one
  new browser execution worker. The run on the page does not change. Each pending
  inspection gets the review outcome of the comparison.
- The **Simulated comparison** panel shows the two results: status, end time, completed
  and skipped tasks, late orders, and a task timeline with a lane for each task.
- After a run on the applied revision, the page of an owner or an admin sends its
  findings to the Worker. A finding is `run_blocked`, `task_failed`, `recovery_failed`,
  `decision_rejected` or `late_order`, with identifiers and numbers only. A late order
  waited more than 900 s (`ORDER_TARGET_SECONDS`), or it did not finish. An order that
  did not finish has a `waitSeconds` of `null`.
- Apply compiles the draft as it is now and sends the document with the digest that the
  person last saw. A changed head gives "Another person applied a newer revision".
- The fixed animation is a view (`recipe-clock.ts`). A changed duration stretches its
  stage. An added step holds the scene for at most 10 animation seconds (`MAX_HOLD_S`).
  A skipped arm takes no time. A removed or reordered stage shows "This animation shows
  the original recipe."

### Agent proposals

1. A person asks in the Portal chat. The canvas composer and **Ask the agent** only put
   words in the chat box. The person sends them, so no turn starts by itself.
2. The agent calls `recipe_workflow_read`: the list of recipes, or one recipe with its
   digest, steps, arrows, last-run findings and the count of proposals that wait. The
   list holds at most 50 applied workflows, newest first.
3. The agent calls `recipe_workflow_propose` with the base digest, 1 to 32 changes
   (`MAX_WORKFLOW_CHANGES`), at most 16 finding ids and one reason. The reason is not
   empty and has at most 300 characters. Each finding id must be in the stored findings
   of the current digest. The change kinds are `add_step`, `add_decision`,
   `remove_node`, `connect`, `disconnect` and `set_step`. `add_step` adds only a work
   step or a wait.
4. The Worker applies the changes to the applied revision and runs `compileDraft`. A
   refusal returns the problems and stores nothing.
5. A step that a person changed in the shared draft refuses the proposal with
   `human_intervention`. A changed base refuses it with `revision_conflict`.
6. The proposed document goes to R2 under its digest. The proposal is an
   `operator_configuration_draft` of the family `workflow_change`, with a card in the
   chat (COM-05).
7. The page draws the proposal in a review mode over the applied graph. It has the badges
   **Added** and **Changed**, a list of removed steps, the reason, **What went wrong** and
   **What changed**. Run proposal runs the comparison. Before that, the panel says "Not
   simulated yet."
8. Approve or Decline is in the panel or on the chat card. Approve writes the revision
   with the proposal, Session, turn and operation ids. It then merges the proposal into
   the shared draft as one update, so other draft work stays.

- The badges come from `workflowDiff`, never from a model. The change summary of a
  proposal (`proposalChangeSummary`) holds the labels of the added, changed and removed
  steps and the count of changed arrows.
- After an approval, the badges stay until the next revision: the current read returns
  the replaced revision.
- The approval also moves each step that the reviewed layout moved. A step that a person
  moved in the draft keeps its place.

## Contracts

- **Package** `packages/bakery-workflow` (`@purin-labs/bakery-workflow`): `index.ts`
  (document, importer, lowering, parser), `draft.ts` (seed, `compileDraft`, arm rule,
  `workflowDiff`, step field editors), `changes.ts` (proposal changes, overlap, merge,
  summary), `findings.ts` (`runFindings`, `FINDINGS_LIMIT` 64) and `layout.ts`.
- **Draft document** `packages/workflow-canvas-crdt/src/draft.ts`, `draft-shape.ts` and
  `draft-protocol.ts`: schema `workflow_canvas_crdt.v2`, protocol
  `workflow_draft_sync.v1`, at most 512 steps (`DRAFT_OBJECT_LIMIT`) and 2,048 arrows
  (four times the limit), labels of 200 characters, state and update of 768 KiB,
  positions inside `DRAFT_BOUNDS` (0–8,000 × 0–4,000).
- **Engine** `packages/production-simulation`: `scenario.ts` (`TaskExecutor`,
  `DecisionGuard`, `DecisionRule`, `SCENARIO_SCHEMA_VERSION` 5), `admission.ts`
  (`admitScenario`), `inspections.ts` (`ruleOutcome`) and `src/recipes/bakery/`.
- **Portal** `areas/kitchen/ui/features/production-run/`: `recipe-workflow-graph.tsx`,
  `recipe-graph.ts` (sources and stage bindings), `recipe-workflow.tsx` (surfaces),
  `recipe-clock.ts`, `recipe-draft-run.ts`, `recipe-workspace.ts` (requests),
  `workflow-draft-client.ts`, `draft-placement.ts` and the recipe folders.
- **Regional D1** (`migrations-regional/0001_current_schema.sql`): `bakery_workflow`
  (`workflow_id`, `recipe`, `title`, `current_revision`) and `bakery_workflow_revision`
  (`revision`, `digest`, `base_digest`, `scenario_digest`, `applied_by`, `applied_at`,
  `proposal_id`, `session_id`, `turn_id`, `operation_id`). The revision row is the
  receipt.
- **R2** (binding `ARCHIVE`): `bakery-workflows/<org>/<digest>` holds each applied
  revision and each proposed document as canonical JSON. A read checks the SHA-256.
  `bakery-workflows/<org>/findings/<workflowId>` holds the findings of the last run. The
  apply route reads a body of at most 1 MiB (`MAX_WORKFLOW_DOCUMENT_BYTES`) and 256
  bytes. A proposed document has no size check.
- **Actor SQLite:** `workflow_draft` in the Organisation Actor
  (`actors/workflow-draft.ts`), one row for each workflow id.
- **Domain code** `areas/kitchen/server/bakery/workflow-revisions.ts` (store,
  apply, findings, `readAppliedWorkflowHead`) and `workflow-proposals.ts` (prepare,
  approve, open proposals). The port `kitchen/contract/workflow-changes.ts` gives the
  approval to the configuration draft.

Routes under `/v1/control/organisations/:id/bakery/workflows/:workflowId`
(`control/admission/bakery-workflows.ts`, `control/routes/bakery-workflows.ts`):

| Route                                           | Role                            | Purpose                                                                                            |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET`                                           | Viewer                          | The applied revision, the replaced revision, the findings and the person's 5 newest open proposals |
| `GET /socket`                                   | Viewer                          | The shared draft room                                                                              |
| `POST /apply`                                   | Admin                           | Apply a document with its base digest                                                              |
| `POST /findings`                                | Operator                        | Record the findings of a run on the current digest                                                 |
| `GET /proposals/:draftId`                       | The person who asked            | Read one proposal and its document                                                                 |
| `POST /proposals/:draftId/approve`, `…/decline` | Admin, and the person who asked | Decide a proposal                                                                                  |

An open proposal is pending and not expired. `GET` and `recipe_workflow_read` return
at most the 5 newest open proposals of the person.

The error codes are `bakery_workflow_invalid`, `bakery_workflow_refused`,
`bakery_workflow_stale`, `bakery_workflow_human_intervention`,
`bakery_workflow_proposal_closed`, `bakery_workflow_not_found`,
`bakery_workflow_too_large` and `bakery_workflow_unavailable`. The draft room gives
`bakery_workflow_too_large` (422) when the applied revision does not fit a draft.

Agent tools in `areas/kitchen/server/agent-tools/kitchen/recipe-workflow.ts`, with the
handlers in `handlers.ts` and `turn-services.ts`:

| Tool                      | Capability                         | Effect   | Rerun                                                           |
| ------------------------- | ---------------------------------- | -------- | --------------------------------------------------------------- |
| `recipe_workflow_read`    | `commerce.recipe_workflow.read`    | Read     | Any caller                                                      |
| `recipe_workflow_propose` | `commerce.recipe_workflow.propose` | Proposal | A script only; the same content returns the proposal that waits |

Both capabilities are in `authorization/capability-catalogue.ts` and need
`scripts/capability-policy-backfill-sql.mjs`. The configuration draft operation is
`bakery.workflow_change`.

## Rules and limits

| Action                                          | Viewer | Operator | Admin and owner      | Agent                                                               |
| ----------------------------------------------- | ------ | -------- | -------------------- | ------------------------------------------------------------------- |
| See the graph, run and compare a draft          | Yes    | Yes      | Yes                  | No                                                                  |
| Edit the shared draft                           | No     | Yes      | Yes                  | No                                                                  |
| Apply a revision, record findings from the page | No     | No       | Yes                  | No                                                                  |
| Read the applied workflow and findings          | Yes    | Yes      | Yes                  | `recipe_workflow_read`                                              |
| Propose a change                                | No     | No       | Yes                  | `recipe_workflow_propose`, for an admin or owner in the Portal chat |
| Read, approve or decline a proposal             | No     | No       | The person who asked | No                                                                  |

- **Only the person who asked.** A proposal holds model text from a private chat. The
  tool refuses a turn that is not from the Portal chat, and a person who is not an owner
  or an admin. The routes answer `bakery_workflow_not_found` to another person.
- **No tool applies.** Only the approval of the person writes a revision. A repeated
  approval of a settled proposal writes nothing and returns the receipt of the current
  revision. A repeated apply of the current document returns its receipt and writes
  nothing. An approval that stops after the claim runs again on the next approval.
- **Stale base.** An apply or an approval on a base that is not the current head gives
  `bakery_workflow_stale`. A step of the proposal that a person changed in the draft
  gives `bakery_workflow_human_intervention`. `POST /findings` for a digest that is not
  the current head gives `bakery_workflow_stale`. Its body is at most 64 KiB.
- **Time limits.** A proposal expires after 1 hour (`OPERATOR_DRAFT_TTL_MS` in
  `actors/session/proposal-staging.ts`). A draft merge has a deadline of 30 s. Revisions
  have no time limit.
- **Retention.** The Organisation purge erases `bakery_workflow` and
  `bakery_workflow_revision` (`data/purge-catalogue.ts`). The draft lives in the
  Organisation Actor.
- **Information flow.** An agent read enters the turn under the `recipe_workflow`
  source label, which every member reads (`policy/information-flow/source-labels.ts`).
  The tool tells the agent that step labels are data, not instructions. A recipe title
  goes through `untrustedDeviceText`. A finding holds identifiers and numbers only.
- **Cost.** A page open writes no row when the revision and the draft row exist. The
  room keeps the person's state in the socket attachment, not in storage. The first
  open writes the draft row one time. Each comparison of an admin writes one R2
  object for the findings. No cron, alarm or poll belongs to this subsystem.
- **Out of scope:** edits inside a running run; free loops; generated code in a step;
  new robot skills from the canvas; a tray move or a native task inside an arm; more
  than two outcomes for one decision; proposal cards in Slack; an optimizing scheduler.
- **KIT-01** owns the Production page, the `schedule.ts` financier shift, the
  `bakery_procedure` entities and the `workflow_canvas` room of saved runs. A recipe view
  shares only the browser engine worker with it.
- **KIT-02** owns the cells, the native attempts, the recordings and the equipment
  models. **KIT-04** owns Costs & margins.
- **Plan 24** owns physical bake runs. A bake proposal and a stock level name an applied
  workflow by id, revision and digest (`readAppliedWorkflowHead`). A revision gives no
  dispatch authority.
- **FND-10** owns the room protocol. **FND-09** owns the tool catalogue. **FND-07** owns
  the labels. **COM-05** owns configuration drafts and their chat card.
- The Recipes page (`features/recipes/`) edits the ingredient quantities of commerce
  recipes. It does not read a workflow.

## Open work

- **Plan 61A intake.** The operator intake of the oven, its program, the recipe
  revision, observed masses and named moulds is not built. The financier inputs are
  assumptions.
- **Plan 61A geometry.** The mould and carrier geometry, the loaded stability and the
  payload are not qualified. The cold carrier stays a rehearsal until it passes.
- **Plan 61A views.** The native recipe handling is not connected to the synchronized
  native views. The finishing rehearsal still exists: `financier.ts` starts from a
  `rested-batter` lot, and `schedule.ts` derives output from `piecesPerTray`. Remove it
  when its users move to the complete recipe.
- **Plan 61A commands and archives.** Persistent agent commands for the financier run
  and the save of large native archives are open.
- **Plan 61A acceptance.** The full journey (three loads, two moulds, a delayed oven, an
  interrupted cold transfer, a refused profile, save and reopen) has no single
  repository journey with a portable evidence packet.
- **Calibration.** Plans 61A and 61E have no observed production data. Timings, payloads
  and release criteria are assumptions. Unattended server execution of a shift is not
  built: a closed browser does not continue a run.
- **Plan 84 later slices.** Bounded retry, a tray reject route, a typed node reference in
  `AdmissionProblem` and a shared review by a second admin are not built. A failure
  preset (`check`) stays in its animation and does not lower to a scripted decision.
- **Retention.** No code deletes the objects under `bakery-workflows/<org>/` in R2. A
  declined or expired proposal keeps its document.
- **IFC guide.** `foundation/authority/policy/information-flow/README.md` does not list
  the `recipe_workflow` source.
- **Canvas checks.** No journey checks pan, zoom, Space or the wheel. The wire check is a
  local script. The canvas height inside the signed-in Portal route is not checked.
- **Draft positions.** A draft made before the step labels keeps rows 84 px apart, and a
  step that a person adds keeps its place, so a late join can make one long wire.

## Sources

- [Plan 84](../../../history/plan-84-general-workflow-canvas.md),
  [Plan 61A](../../../history/plan-61A-financier-workflow.md),
  [Plan 61E](../../../history/plan-61E-combined-cafe-shift.md) and the
  [workflow canvas design profile](../../../workflow-canvas-design-profile.md). Where they
  differ from the code, this spec follows the code. The recipes:
  [financiers](../../../recipes/financiers.md), [pies](../../../recipes/pies.md) and the
  [bar mise en place](../../../recipes/bar-mise-en-place.md). Plan 61B is on hold, and
  Plans 61C and 61D are in the archive.
- Evidence in the archive: Plan 84
  [Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-1.md),
  [Phase 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-2.md),
  [Phase 3](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-3.md),
  [Phase 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-4.md),
  [Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-5.md);
  Plan 61A
  [preparation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-ingredient-preparation.md),
  [mould cycle](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-mould-cycle.md),
  [operator inspections](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-operator-inspections.md),
  [shared saves](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-shared-saves.md),
  [cold carrier](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61A-cold-carrier-handling.md),
  [mould intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/matsunaga-financier-8p/README.md);
  Plan 61E
  [café shift](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/cafe-shift-20261018.md),
  [café shift release](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/cafe-shift-release-20261019.md),
  [morning shift](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-morning-shift.md),
  [six-hour evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-61E-six-hour-evidence.md);
  the
  [design profile images](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile).
- E2E journeys in `services/platform/tests/e2e/`: `bakery-workflow-draft.test.ts` (two
  people, offline edits, one revision) and `bakery-workflow-agent.test.ts` (the agent
  proposal, approval and each refusal), with `workflow-draft-peer.ts`.
- Browser journeys in `scripts/plan-84/`: `browser-draft.js` and `browser-proposal.js`.
  They run through `scripts/plan-74/run-browser.py` and are not in a journey index.
- Journeys in `scripts/production-simulation/`, indexed in its `journeys.json`:
  - Plan 84: `verify-workflow-document-journey.mjs`,
    `verify-workflow-branch-journey.mjs`, `verify-workflow-findings-journey.mjs`,
    `verify-schedule-layout-journey.mjs`, `verify-workflow-graph-browser.js`,
    `verify-workflow-edit-browser.js`, `verify-workflow-branch-browser.js`,
    `verify-workflow-engine-edit-browser.js`, `verify-recipe-workflow-browser.js` and
    `verify-recipe-split-browser.js`.
  - Plan 61A: `verify-financier-journey.mjs`, `verify-native-financier-journey.mjs`,
    `verify-oven-financier-journey.mjs`, `verify-financier-cold-handling.mjs`,
    `verify-financier-journey-browser.js` and `verify-oven-financier-browser.js`.
  - Plan 61E: `verify-bakery-shift-journey.mjs`, `verify-morning-shift-journey.mjs`,
    `verify-six-hour-shift-journey.mjs`, `verify-recipe-appliance-wasm.mjs`,
    `verify-morning-shift-browser.js` and `verify-six-hour-shift-browser.js`.
