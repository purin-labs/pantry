import type {
  PhysicsRecording,
  PhysicsSequence,
} from "@seams/bakery-model/bakery-physics";
import {
  loadPhysicsReplay,
  navigateRecording,
  previewRecordingDoor,
  type PlaybackSession,
  type RecordingSource,
  type RecordingDocument,
  type RecordingNavigation,
} from "@seams/production-simulation/simulator/playback-state";
import type { TransferInput } from "@seams/production-simulation/recipes/bakery/workcell-input";
import type { Variant } from "@seams/type-utils";

declare const recording: PhysicsRecording;
declare const activeRecording: Variant<PlaybackSession, "recording">;
declare const workflow: Variant<PlaybackSession, "workflow">;
declare const rawRecording: unknown;
declare const input: TransferInput;
declare const sequence: PhysicsSequence;
declare const navigation: RecordingNavigation;

// @ts-expect-error A cycle cannot attach to a single-transfer input through a spread.
const cycleEvidence: PlaybackSession = {
  ...activeRecording,
  recording: sequence,
  source: { kind: "workcell", input },
};

// @ts-expect-error A cycle cannot be cast directly into one-transfer evidence.
const castEvidence = sequence as PhysicsRecording;

// @ts-expect-error The return request is not an independently dispatchable outbound task.
const returnEvidence: PhysicsRecording = sequence.unloading;

// @ts-expect-error Sequence construction requires the boundary parser's brand.
const rawSequence: PhysicsSequence = {
  schemaVersion: 2,
  kind: "bakery-physics-sequence",
  handoffDigest: "0".repeat(64),
  loading: sequence.loading,
  unloading: sequence.unloading,
};

// @ts-expect-error A sequence cannot inherit an arbitrary or failed loading predecessor.
const failedPredecessor: PhysicsSequence = { ...sequence, loading: recording };

// @ts-expect-error Standalone recording time cannot carry a workcell run binding.
const mixedTiming: RecordingSource = { kind: "standalone", input };
// @ts-expect-error Workcell playback needs an exact compiled input.
const missingTiming: RecordingSource = { kind: "workcell" };

// @ts-expect-error Playback sessions must be built through the state transitions.
const unbuilt: PlaybackSession = {
  kind: "workflow",
  cursor: { time: 0, speed: 120, playback: "paused" },
  savedRecording: { kind: "empty" },
};

const twoPlayingViews: PlaybackSession = {
  ...activeRecording,
  // @ts-expect-error The suspended workflow is a bookmark with no playback state.
  workflow: { time: 10, speed: 120, playback: "playing" },
};

// @ts-expect-error An empty recording view cannot inherit an active clock or recording.
const emptyWithRecording: PlaybackSession = {
  ...activeRecording,
  kind: "recording-empty",
};

// @ts-expect-error Workflow mode cannot acquire a second active recording through a spread.
const mixedSources: PlaybackSession = { ...workflow, recording };

// @ts-expect-error Untrusted recordings must cross the recording parser before playback.
loadPhysicsReplay(activeRecording, rawRecording);

void [
  unbuilt,
  twoPlayingViews,
  emptyWithRecording,
  mixedSources,
  mixedTiming,
  missingTiming,
  cycleEvidence,
  castEvidence,
  returnEvidence,
  rawSequence,
  failedPredecessor,
];

const selectedEmpty: RecordingDocument = {
  kind: "empty",
  // @ts-expect-error An empty recording has no selectable source.
  selection: { kind: "resource", id: "fr10-1" },
};
const unrelatedSelection: PlaybackSession = {
  ...activeRecording,
  // @ts-expect-error Recording navigation excludes unrelated Shift resources.
  selection: { kind: "resource", id: "baker-1" },
};
void [selectedEmpty, unrelatedSelection];

// @ts-expect-error Navigation must resolve against the loaded recording before commit.
const unbuiltNavigation: RecordingNavigation = {
  from: navigation.from,
  selection: navigation.selection,
  time: 0,
};
// @ts-expect-error Recording navigation cannot mutate the workflow clock.
navigateRecording(workflow, navigation);
void unbuiltNavigation;

// @ts-expect-error A door preview cannot coexist with a playing clock through a spread.
const playingPreview: PlaybackSession = {
  ...activeRecording,
  doorPreviewDegrees: 90,
  cursor: { time: 0, speed: 1, playback: "playing" },
};
// @ts-expect-error The workflow clock has no recorded oven door to preview.
previewRecordingDoor(workflow, 90);
void playingPreview;
