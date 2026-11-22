import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProductionActivityTrace } from "@purin-labs/area-kitchen/ui/features/production-run/production-activity-trace";
import "../styles.css";
import { Select } from "@purin-labs/ui/select";
import {
  parseExecutionBundle,
  parseHostView,
  type HostView,
  type RecoveryView,
  type ExecutionBundle,
} from "@purin-labs/production-simulation";
import {
  coldCellJourneyAdapter,
  coldCellJourneySnapshot,
} from "@purin-labs/production-simulation/recipes/cold-cell-journey";
import type { StrictUnion } from "@purin-labs/type-utils";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { checkpointBody } from "@purin-labs/bakery-model/bakery-checkpoint";
import {
  openExecutionWorker,
  openAuthoredCellWorker,
  type ExecutionWorker,
} from "./collecting-execution-worker";
import { PRODUCTION_EXECUTION_MANIFEST } from "@purin-labs/production-simulation/execution-manifest";
import "./production-run-preview.css";

/**
 * A development page for the Plan 70 single-cell journey. Two orders each
 * put a tray through one cold cell. The run executes in the retained
 * bundle's worker; this page starts it, pauses and saves it, destroys the
 * worker and continues the save in a fresh one.
 */

const CELL = "cold-cell-1";
const HORIZON = 600_000_000;
// A time inside the wait between the two orders, while the cell is empty.
const EMPTY_WAIT = 50_000_000;
// Needs performed between turns of this page's event loop.
const TURNS = 8;

type View = HostView;

type Saved = Readonly<{
  document: Readonly<Record<string, unknown>>;
  checkpoints: readonly Readonly<{ digest: string; content: string }>[];
}>;

type StoredArtifact = Readonly<{
  digest: string;
  byteLength: number;
  role: string;
  content: string;
}>;

// Named points of the journey at which the page pauses and saves by itself.
const STOPS = {
  "tray-a-after-pickup": "After tray A's pickup",
  "empty-cell-at-rest": "Empty cell between the orders",
  "tray-b-returning": "Arm returning for tray B",
  "tray-b-after-pickup": "After tray B's pickup",
  "recovery-handling": "During recovery handling (31 s)",
  "recovery-returning": "During recovery return (38 s)",
} as const;
type Stop = keyof typeof STOPS;
type PreviewChoice = Readonly<{ value: string; label: string }>;
const STOP_CHOICES: readonly PreviewChoice[] = [
  { value: "", label: "No set point" },
  ...Object.entries(STOPS).map(([value, label]) => ({ value, label })),
];
const JOURNEY_CHOICES: readonly PreviewChoice[] = [
  { value: "nominal", label: "Two tray transfers" },
  { value: "recovery", label: "Weak clamp with human recovery" },
];
const STORAGE_CHOICES: readonly PreviewChoice[] = [
  { value: "reject-shelf", label: "Reject shelf (2 trays)" },
  { value: "full-shelf", label: "Occupied shelf (no free space)" },
];

function isStop(value: string): value is Stop {
  return value in STOPS;
}

function reached(stop: Stop, view: View): boolean {
  const cell = view.cells[0];
  if (cell === undefined) return false;
  const attempt = cell.attempt;
  switch (stop) {
    case "recovery-handling":
      return view.time === 31_000_000;
    case "recovery-returning":
      return view.time === 38_000_000;
    case "tray-a-after-pickup":
      return (
        attempt?.id === "tray-orders#0/transfer@1" && attempt.steps >= 4700
      );
    case "empty-cell-at-rest":
      return (
        cell.carrier === null && attempt === null && cell.hold === "settled"
      );
    case "tray-b-returning":
      return (
        attempt?.id === "tray-orders#1/transfer@1" && attempt.steps >= 1700
      );
    case "tray-b-after-pickup":
      return (
        attempt?.id === "tray-orders#1/transfer@1" && attempt.steps >= 8200
      );
  }
}

type Journey = "nominal" | "recovery";
type Lifecycle = StrictUnion<
  | Readonly<{ kind: "idle" | "opening" | "destroyed" | "error" }>
  | Readonly<{
      kind: "running" | "saving" | "saved" | "ended" | "commanding";
      worker: ExecutionWorker;
    }>
