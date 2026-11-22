import { applianceVisual } from "@purin-labs/production-simulation/simulator/appliance-runtime";
import { EspressoScene } from "./espresso-scene";
import { assertNever } from "@purin-labs/std";
import {
  controlRead,
  controlMutation,
  type ControlMutationIntent,
} from "@purin-labs/control/portal/control-client";
import {
  prepareEspressoWorkspaceRun,
  savePreparedWorkspaceRun,
  readWorkspaceRuns,
  readExactWorkspaceRun,
} from "../../workflow-simulator/workspace-runs-api";
import { downloadBakeryFile } from "../../workflow-simulator/file-download";
import {
  MAX_ESPRESSO_FILE_BYTES,
  readEspressoRun,
  saveEspressoRun,
  prepareEspressoRun,
  type EspressoTelemetry,
  type SavedEspressoRun,
} from "@purin-labs/bakery-model/espresso-rehearsal-file";
import {
  freshApplianceRequest,
  type ApplianceAction,
  type ApplianceRequest,
  type ApplianceResult,
  type EspressoGroup,
  type EspressoOutlet,
  type EspressoDoseSlot,
} from "@purin-labs/bakery-model/bakery-appliance-protocol";
import { EngineJobs, type JobProgress } from "../engine-jobs";
import "./linea-rehearsal.css";

type Session = { kind: "fresh" } | ({ kind: "continued" } & SavedEspressoRun);
type State =
  | { kind: "ready"; session: Session }
  | {
      kind: "file-operation";
      operation: "open" | "save" | "list";
      session: Session;
    }
  | {
      kind: "running";
      session: Session;
      request: ApplianceRequest;
      task:
        | {
            kind: "commands";
            remaining: readonly (readonly ApplianceAction[])[];
          }
        | { kind: "restore"; saved: SavedEspressoRun };
    };
const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) throw new Error("Missing preview root.");
type Machine =
  | Readonly<{
      model: "linea";
      appliance: "la-marzocco-linea-classic-s-2g";
      archive: "linea";
      label: "Linea Classic S";
    }>
  | Readonly<{
      model: "eagle-one";
      appliance: "victoria-arduino-eagle-one-2g";
      archive: "eagle";
      label: "Eagle One";
    }>;
