import { Select } from "@purin-labs/ui/select";
import {
  HUMAN_CELL_TRANSFER,
  supportsHumanCellTransfer,
} from "@purin-labs/production-simulation/recipes/bakery/human-cell-transfer";
import { prepareRehearsalReview } from "./rehearsal-edits";
import type { BakeryRehearsalChange } from "@purin-labs/bakery-model/bakery-surface";
import React from "react";
import { parseIngredientLoad } from "@purin-labs/bakery-model/bakery-physics";
import type {
  PlannedProductionWorkcell,
  ProductionWorkcells,
  ProductionWorkcell,
  RehearsalEdit,
} from "@purin-labs/production-simulation/recipes/bakery/production-workcells";
import { prepareRehearsalEdit, trayChainEdit } from "./rehearsal-edits";
import type { Run } from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { ProductionReady as Ready } from "./production-session";
import {
  handlingChoice,
  outageChoice,
  wholeSeconds,
} from "./production-fault-inputs";
import {
  layoutTray,
  rehearsalSessionPatch,
  selectedTray,
  stepName,
} from "./scheduled-rehearsal";
import { parseCellId } from "@purin-labs/production-simulation/recipes/bakery/workcell-instances";
import { RackLayoutEditor } from "./rack-layout-editor";
import {
  COLD_CELLS,
  KEEP_HOLDS,
  NO_FAILURE,
  NO_OUTAGE,
  PRESET_CHOICES,
  RACK_CASES,
  renderItem,
  workerChoices,
  type SelectChoice,
} from "./production-workspace-choices";
import {
  evaluateRackLayout,
  prepareRackLayout,
  rackPlacementFit,
  type RackLayoutProposal,
} from "./rack-layout";
import {
  REHEARSAL_PRESETS,
  presetName,
  rehearsalPreset,
  rehearsalSettings,
  type RehearsalPreset,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import {
  NO_FAULTS,
  OUTAGE_WORKCELL_RESOURCES,
  handlingTaskId,
  outageResourceName,
  type OutageResource,
  type RunFaults,
} from "@purin-labs/production-simulation/recipes/bakery/run-faults";
import {
  compareRuns,
  duration,
  summarizeRun,
} from "@purin-labs/production-simulation/simulator/run-comparison";
import type { ProductionWorkspace } from "./production-workspace";
import {
  browserRoot,
  byStep,
  byTrayStep,
  cellRobotLabel,
  hasPresetValue,
  hasResult,
  isHumanTransferStep,
  isRoot,
  message,
  otherId,
  otherTray,
  readPresetExample,
  reason,
  resourceChoice,
  runEnd,
  sameTray,
} from "./production-workspace-queries";

export const productionRehearsalAuthoring = {
  // The multi-tray rehearsal starts from two recorded trays on the production
  // scheduler: a cold oven cycle and a table-to-rack transfer. The single-skill
  // examples are presets of one tray.
  async prepareRehearsal(
    this: ProductionWorkspace,
    preset: RehearsalPreset = "two-trays",
  ): Promise<void> {
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await rehearsalPreset(
        preset,
        rehearsalSettings(this.props.settings),
        readPresetExample,
      );
      if (result.kind === "rejected") throw new Error(result.message);
      if (!this.mounted || generation !== this.generation) return;
      this.applyRehearsal(
        result.plan,
        preset === "two-trays"
          ? "Rehearsal prepared with two recorded trays. Use Edit trays to add a browser chain."
          : `${presetName(preset)} opened from its recorded result. Clear its results to run it in browser MuJoCo.`,
      );
    } catch (error) {
      if (!this.mounted || generation !== this.generation) return;
      if (this.props.session.data.kind === "ready")
        this.update({ notice: message(error) });
      else this.update({ data: { kind: "failed" }, notice: message(error) });
    } finally {
      if (this.mounted) this.update({ reading: false });
    }
  },

  choosePreset(this: ProductionWorkspace, value: string | null): void {
    const preset = REHEARSAL_PRESETS.find(hasPresetValue.bind(null, value));
    if (preset !== undefined) this.setState({ preset: preset.id });
  },

  startPreset(this: ProductionWorkspace): void {
    void this.reviewRehearsalChange({
      kind: "replace_preset",
      preset: this.state.preset,
    });
  },

  applyRehearsal(
    this: ProductionWorkspace,
    plan: ProductionWorkcells,
    notice: string,
    keepView = false,
    readOnly: readonly string[] = [],
  ): void {
    this.generation++;
    this.props.playback.pause();
    this.update(
      rehearsalSessionPatch(
        this.props.session,
        plan,
        notice,
        keepView,
        this.props.layout,
        readOnly,
      ),
    );
  },

  // Chat prepares the same edits; the workspace commits them.
  async editRehearsal(
    this: ProductionWorkspace,
    edit: RehearsalEdit,
    notice?: string,
  ): Promise<void> {
    if (this.props.session.data.kind !== "ready") return;
    const plan = this.props.session.data.plan;
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await prepareRehearsalEdit(plan, edit, notice);
      if (!this.mounted || generation !== this.generation) return;
      if (result.kind === "rejected") this.update({ notice: result.message });
      else this.props.rehearsalEdited(result.edit);
    } finally {
      if (this.mounted) this.update({ reading: false });
    }
  },

  async addRehearsalChain(this: ProductionWorkspace): Promise<void> {
    try {
      await this.editRehearsal(await trayChainEdit(this.state.rackCase));
    } catch (error) {
      if (this.mounted) this.update({ notice: message(error) });
    }
  },

  rackCase(this: ProductionWorkspace, value: string | null): void {
    if (value === "nominal" || value === "slip")
      this.setState({ rackCase: value });
  },

  rehearsalIngredients(
    this: ProductionWorkspace,
    batchId: string,
    event: React.FormEvent<HTMLFormElement>,
  ): void {
    event.preventDefault();
    if (this.locked()) return;
    const form = new FormData(event.currentTarget);
    try {
      const ingredients = parseIngredientLoad({
        massKg: Number(form.get("massKg")),
        forwardMm: Number(form.get("forwardMm")),
        lateralMm: Number(form.get("lateralMm")),
      });
      void this.editRehearsal({ kind: "ingredients", batchId, ingredients });
    } catch (error) {
      this.update({ notice: message(error) });
    }
  },

  ingredientEditor(
    this: ProductionWorkspace,
    root: ProductionWorkcell,
  ): React.ReactNode {
    if (!browserRoot(root)) return null;
    const load = root.attempt.input.request.ingredients;
    return (
      <form
        key={`${root.attempt.input.request.attemptId}:${load.massKg}:${load.forwardMm}:${load.lateralMm}`}
        aria-label={`Tray ${root.batchId} ingredients`}
        onSubmit={this.rehearsalIngredients.bind(this, root.batchId)}
      >
        <fieldset disabled={this.locked()}>
          <legend>Ingredient load</legend>
          <label>
            Ingredient mass (kg)
            <input
              name="massKg"
              type="number"
              min="0"
              max="4"
              step="any"
              required
              defaultValue={load.massKg}
            />
          </label>
          <label>
            Forward offset (mm)
            <input
              name="forwardMm"
              type="number"
              min="-100"
              max="100"
              step="1"
              required
              defaultValue={load.forwardMm}
            />
          </label>
          <label>
            Lateral offset (mm)
            <input
              name="lateralMm"
              type="number"
              min="-60"
              max="60"
              step="1"
              required
              defaultValue={load.lateralMm}
            />
          </label>
          <p>
            Mass excludes the tray and tool. Positive forward is away from the
            wrist; positive lateral follows the staging Y axis.
          </p>
          <p>
            Applying a changed load clears this tray’s results and continuation
            states. Run the tray again to check the new load.
          </p>
          <button type="submit">
            Apply ingredients to tray {root.batchId}
          </button>
        </fieldset>
      </form>
    );
  },

  rehearsalWorker(
    this: ProductionWorkspace,
    batchId: string,
    value: string | null,
  ): void {
    if (value === null) return;
    void this.editRehearsal({
      kind: "worker",
      batchId,
      workerId: `human-${Number(value)}`,
    });
  },

  rehearsalCell(
    this: ProductionWorkspace,
    batchId: string,
    value: string | null,
  ): void {
    if (value === null) return;
    const cellId = parseCellId(value);
    if (cellId !== null)
      void this.reviewRehearsalChange({
        kind: "set_cell",
        batchId,
        cellId,
      });
  },

  rehearsalStart(
    this: ProductionWorkspace,
    operation: ProductionWorkcell | PlannedProductionWorkcell,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const value = Number(event.currentTarget.value);
    if (value === operation.earliestStartSeconds) return;
    if (!Number.isInteger(value) || value < 0) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    void this.editRehearsal({
      kind: "start",
      operationId: operation.id,
      earliestStartSeconds: value,
    });
  },

  rehearsalPrerequisite(
    this: ProductionWorkspace,
    tray: ProductionWorkcell,
    id: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const dependsOn = event.currentTarget.checked
      ? [...tray.dependsOn, id]
      : tray.dependsOn.filter(otherId.bind(null, id));
    void this.editRehearsal({
      kind: "prerequisites",
      batchId: tray.batchId,
      dependsOn,
    });
  },

  resetRehearsalTray(this: ProductionWorkspace, batchId: string): void {
    void this.reviewRehearsalChange({ kind: "clear_results", batchId });
  },

  removeRehearsalTray(this: ProductionWorkspace, batchId: string): void {
    void this.reviewRehearsalChange({ kind: "remove_tray", batchId });
  },

  async reviewRehearsalChange(
    this: ProductionWorkspace,
    change: BakeryRehearsalChange,
  ): Promise<void> {
    const data = this.props.session.data;
    if (data.kind !== "ready" || this.locked()) return;
    const generation = ++this.generation;
    this.update({ reading: true });
    try {
      const result = await prepareRehearsalReview(data.plan, change);
      if (!this.mounted || generation !== this.generation) return;
      this.update({ reading: false });
      if (result.kind === "rejected") this.update({ notice: result.message });
      else
        this.props.authored({
          kind: "rehearsalReviewPrepared",
          review: result.review,
        });
    } catch (error) {
      if (this.mounted && generation === this.generation)
        this.update({ reading: false, notice: message(error) });
    }
  },

  resolveRehearsalReview(
    this: ProductionWorkspace,
    decision: "apply" | "discard",
  ): void {
    const review = this.props.session.rehearsalReview;
    if (review !== null)
      this.props.authored({
        kind: "rehearsalReviewResolved",
        review,
        decision,
      });
  },

  rehearsalChangeReview(this: ProductionWorkspace): React.ReactNode {
    const review = this.props.session.rehearsalReview;
    if (review === null) return null;
    return (
      <section
        className="workcell-save-review"
        aria-label="Review rehearsal change"
      >
        <h4>Review rehearsal change</h4>
        <p>After applying: {review.edit.notice}</p>
        <p>
          Current run: {review.summary.currentResults} accepted results.
          Proposed run: {review.summary.proposedResults} accepted results.
        </p>
        <p>
          Apply replaces the affected trays or results in this open run. Saved
          runs are kept.
        </p>
        <button
          type="button"
          onClick={this.resolveRehearsalReview.bind(this, "apply")}
        >
          Apply rehearsal change
        </button>
        <button
          type="button"
          onClick={this.resolveRehearsalReview.bind(this, "discard")}
        >
          Discard rehearsal change
        </button>
      </section>
    );
  },

  locked(this: ProductionWorkspace): boolean {
    return (
      this.props.session.reading ||
      this.props.session.readOnly.length > 0 ||
      this.props.session.rehearsalReview !== null ||
      this.props.browserJob.kind === "running" ||
      this.props.browserJob.kind === "loading"
    );
  },

  rehearsalAuthor(this: ProductionWorkspace, data: Ready): React.ReactNode {
    const roots = data.plan.operations.filter(isRoot);
    const steps = [...data.plan.operations, ...data.plan.planned];
    const workers = workerChoices(data.plan.settings.workerCount);
    return (
      <>
        <div className="production-section-header">
          <button
            type="button"
            className="production-menu-back"
            onClick={this.goBack.bind(this)}
          >
            ← Back
          </button>
          <h3>Rehearsal trays</h3>
        </div>
        {this.detailsModeTabs("author")}
        <p aria-label="Workcell robot assignments">
          Robot cell 1: {cellRobotLabel(data.plan.cellRobots["cold-cell-1"])}.{" "}
          Robot cell 2: {cellRobotLabel(data.plan.cellRobots["cold-cell-2"])}.{" "}
          Each cell keeps the same arm throughout this run.
        </p>
        <p>
          Each tray is staged into its assigned Robot cell, runs its skills,
          then is cleared. A tray's prerequisites must finish before it takes
          the cell. Changing cell clears that tray’s results after operator
          review.
        </p>
        {this.props.session.readOnly.length > 0 && (
          <section
            className="workcell-save-review"
            aria-label="Read-only conversion"
          >
            <p>
              This run was converted from an earlier format and is read-only.
            </p>
            <ul>{this.props.session.readOnly.map(reason)}</ul>
            <button type="button" onClick={this.startFromConversion.bind(this)}>
              Start a new rehearsal from this run
            </button>
          </section>
        )}
        <div className="production-rehearsal-preset">
          <label>
            Start from
            <Select.Root
              items={PRESET_CHOICES}
              value={this.state.preset}
              onValueChange={this.choosePreset.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{PRESET_CHOICES.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            disabled={this.locked()}
            onClick={this.startPreset.bind(this)}
          >
            Replace with preset
          </button>
        </div>
        {this.rehearsalChangeReview()}
        <div className="production-rehearsal-add">
          <label>
            Racking
            <Select.Root
              items={RACK_CASES}
              value={this.state.rackCase}
              onValueChange={this.rackCase.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{RACK_CASES.map(renderItem)}</Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            disabled={this.locked()}
            onClick={this.addRehearsalChain.bind(this)}
          >
            Add browser tray chain
          </button>
        </div>
        {roots.map(this.rehearsalTray.bind(this, steps, workers, roots.length))}
        {this.trayLayout(data)}
        {this.rehearsalFaults(data, roots, steps)}
        {this.baselineComparison(data)}
      </>
    );
  },

  // A rack translation moves one table-to-rack tray's first request.
  trayLayout(this: ProductionWorkspace, data: Ready): React.ReactNode {
    const tray = layoutTray(data.plan, selectedTray(this.props.session));
    if (tray === null || this.locked()) return null;
    const layout = this.props.session.layout;
    return (
      <RackLayoutEditor
        attempt={tray.attempt}
        review={
          layout?.operationId === tray.id ? layout.review : { kind: "none" }
        }
        actions={{
          previewRackLayout: this.previewTrayLayout.bind(this, tray),
          prepareRackLayout: this.prepareTrayLayout.bind(this, tray),
          discardRackLayout: this.discardTrayLayout.bind(this),
          applyRackLayout: this.applyTrayLayout.bind(this, tray),
        }}
        tray={`Tray ${tray.batchId}`}
      />
    );
  },

  previewTrayLayout(
    this: ProductionWorkspace,
    tray: ProductionWorkcell,
    xMm: number,
    yMm: number,
  ): void {
    this.update({
      layout: {
        operationId: tray.id,
        review: evaluateRackLayout(tray.attempt, 0, xMm, yMm),
      },
    });
  },

  async prepareTrayLayout(
    this: ProductionWorkspace,
    tray: ProductionWorkcell,
    xMm: number,
    yMm: number,
  ): Promise<void> {
    const draft = evaluateRackLayout(tray.attempt, 0, xMm, yMm);
    if (draft.kind === "invalid") {
      this.update({ layout: { operationId: tray.id, review: draft } });
      return;
    }
    try {
      const proposal = await prepareRackLayout(draft);
      const data = this.props.session.data;
      if (
        !this.mounted ||
        data.kind !== "ready" ||
        !data.plan.operations.includes(tray)
      )
        return;
      this.update({
        layout: {
          operationId: tray.id,
          review: { kind: "prepared", proposal },
        },
      });
    } catch (error) {
      if (this.mounted) this.update({ notice: message(error) });
    }
  },

  discardTrayLayout(this: ProductionWorkspace): void {
    this.update({ layout: null });
  },

  applyTrayLayout(
    this: ProductionWorkspace,
    tray: ProductionWorkcell,
    proposal: RackLayoutProposal,
  ): void {
    if (
      proposal.kind === "blocked" ||
      proposal.previous !== tray.attempt ||
      rackPlacementFit(proposal.layout).kind === "blocked"
    ) {
      this.update({
        notice: "The layout proposal is blocked or stale. Review it again.",
      });
      return;
    }
    void this.editRehearsal({
      kind: "layout",
      batchId: tray.batchId,
      input: proposal.input,
    });
  },

  editFaults(
    this: ProductionWorkspace,
    faults: RunFaults,
    notice: string,
  ): void {
    void this.editRehearsal({ kind: "faults", faults }, notice);
  },

  outageResource(
    this: ProductionWorkspace,
    faults: RunFaults,
    value: string | null,
  ): void {
    if (value === null) return;
    const resource = outageChoice(value);
    this.editFaults(
      {
        ...faults,
        outage:
          resource === null
            ? null
            : {
                resource,
                start: faults.outage?.start ?? 0,
                end: faults.outage?.end ?? 300,
              },
      },
      resource === null
        ? "Outage removed."
        : `${outageResourceName(resource)} outage applied. Accepted results are kept.`,
    );
  },

  outageTime(
    this: ProductionWorkspace,
    faults: RunFaults,
    edge: "start" | "end",
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const outage = faults.outage;
    const value = wholeSeconds(event.currentTarget.value);
    if (outage === null || value === outage[edge]) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, outage: { ...outage, [edge]: value } },
      "Outage window changed. Accepted results are kept.",
    );
  },

  failureTask(
    this: ProductionWorkspace,
    faults: RunFaults,
    value: string | null,
  ): void {
    if (value === null) return;
    const bakeryTaskId = handlingChoice(value);
    this.editFaults(
      {
        ...faults,
        failure:
          bakeryTaskId === null
            ? null
            : {
                bakeryTaskId,
                afterSeconds: faults.failure?.afterSeconds ?? 10,
              },
      },
      bakeryTaskId === null ? "Injected failure removed." : "Failure injected.",
    );
  },

  failureAfter(
    this: ProductionWorkspace,
    faults: RunFaults,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const failure = faults.failure;
    const value = wholeSeconds(event.currentTarget.value);
    if (failure === null || value === failure.afterSeconds) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, failure: { ...failure, afterSeconds: value } },
      "Failure time changed.",
    );
  },

  recoveryTask(
    this: ProductionWorkspace,
    faults: RunFaults,
    bakeryTaskId: string | null,
  ): void {
    if (bakeryTaskId === null) return;
    this.editFaults(
      {
        ...faults,
        recovery:
          bakeryTaskId === ""
            ? null
            : { bakeryTaskId, seconds: faults.recovery?.seconds ?? 120 },
      },
      bakeryTaskId === ""
        ? "Recovery removed; failures keep their holds."
        : "Recovery assumed for that task if it fails.",
    );
  },

  recoverySeconds(
    this: ProductionWorkspace,
    faults: RunFaults,
    event: React.FocusEvent<HTMLInputElement>,
  ): void {
    const recovery = faults.recovery;
    const value = wholeSeconds(event.currentTarget.value);
    if (recovery === null || value === recovery.seconds) return;
    if (value === null) {
      this.update({ notice: "Enter a whole number of seconds." });
      return;
    }
    this.editFaults(
      { ...faults, recovery: { ...recovery, seconds: value } },
      "Recovery duration changed.",
    );
  },

  rehearsalFaults(
    this: ProductionWorkspace,
    data: Ready,
    roots: readonly ProductionWorkcell[],
    steps: readonly (ProductionWorkcell | PlannedProductionWorkcell)[],
  ): React.ReactNode {
    const faults = data.plan.faults;
    const resources: OutageResource[] = [];
    for (let worker = 1; worker <= data.plan.settings.workerCount; worker++)
      resources.push(`human-${worker}`);
    resources.push(...OUTAGE_WORKCELL_RESOURCES);
    const outages = [NO_OUTAGE, ...resources.map(resourceChoice)];
    const handling: SelectChoice[] = [NO_FAILURE];
    const recoverable: SelectChoice[] = [KEEP_HOLDS];
    for (const root of roots) {
      const phases: ("stage" | "clear" | "transfer")[] = ["stage", "clear"];
      if (steps.some(isHumanTransferStep.bind(null, root.batchId)))
        phases.push("transfer");
      for (const phase of phases) {
        const id = handlingTaskId(root.batchId, root.tray, phase);
        const label = `Tray ${root.batchId} ${phase === "transfer" ? "human transfer" : phase === "stage" ? "staging" : "clearance"}`;
        handling.push({ value: id, label });
        recoverable.push({ value: id, label });
      }
      for (const step of steps.filter(sameTray.bind(null, root)).sort(byStep))
        recoverable.push({
          value: step.id,
          label: `Tray ${step.batchId} step ${step.step} · ${stepName(step)}`,
        });
    }
    return (
      <fieldset className="production-assignment production-faults">
        <legend>Faults and recovery</legend>
        <p>
          Assumptions to compare against a pinned baseline. An outage postpones
          new work that needs its resource; running work continues. A failed
          staging or clearance holds its baker and the cell. A recovery releases
          them after its duration; the failed tray and work waiting for it stay
          blocked. Native failures come from recordings, such as injected-slip
          racking.
        </p>
        <label>
          Unavailable resource
          <Select.Root
            items={outages}
            value={faults.outage?.resource ?? ""}
            disabled={this.locked()}
            onValueChange={this.outageResource.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{outages.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.outage !== null && (
          <>
            <label key={`start-${faults.outage.start}`}>
              Unavailable from (s)
              <input
                type="number"
                min="0"
                step="1"
                defaultValue={faults.outage.start}
                disabled={this.locked()}
                onBlur={this.outageTime.bind(this, faults, "start")}
              />
            </label>
            <label key={`end-${faults.outage.end}`}>
              Available again (s)
              <input
                type="number"
                min="1"
                step="1"
                defaultValue={faults.outage.end}
                disabled={this.locked()}
                onBlur={this.outageTime.bind(this, faults, "end")}
              />
            </label>
          </>
        )}
        <label>
          Injected failure
          <Select.Root
            items={handling}
            value={faults.failure?.bakeryTaskId ?? ""}
            disabled={this.locked()}
            onValueChange={this.failureTask.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{handling.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.failure !== null && (
          <label key={`after-${faults.failure.afterSeconds}`}>
            Fail after (s into the task)
            <input
              type="number"
              min="1"
              step="1"
              defaultValue={faults.failure.afterSeconds}
              disabled={this.locked()}
              onBlur={this.failureAfter.bind(this, faults)}
            />
          </label>
        )}
        <label>
          Assumed recovery
          <Select.Root
            items={recoverable}
            value={faults.recovery?.bakeryTaskId ?? ""}
            disabled={this.locked()}
            onValueChange={this.recoveryTask.bind(this, faults)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{recoverable.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {faults.recovery !== null && (
          <label key={`recovery-${faults.recovery.seconds}`}>
            Recovery duration (s)
            <input
              type="number"
              min="1"
              step="1"
              defaultValue={faults.recovery.seconds}
              disabled={this.locked()}
              onBlur={this.recoverySeconds.bind(this, faults)}
            />
          </label>
        )}
        <button
          type="button"
          disabled={this.locked() || faults === NO_FAULTS}
          onClick={this.editFaults.bind(this, NO_FAULTS, "Faults cleared.")}
        >
          Clear faults
        </button>
      </fieldset>
    );
  },

  pinBaseline(this: ProductionWorkspace, run: Run): void {
    this.props.authored({
      kind: "productionBaselineChanged",
      action: "pin",
      source: run,
      baseline: this.props.session.baseline,
    });
  },

  clearBaseline(this: ProductionWorkspace, run: Run): void {
    this.props.authored({
      kind: "productionBaselineChanged",
      action: "clear",
      source: run,
      baseline: this.props.session.baseline,
    });
  },

  baselineComparison(
    this: ProductionWorkspace,
    data: Ready,
  ): React.ReactNode {
    const run = this.props.session.preview?.run ?? data.run;
    const baseline = this.props.session.baseline;
    const current = summarizeRun(run);
    const unit =
      this.props.session.procedure === "rehearsal" ? "tray" : "batch";
    return (
      <section className="production-baseline" aria-label="Baseline comparison">
        <h4>Compare with a pinned baseline</h4>
        <p>
          Pin the current run, change the workflow or its faults, then compare.
          The baseline stays fixed until you replace it.
        </p>
        <button type="button" onClick={this.pinBaseline.bind(this, run)}>
          Pin current run as baseline
        </button>
        {baseline !== null && (
          <>
            <button type="button" onClick={this.clearBaseline.bind(this, run)}>
              Clear baseline
            </button>
            <table>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Baseline</th>
                  <th scope="col">Current</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Run end</th>
                  <td>{runEnd(baseline)}</td>
                  <td>{runEnd(current)}</td>
                </tr>
                <tr>
                  <th scope="row">Completed tasks</th>
                  <td>{baseline.completed}</td>
                  <td>{current.completed}</td>
                </tr>
                <tr>
                  <th scope="row">Unfinished {unit}s</th>
                  <td>{baseline.unfinished}</td>
                  <td>{current.unfinished}</td>
                </tr>
                <tr>
                  <th scope="row">Failed tasks</th>
                  <td>{baseline.failed}</td>
                  <td>{current.failed}</td>
                </tr>
                <tr>
                  <th scope="row">Total waiting</th>
                  <td>{duration(baseline.waiting)}</td>
                  <td>{duration(current.waiting)}</td>
                </tr>
              </tbody>
            </table>
            <p role="status">{compareRuns(baseline, current, unit)}</p>
            <p>
              Total waiting sums every {unit}'s waits, so parallel waits
              overlap.
            </p>
          </>
        )}
      </section>
    );
  },

  rehearsalTray(
    this: ProductionWorkspace,
    steps: readonly (ProductionWorkcell | PlannedProductionWorkcell)[],
    workers: readonly SelectChoice[],
    count: number,
    root: ProductionWorkcell,
  ): React.ReactNode {
    const chain = steps.filter(sameTray.bind(null, root)).sort(byStep);
    const others = steps.filter(otherTray.bind(null, root)).sort(byTrayStep);
    return (
      <fieldset key={root.id} className="production-assignment">
        <legend>
          Tray {root.batchId} · {chain.map(stepName).join(" → ")}
        </legend>
        <label>
          Baker
          <Select.Root
            items={workers}
            value={String(Number(root.workerId.slice(6)))}
            disabled={this.locked()}
            onValueChange={this.rehearsalWorker.bind(this, root.batchId)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{workers.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Cold cell (assumed independent layout)
          <Select.Root
            items={COLD_CELLS}
            value={root.attempt.input.bindings.cell}
            disabled={this.locked() || !browserRoot(root)}
            onValueChange={this.rehearsalCell.bind(this, root.batchId)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{COLD_CELLS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        {this.ingredientEditor(root)}
        {supportsHumanCellTransfer(root.attempt.input) &&
          chain.length === 1 && (
            <button
              type="button"
              disabled={this.locked()}
              onClick={this.reviewRehearsalChange.bind(this, {
                kind: "add_human_transfer",
                batchId: root.batchId,
              })}
            >
              Add human transfer to cell 2 for tray {root.batchId}
            </button>
          )}
        {chain.some(isHumanTransferStep.bind(null, root.batchId)) && (
          <p>
            Assumed human transfer: cell 1 rack → one-slot buffer → cell 2
            source. Pickup {HUMAN_CELL_TRANSFER.pickupSeconds}s, carry{" "}
            {HUMAN_CELL_TRANSFER.carrySeconds}s, placement{" "}
            {HUMAN_CELL_TRANSFER.placementSeconds}s. Placement uses cell 2’s
            native source pose. Cells use independent model frames; the bakery
            layout is unmeasured.
          </p>
        )}
        {chain.map(this.rehearsalStep.bind(this))}
        {others.length > 0 && (
          <>
            <h4>
              Prerequisites ({root.dependsOn.length}) · must finish before
              staging
            </h4>
            {others.map(this.rehearsalChoice.bind(this, root))}
          </>
        )}
        <button
          type="button"
          disabled={
            this.locked() || !browserRoot(root) || !chain.some(hasResult)
          }
          onClick={this.resetRehearsalTray.bind(this, root.batchId)}
        >
          Clear tray {root.batchId} results
        </button>
        <button
          type="button"
          disabled={this.locked() || count === 1}
          onClick={this.removeRehearsalTray.bind(this, root.batchId)}
        >
          Remove tray {root.batchId}
        </button>
      </fieldset>
    );
  },

  rehearsalStep(
    this: ProductionWorkspace,
    operation: ProductionWorkcell | PlannedProductionWorkcell,
  ): React.ReactNode {
    return (
      <label key={`${operation.id}-${operation.earliestStartSeconds}`}>
        {operation.step === 1
          ? "Earliest staging (s)"
          : `Step ${operation.step} · ${stepName(operation)} earliest start (s)`}
        <input
          type="number"
          min="0"
          step="1"
          defaultValue={operation.earliestStartSeconds}
          disabled={this.locked()}
          onBlur={this.rehearsalStart.bind(this, operation)}
        />
      </label>
    );
  },

  rehearsalChoice(
    this: ProductionWorkspace,
    tray: ProductionWorkcell,
    operation: ProductionWorkcell | PlannedProductionWorkcell,
  ): React.ReactNode {
    return (
      <label key={operation.id}>
        <input
          type="checkbox"
          checked={tray.dependsOn.includes(operation.id)}
          disabled={this.locked()}
          onChange={this.rehearsalPrerequisite.bind(this, tray, operation.id)}
        />
        Tray {operation.batchId} · step {operation.step} ({stepName(operation)})
      </label>
    );
  },
};