>;

type Session = {
  /** A cell definition to start from, set to repeat an earlier run's world. */
  definition: unknown;
  stopAt: Stop | null;
  /** How long each execution took to resolve, start and begin. */
  timings: { execution: number; openMs: number; beginMs: number }[];
  lifecycle: Lifecycle;
  journey: Journey;
  recoveryStorage: "reject-shelf" | "full-shelf";
  commandSequence: number;
  receipt:
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "rejected"; reason: string }>
    | null;
  execution: number;
  view: View | null;
  events: unknown[];
  saved: Saved | null;
  /** Keep every handed-over artifact; later saves can reference earlier packs. */
  artifacts: Map<string, StoredArtifact>;
  pauseRequested: boolean;
  notice: string;
};

const session: Session = {
  definition: null,
  stopAt: null,
  timings: [],
  lifecycle: { kind: "idle" },
  journey: "nominal",
  recoveryStorage: "reject-shelf",
  commandSequence: 0,
  receipt: null,
  execution: 0,
  view: null,
  events: [],
  saved: null,
  artifacts: new Map(),
  pauseRequested: false,
  notice: "No run yet.",
};

function readView(reply: unknown, kind: string): View {
  if (!isRecord(reply) || reply.kind !== kind)
    throw new Error(JSON.stringify(reply));
  const parsed = parseHostView(reply.view);
  if (!parsed.ok) throw new Error("The worker returned an invalid run view.");
  return parsed.value;
}

function currentWorker(): ExecutionWorker | null {
  return session.lifecycle.worker ?? null;
}

