# Plan 84 — General workflow canvas for Satyr Kitchen

Status: Phases 1 to 4 pass locally ([Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-1.md),
[Phase 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-2.md), [Phase 3](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-3.md),
[Phase 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-4.md)). The code is live since 3 November 2026, and J8
passed in production ([Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-84-phase-5.md)). The plan is complete. D7 is decided (2026-11-14): the old financier canvas editor (`ProcedureCanvas`, its chat panel and the procedure canvas room) is removed. `schedule.ts` and the `bakery_procedure` entity stay, because the financier shift, the factory views and the pastry bench still run on them. The removal is released
(2026-11-14, satyr-edge `8fd003df`, ref `refs/backup/released-2026-11-14-plan-84-d7` = the Plan 86 Phase 6
release plus the two D7 commits). Date: 3 November 2026. The owner accepted the
defaults of decisions D1–D8 on 3 November 2026.
Owners: Satyr platform and Portal.

This plan builds on [Plan 42](plan-42-bakery-workflow-simulator.md),
[Plan 42F](plan-42F-general-orchestration.md),
[Plan 40C](plan-40C-multiplayer-module.md) and
[Plan 81](plan-81-agent-portal-control.md). The
[status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-release-readiness.md) stays the record of what Plan 42 closed.
The public name is Satyr Kitchen. Code identifiers keep `bakery`.

## Outcome and scope

An operator opens any recipe in Satyr Kitchen and sees its real workflow: steps, real
prerequisites and decision branches. The operator edits that workflow on the canvas, runs
the draft in simulation and compares the result with the applied revision. An agent can
propose a change. The canvas marks each changed node as **Added**, **Changed** or
**Removed**, and a summary states **What went wrong** and **What changed**. A person
approves the change, and the Platform keeps a receipt.

In scope:

- One typed workflow definition for every recipe in the persistent engine, and for the
  eight recipe simulations of the 3 November Workflow view.
- Canvas editing of steps, prerequisites, resources, durations and decisions.
- Decision branches in the persistent engine.
- Agent proposals through the existing policy, approval, receipt and replay boundaries.

Out of scope:

- Physical dispatch. [Plan 24](plan-24-cafeos-bakery-automation.md) owns it. A workflow
  revision has no physical, stock or shipment authority.
- Edits inside a running run. Plan 42 keeps this rule, and `commands.ts` states it: a
  recipe edit starts a separate comparison run.
- New robot skills from the canvas. A native step selects a skill that its cell declares.
- Free loops, and generated code inside a node.
- The financier shift scheduler `schedule.ts` and its seven-operation procedure. They stay
  (D7, 2026-11-14).
- Proposal cards in Slack. Plan 81's Slack path can add them later.

The owner's reference design reached this plan only as a description: an agent-managed flow
canvas, branch nodes, "Added" badges and a summary. Check the visual match against the
original image at the Phase 2 mock review.

## Facts from the code

### Five forms of a workflow exist today

| Form                | Where                                                                                                        | Graph                                                          | Editable                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------- |
| Financier procedure | `packages/bakery-model/src/bakery-procedure.ts`, drawn by `ProcedureCanvas` (removed by D7)             | Seven fixed operations in `PROCEDURE_CANVAS_POSITIONS`         | Minutes of one operation (1–60), and the Bake oven |
| Appliance workflow  | `packages/bakery-model/src/bakery-appliance-workflow.ts`, used by saved-run canvases                    | Four recipes. Each operation has one `predecessor`             | Node positions only                                |
| Engine graph        | `WorkflowDefinition` in `packages/production-simulation/src/scenario.ts`, drawn read-only by `OvenTaskViews` | Real `prerequisites`, claims, executors, material and carriers | No                                                 |
| Recipe input        | `parse*Recipe` and `compile*` in `recipes/bakery/`, with the recipe author forms                             | The compiler fixes the graph. The input sets values            | Values only                                        |
| Stage list          | `*TimelineStages` in eight `*-model.ts` files, drawn by `RecipeWorkflow`                                     | Timed list. Arrows show order only                             | No                                                 |

