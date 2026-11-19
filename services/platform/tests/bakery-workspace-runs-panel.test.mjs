import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recording from "../../../assets/bakery-mujoco/fr10-workcell/recordings/nominal.json";
import { parsePhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import { sampleSettings } from "@purin-labs/bakery-model/bakery";
import { WorkspaceRunsPanel } from "../../../apps/portal/src/features/workflow-simulator/workspace-runs-panel";
import { ControlApiError } from "../../../apps/portal/src/control-client";
import { editRehearsalWorkcells } from "../../../packages/production-simulation/src/recipes/bakery/production-workcells.ts";
import {
  rehearsalFromRecording,
  rehearsalSettings,
} from "@purin-labs/production-simulation/simulator/rehearsal-presets";
import {
  initialSimulatorState,
  applyBakeryWorkspaceAction,
} from "../../../apps/portal/src/features/workflow-simulator/simulator-state";

const transport = vi.hoisted(createTransport);
function createTransport() {
  return { read: vi.fn() };
}
vi.mock("../../../apps/portal/src/control-client", controlClient);
async function controlClient() {
  const original = await vi.importActual(
    "../../../apps/portal/src/control-client",
  );
  return { ...original, controlRead: transport.read };
}

class PanelHarness extends WorkspaceRunsPanel {
  setState(update, callback) {
    const previous = this.state;
    this.state = { ...previous, ...update };
    this.componentDidUpdate(this.props, previous);
    callback?.();
  }
  setProps(props) {
    const previous = this.props;
    this.props = props;
    this.componentDidUpdate(previous);
  }
}

const first = summary("a", "Morning");
const second = summary("b", "Evening");
const firstPage = { ok: true, snapshots: [first], nextCursor: "second/page" };
const lastPage = { ok: true, snapshots: [second], nextCursor: null };
const parsed = parsePhysicsReplay(JSON.stringify(recording));
if (parsed.kind === "rejected") throw new Error(parsed.message);
// One rehearsal tray with its recorded result, and the same tray cleared.
const settings = rehearsalSettings(sampleSettings());
const recorded = await rehearsalFromRecording(settings, parsed.recording);
if (recorded.kind === "rejected") throw new Error(recorded.message);
const cleared = await editRehearsalWorkcells(recorded.plan, {
  kind: "reset",
  batchId: "A",
});
if (cleared.kind === "rejected") throw new Error(cleared.message);
const pendingPlan = cleared.plan;
let panel;
let workspaceState;
beforeEach(reset);
afterEach(cleanup);
function reset() {
  transport.read.mockReset();
}
function cleanup() {
  panel?.componentWillUnmount();
  panel = undefined;
}
function summary(character, name) {
  return {
    id: character.repeat(64),
    name,
    kind: "rehearsal",
    savedAt: "2026-09-23T00:00:00.000Z",
    bytes: 500,
  };
}
function mount() {
  workspaceState = initialSimulatorState("closed");
  transport.read.mockResolvedValueOnce(firstPage);
  panel = new PanelHarness({
    kind: "rehearsal-run",
    connection: {
      kind: "workspace",
      organisationId: "bakery-a",
      canManage: true,
      mutate: vi.fn(),
    },
    source: null,
    proposal: null,
    open: vi.fn(),
    saveStatus: workspaceState.workspace.runSaves.rehearsal,
    saveChanged,
  });
  panel.errorMessage.current = { focus: vi.fn() };
  panel.pageHeading.current = { focus: vi.fn() };
  panel.reviewHeading.current = { focus: vi.fn() };
  panel.componentDidMount();
  return panel;
}
function saveChanged(action) {
  workspaceState = applyBakeryWorkspaceAction(action, workspaceState);
  if (panel?.mounted) {
    panel.setProps({
      ...panel.props,
      saveStatus: workspaceState.workspace.runSaves.rehearsal,
    });
  }
}
function firstPageLoaded() {
  expect(panel.state.page?.snapshots).toEqual([first]);
  expect(panel.state.activity.kind).toBe("idle");
}

it(
  "delegates exact run opening and ignores stale completion messages",
  staleOpen,
);
async function staleOpen() {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  page.props.open.mockRejectedValueOnce(
    new Error("Saved copy no longer available"),
  );
  await page.open(first.id);
  expect(page.state.activity.kind).toBe("failed");
  expect(page.props.open).toHaveBeenCalledWith(first.id);
  const pending = Promise.withResolvers();
  page.props.open.mockReturnValueOnce(pending.promise);
  const opening = page.open(first.id);
  const original = page.props;
  page.setProps({ ...original, source: pendingPlan });
  page.setProps(original);
  pending.resolve();
  await opening;
  expect(page.state.activity.message).toContain("current run is kept");
  await page.open(first.id);
  expect(page.state.activity.kind).toBe("idle");
  expect(page.props.open).toHaveBeenCalledTimes(3);
}

it(
  "changing workspace clears the catalogue and ignores the previous workspace's late page",
  changedWorkspace,
);
async function changedWorkspace() {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  const pending = Promise.withResolvers();
  transport.read.mockReturnValueOnce(pending.promise);
  page.next();
  transport.read.mockResolvedValueOnce({
    ok: true,
    snapshots: [],
    nextCursor: null,
  });
  page.setProps({
    ...page.props,
    connection: { ...page.props.connection, organisationId: "bakery-b" },
  });
  await vi.waitFor(emptyPageLoaded);
  pending.resolve(lastPage);
  await pending.promise;
  await vi.waitFor(emptyPageLoaded);
  expect(page.state.page.cursors).toEqual([null]);
  expect(transport.read).toHaveBeenLastCalledWith(
    "/v1/control/organisations/bakery-b/bakery/runs",
  );
}
function emptyPageLoaded() {
  expect(panel.state.activity.kind).toBe("idle");
  expect(panel.state.page?.snapshots).toEqual([]);
}

it(
  "review saves frozen bytes while a newer run remains in the workspace",
  reviewedSave,
);
async function reviewedSave() {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  const firstSource = pendingPlan;
  page.setProps({ ...page.props, source: firstSource });
  await page.prepare({ preventDefault() {} });
  const prepared = page.state.prepared;
  expect(prepared?.snapshot.kind).toBe("rehearsal");
  expect(page.reviewHeading.current.focus).toHaveBeenCalledOnce();
  const pending = Promise.withResolvers();
  page.props.connection.mutate.mockReturnValueOnce(pending.promise);
  const saving = page.save();
  await vi.waitFor(mutationStarted);
  const newerSource = recorded.plan;
  page.setProps({ ...page.props, source: newerSource });
  const submitted = page.props.connection.mutate.mock.calls[0][1];
  expect(submitted.document.fingerprint).toBe(firstSource.fingerprint);
  transport.read.mockResolvedValueOnce(savedRunBody(submitted));
  pending.resolve({
    ok: true,
    snapshot: {
      id: prepared.id,
      name: prepared.snapshot.name,
      kind: prepared.snapshot.kind,
      savedAt: "2026-09-23T00:00:00.000Z",
      bytes: prepared.bytes,
    },
  });
  await saving;
  expect(page.props.source).toBe(newerSource);
  expect(page.props.saveStatus.kind).toBe("verified");
  expect(page.props.saveStatus.snapshot.id).toBe(prepared.id);
  expect(page.state.prepared).toBeNull();
}

it("settles the exact save into route state after the panel unmounts", async () => {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  page.setProps({ ...page.props, source: pendingPlan });
  await page.prepare({ preventDefault() {} });
  const prepared = page.state.prepared;
  const pending = Promise.withResolvers();
  page.props.connection.mutate.mockReturnValueOnce(pending.promise);
  const saving = page.save();
  await vi.waitFor(mutationStarted);
  assertSaveStatus("saving", prepared.id);
  page.componentWillUnmount();
  transport.read.mockResolvedValueOnce(
    savedRunBody(page.props.connection.mutate.mock.calls[0][1]),
  );
  pending.resolve({
    ok: true,
    snapshot: {
      id: prepared.id,
      name: prepared.snapshot.name,
      kind: prepared.snapshot.kind,
      savedAt: "2026-09-23T00:00:00.000Z",
      bytes: prepared.bytes,
    },
  });
  await saving;
  assertSaveStatus("verified", prepared.id);
});

function assertSaveStatus(kind, id) {
  const status = workspaceState.workspace.runSaves.rehearsal;
  expect(status.kind).toBe(kind);
  expect(kind === "verified" ? status.snapshot.id : status.id).toBe(id);
}

it("retains the recovery ID after an unmounted save loses its response", async () => {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  page.setProps({ ...page.props, source: pendingPlan });
  await page.prepare({ preventDefault() {} });
  const expectedId = page.state.prepared.id;
  const pending = Promise.withResolvers();
  page.props.connection.mutate.mockReturnValueOnce(pending.promise);
  const saving = page.save();
  await vi.waitFor(mutationStarted);
  page.componentWillUnmount();
  pending.reject(new Error("Response lost"));
  await saving;
  assertSaveStatus("outcome-unknown", expectedId);
  transport.read.mockResolvedValueOnce(firstPage);
  panel = new PanelHarness({
    ...page.props,
    saveStatus: workspaceState.workspace.runSaves.rehearsal,
  });
  panel.componentDidMount();
  await vi.waitFor(firstPageLoaded);
  expect(panel.props.saveStatus.id).toBe(expectedId);
  expect(panel.render().props["aria-busy"]).toBe(false);
  expect(panel.saveReviewBlocked()).toBe(true);
  await panel.prepare({ preventDefault() {} });
  expect(panel.state.prepared).toBeNull();
  transport.read.mockResolvedValueOnce(
    savedRunBody(page.props.connection.mutate.mock.calls[0][1]),
  );
  await panel.checkSavedRun();
  assertSaveStatus("readback-confirmed", expectedId);
  expect(panel.saveReviewBlocked()).toBe(false);
  expect(page.props.connection.mutate).toHaveBeenCalledOnce();
});

it("retries only the same reviewed run after its exact read reports missing", async () => {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  const originalSource = pendingPlan;
  page.setProps({ ...page.props, source: originalSource });
  await page.prepare({ preventDefault() {} });
  const original = page.state.prepared;
  page.props.connection.mutate.mockRejectedValueOnce(
    new Error("Response lost"),
  );
  await page.save();
  assertSaveStatus("outcome-unknown", original.id);

  transport.read.mockRejectedValueOnce(
    new ControlApiError(
      "This saved run could not be found.",
      "bakery_run_not_found",
    ),
  );
  await page.checkSavedRun();
  assertSaveStatus("not-found", original.id);
  expect(page.saveReviewBlocked()).toBe(false);

  page.setProps({ ...page.props, source: recorded.plan });
  await page.prepare({ preventDefault() {} });
  expect(page.state.prepared).toBeNull();
  expect(page.state.activity.message).toContain(
    "differs from the missing copy",
  );
  expect(page.props.connection.mutate).toHaveBeenCalledOnce();

  page.setProps({ ...page.props, source: originalSource });
  await page.prepare({ preventDefault() {} });
  expect(page.state.prepared.id).toBe(original.id);
  page.props.connection.mutate.mockResolvedValueOnce({
    ok: true,
    snapshot: {
      id: original.id,
      name: original.snapshot.name,
      kind: original.snapshot.kind,
      savedAt: "2026-09-23T00:00:00.000Z",
      bytes: original.bytes,
    },
  });
  transport.read.mockResolvedValueOnce(JSON.parse(original.snapshot.content));
  await page.save();
  assertSaveStatus("verified", original.id);
  expect(page.props.connection.mutate).toHaveBeenCalledTimes(2);
});

function mutationStarted() {
  expect(panel.props.connection.mutate).toHaveBeenCalledOnce();
}

function savedRunBody(request) {
  const { expectedId, ...body } = request;
  expect(expectedId).toMatch(/^[a-f0-9]{64}$/u);
  return body;
}

it(
  "effect remount restarts an interrupted list without accepting its late response",
  remount,
);
async function remount() {
  const page = mount();
  await vi.waitFor(firstPageLoaded);
  const pending = Promise.withResolvers();
  transport.read.mockReturnValueOnce(pending.promise);
  page.next();
  page.componentWillUnmount();
  transport.read.mockResolvedValueOnce(firstPage);
  page.componentDidMount();
  await vi.waitFor(firstPageLoaded);
  pending.resolve(lastPage);
  await pending.promise;
  await vi.waitFor(firstPageLoaded);
  expect(page.state.page.cursors).toEqual([null]);
}