async function scenarioFor(
  definition: unknown,
  journey: Journey = "nominal",
): Promise<unknown> {
  if (!isRecord(definition) || !isRecord(definition.execution))
    throw new Error("The worker returned no cell definition");
  const compiled = coldCellJourneyAdapter.compile(
    await coldCellJourneySnapshot(
      {
        horizonSeconds: HORIZON / 1_000_000,
        orders: 2,
        trays: ["tray-a", "tray-b"],
        cell: {
          id: CELL,
          modelHash: String(definition.modelHash),
          controllerSourceHash: String(
            definition.execution.controllerSourceHash,
          ),
          timestepSeconds: 0.002,
          // The settled hold the controller offers a rested, idle cell.
          holdModel: "cold-cell-rest.1",
        },
        load: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
        unload: { pickupSeconds: 4, placementSeconds: 12, durationSeconds: 14 },
      },
      1,
    ),
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  if (journey === "nominal") return compiled.value;
  // Declared acceptance inputs: a baker's break and finite reject storage.
  return {
    ...compiled.value,
    destinations: [
      ...compiled.value.destinations,
      {
        id: "rejected-trays",
        role: "rejected-output",
        product: "portioned-tray",
      },
    ],
    storages: [
      ...compiled.value.storages,
      {
        id: "reject-shelf",
        capacity: { kind: "carriers", slots: 2 },
        cell: null,
      },
      {
        id: "full-shelf",
        capacity: { kind: "carriers", slots: 1 },
        cell: null,
      },
    ],
    carriers: [
      ...compiled.value.carriers,
      { id: "unrelated-tray", storage: "full-shelf" },
    ],
    availability: [
      {
        id: "baker-break",
        resource: "baker",
        interval: { start: 15_000_000, end: 30_000_000 },
      },
    ],
  };
}

function identity(execution: number, parent: unknown) {
  return {
    runId: "production-run-preview",
    executionId: `browser-${execution}`,
    hostSession: `tab-${execution}`,
    parent,
  };
}

async function open(claim: ExecutionBundle | null): Promise<ExecutionWorker> {
  const opened = await openExecutionWorker(claim);
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  return opened.value;
}

// The definition a new cell is created from, pinned by this worker's runtime.
async function define(worker: ExecutionWorker): Promise<unknown> {
  const defined = await worker.request({ kind: "define", cell: CELL });
  if (!isRecord(defined) || defined.kind !== "defined")
    throw new Error(JSON.stringify(defined));
  return defined.definition;
}

async function begin(
  worker: ExecutionWorker,
  execution: number,
  definition: unknown,
  origin: unknown,
  parent: unknown,
): Promise<View> {
  const began = await worker.request({
    kind: "begin",
    bundle: worker.manifest.bundle,
    cells: [definition],
    identity: identity(execution, parent),
    origin,
  });
  return readView(began, "began");
}

async function saveNow(worker: ExecutionWorker): Promise<void> {
  session.lifecycle = { kind: "saving", worker };
  const paused = await worker.request({
    kind: "pause",
    commandId: `pause-${session.execution}-${++session.commandSequence}`,
  });
  session.view = readView(paused, "commanded");
  if (session.view.status.kind !== "paused")
    throw new Error("The run did not reach a paused boundary.");
  if (isRecord(paused) && Array.isArray(paused.events))
    session.events.push(...paused.events);
  const saved = await worker.request({ kind: "save" });
  if (!isRecord(saved) || saved.kind !== "saved" || !isRecord(saved.document))
    throw new Error(JSON.stringify(saved));
  if (!Array.isArray(saved.artifacts))
    throw new Error("The save has no artifacts.");
  for (const raw of saved.artifacts) {
    const artifact = await readArtifact(raw);
    session.artifacts.set(artifact.digest, artifact);
  }
  const checkpoints: { digest: string; content: string }[] = [];
  for (const cell of session.view.cells) {
    const artifact = session.artifacts.get(cell.checkpoint);
    if (artifact === undefined || artifact.role !== "cell-checkpoint")
      throw new Error(`The save is missing ${cell.id}'s checkpoint.`);
    checkpoints.push({ digest: artifact.digest, content: artifact.content });
  }
  session.saved = { document: saved.document, checkpoints };
  session.lifecycle = { kind: "saved", worker };
  session.notice = `Saved snapshot ${String(saved.document.snapshot).slice(0, 12)}.`;
}

async function readArtifact(raw: unknown): Promise<StoredArtifact> {
  if (
    !isRecord(raw) ||
    typeof raw.digest !== "string" ||
    typeof raw.byteLength !== "number" ||
    typeof raw.role !== "string" ||
    typeof raw.content !== "string"
  )
    throw new Error("Invalid saved artifact.");
  const bytes = new TextEncoder().encode(raw.content);
  if (
    bytes.byteLength !== raw.byteLength ||
    (await sha256Hex(bytes)) !== raw.digest
  )
    throw new Error("A saved artifact failed its integrity check.");
  return {
    digest: raw.digest,
    byteLength: raw.byteLength,
    role: raw.role,
    content: raw.content,
  };
}

async function drive(worker: ExecutionWorker): Promise<void> {
  session.lifecycle = { kind: "running", worker };
  session.pauseRequested = false;
  // A held cell needs nothing from physics, so a run passes through its
  // wait within one turn. To stop inside that wait the page drives up to a
  // time in it first.
  let limit = HORIZON;
  if (session.stopAt === "empty-cell-at-rest") limit = EMPTY_WAIT;
  if (session.stopAt === "recovery-handling") limit = 31_000_000;
  if (session.stopAt === "recovery-returning") limit = 38_000_000;
  while (currentWorker() === worker) {
    const reply = await worker.request({
      kind: "drive",
      turns: TURNS,
      until: limit,
    });
    const view = readView(reply, "drove");
    session.view = view;
    if (isRecord(reply) && Array.isArray(reply.events))
      session.events.push(...reply.events);
    render();
    if (view.status.kind === "advancing") limit = HORIZON;
    else if (view.status.kind !== "awaiting-execution") {
      session.lifecycle = { kind: "ended", worker };
      session.notice = `The run is ${view.status.kind}.`;
      break;
    }
    if (session.stopAt !== null && reached(session.stopAt, view)) {
      session.stopAt = null;
      session.pauseRequested = true;
    }
    if (session.pauseRequested) {
      await saveNow(worker);
      break;
    }
  }
  render();
}

function report(action: Promise<void>): void {
  void action.catch(reportFailure);
}

function reportFailure(error: unknown): void {
  currentWorker()?.terminate();
  session.lifecycle = { kind: "error" };
  session.notice = error instanceof Error ? error.message : String(error);
  render();
}

function weakClamp(definition: unknown): unknown {
  if (!isRecord(definition) || !isRecord(definition.ingredients))
    throw new Error("The cell has no ingredient declaration.");
  return {
    ...definition,
    clampForceN: 20,
    ingredients: { ...definition.ingredients, massKg: 2.5 },
  };
}

async function startRun(): Promise<void> {
  if (!["idle", "ended", "error"].includes(session.lifecycle.kind)) return;
  currentWorker()?.terminate();
  session.lifecycle = { kind: "opening" };
  session.view = null;
  session.receipt = null;
  session.artifacts.clear();
  session.execution += 1;
  session.events = [];
  session.saved = null;
  session.notice = "Starting the worker…";
  render();
  const opening = performance.now();
  const worker = await open(null);
  session.lifecycle = { kind: "commanding", worker };
  const beginning = performance.now();
  const prepared = session.definition ?? (await define(worker));
  const definition =
    session.journey === "recovery" ? weakClamp(prepared) : prepared;
  session.view = await begin(
    worker,
    session.execution,
    definition,
    {
      kind: "scenario",
      scenario: await scenarioFor(definition, session.journey),
    },
    null,
  );
  session.timings.push({
    execution: session.execution,
    openMs: beginning - opening,
    beginMs: performance.now() - beginning,
  });
  session.notice = "Running.";
  await drive(worker);
}

function destroyWorker(): void {
  if (session.lifecycle.kind !== "saved") return;
  session.lifecycle.worker.terminate();
  session.lifecycle = { kind: "destroyed" };
  session.notice = "The worker was destroyed. Its worlds are gone.";
  render();
}

// A saved cell continues from the definition its checkpoint carries. Since
// Refactor 16 step 6D the checkpoint is an envelope; checkpointBody reads
// both shapes.
function savedDefinition(saved: Saved): unknown {
  const content = saved.checkpoints[0]?.content;
  const body =
    content === undefined ? null : checkpointBody(JSON.parse(content));
  return body?.definition ?? null;
}

async function continueRun(): Promise<void> {
  const saved = session.saved;
  if (saved === null || session.lifecycle.kind !== "destroyed") return;
  session.lifecycle = { kind: "opening" };
  const claim = parseExecutionBundle(saved.document.bundle);
  if (claim === null) throw new Error("The save names no bundle");
  const previous = `browser-${session.execution}`;
  session.execution += 1;
  session.notice = "Resolving the bundle the save names…";
  render();
  const opening = performance.now();
  const worker = await open(claim);
  session.lifecycle = { kind: "commanding", worker };
  const beginning = performance.now();
  session.view = await begin(
    worker,
    session.execution,
    savedDefinition(saved),
    {
      kind: "snapshot",
      document: saved.document,
      checkpoints: saved.checkpoints,
    },
    { snapshot: saved.document.snapshot, execution: previous },
  );
  session.timings.push({
    execution: session.execution,
    openMs: beginning - opening,
    beginMs: performance.now() - beginning,
  });
  session.notice = `Continuing as browser-${session.execution}.`;
  await drive(worker);
}

function button(label: string, enabled: boolean, action: () => void) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.disabled = !enabled;
  element.addEventListener("click", action);
  return element;
}