### The eight recipe simulations do not use the engine

The eight `*SimulationEngine` classes hold 6,338 lines. None of them imports
`@satyr/production-simulation` or Wasm. Each one computes a sample from a fixed time window.
So an edit on a canvas cannot change these animations without new work. D2 covers this.

The persistent engine has no compiler for latte or siphon. `schedule.ts` lists a siphon
coffee for the shift scheduler only. Financier, black sesame, ginger tea and café shift have
compilers. The three financier views (batter, bake, pack) show parts of one recipe.

### Measured graph sizes

Measured on 3 November 2026 from the compilers and the saved Plan 61E scenario.

| Recipe                              | Workflows | Task definitions | Largest workflow | Edges |
| ----------------------------------- | --------: | ---------------: | ---------------: | ----: |
| Financier, one load, no native cell |         3 |               39 |               25 |    37 |
| Black sesame, no native cell        |         2 |               26 |               20 |    25 |
| Ginger black tea, no native cell    |         1 |               14 |               14 |    14 |
| Pie                                 |         5 |               64 |               20 |    59 |
| Six-hour shift                      |        17 |              258 |               28 |   253 |

The six-hour shift has 12 inspections, 5 conditional tasks and 6 native tasks. It also has
35 dependencies across workflows. Its scenario file is 214 KB. Its largest workflow is
18 KB, and its largest task is 2.1 KB. I did not measure ginger milk tea and mixed tea,
because their compilers need a native cell.

### The canvas document holds positions only

- `WorkflowCanvasDoc` accepts one root, `positions`. It refuses an update that adds or
  removes an object (`object_conflict`), because the source owns membership.
- `CANVAS_BOUNDS` is 570 × 250. A 28-node workflow does not fit at the 230 × 116 node pitch
  of `OvenTaskViews`.
- `CANVAS_OBJECT_LIMIT` is 128. The largest workflow fits, but the six-hour shift does not.
- The state limit is 128 KiB and the update limit is 64 KiB. The largest workflow fits.
- `WorkflowCanvasSource` has two kinds: `procedure` and `saved-run`.

### The engine has one form of branch

- An `inspection` task stops the run in `awaiting-inspection`. The `inspect` command binds
  the task, the definition digest, the held lots, the outcome and a note.
- An `after-inspection` task runs on `accept` or `reject`. The other outcome records
  `task-skipped`.
- `taskFinished` counts `completed` and `skipped`. So a join after a branch already works.
- Conditional work is only `declared` or `attended`. It has no carriers and no releases.
- An inspection cannot be conditional, so nested branches are not possible.
- Skip does not spread. A later task without `after-inspection` runs even when its arm was
  skipped.
- `admitScenario` refuses cycles (`cyclic_tasks`). `AdmissionProblem.where` is a string for
  diagnostics. It is not a typed node reference.

### Agent boundaries that exist

- `workflow_canvas_read` and `move_object` change layout only. `CanvasMoveRequest` has
  an operation ID and an observed revision, and `human_intervention` stops an agent on an
  object that a person changed. The capability is `commerce.workflow_canvas.move`.
- `bakery_surface_*` tools are signed effects with receipts in the Session outbox
  (`bakery-surface-effect.ts`). `authorizedBakerySurfaceCommands` limits them to owners and
  administrators. `bakery_surface_edit_production` edits the financier draft only.
- `approveAgentScenarioSave` binds an approval to an exact effect, person and payload digest.
- `CanvasLastChange` records `initial`, `human` or `agent` for the document, not for a node.
- `services/platform` already imports `@satyr/production-simulation`, so a Worker can run
  admission. I did not measure the CPU cost for a large scenario. Phase 1 measures it.

## 1. One typed definition

Add the package `packages/bakery-workflow` (`@satyr/bakery-workflow`). It owns the document
as TypeBox schemas (Plan 78), the importers, the compiler to the engine and the diff.

