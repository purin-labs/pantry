import type { BakeryWorkspaceAction } from "./simulator-state";
import type {
  Operation,
  Settings,
  SettingsField,
  StationId,
} from "@purin-labs/bakery-model/bakery";
import type React from "react";
import type { PhysicsReplay } from "@purin-labs/bakery-model/bakery-physics";
import type { RecordingNavigation } from "@purin-labs/production-simulation/simulator/playback-state";

import type { DemoPreset } from "@purin-labs/production-simulation/simulator/demo";
import type {
  Interval,
  ScheduleVariant,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import type { Selection } from "@purin-labs/production-simulation/simulator/selection";
import type { SceneLabelMode } from "./simulator-state";
import type { SimulatorDock as Dock } from "./simulator-state";

export type RecordingReplayActions = Readonly<{
  nextEvent(): void;
  close(): void;
  pause(): void;
  toggle(): void;
  seek(time: number): void;
  changeSpeed(speed: number): void;
  loaded(recording: PhysicsReplay): void;
  navigate(navigation: RecordingNavigation): void;
  // Opens the recording as a rehearsal tray; resolves with why it could not.
  rehearse(recording: PhysicsReplay): Promise<string | null>;
}>;

// Browser MuJoCo runs of the open production or rehearsal run.
export type BrowserRunActions = Readonly<{
  runProductionInBrowser(): void;
  stopSimulation(): void;
  persistentOvenVisible(visible: boolean): void;
}>;

export type WorkflowSimulatorActions = Readonly<{
  toggleDock(dock: Exclude<Dock, "closed">): void;
  closeDock(): void;
  dockKeyDown(event: React.KeyboardEvent): void;
  resetView(): void;
  openDock(dock: Dock): void;
  observeOperation(operation: Operation): void;
  chooseDemo(preset: DemoPreset): void;
  discardAssumptions(): void;
  runShift(event: React.FormEvent<HTMLFormElement>): void;
  changeAssumption(
    field: SettingsField,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void;
  stageMeasuredSettings(settings: Settings): void;
  createSample(): Promise<void>;
  loadProcedureId(id: string): Promise<void>;
  useSample(): void;
  loadScenarioId(id: string): Promise<void>;
  changeCopyName(event: React.ChangeEvent<HTMLInputElement>): void;
  changeCopyNote(event: React.ChangeEvent<HTMLTextAreaElement>): void;
  saveScenario(event: React.FormEvent<HTMLFormElement>): Promise<void>;
  select(selection: Selection): void;
  chooseVariant(variant: ScheduleVariant): void;
  compareOutage(): void;
  inspectInterval(interval: Interval): void;
  pinBaseline(): void;
  changeSpeed(speed: number): void;
  togglePlay(): void;
  restart(): void;
  nextEvent(): void;
  seek(event: React.ChangeEvent<HTMLInputElement>): void;
  toggleCamera(): void;
  resetCamera(): void;
  setLabels(labels: SceneLabelMode): void;
  toggleMinimap(): void;
  toggleChrome(): void;
  seekInterval(interval: Interval): void;
  seekStation(station: StationId, time: number): void;
  goTo(time: number): void;
  openRecording(): void;
}>;

export type WorkflowSimulatorActionGroups = Readonly<{
  shell: Pick<
    WorkflowSimulatorActions,
    | "toggleDock"
    | "dockKeyDown"
    | "resetView"
    | "openDock"
    | "openRecording"
    | "toggleChrome"
  >;
  sceneView: Pick<
    WorkflowSimulatorActions,
    "toggleCamera" | "resetCamera" | "setLabels" | "toggleMinimap"
  >;
  workflowInput: Pick<
    WorkflowSimulatorActions,
    | "closeDock"
    | "observeOperation"
    | "chooseDemo"
    | "discardAssumptions"
    | "runShift"
    | "changeAssumption"
    | "stageMeasuredSettings"
  >;
  surfaceEdit: Readonly<{
    apply(): Promise<void>;
    discard(): void;
    undo(): void;
  }>;
  scenario: Pick<
    WorkflowSimulatorActions,
    | "closeDock"
    | "createSample"
    | "loadProcedureId"
    | "loadScenarioId"
    | "saveScenario"
    | "changeCopyName"
    | "changeCopyNote"
    | "useSample"
  >;
  inspector: Pick<
    WorkflowSimulatorActions,
    "closeDock" | "select" | "observeOperation" | "goTo" | "inspectInterval"
  >;
  comparison: Pick<
    WorkflowSimulatorActions,
    | "closeDock"
    | "compareOutage"
    | "chooseVariant"
    | "pinBaseline"
    | "inspectInterval"
  >;
  playback: Pick<
    WorkflowSimulatorActions,
    | "togglePlay"
    | "nextEvent"
    | "restart"
    | "changeSpeed"
    | "toggleDock"
    | "seek"
    | "select"
    | "seekInterval"
    | "seekStation"
    | "inspectInterval"
  >;
  recording: RecordingReplayActions;
  workspace(action: BakeryWorkspaceAction): void;
  browser: BrowserRunActions;
}>;