function describe(event: unknown): string {
  if (!isRecord(event)) return "";
  const subject = event.task ?? event.carrier ?? event.instance ?? event.cell;
  return `${(Number(event.time) / 1_000_000).toFixed(3)} s  ${String(event.kind)}  ${String(subject ?? "")}`;
}

function startClicked(): void {
  report(startRun());
}

function pauseClicked(): void {
  if (session.lifecycle.kind !== "running") return;
  session.pauseRequested = true;
  session.notice = "Pausing at the next turn…";
  render();
}

function continueClicked(): void {
  report(continueRun());
}

function chooseStop(value: string): void {
  session.stopAt = isStop(value) ? value : null;
}

function chooseJourney(value: string): void {
  if (value !== "nominal" && value !== "recovery") return;
  session.journey = value;
  session.stopAt = null;
  render();
}

function journeyPicker(): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = "Scenario ";
  label.append(
    previewSelect("journey", {
      name: "journey",
      items: JOURNEY_CHOICES,
      current: () => session.journey,
      disabled: !["idle", "ended", "error"].includes(session.lifecycle.kind),
      choose: chooseJourney,
    }),
  );
  return label;
}

function chooseStorage(value: string): void {
  if (value === "reject-shelf" || value === "full-shelf")
    session.recoveryStorage = value;
}