```ts
type BakeryWorkflowDocument = Readonly<{
  schema: "bakery_workflow.v1";
  id: string;
  title: string;
  source: Readonly<{ recipe: string; inputDigest: Sha256Hex }>;
  world: BakeryWorkflowWorld;
  workflows: readonly WorkflowGraph[];
  demand: BakeryWorkflowDemand;
}>;

type WorkflowGraph = Readonly<{
  id: WorkflowId;
  demand: "order" | "production";
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}>;

type WorkflowEdge = Readonly<{
  from: TaskKey;
  to: TaskKey;
  branch: "accept" | "reject" | null;
}>;

type WorkflowNode = StrictUnion<
  | Readonly<{ kind: "step"; id: TaskKey; label: string; body: StepBody }>
  | Readonly<{
      kind: "decision";
      id: TaskKey;
      label: string;
      rule: DecisionRule;
    }>
>;
```

- `StepBody` is `TaskDefinition` without its key and `prerequisites`. Edges supply the
  prerequisites. So the document has one source for each prerequisite.
- `world` holds the products, destinations, resources, storages, carriers, cells and stock
  of `CompiledScenario`. The palette and the resource pickers read it.
- `demand` holds arrivals, dependencies, availability and limits. This matches the
  definition and scenario layers of Plan 42.
- The compiler lowers a document to `CompiledScenario`. `admitScenario` stays the only
  validator. This plan adds no second rule set and no new graph language.
- Each `AdmissionProblem` gains a typed node reference, so the canvas marks the exact node.

**Importers.** A generic importer reads any `CompiledScenario` and derives labels from task
keys, with a label table for each recipe. Every compiler becomes an importer through it. The
compilers stay, because they produce the first document. An imported document is a snapshot:
after an edit, it no longer follows the compiler. Changing a recipe input imports a new
document, and the canvas shows the diff against the old one.

**Latte and siphon.** Write `recipes/bakery/latte.ts` and `recipes/bakery/siphon.ts` from the
stage lists, with real prerequisites and `assumed` durations. Example for latte: the shot and
the steamed milk are two arms, and both must finish before the pour. The cobot claim still
keeps one-arm work in order. The canvas now shows why.

**Stage bindings.** Each of the eight views gets a table from `stage.id` to task keys. A
financier batter, bake or pack view binds to its part of one financier document. The view
stays one surface of one document.

**Storage (D3).** An applied revision is immutable and content-addressed in R2, by the same
method as `bakeryRunSnapshotPrefix`. A regional D1 table holds the index: workflow, revision
number, digest, author, receipt and the current pointer. A run pins the revision digest.
The D1 change ships with a patch script (`pnpm lint:d1-patch`).

This replaces one sentence of Plan 40C for this document: the entity plane does not hold
these revisions. The `bakery_procedure` entity stays (D7).

## 2. Edit any recipe on the canvas

**Page.** Keep the Factory / Workflow switch. The Workflow surface shows one canvas, with a
small toolbar: Add step, Add decision, Undo, Fit, Run draft and Apply. A selected node opens
the side drawer. Keep the page in one column, as the owner prefers. At phone width, show the
graph as a list with the same forms. Plan 42 requires a keyboard or form path for each drag.

**Component.** Add `WorkflowCanvas` in `apps/portal/src/features/workflow-simulator/`. It
takes a document, a run view and a draft client. It replaces the graph in `OvenTaskViews`
and `RecipeWorkflow`. Reuse `canvas-motion.ts`, `canvas-resize.ts`, the pointers and
`AgentCursors`. Reuse the rank layout of `graphNodes` for nodes without a position. I do not
add a graph library, because the collaboration parts already exist and need the same code.

**Shift scale.** A six-hour shift opens as an overview: one node for each of 17 workflows,
with the 35 cross-workflow dependencies. A click opens one workflow. So the limit of 128
objects stays, and the largest document has 28 nodes.

**What a person can edit:**

| Node                         | Editable                                                                                   | Locked                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Manual step (`attended`)     | Label, duration, workers, start and finish places, prerequisites, priority, earliest start | —                                                               |
| Wait or process (`declared`) | Label, duration, prerequisites                                                             | —                                                               |
| Machine (`batch`)            | Program, from those that the machine declares, prerequisites                               | Load and unload pairing                                         |
| Transfer (carrier step)      | Worker, duration, prerequisites                                                            | Route, unless both places exist in `world` and admission passes |
| Native (`native`)            | Prerequisites, skill from the cell's list                                                  | Cell, parameter digest                                          |
| Decision                     | Question, rule, arms                                                                       | —                                                               |