function readMachine(value: unknown): Machine {
  switch (value) {
    case "linea":
      return {
        model: "linea",
        appliance: "la-marzocco-linea-classic-s-2g",
        archive: "linea",
        label: "Linea Classic S",
      };
    case "eagle-one":
      return {
        model: "eagle-one",
        appliance: "victoria-arduino-eagle-one-2g",
        archive: "eagle",
        label: "Eagle One",
      };
    default:
      throw new Error("Select a supported espresso machine.");
  }
}
const machine = readMachine(root.dataset.appliance);
root.innerHTML = `<header><h1>${machine.label} · two groups</h1><p>MuJoCo appliance rehearsal. Heating, flow, pressure and mechanical limits are uncalibrated assumptions. Eagle One uses an aggregate coffee-circuit model; NEO and TERS are not separately resolved.</p></header><section aria-label="Saved espresso run" id="files"><button id="save-run" disabled>Save rehearsal file</button><label>Open rehearsal file <input id="open-run" type="file" accept=".json,application/json"></label><p>Files retain doses, cup contents and the last recording. Reopen checks the saved state with Rust before replacement. Reopen uses the saved controller and visual build.</p></section><section id="shared-runs" aria-label="Shared espresso runs" hidden><h2>Workspace runs</h2><label>Shared run name <input id="shared-name" maxlength="80" value="${machine.label} rehearsal"></label><button id="shared-save" disabled>Save to workspace</button><button id="shared-refresh">Refresh shared runs</button><button id="shared-more" hidden>Load more runs</button><ul id="shared-list"></ul><p id="shared-status" role="status">Workspace permissions are checked on each request.</p></section><div class="linea-layout"><section aria-label="Recorded appliance view" id="view"></section><section><h2>Controls</h2><p>Runs the shared Rust controller in a browser worker, then shows its recorded motion.</p><div id="controls"></div><p id="cups" aria-live="polite"></p><p role="status" id="status">Ready. The left basket contains an assumed 18 g coffee dose.</p><label>Recorded frame <input id="frame" type="range" min="0" max="0" value="0"></label><p id="clock"></p><details><summary>Recorded controller state</summary><pre id="telemetry"></pre></details><a id="download" hidden>Download the last recording</a></section></div>`;
function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing ${id}.`);
  return value;
}
type SharedScope =
  { kind: "local" } | { kind: "workspace"; organisationId: string };
function sharedScope(): SharedScope {
  const organisationId = new URL(location.href).searchParams.get(
    "organisation",
  );
  if (organisationId === null) return { kind: "local" };
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(organisationId))
    throw new Error("Invalid workspace identity.");
  return { kind: "workspace", organisationId };
}
const scope = sharedScope();
let nextSharedPage: { kind: "complete" } | { kind: "more"; cursor: string } = {
  kind: "complete",
};
const controls = element("controls");
const status = element("status");
const slider = element("frame");
if (!(slider instanceof HTMLInputElement))
  throw new Error("Missing frame slider.");
const frameSlider = slider;
const download = element("download");
if (!(download instanceof HTMLAnchorElement))
  throw new Error("Missing recording link.");
const recordingLink = download;
let downloadUrl: string | null = null;
let state: State = { kind: "ready", session: { kind: "fresh" } };
const job = new EngineJobs();
const runId = `espresso-${crypto.randomUUID()}`;
let attempt = 0;
const visual = new EspressoScene(element("view"), machine.model);
await visual.load();
function button(label: string, handler: () => void): void {
  const node = document.createElement("button");
  node.textContent = label;
  node.addEventListener("click", handler);
  controls.append(node);
}
function advance(seconds: number): ApplianceAction {
  return { kind: "advance", seconds };
}
function send(actions: readonly ApplianceAction[]): void {
  sequence([actions]);
}
function sequence(steps: readonly (readonly ApplianceAction[])[]): void {
  if (state.kind !== "ready") return;
  dispatch(state.session, steps);
}
function dispatch(
  session: Session,
  steps: readonly (readonly ApplianceAction[])[],
): void {
  const actions = steps[0];
  if (!actions) {
    state = { kind: "ready", session };
    setDisabled(false);
    return;
  }
  attempt++;
  const attemptId = `espresso-${crypto.randomUUID()}`;
  const request =
    session.kind === "continued"
      ? session.result.continuation.request(
          session.result.runId,
          attemptId,
          actions,
        )
      : freshApplianceRequest(
          machine.appliance,
          runId,
          attemptId,
          {
            kind: "loaded",
            batch: {
              identity: "espresso-coffee-dose",
              mass_kg: 0.018,
              temperature_c: 20,
              specific_heat: 1500,
              density_kg_l: 0.5,
              resistance: 0,
            },
          },
          actions,
        );
  state = {
    kind: "running",
    session,
    request,
    task: { kind: "commands", remaining: steps.slice(1) },
  };
  setDisabled(true);
  beginRequest(request);
}
async function prepared(): Promise<boolean> {
  return true;
}
function progress(progress: JobProgress): void {
  status.textContent = `${progress.stage === "loading" ? "Loading" : "Simulating"} job ${attempt}…`;
}
function beginRequest(request: ApplianceRequest): void {
  try {
    job.beginAppliance(request, { prepared, completed, failed, progress });
  } catch (error) {
    failed(
      error instanceof Error
        ? error.message
        : "The simulation could not start.",
    );
  }
}
async function completed(result: ApplianceResult): Promise<void> {
  if (state.kind !== "running") return;
  const current = state;
  if (current.task.kind === "restore" && result.outcome.kind !== "completed") {
    failed(
      `Saved state refused: ${result.outcome.message}. The current run is unchanged.`,
    );
    return;
  }
  if (current.task.kind === "restore") {
    try {
      await visual.load(applianceVisual(current.task.saved.result));
    } catch (error) {
      failed(
        error instanceof Error
          ? error.message
          : "The retained visual is unavailable.",
      );
      return;
    }
  }
  const accepted =
    current.task.kind === "restore"
      ? current.task.saved
      : prepareEspressoRun(current.request, result);
  const session: Session = {
    kind: "continued",
    result: accepted.result,
    request: accepted.request,
    telemetry: accepted.telemetry,
  };
  state = { kind: "ready", session };
  showResult(accepted.result);
  const latest = accepted.telemetry.at(-1);
  if (latest) restoreDoseInputs(latest);
  if (current.task.kind === "restore") {
    status.textContent =
      "Saved rehearsal restored. Doses and cup contents are ready to continue.";
    setDisabled(false);
  } else if (result.outcome.kind === "rejected") {
    status.textContent = `Command refused: ${result.outcome.message}`;
    setDisabled(false);
  } else if (current.task.remaining.length > 0)
    dispatch(session, current.task.remaining);
  else {
    status.textContent = `Completed job ${attempt}.`;
    setDisabled(false);
  }
}
function showResult(result: ApplianceResult): void {
  frameSlider.max = String(result.samples.length - 1);
  frameSlider.value = frameSlider.max;
  showSelectedFrame();
  if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(
    new Blob([result.file], { type: "application/json" }),
  );
  recordingLink.href = downloadUrl;
  recordingLink.download = `${result.attemptId}.json`;
  recordingLink.hidden = false;
}
function saveRun(): void {
  if (state.kind !== "ready" || state.session.kind !== "continued") return;
  downloadBakeryFile(
    `${state.session.result.runId}.espresso.json`,
    saveEspressoRun(state.session),
  );
}
async function openRun(event: Event): Promise<void> {
  if (!(event.target instanceof HTMLInputElement) || state.kind !== "ready")
    return;
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  const previous = state.session;
  state = { kind: "file-operation", operation: "open", session: previous };
  setDisabled(true);
  status.textContent = "Checking the saved rehearsal…";
  try {
    if (file.size > MAX_ESPRESSO_FILE_BYTES)
      throw new Error("The espresso file exceeds 34 MiB.");
    beginRestore(previous, await file.text());
  } catch (error) {
    state = { kind: "ready", session: previous };
    status.textContent = `${error instanceof Error ? error.message : "The file could not open."} The current run is unchanged.`;
    setDisabled(false);
  }
}
function beginRestore(previous: Session, file: string): void {
  const saved = readEspressoRun(file);
  if (saved.request.appliance !== machine.appliance)
    throw new Error("The saved run belongs to another machine.");
  const request = saved.result.continuation.request(
    saved.result.runId,
    `restore-${crypto.randomUUID()}`,
    [{ kind: "inspect" }],
  );
  state = {
    kind: "running",
    session: previous,
    request,
    task: { kind: "restore", saved },
  };
  beginRequest(request);
}
function sharedMutation(
  path: string,
  body: unknown,
  intent: ControlMutationIntent,
): Promise<unknown> {
  return controlMutation(path, "POST", body, undefined, intent);
}
async function saveShared(): Promise<void> {
  if (
    scope.kind !== "workspace" ||
    state.kind !== "ready" ||
    state.session.kind !== "continued"
  )
    return;
  const previous = state.session;
  const nameInput = element("shared-name");
  if (!(nameInput instanceof HTMLInputElement)) return;
  state = { kind: "file-operation", operation: "save", session: previous };
  setDisabled(true);
  const message = element("shared-status");
  message.textContent = "Saving to the current workspace…";
  try {
    const prepared = await prepareEspressoWorkspaceRun(
      nameInput.value,
      saveEspressoRun(previous),
    );
    const outcome = await savePreparedWorkspaceRun(
      scope.organisationId,
      sharedMutation,
      prepared,
      controlRead,
    );
    switch (outcome.kind) {
      case "verified":
        message.textContent = `Saved and verified: ${outcome.snapshot.name}`;
        break;
      case "saved-readback-failed":
        message.textContent = `Saved, but verification failed: ${outcome.message}`;
        break;
      case "outcome-unknown":
        message.textContent = `Save outcome unknown. Refresh shared runs before retrying. ${outcome.message}`;
        break;
      default:
        assertNever(outcome);
    }
  } catch (error) {
    message.textContent =
      error instanceof Error ? error.message : "Workspace save failed.";
  }
  state = { kind: "ready", session: previous };
  setDisabled(false);
}
async function listShared(cursor: string | null): Promise<void> {
  if (scope.kind !== "workspace" || state.kind !== "ready") return;
  const previous = state.session;
  state = { kind: "file-operation", operation: "list", session: previous };
  setDisabled(true);
  const message = element("shared-status");
  try {
    const page = await readWorkspaceRuns(
      scope.organisationId,
      machine.archive,
      cursor,
      controlRead,
    );
    const list = element("shared-list");
    if (cursor === null) list.replaceChildren();
    for (const item of page.snapshots) {
      const row = document.createElement("li");
      const open = document.createElement("button");
      open.textContent = `Open ${item.name}`;
      open.addEventListener("click", openShared.bind(null, item.id));
      row.append(open);
      list.append(row);
    }
    nextSharedPage =
      page.nextCursor === null
        ? { kind: "complete" }
        : { kind: "more", cursor: page.nextCursor };
    element("shared-more").hidden = nextSharedPage.kind === "complete";
    message.textContent =
      list.childElementCount === 0
        ? "No runs for this machine in this page. Load more if available."
        : "Select a run to validate and reopen it.";
  } catch (error) {
    message.textContent =
      error instanceof Error ? error.message : "Workspace read failed.";
  }
  state = { kind: "ready", session: previous };
  setDisabled(false);
}
function refreshShared(): void {
  void listShared(null);
}
function moreShared(): void {
  if (nextSharedPage.kind === "more") void listShared(nextSharedPage.cursor);
}
async function openShared(id: string): Promise<void> {
  if (scope.kind !== "workspace" || state.kind !== "ready") return;
  const previous = state.session;
  state = { kind: "file-operation", operation: "open", session: previous };
  setDisabled(true);
  status.textContent = "Checking the shared run…";
  try {
    const snapshot = await readExactWorkspaceRun(
      scope.organisationId,
      id,
      controlRead,
    );
    if (snapshot.kind !== machine.archive)
      throw new Error("Choose a run for this machine.");
    beginRestore(previous, snapshot.file);
  } catch (error) {
    state = { kind: "ready", session: previous };
    status.textContent = `${error instanceof Error ? error.message : "Workspace read failed."} The current run is unchanged.`;
    setDisabled(false);
  }
}
function failed(message: string): void {
  if (state.kind !== "running") return;
  state = { kind: "ready", session: state.session };
  status.textContent = `${message} The last accepted state is unchanged.`;
  setDisabled(false);
}
function setDisabled(disabled: boolean): void {
  for (const input of controls.querySelectorAll("button, input")) {
    if (input instanceof HTMLButtonElement || input instanceof HTMLInputElement)
      input.disabled = disabled;
  }
  for (const input of element("shared-runs").querySelectorAll(
    "button, input",
  )) {
    if (input instanceof HTMLButtonElement || input instanceof HTMLInputElement)
      input.disabled = disabled;
  }
  const sharedSave = element("shared-save");
  if (sharedSave instanceof HTMLButtonElement)
    sharedSave.disabled = disabled || state.session.kind === "fresh";
  const save = element("save-run");
  const open = element("open-run");
  if (save instanceof HTMLButtonElement)
    save.disabled = disabled || state.session.kind === "fresh";
  if (open instanceof HTMLInputElement) open.disabled = disabled;
}
function warmup(): void {
  sequence([
    [
      {
        kind: "start",
        program: { kind: "espresso-warmup", coffee_c: 93, steam_c: 125 },
      },
      advance(480),
    ],
    [advance(480)],
    [advance(480), { kind: "require", state: "ready" }],
  ]);
}
function runShot(group: EspressoGroup): void {
  send([
    {
      kind: "start",
      program: { kind: "espresso-shot", group, duration_s: 25 },
    },
    advance(5),
  ]);
}
function hotWater(): void {
  send([
    { kind: "start", program: { kind: "espresso-hot-water", duration_s: 15 } },
    advance(3),
  ]);
}
function stopHotWater(): void {
  send([{ kind: "stop-hot-water" }, advance(1)]);
}
function moveCup(outlet: EspressoOutlet, position: "placed" | "removed"): void {
  send([{ kind: "move-cup", outlet, position }, advance(5)]);
}
function emptyCup(outlet: EspressoOutlet): void {
  send([{ kind: "empty-cup", outlet }, advance(1)]);
}
function presetShot(group: EspressoGroup, slot: EspressoDoseSlot): void {
  send([
    { kind: "start", program: { kind: "espresso-shot-preset", group, slot } },
    advance(5),
  ]);
}
function programShot(
  group: EspressoGroup,
  slot: EspressoDoseSlot,
  input: HTMLInputElement,
): void {
  send([
    { kind: "set-shot-dose", group, slot, duration_s: Number(input.value) },
  ]);
}
function programWater(input: HTMLInputElement): void {
  send([{ kind: "set-hot-water-dose", duration_s: Number(input.value) }]);
}
function presetWater(): void {
  send([
    { kind: "start", program: { kind: "espresso-hot-water-preset" } },
    advance(3),
  ]);
}
function doseInput(label: string, value: number): HTMLInputElement {
  const container = document.createElement("label");
  container.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "60";
  input.value = String(value);
  container.append(input);
  controls.append(container);
  return input;
}
function stopShot(group: EspressoGroup): void {
  send([{ kind: "stop-shot", group }, advance(2)]);
}
function removeFilter(group: EspressoGroup): void {
  send([
    { kind: "move-cup", outlet: group, position: "removed" },
    advance(5),
    { kind: "portafilter", group, position: "unlocked" },
    advance(1),
    { kind: "portafilter", group, position: "removed" },
    advance(3),
  ]);
}
function seatFilter(group: EspressoGroup): void {
  send([
    { kind: "portafilter", group, position: "seated" },
    advance(3),
    { kind: "portafilter", group, position: "locked" },
    advance(1),
  ]);
}
function steam(group: EspressoGroup, open: boolean): void {
  send([{ kind: "steam", group, open }, advance(3)]);
}
function wand(group: EspressoGroup): void {
  send([{ kind: "steam-wand", group, angle_degrees: 25 }, advance(1)]);
}
function water(available: boolean): void {
  send([{ kind: "water-supply", available }, advance(1)]);
}
function stop(): void {
  send([{ kind: "stop" }, advance(2)]);
}
function advanceTwenty(): void {
  send([advance(20)]);
}
const shotDoseInputs = new Map<string, HTMLInputElement>();
button("Warm both boilers", warmup);
button("Advance 20 seconds", advanceTwenty);
button("Start 15-second hot water", hotWater);
const waterDose = doseInput("Hot-water preset seconds", 15);
button("Save hot-water preset", programWater.bind(null, waterDose));
button("Run hot-water preset", presetWater);
button("Stop hot water", stopHotWater);
button("Power off / stop all", stop);
for (const group of ["left", "right"] satisfies EspressoGroup[]) {
  const heading = document.createElement("h3");
  heading.textContent = `${group} group`;
  controls.append(heading);
  button("Start 25-second shot", runShot.bind(null, group));
  button("Stop shot", stopShot.bind(null, group));
  for (const slot of ["one", "two"] satisfies EspressoDoseSlot[]) {
    const input = doseInput(
      `${group} dose ${slot} seconds`,
      slot === "one" ? 12 : 25,
    );
    shotDoseInputs.set(`${group}-${slot}`, input);
    button(
      `Save ${group} dose ${slot}`,
      programShot.bind(null, group, slot, input),
    );
    button(`Run ${group} dose ${slot}`, presetShot.bind(null, group, slot));
  }
  button("Unlock and remove filter", removeFilter.bind(null, group));
  button("Seat and lock filter", seatFilter.bind(null, group));
  button("Steam on", steam.bind(null, group, true));
  button("Steam off", steam.bind(null, group, false));
  button("Swivel wand", wand.bind(null, group));
}
for (const outlet of [
  "left",
  "right",
  "hot-water",
] satisfies EspressoOutlet[]) {
  button(`Remove ${outlet} cup`, moveCup.bind(null, outlet, "removed"));
  button(`Place ${outlet} cup`, moveCup.bind(null, outlet, "placed"));
  button(`Empty ${outlet} cup`, emptyCup.bind(null, outlet));
}
button("Simulate water loss", water.bind(null, false));
button("Restore water", water.bind(null, true));
function showSelectedFrame(): void {
  if (state.session.kind !== "continued") return;
  const sample = state.session.result.samples[Number(frameSlider.value)];
  if (!sample) return;
  visual.setFrame(sample);
  element("clock").textContent =
    `Simulation time: ${sample.timeSeconds.toFixed(1)} seconds`;
  element("telemetry").textContent = sample.telemetryText;
  const telemetry = state.session.telemetry[Number(frameSlider.value)];
  if (telemetry) showCups(telemetry);
}
function restoreDoseInputs(telemetry: EspressoTelemetry): void {
  waterDose.value = String(telemetry.hotWaterDose);
  for (const [index, group] of ["left", "right"].entries()) {
    const doses = telemetry.shotDoses[index];
    if (!doses) continue;
    for (const [slotIndex, slot] of ["one", "two"].entries()) {
      const input = shotDoseInputs.get(`${group}-${slot}`);
      if (input) input.value = String(doses[slotIndex]);
    }
  }
}
function showCups(telemetry: EspressoTelemetry): void {
  const summaries: string[] = [];
  for (const [index, cup] of telemetry.cups.entries()) {
    const label = ["Left", "Right", "Hot water"][index];
    summaries.push(
      `${label}: ${cup.mass_g.toFixed(1)} g, ${cup.temperature_c.toFixed(1)}°C (${cup.position})`,
    );
  }
  element("cups").textContent = summaries.join(" · ");
}
frameSlider.addEventListener("input", showSelectedFrame);

element("save-run").addEventListener("click", saveRun);
element("open-run").addEventListener("change", openRun);

if (scope.kind === "workspace") {
  element("shared-runs").hidden = false;
  element("shared-save").addEventListener("click", saveShared);
  element("shared-refresh").addEventListener("click", refreshShared);
  element("shared-more").addEventListener("click", moreShared);
}