type PreviewSelect = Readonly<{
  name: string;
  items: readonly PreviewChoice[];
  current(): string;
  disabled: boolean;
  choose(value: string): void;
}>;
type SelectHost = {
  readonly element: HTMLSpanElement;
  readonly root: Root;
  select: PreviewSelect;
};

// Each select keeps one React root across renders. A render moves its
// element into the new label and draws it again with the session's value.
const selectHosts = new Map<string, SelectHost>();

function previewSelect(key: string, select: PreviewSelect): HTMLElement {
  let host = selectHosts.get(key);
  if (host === undefined) {
    const element = document.createElement("span");
    element.style.display = "contents";
    host = { element, root: createRoot(element), select };
    selectHosts.set(key, host);
  } else host.select = select;
  drawSelect(host);
  return host.element;
}

function drawSelect(host: SelectHost): void {
  const { name, items, disabled } = host.select;
  host.root.render(
    React.createElement(
      Select.Root<string>,
      {
        name,
        items,
        value: host.select.current(),
        disabled,
        onValueChange: chooseInSelect.bind(null, host),
      },
      React.createElement(
        Select.Trigger,
        null,
        React.createElement(Select.Value),
      ),
      React.createElement(Select.Popup, null, items.map(previewItem)),
    ),
  );
}

function chooseInSelect(host: SelectHost, value: string | null): void {
  if (value === null) return;
  host.select.choose(value);
  drawSelect(host);
}

function previewItem(item: PreviewChoice): React.ReactNode {
  return React.createElement(
    Select.Item,
    { key: item.value, value: item.value },
    item.label,
  );
}

function recoveryControls(recoveries: readonly RecoveryView[]): HTMLElement {
  const panel = document.createElement("section");
  panel.className = "production-run-recovery";
  panel.setAttribute("aria-label", "Failed transfer recovery");
  for (const recovery of recoveries) {
    const description = document.createElement("p");
    if (recovery.kind === "recovery-required") {
      description.textContent =
        "Transfer stopped. The operator will reject the tray contents and return the arm. Handling assumes 5 seconds. The original order stays failed.";
      const label = document.createElement("label");
      label.textContent = "Recovery destination ";
      label.append(
        previewSelect(`recovery-storage:${recovery.task}`, {
          name: "recovery-storage",
          items: STORAGE_CHOICES,
          current: () => session.recoveryStorage,
          disabled: session.lifecycle.kind !== "ended",
          choose: chooseStorage,
        }),
      );
      panel.append(
        description,
        label,
        button(
          "Recover failed transfer",
          session.lifecycle.kind === "ended",
          recoverClicked.bind(null, recovery.task),
        ),
      );
    } else {
      description.textContent =
        recovery.kind === "recovery-failed"
          ? "Recovery failed. The cell and resources remain held."
          : recovery.phase === "handling"
            ? "The operator is handling the failed tray."
            : "The tray is on the reject shelf. The arm is returning.";
      panel.append(description);
    }
  }
  return panel;
}

function recoverClicked(task: string): void {
  report(recover(task));
}