Admission decides material and carriers. If a person removes a step that supplies a lot, the
draft stays, the Run button refuses, and the drawer names both nodes. A draft can hold
missing edges and cycles. Plan 42 already sets this rule.

**Shared draft.** Add `workflow_canvas_crdt.v2` and `workflow_canvas_sync.v3`, on the Plan 40C
room:

- Roots: `nodes`, `edges`, `positions`. Each entry is one whole value under a stable ID, so
  the later write wins for one node. The schemas parse each value at the room boundary.
- The document now owns membership. `CanvasEncoding` and `validateDocument` change for this.
- Add the source kind `{ kind: "workflow"; workflowId }`, with the document prefix `workflow:`.
- Raise `CANVAS_BOUNDS` to 8,000 × 4,000 in v2. The tool schemas read the same constant.
- Keep the 128 KiB and 64 KiB limits. Measure them in Journey J3, and raise them only if
  the journey fails.
- v1 rooms for `procedure` and `saved-run` stay unchanged.

**Run and compare.** Run draft lowers the draft, admits it and starts a separate run in
`execution-worker.ts`. The applied run stays as it was. The result uses the comparison views
that exist (`factory-comparison.tsx`) and the shared cursor. Apply binds the draft digest,
writes an immutable revision and a receipt, and rebases the draft.

**The eight animations (D2).** The engine owns state, and the animation is a view. The new
shared clock in `recipe-workflow.tsx` maps engine task times to model time through the stage
bindings:

- A changed duration stretches that stage window. The animation stays correct.
- An added step has no animation. The scene holds its pose and shows the step label.
- A skipped arm jumps over its window.
- A removed or reordered stage cannot play correctly. The Factory view shows the message
  "This animation shows the original recipe", and the timeline and canvas stay correct.
- A failure preset (`check`) lowers to a scripted decision, so the engine and the animation
  state one outcome.

## 3. Branch nodes and how each engine runs them

| Engine                                       | Runs the document           | Branch behaviour                                                                                |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| Persistent engine with Rust and MuJoCo cells | Yes                         | Full. A cell receives only tasks that the engine dispatches, so `bakery-native` does not change |
| Eight fixed animations                       | No. They show an engine run | They follow the taken arm through the stage bindings                                            |
| Financier shift, `schedule.ts`               | No                          | None. No change                                                                                 |
| Appliance workflow, saved runs               | No                          | None. Its canvas stays layout only                                                              |

**Arm rule.** The compiler derives arm membership from the graph. If every path from the
roots to a node passes one branch edge, the node is inside that arm. A node that both arms
reach is a join, and it runs after both settle. Skip counts as settled, as `taskFinished`
does today. So the person draws edges only, and the compiler sets each guard.

**Slice 3A: no engine change.** A decision with an operator rule lowers to `inspection`, and
its arm steps lower to `after-inspection`. The ginger milk tea recipe already runs this form.
The limits remain, and the drawer states them before Run: an arm holds only manual or wait
steps, with no tray move and no nested decision.

**Slice 3B: engine schema 6.**

- Replace the single condition with a guard list on any executor except `batch` and
  `native`. A guarded inspection makes nested decisions possible.
- A task skips when a guard is false, or when its guard decision was skipped.
- Add decision rules:

```ts
type DecisionRule = StrictUnion<
  | Readonly<{ kind: "operator"; question: string }>
  | Readonly<{ kind: "scripted"; outcomes: readonly ScriptedOutcome[] }>
  | Readonly<{
      kind: "measurement";
      measurement: MeasurementId;
      accept: MeasurementRange;
    }>
>;
```

- `operator` stops the run and waits. This behaviour exists today.
- `scripted` states the outcome for each arrival occurrence. A what-if run uses it, and
  the run does not stop.
