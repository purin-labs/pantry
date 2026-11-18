import type {
  ProcedureLoadState,
  SimulatorConnection,
  SimulatorExperimentAction,
  SimulatorViewAction,
  WorkspaceRunSaveStatus,
  BakeryWorkspaceAction,
  SimulatorState,
} from "./simulator-state";
import type {
  AgentScenarioSaveManifest,
  AgentScenarioSavePayload,
} from "@seams/bakery-model/bakery-agent-scenario-save";
import type { ReplayState } from "@seams/production-simulation/simulator/playback-state";
import type { RecordingAcceptanceReference } from "./recording-acceptance";
import type { RunSnapshotSummary } from "@seams/bakery-model/bakery-run-snapshot";
import type { PreparedWorkspaceRun } from "./workspace-runs-api";
import type { Variant } from "@seams/type-utils";

declare const mutate: Variant<SimulatorConnection, "workspace">["mutate"];
declare const sampleShift: Variant<
  SimulatorExperimentAction,
  "localSampleSelected"
>["shift"];
declare const savingStatus: Variant<WorkspaceRunSaveStatus, "saving">;
declare const snapshotSummary: RunSnapshotSummary;
declare const shiftSelection: Variant<
  SimulatorViewAction,
  "navigate"
>["selection"];
declare const preparedRun: PreparedWorkspaceRun;
declare const scenarioPayload: AgentScenarioSavePayload;
declare const scenarioManifest: AgentScenarioSaveManifest;

const preview: SimulatorConnection = { kind: "preview" };
const workspace: SimulatorConnection = {
  kind: "workspace",
  organisationId: "organisation-a",
  canManage: true,
  mutate,
};

// @ts-expect-error Preview sessions cannot carry workspace authority.
const invalidPreview: SimulatorConnection = {
  kind: "preview",
  organisationId: "organisation-a",
  mutate,
};

// @ts-expect-error Workspace sessions require a mutation transport.
const invalidWorkspace: SimulatorConnection = {
  kind: "workspace",
  organisationId: "organisation-a",
  canManage: true,
};

// @ts-expect-error Playing replay state requires a speed.
const invalidReplay: ReplayState = { playback: "playing", time: 12 };

// @ts-expect-error Failed procedure loads require a user-facing message.
const invalidProcedureLoad: ProcedureLoadState = { kind: "failed" };

// @ts-expect-error Selecting a local sample requires a fresh scenario identity.
const invalidSampleSelection: SimulatorExperimentAction = {
  kind: "localSampleSelected",
  shift: sampleShift,
  notice: "Sample selected.",
};

// @ts-expect-error In-flight saves require a stable request identity.
const invalidSaving: WorkspaceRunSaveStatus = {
  kind: "saving",
  organisationId: "organisation-a",
  id: "run-a",
  name: "Morning",
};

// @ts-expect-error A save must retain whether it originated from an agent effect.
const missingSaveOrigin: WorkspaceRunSaveStatus = {
  kind: "saving",
  organisationId: "organisation-a",
  requestId: "request-a",
  id: "run-a",
  name: "Morning",
};

// @ts-expect-error A verified save requires its canonical summary.
const invalidVerified: WorkspaceRunSaveStatus = {
  kind: "verified",
  organisationId: "organisation-a",
  requestId: "request-a",
  id: "run-a",
};

// @ts-expect-error A saving status cannot become verified through a broad spread.
const invalidSpread: WorkspaceRunSaveStatus = {
  ...savingStatus,
  kind: "verified",
  snapshot: snapshotSummary,
};

// @ts-expect-error A workcell reference cannot carry an operation identity.
const invalidWorkcellReference: RecordingAcceptanceReference = {
  kind: "workcell",
  surfaceSessionId: "session",
  surfaceEpoch: 1,
  recordingDigest: "recording",
  inputFingerprint: "input",
  operationId: "operation",
};

// @ts-expect-error A selection-and-seek command needs explicit focus behavior.
const invalidNavigate: SimulatorViewAction = {
  kind: "navigate",
  selection: shiftSelection,
  time: 12,
};

// @ts-expect-error Reconciled saves retain the exact reviewed name.
const invalidRecoveredSave: WorkspaceRunSaveStatus = {
  kind: "readback-confirmed",
  organisationId: "organisation-a",
  requestId: "request-a",
  id: "run-a",
};

// @ts-expect-error A missing save must keep the original reviewed run name.
const invalidMissingSave: WorkspaceRunSaveStatus = {
  kind: "not-found",
  organisationId: "organisation-a",
  requestId: "request-a",
  id: "run-a",
};

// @ts-expect-error A chat-prepared save must retain its originating effect.
const invalidRunSaveProposal: BakeryWorkspaceAction = {
  kind: "workspaceRunSaveProposed",
  prepared: preparedRun,
};

// @ts-expect-error Saving a reviewed scenario must retain a status message.
const invalidScenarioSaving: SimulatorState["workspace"]["scenarioSaveProposal"] =
  {
    kind: "saving",
    payload: scenarioPayload,
    manifest: scenarioManifest,
    effectId: "surface_effect_1",
  };

// @ts-expect-error An empty proposal cannot retain an agent effect.
const invalidEmptyScenarioProposal: SimulatorState["workspace"]["scenarioSaveProposal"] =
  {
    kind: "none",
    effectId: "surface_effect_1",
  };

void preview;
void workspace;
void invalidPreview;
void invalidWorkspace;
void invalidReplay;
void invalidProcedureLoad;
void invalidSampleSelection;
void invalidSaving;
void invalidVerified;
void invalidSpread;
void invalidNavigate;
void invalidRecoveredSave;
void invalidMissingSave;
void invalidScenarioSaving;
void invalidEmptyScenarioProposal;

// Persistent saves cannot reuse a finite plan or an agent proposal.
declare const finiteRunPanel: Extract<
  ConstructorParameters<
    typeof import("./workspace-runs-panel").WorkspaceRunsPanel
  >[0],
  { kind: "production" | "rehearsal-run" }
>;
// @ts-expect-error Changing the discriminant cannot turn a finite plan into a resumable save source.
export const mixedPersistentRunPanel: ConstructorParameters<
  typeof import("./workspace-runs-panel").WorkspaceRunsPanel
>[0] = { ...finiteRunPanel, kind: "persistent-production" };
// @ts-expect-error A save source requires a reader for the exact settled boundary.
export const missingPersistentSaveReader: import("./workspace-runs-panel").PersistentSaveSource =
  { identity: "held-inspection" };