async function recover(task: string): Promise<void> {
  if (session.lifecycle.kind !== "ended") return;
  const worker = session.lifecycle.worker;
  session.lifecycle = { kind: "commanding", worker };
  render();
  const reply = await worker.request({
    kind: "recover",
    commandId: `recover-${session.execution}-${++session.commandSequence}`,
    task,
    resource: "baker",
    storage: session.recoveryStorage,
    handling: 5_000_000,
    evidence: "assumed",
    reports: [{ product: "portioned-tray", destination: "rejected-trays" }],
  });
  session.view = readView(reply, "commanded");
  if (!isRecord(reply) || !isRecord(reply.receipt))
    throw new Error("Missing recovery receipt.");
  if (Array.isArray(reply.events)) session.events.push(...reply.events);
  const receipt = reply.receipt;
  if (receipt.status === "rejected" && typeof receipt.reason === "string") {
    session.receipt = { status: "rejected", reason: receipt.reason };
    session.lifecycle = { kind: "ended", worker };
    session.notice =
      receipt.reason === "recovery_destination_full"
        ? "Recovery did not start. The selected shelf has no free tray space."
        : `Recovery did not start: ${receipt.reason}.`;
    render();
    return;
  }
  if (receipt.status !== "accepted")
    throw new Error("Invalid recovery receipt.");
  session.receipt = { status: "accepted" };
  session.notice =
    "Recovery admitted. The baker and reject space remain reserved until handling and arm return finish.";
  await drive(worker);
}

const activityElement = document.createElement("section");
activityElement.setAttribute("aria-label", "Accepted production activity");
const activityRoot = createRoot(activityElement);
const controlsElement = document.createElement("section");
const eventsElement = document.createElement("section");
let diagnosticsOpen = false;
document
  .getElementById("root")
  ?.replaceChildren(controlsElement, activityElement, eventsElement);

function selectActivityTask(task: string): void {
  session.notice = `Selected task: ${task}`;
  render();
  const row = activityElement.querySelector<HTMLElement>(
    `[data-task-id="${CSS.escape(task)}"]`,
  );
  const trigger = row?.querySelector<HTMLButtonElement>(
    ".pantry-trace-collapsible-trigger",
  );
  if (!row || !trigger) return;
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  trigger.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}
// The recover button is the panel's own; the destination Select's trigger is
// a button inside its label.
function reviewActivityRecovery(): void {
  document
    .querySelector<HTMLButtonElement>(".production-run-recovery > button")
    ?.focus();
}

function toggleDiagnostics(event: Event): void {
  if (
    event.currentTarget instanceof HTMLDetailsElement &&
    event.currentTarget.isConnected
  )
    diagnosticsOpen = event.currentTarget.open;
}

function resumeSavedRun(): void {
  destroyWorker();
  continueClicked();
}

function previewStatus(): string {
  switch (session.lifecycle.kind) {
    case "idle":
      return "Ready";
    case "opening":
      return "Preparing";
    case "running":
      return "In progress";
    case "saving":
      return "Saving";
    case "saved":
      return "Paused · saved";
    case "destroyed":
      return "Ready to restore";
    case "commanding":
      return "In progress";
    case "error":
      return "Needs attention";
    case "ended": {
      if (session.view?.status.kind === "completed") return "Run complete";
      return "Needs attention";
    }
  }
}

function previewSummary(): string {
  const view = session.view;
  if (view === null)
    return "One robot cell. Two trays. Every step stays recorded.";
  let complete = 0;
  let failed = 0;
  let total = 0;
  if (view.logistics.kind === "available")
    for (const task of view.logistics.tasks) {
      total += 1;
      if (task.kind === "completed") complete += 1;
      if (
        task.kind === "failed" ||
        task.kind === "recovery-required" ||
        task.kind === "recovery-failed" ||
        task.kind === "recovering"
      )
        failed += 1;
    }
  const progress = `${complete} of ${total} steps complete`;
  return failed > 0
    ? `${progress} · ${failed} failed transfer${failed === 1 ? "" : "s"}.`
    : `${progress} · ${(view.time / 1e6).toFixed(1)} s simulated.`;
}