- `measurement` reads an accepted value from an earlier measured output.
- Each result records a new `decision-taken` event. Replay reads the event and never decides
  again, so a run stays deterministic.
- Generalize the conditional material check in `admission.ts`, which today has one decision
  for each amount.
- Raise `SCENARIO_SCHEMA_VERSION` to 6 and build a new execution bundle. A saved run resumes
  through the retained bundle that it names, so old runs do not change. A file with an old
  definition gets a clear refusal, and its recipe compiles again.

**Not in the first release (D6):**

- Cycles. `admitScenario` keeps its refusal.
- Bounded retry. It compiles to at most three copies of an arm. It is a small later slice.
- More than two outcomes. Two nested decisions express them.
- Tray moves and native tasks inside an arm. `scenario.ts` states that carrier routes stay
  unconditional. My reason to keep this rule: later steps depend on a known tray place. A
  real reject route for a tray needs its own design.

## 4. Agent changes on the canvas

Human, agent and future machine actions use the same boundaries. The agent gets no separate
path to change a recipe.

**Tools.**

| Tool                              | Effect                                                                                             | Capability                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `workflow_canvas_read` (extended) | Reads nodes, edges, the revision and the current admission problems                                | Its existing read rule                 |
| `workflow_run_findings`           | Reads typed findings from a pinned run                                                             | The same read rule                     |
| `workflow_canvas_propose`         | Stores a proposal. Changes nothing that a person or a run uses                                     | `commerce.workflow_canvas.propose`     |
| `bakery_surface_compare_workflow` | The attached page runs the base and the proposal in simulation. A signed effect returns the result | Existing owner and administrator limit |

No tool applies a proposal. Only a person's approval does this. A new capability needs
`scripts/capability-policy-backfill-sql.mjs` on each regional database, and a refusal raises
the permission prompt in context. It never sends the person to the Access page.

**Flow.**

1. A person asks in the chat beside the canvas. A failed run also offers an **Ask the agent**
   button. No turn starts by itself (D8).
2. The agent calls `workflow_canvas_read` and `workflow_run_findings`.
3. The agent calls `workflow_canvas_propose` with at most 32 typed changes, the base revision
   digest, the finding IDs and a short reason. Change kinds are `add_step`, `add_decision`,
   `remove_node`, `connect`, `disconnect` and `set_step`.
4. The Worker applies the changes to the base, lowers the result and runs `admitScenario`.
   If admission fails, the tool returns the problems for each node and stores nothing.
5. The canvas draws the proposal over the applied revision, in a separate layer (D4). The
   shared draft does not change.
6. The attached page runs the comparison. Without an attached page, the summary says
   "Not simulated yet", with a Run button.
7. An owner or administrator selects Approve or Decline, in the drawer or the chat card (D5).
8. Approve binds the proposal digest and the base digest, and it writes a new revision and a
   receipt. Any unapplied draft work that the proposal does not touch stays in the draft.

**Refusals.**

- A base revision that changed gives `revision_conflict`.
- A node that a person changed after the agent's read gives `human_intervention`, by the rule
  of `move_object`.
- The same operation ID with other content gives `operation_conflict`. The same ID and the
  same content return the same proposal.
- A second approval of one proposal returns the first receipt and writes nothing.

**Replay.** Add rules to `pi-tool-replay.ts`. Any caller can repeat the two read tools. Only a
script can repeat `workflow_canvas_propose`, because the receipt owner answers from the first
receipt. A direct call keeps the existing rule: an operator resolves it, and the turn waits.

**Badges.** A pure `workflowDiff(base, proposed)` in `@satyr/bakery-workflow` gives Added,
Changed and Removed for nodes and edges. No model writes a badge. Each badge has text and an
icon, not only a color. Unchanged nodes have no badge. After approval, the badges stay until
the next applied revision. The diff also serves a person's draft and a re-import.

**Summary.** The summary has two parts, and the data has one source for each claim:

