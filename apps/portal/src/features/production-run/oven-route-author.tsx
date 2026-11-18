import { Select } from "../../ui/select";
import React from "react";
import { assertNever, isRecord } from "@seams/std";
import type { StrictUnion, VariantBy } from "@seams/type-utils";
import {
  bakeryFingerprint,
  parseSettings,
} from "@seams/bakery-model/bakery";
import { parsePersistentCell } from "@seams/bakery-model/bakery-physics";
import type { CompiledProcedure } from "@seams/bakery-model/bakery-procedure";
import {
  parseProductionManualTasks,
  parseProductionScenario,
  productionDefinitionFingerprint,
  productionTaskChoices,
  validProductionWorkflow,
  type ProductionManualTask,
  type ProductionTaskChoice,
} from "@seams/bakery-model/bakery-production-scenario";
import type { SimulatorConnection } from "../workflow-simulator/simulator-state";
import { saveProductionScenario } from "../workflow-simulator/production-scenario-api";
import { openExecutionWorker, type ExecutionWorker } from "./execution-client";
import { prepareOvenDefinition, type OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";

type DefinitionSource = VariantBy<OvenRunSource, "kind", "definition">;
type Choice = Readonly<{ value: string; label: string }>;
const VARIANTS: readonly Choice[] = [
  { value: "normal", label: "Normal" },
  { value: "outage", label: "Assumed oven outage" },
];
type Draft = Readonly<{
  id: string;
  name: string;
  note: string;
  variant: "normal" | "outage";
  manualTasks: readonly ProductionManualTask[];
}>;
type Review = StrictUnion<
  | Readonly<{ kind: "editing" | "preparing" }>
  | Readonly<{
      kind: "reviewed" | "saving" | "saved" | "uncertain";
      source: DefinitionSource;
    }>
>;
type State = Readonly<{
  draft: Draft;
  review: Review;
  taskId: string;
  notice: string;
}>;
type Props = Readonly<{
  procedure: CompiledProcedure;
  connection: SimulatorConnection;
  open(source: OvenRunSource): void;
}>;

export class OvenRouteAuthor extends React.Component<Props, State> {
  state: State = {
    draft: {
      id: `production-${crypto.randomUUID()}`,
      name: "Oven production",
      note: "One shared oven cell. Worker handling and recipe timings are assumed.",
      variant: "normal",
      manualTasks: [],
    },
    review: { kind: "editing" },
    taskId: "batch:A:process:stage",
    notice: "Review the route before saving or starting it.",
  };
  private mounted = false;

  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }

  private edit(draft: Draft): void {
    if (
      this.state.review.kind === "preparing" ||
      this.state.review.kind === "saving"
    )
      return;
    const id =
      this.state.review.kind === "saved" ||
      this.state.review.kind === "uncertain"
        ? `production-${crypto.randomUUID()}`
        : draft.id;
    this.setState({
      draft: {
        id,
        name: draft.name,
        note: draft.note,
        variant: draft.variant,
        manualTasks: draft.manualTasks,
      },
      review: { kind: "editing" },
      notice: "Review the changed route before saving or starting it.",
    });
  }
  private name(event: React.ChangeEvent<HTMLInputElement>): void {
    this.edit({ ...this.state.draft, name: event.currentTarget.value });
  }
  private note(event: React.ChangeEvent<HTMLTextAreaElement>): void {
    this.edit({ ...this.state.draft, note: event.currentTarget.value });
  }
  private variant(variant: string | null): void {
    if (variant === "normal" || variant === "outage")
      this.edit({ ...this.state.draft, variant });
  }
  private chooseTask(taskId: string | null): void {
    if (taskId !== null) this.setState({ taskId });
  }
  private rule(): ProductionManualTask {
    for (const task of this.state.draft.manualTasks)
      if (task.bakeryTaskId === this.state.taskId) return task;
    return {
      bakeryTaskId: this.state.taskId,
      workerId: null,
      dependsOn: [],
      earliestStartSeconds: 0,
    };
  }
  private changeRule(rule: ProductionManualTask): void {
    const rules: ProductionManualTask[] = [];
    for (const task of this.state.draft.manualTasks)
      if (task.bakeryTaskId !== rule.bakeryTaskId) rules.push(task);
    if (
      rule.workerId !== null ||
      rule.dependsOn.length > 0 ||
      rule.earliestStartSeconds !== 0
    )
      rules.push(rule);
    this.edit({ ...this.state.draft, manualTasks: rules });
  }
  private worker(raw: string | null): void {
    if (raw === null) return;
    const workerId =
      raw === "automatic" ? null : (`human-${Number(raw)}` as const);
    this.changeRule({ ...this.rule(), workerId });
  }
  private earliest(event: React.ChangeEvent<HTMLInputElement>): void {
    this.changeRule({
      ...this.rule(),
      earliestStartSeconds: event.currentTarget.valueAsNumber,
    });
  }
  private prerequisite(
    id: string,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const rule = this.rule();
    const dependencies = new Set(rule.dependsOn);
    if (event.currentTarget.checked) dependencies.add(id);
    else dependencies.delete(id);
    this.changeRule({ ...rule, dependsOn: [...dependencies].sort() });
  }

  private async prepare(): Promise<void> {
    if (
      this.state.review.kind === "preparing" ||
      this.state.review.kind === "saving" ||
      this.state.review.kind === "uncertain"
    )
      return;
    const draft = this.state.draft;
    const settings = parseSettings({
      ...this.props.procedure.settings,
      ovenTrays: 1,
      traysPerBatch: 1,
    });
    if (settings.kind !== "valid") {
      this.setState({
        notice: "The procedure inputs do not fit this oven cell.",
      });
      return;
    }
    const rules = parseProductionManualTasks(
      draft.manualTasks,
      settings.settings,
      [],
      "oven-rack",
    );
    if (
      rules === null ||
      !validProductionWorkflow(settings.settings, [], rules, "oven-rack")
    ) {
      this.setState({
        notice:
          "Review baker assignments, start times, and prerequisites. Dependencies must not form a cycle.",
      });
      return;
    }
    this.setState({
      review: { kind: "preparing" },
      notice: "Preparing the shared oven cell…",
    });
    let worker: ExecutionWorker | null = null;
    try {
      const opened = await openExecutionWorker(null);
      if (!opened.ok)
        throw new Error(`Cannot prepare the oven cell: ${opened.error.code}.`);
      worker = opened.value;
      if (!this.mounted) return;
      const reply = await worker.request({
        kind: "define",
        cell: "oven-cell-1",
        fixture: "oven-rack",
        robot: "universal-robots-ur5e",
      });
      if (!isRecord(reply) || reply.kind !== "defined")
        throw new Error("The oven cell could not be prepared.");
      const cell = parsePersistentCell(reply.definition);
      if (cell === null || cell.fixture !== "persistent-oven-rack/1")
        throw new Error("The prepared oven cell is invalid.");
      const route = {
        route: "oven-rack" as const,
        cell,
        executionBundleId: worker.manifest.bundle.id,
      };
      const sourceFingerprint = await bakeryFingerprint(
        this.props.procedure.revisionKey,
      );
      const definition = parseProductionScenario({
        id: draft.id,
        name: draft.name.trim(),
        note: draft.note.trim(),
        procedureId: this.props.procedure.reference.entityId,
        sourceFingerprint,
        definitionFingerprint: await productionDefinitionFingerprint(
          sourceFingerprint,
          settings.settings,
          draft.variant,
          [],
          rules,
          route,
        ),
        settings: settings.settings,
        variant: draft.variant,
        assignments: [],
        manualTasks: rules,
        presentation: {},
        route: route.route,
        cell,
        executionBundleId: route.executionBundleId,
      });
      if (definition?.route !== "oven-rack")
        throw new Error("Enter a name and note for this route.");
      const prepared = await prepareOvenDefinition(definition);
      if (!prepared.ok) throw new Error(prepared.error);
      if (this.mounted)
        this.setState({
          review: { kind: "reviewed", source: prepared.value },
          notice:
            "Route reviewed. The oven has one tray slot. Each batch performs loading, baking, retrieval, racking, and rack clearance.",
        });
    } catch (error) {
      if (this.mounted)
        this.setState({
          review: { kind: "editing" },
          notice:
            error instanceof Error
              ? error.message
              : "Route preparation failed.",
        });
    } finally {
      worker?.terminate();
    }
  }

  private async save(): Promise<void> {
    const connection = this.props.connection;
    if (
      connection.kind !== "workspace" ||
      !connection.canManage ||
      this.state.review.kind !== "reviewed"
    )
      return;
    const source = this.state.review.source;
    this.setState({
      review: { kind: "saving", source },
      notice: "Saving the oven route…",
    });
    const result = await saveProductionScenario(
      connection.organisationId,
      connection.mutate,
      source.definition,
    );
    if (!this.mounted) return;
    switch (result.kind) {
      case "verified":
        this.setState({
          review: { kind: "saved", source },
          notice: `Saved and verified “${source.definition.name}”. Open its scenario ID to share this route.`,
        });
        return;
      case "saved-readback-failed":
      case "outcome-unknown":
        this.setState({
          review: { kind: "uncertain", source },
          notice: result.message,
        });
        return;
      case "failed-before-save":
        this.setState({
          review: { kind: "reviewed", source },
          notice: result.message,
        });
        return;
      default:
        return assertNever(result);
    }
  }
  private run(): void {
    if (
      this.state.review.kind === "reviewed" ||
      this.state.review.kind === "saved"
    )
      this.props.open(this.state.review.source);
  }
  private dependency(task: ProductionTaskChoice): React.ReactNode {
    if (task.id === this.state.taskId) return null;
    return (
      <label key={task.id}>
        <input
          type="checkbox"
          checked={this.rule().dependsOn.includes(task.id)}
          onChange={this.prerequisite.bind(this, task.id)}
        />
        {task.label}
      </label>
    );
  }

  render(): React.ReactNode {
    const settings = this.props.procedure.settings;
    const choices = productionTaskChoices(settings, [], "oven-rack");
    const tasks = choices.filter(manualChoice).map(taskItem);
    const workers: Choice[] = [
      { value: "automatic", label: "Any available baker" },
    ];
    for (let worker = 1; worker <= settings.workerCount; worker++)
      workers.push({ value: String(worker), label: `Baker ${worker}` });
    const busy =
      this.state.review.kind === "preparing" ||
      this.state.review.kind === "saving";
    const reviewed =
      this.state.review.kind === "reviewed" ||
      this.state.review.kind === "saved";
    const canSave =
      this.props.connection.kind === "workspace" &&
      this.props.connection.canManage;
    const rule = this.rule();
    return (
      <section aria-label="Author persistent oven route">
        <p>
          Each batch contains one tray. One UR5e cell has one carrier slot
          across the source table, oven, and rack. Bakers stage the source table
          and clear the rack to cooling. Recipe timings come from the loaded
          procedure.
        </p>
        <p role="status">{this.state.notice}</p>
        <p>
          Scenario ID:{" "}
          <output aria-label="Oven scenario ID">{this.state.draft.id}</output>
        </p>
        <fieldset className="production-assignment" disabled={busy}>
          <legend>Oven route and baker rules</legend>
          <label>
            Oven route name
            <input
              value={this.state.draft.name}
              maxLength={80}
              onChange={this.name.bind(this)}
            />
          </label>
          <label>
            Oven route note
            <textarea
              value={this.state.draft.note}
              maxLength={2000}
              onChange={this.note.bind(this)}
            />
          </label>
          <label>
            Oven availability
            <Select.Root
              items={VARIANTS}
              value={this.state.draft.variant}
              onValueChange={this.variant.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{VARIANTS.map(choiceItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Oven route manual task
            <Select.Root
              items={tasks}
              value={this.state.taskId}
              onValueChange={this.chooseTask.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{tasks.map(choiceItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Assigned baker
            <Select.Root
              items={workers}
              value={
                rule.workerId === null ? "automatic" : rule.workerId.slice(6)
              }
              onValueChange={this.worker.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>{workers.map(choiceItem)}</Select.Popup>
            </Select.Root>
          </label>
          <label>
            Earliest task start (seconds after 06:00)
            <input
              type="number"
              min={0}
              max={settings.horizonMinutes * 60 - 1}
              step={1}
              value={rule.earliestStartSeconds}
              onChange={this.earliest.bind(this)}
            />
          </label>
          <details>
            <summary>
              Additional task prerequisites ({rule.dependsOn.length})
            </summary>
            <div className="production-predecessors">
              {choices.map(this.dependency.bind(this))}
            </div>
          </details>
        </fieldset>
        <button
          disabled={busy || this.state.review.kind === "uncertain"}
          onClick={this.prepare.bind(this)}
        >
          Review oven route
        </button>
        <button
          disabled={!canSave || this.state.review.kind !== "reviewed"}
          onClick={this.save.bind(this)}
        >
          Save oven scenario copy
        </button>
        <button disabled={!reviewed} onClick={this.run.bind(this)}>
          Run reviewed oven route
        </button>
        {!canSave && (
          <p>Workspace admin access is required to save a shared route.</p>
        )}
        {this.state.review.kind === "uncertain" && (
          <p>
            Open this scenario ID to confirm the save. Editing the route
            prepares a new copy with a different ID.
          </p>
        )}
      </section>
    );
  }
}

function manualChoice(task: ProductionTaskChoice): boolean {
  return task.kind === "manual";
}
function taskItem(task: ProductionTaskChoice): Choice {
  return { value: task.id, label: task.label };
}
function choiceItem(choice: Choice): React.ReactNode {
  return (
    <Select.Item key={choice.value} value={choice.value}>
      {choice.label}
    </Select.Item>
  );
}