function render(): void {
  const root = document.getElementById("root");
  if (root === null) return;
  const view = session.view;
  const cell = view?.cells[0] ?? null;
  const data = document.body.dataset;
  data.phase = session.lifecycle.kind;
  data.status = view?.status.kind ?? "";
  data.time = String(view?.time ?? 0);
  data.execution = String(session.execution);
  data.carrier = cell?.carrier ?? "";
  data.attempt = cell?.attempt?.id ?? "";
  data.attemptSteps = String(cell?.attempt?.steps ?? 0);
  data.checkpoint = cell?.checkpoint ?? "";
  data.hold = cell?.hold ?? "";
  data.cellSteps = String(cell?.steps ?? 0);
  data.snapshot =
    session.saved === null ? "" : String(session.saved.document.snapshot);

  data.recovery = view?.recoveries[0]?.kind ?? "";
  data.recoveryPhase = view?.recoveries[0]?.phase ?? "";
  data.recoveryTask = view?.recoveries[0]?.task ?? "";
  data.receipt = session.receipt?.status ?? "";
  data.refusal =
    session.receipt?.status === "rejected" ? session.receipt.reason : "";

  const heading = document.createElement("h1");
  heading.textContent = "Cold-cell transfer";
  const status = document.createElement("span");
  status.className = "production-run-status";
  status.textContent = previewStatus();
  const header = document.createElement("header");
  header.className = "production-run-heading";
  header.append(heading, status);
  const summary = document.createElement("p");
  summary.className = "production-run-summary";
  summary.setAttribute("role", "status");
  summary.textContent = previewSummary();
  const controls = document.createElement("div");
  controls.className = "production-run-controls";
  controls.append(journeyPicker());
  if (["idle", "ended", "error"].includes(session.lifecycle.kind))
    controls.append(button("Start run", true, startClicked));
  if (session.lifecycle.kind === "running")
    controls.append(button("Pause and save", true, pauseClicked));
  if (session.lifecycle.kind === "saved")
    controls.append(button("Resume saved run", true, resumeSavedRun));
  if (session.lifecycle.kind === "destroyed")
    controls.append(
      button("Continue from save", session.saved !== null, continueClicked),
    );
  const diagnostics = document.createElement("details");
  diagnostics.className = "production-run-diagnostics";
  diagnostics.open = diagnosticsOpen;
  diagnostics.addEventListener("toggle", toggleDiagnostics);
  const diagnosticsTitle = document.createElement("summary");
  diagnosticsTitle.textContent = "Simulation details";
  const technical = document.createElement("p");
  technical.textContent = `${session.notice} Execution browser-${session.execution}. Cell holds ${cell?.carrier ?? "no tray"}.`;
  diagnostics.append(diagnosticsTitle, technical);
  const label = document.createElement("label");
  label.textContent = "Pause and save at ";
  label.append(
    previewSelect("stop", {
      name: "stop",
      items: STOP_CHOICES,
      current: () => session.stopAt ?? "",
      disabled: false,
      choose: chooseStop,
    }),
  );
  diagnostics.append(label);
  if (session.lifecycle.kind === "saved")
    diagnostics.append(button("Destroy worker", true, destroyWorker));
  const recovery = recoveryControls(view?.recoveries ?? []);
  const timeline = document.createElement("ol");
  timeline.className = "production-run-timeline";
  for (const event of session.events.slice(-14)) {
    const item = document.createElement("li");
    item.textContent = describe(event);
    timeline.append(item);
  }
  activityRoot.render(
    view === null
      ? null
      : React.createElement(ProductionActivityTrace, {
          view,
          select: selectActivityTask,
          reviewRecovery: reviewActivityRecovery,
        }),
  );
  diagnostics.append(timeline);
  const notice = document.createElement("p");
  notice.className = "production-run-notice";
  if (
    session.lifecycle.kind === "error" ||
    session.receipt?.status === "rejected"
  )
    notice.textContent = session.notice;
  controlsElement.replaceChildren(header, summary, controls, notice, recovery);
  eventsElement.replaceChildren(diagnostics);
}

// The journey script drives reference runs and reads this run's history.
Object.assign(window, {
  productionRunPreview: {
    pinned: PRODUCTION_EXECUTION_MANIFEST.bundle,
    session,
    openExecutionWorker,
    openAuthoredCellWorker,
    define,
    savedDefinition,
    scenarioFor,
    identity,
    currentWorker,
    weakClamp,
  },
});
render();