| Part            | Source                                                                                                                                                                                                                         | Model role                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| What went wrong | Findings from accepted run events: `task-failed`, `recovery-failed`, a rejected decision, lateness from the shift metrics, and waits from `wait-explanation.ts`. Each finding names an event and moves the shared cursor to it | Selects findings and writes one short reason        |
| What changed    | `workflowDiff` and the comparison result, such as "Late drinks 7 → 0"                                                                                                                                                          | Writes one reason for each change. Writes no number |

The page labels each result as simulated. A number with no comparison result does not appear.

**Receipts.** Add `bakery_workflow_receipt.v1` with the workflow, the proposal, the base and
new digests, the approver, the Session, the turn, the operation and the time. A person's own
Apply writes the same shape, with no Session. The Brain and chat timeline can read it later.

**Information flow.** A proposal's reason and labels are model output from a turn with a flow
label. Store the turn's `FlowBinding` with the proposal, and check it on each read, each chat
delivery and each restore. Node text carries its restriction through revisions, summaries and
forks. Update the [IFC guide](../services/platform/src/policy/information-flow/README.md), run
`pnpm lint:ifc-boundaries`, and add the allowed and denied journey J7.

## 5. Phases, costs and acceptance

Costs are my estimates in agent days, with one session at work. I did not measure them. The
sum is 35–48 agent days. Each phase ends with a product that a person can use, so the owner
can stop after any phase. Phases 3 and 4 can run at one time after Phase 2. Slice 3A is
enough for Phase 4.

| Phase                       | Result for the operator                                            | Main changes                                                                                                                 | Cost  |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1. Definition and true view | Every recipe shows real prerequisites, read-only                   | `@satyr/bakery-workflow`, importers, latte and siphon, stage bindings, read-only `WorkflowCanvas`, typed admission locations | 6–8   |
| 2. Edit and compare         | A person edits any recipe, runs the draft, compares and applies it | CRDT v2, room, revision store and patch, drawer, palette, run path, animation clock                                          | 11–15 |
| 3A. Simple branch           | A person adds an operator decision with two arms                   | Lowering, arm rule, node limits                                                                                              | 2–3   |
| 3B. Full branch             | Nested, scripted and measured decisions                            | Engine schema 6, events, admission, new bundle                                                                               | 6–8   |
| 4. Agent                    | Proposals, badges, summary, approval and receipt                   | Tools, capabilities and backfill, proposal store, overlay, findings, comparison effect, IFC                                  | 8–11  |
| 5. Release                  | Production proof, then the D7 decision                             | Patch and backfill, deploy, live journey, ledger and `AGENTS.md`                                                             | 2–3   |

Running cost is small. A revision is about 233 KB in R2 for the largest document, measured in
Phase 1. A proposal costs one model turn on the Organisation's pinned route. No automatic turn
exists under the D8 default.

### Changes to this plan from Phases 1 and 2

- **Typed admission locations.** The draft compile reads the task from `AdmissionProblem.where`. A
  typed field in `admission.ts` needs a new execution bundle, so it waits for Phase 3B.
- **`OvenTaskViews`.** It keeps its task graph, which shows run instances and their state. The new
  graph stands beside it on the engine workspace until a later phase merges them.
- **The name `WorkflowCanvas`.** The component is `RecipeWorkflowGraph`. The `decision` node kind waits
  for Slice 3A, because an imported recipe keeps its `inspection` and `after-inspection` executors.
- **Draft limits.** One draft holds one recipe, not one workflow, so a shift has one room. The limits
  are 512 steps and 768 KiB, the same state limit as the menu draft. The protocol name is
  `workflow_draft_sync.v1`, and `CANVAS_BOUNDS` stays for v1 rooms. `DRAFT_BOUNDS` is 8,000 × 4,000.
- **First revision.** The Worker cannot prepare a native cell, so the first person with the right
  applies the compiled recipe as revision 1 when the page opens. A viewer before that gets a local
  draft.
- **Animation clock.** It takes proportions from draft durations, not engine events (D2 still holds).
  An added step holds for at most 10 animation seconds.
- **Stage bindings.** One recipe task can span several animation stages. The financier `mix` task
  covers three batter stages. The eight animations and their recipes can also differ in order.
- **Connecting.** A person selects **+** on a step and then the step that needs it, or uses the check
  boxes in the drawer. Dragging an arrow can come later, because this path also serves the keyboard.

### Changes to this plan from Phases 3 and 4

- **Slice 3A needed the engine.** Admission required `releases` on an inspection. Slices 3A and 3B
  share one additive change and one new bundle, and `SCENARIO_SCHEMA_VERSION` stays 5.
- **Agent tools.** `recipe_workflow_read` and `recipe_workflow_propose`, with the capabilities
  `commerce.recipe_workflow.read` and `commerce.recipe_workflow.propose`. The read holds the findings.
  The name `workflow_canvas_read` stays with the old procedure canvas.
- **Comparison.** A person selects Run proposal. No agent tool runs a comparison.
- **Who sees a proposal.** Only the person who asked reads and approves it, and they must be an owner
  or administrator. This replaces the stored `FlowBinding` of section 4 for this phase. A shared review
  by a second administrator needs that check, and it is a later slice.
- **Receipts.** The revision row holds the proposal, the Session, the turn and the operation. There is
  no separate `bakery_workflow_receipt.v1` document.
- **Failure presets.** A `check` preset stays in its animation. Lowering it to a scripted decision
  needs a tray move inside an arm in most recipes, which D6 refuses. It waits for the tray reject route.
- **Typed admission locations.** The compile reads the task from `AdmissionProblem.where`, and each
  journey shows the right step. A typed field adds no result for a person, so I did not add it.

### Risks

- **Two truths.** A fixed model can report failure when the engine reports success. The engine
  wins in every bound view, and the model supplies poses only.
- **Worker CPU.** Compile, parse, lower and two admissions of the 258-task scenario took 33 ms in
  Node. Phase 4 measures it in a Worker. If it exceeds the limit, the Worker admits only the
  changed workflow with the rest of the pinned revision.
- **Crowded files.** `oven-workspace.tsx` has 2,597 lines, and other sessions edit this area.
  New code goes in new files.
- **Old path.** `ProcedureCanvas` stayed until one production journey passed on the new canvas.
  D7 removed it on 2026-11-14.

### E2E acceptance journeys

Each journey writes a repeatable artifact under `output/acceptance/plan-84/`, and an evidence
note under `docs/evidence/`. Browser journeys use a frozen Vite server. A fake provider only
answers calls. Product code makes each asserted outcome. Assertions read what a person sees.

| ID  | Phase | Scenario                                                                                                                                                                                                                                                          | Pass result                                                                                                                                                                                                                       |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | 1     | Import the six-hour shift, black sesame with its native cell, and the eight recipes. Run each imported document and its compiler output                                                                                                                           | Same event sequence and same metrics for each pair. The latte canvas shows two arms that join at the pour. A real run's task states show on the same nodes in the canvas and timeline                                             |
| J2  | 2     | In black sesame, add a cooling step, connect it, assign a worker and run the draft. Then remove the step that supplies a lot                                                                                                                                      | The comparison shows the later finish. The timeline shows the new task. Removal refuses Run and names both nodes. The applied run does not change. Reload shows the same draft                                                    |
| J3  | 2     | Two browsers edit one 28-node workflow at one time. One connection drops and returns. One person loses access                                                                                                                                                     | Both see one merged graph. The offline edits arrive. The person without access gets a refusal. The document stays inside its size limits. Apply writes one revision and one receipt                                               |
| J4  | 2     | On latte, change a stage duration, add a step, then remove a stage                                                                                                                                                                                                | The animation stretches, then holds with the step label, then shows the original-recipe message. Canvas, timeline and cursor stay in agreement. Seek returns to the same state                                                    |
| J5  | 3A    | In ginger milk tea, add a decision with a re-strain arm and a join. Reject once and accept once, with the native pan cell                                                                                                                                         | The other arm shows Skipped. The join runs once. Reopen in a fresh session continues exactly. A tray move inside an arm is refused before Run                                                                                     |
| J6  | 3B    | Six-hour shift with a nested decision, a scripted reject and a measured rule. Run it twice. Then reopen a saved schema 5 run                                                                                                                                      | Both runs have one event digest. Replay does not decide again. The nested arm skips with its parent. The old run resumes on its retained bundle with its old result                                                               |
| J7  | 4     | With a controlled model on the one-worker shift, which has 7 late orders: propose, compare, approve, re-run. Then repeat with: a person's edit during review, a second approval, a viewer, a revoked capability, a denied flow label, and a cancel after dispatch | Badges match the diff. Numbers match the comparison. One revision and one receipt exist. Each fault gives its own refusal, and no recipe changes. The denied reader sees no reason text. The revoked capability raises the prompt |
| J8  | 5     | Production, signed-in Portal chat, real model. A failed run, the agent's proposal, the owner's approval, and a re-run                                                                                                                                             | One real journey passes on the deployed Worker, and the Plan 42 ledger records it. This run needs the owner's sign-in                                                                                                             |

Also run the narrow checks: `pnpm --filter satyr-edge check:types`, `pnpm portal:build`,
`pnpm lint:ifc-boundaries`, `pnpm lint:d1-patch`, and
`pnpm --filter satyr-edge d1:schema:remote:check` before a release.

## Decisions

The cost column states what the recommendation costs beyond the phase, or what it gives up.

| ID  | Decision               | Recommendation                                                                                                                                                                                                                                | Cost                                                                                                                     | Default        |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| D1  | Definition form        | Engine graph with labels and decisions, compiled to `CompiledScenario`. Compilers become importers. Rejected: a base recipe plus an edit list, which breaks when a compiler changes; and a new graph language, which needs a second validator | About 2 agent days for the importer. An edited recipe does not follow later compiler changes                             | Recommendation |
| D2  | Eight fixed animations | Keep them. Stretch durations, hold on an added step, and show a message on a removed or reordered stage. Rewriting 6,338 lines into stage clips costs about 10–12 more agent days, and a move to MuJoCo costs far more                        | About 2–3 agent days. A removed or reordered stage has no matching animation                                             | Recommendation |
| D3  | Revision store         | Platform: R2 by digest, with a regional D1 index. The entity plane is the rejected option, because it puts simulation data in the commerce service                                                                                            | One patch script. Changes one sentence of Plan 40C                                                                       | Recommendation |
| D4  | Agent change route     | A separate proposal layer. The shared draft stays clean, and approval binds exact content. Direct draft writes are about 2 agent days cheaper, but agent and human work mix before review                                                     | About 2 agent days for the overlay                                                                                       | Recommendation |
| D5  | Approval level         | One owner or administrator approves each proposal. A standing grant for simulation-only changes can come later                                                                                                                                | One click for each change                                                                                                | Each proposal  |
| D6  | First branch scope     | Two outcomes, no cycles, no tray move or native task in an arm. Each deferred item is a later slice                                                                                                                                           | A tray cannot follow a reject route yet. Bounded retry adds about 2 agent days. A tray reject route needs its own design | Recommendation |
| D7  | Old financier canvas   | Keep `ProcedureCanvas`, `schedule.ts` and `bakery_procedure` until J8 passes. Then decide their removal in a new task                                                                                                                         | Two canvases for a time. The removal is not in the 35–48 agent days                                                      | Decided 2026-11-14: remove the editor; keep `schedule.ts` and `bakery_procedure` |
| D8  | When the agent starts  | Only when a person asks, or selects **Ask the agent**. Automatic turns on each failed run cost one model turn for each failure                                                                                                                | A person must ask                                                                                                        | On request     |

## Effect on other plans

- **Plan 42.** Its rules stay: one run, three views, and no edit inside a running run. Its text
  on unsupported branches stays true for `schedule.ts`. This plan owns branches on the new path.
- **Plan 40C.** The room and client are reused. The revision store changes, as D3 states.
- **Plan 81.** The new tools follow its rule, and they fill the Satyr Kitchen recipe gap.
- **Plan 24.** A workflow revision stays simulation data. Its dispatch boundary does not change.
- **Plans 61A–E.** Their compilers stay and become importers.
