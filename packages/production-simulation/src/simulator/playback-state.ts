import { workcellEnd } from "../recipes/bakery/workcell-attempt.ts";
import type {
  PhysicsRecording,
  PhysicsReplay,
  PhysicsSequence,
  PhysicsRackSequence,
} from "@seams/bakery-model/bakery-physics";
import {
  physicsDuration,
  physicsLegAt,
  physicsResources,
  physicsTasks,
} from "../recipes/bakery/physics-playback.ts";
import type { BakerySurfaceCommandV1 } from "@seams/bakery-model/bakery-surface";
import type { WorkcellSelection } from "./selection.ts";
export type PlaybackSnapshot = Readonly<{
  time: number;
  speed: number;
  end: number;
  playback: "paused" | "playing";
}>;

export type PlaybackUpdate = Readonly<{
  time: number;
  playback: "paused" | "playing";
}>;
import type {
  WorkcellInput,
  AnyCycleInput,
  RackCycleInput,
} from "../recipes/bakery/workcell-input.ts";
import type {
  CompletedAttempt,
  HeldAttempt,
  AwaitingReturnAttempt,
} from "../recipes/bakery/workcell-attempt.ts";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

const sessionState: unique symbol = Symbol("simulator playback session");
const navigationState: unique symbol = Symbol("resolved recording navigation");

export type ReplayState = Readonly<{
  time: number;
  speed: number;
  playback: "paused" | "playing";
}>;

type Bookmark = Readonly<{
  time: number;
  speed: number;
  playback?: never;
}>;

export type RecordingSource =
  | Readonly<{ kind: "standalone"; input?: never }>
  | Readonly<{ kind: "workcell"; input: WorkcellInput }>;

type RecordingContent =
  | Readonly<{
      recording: PhysicsReplay;
      source: Variant<RecordingSource, "standalone">;
    }>
  | Readonly<{
      recording: PhysicsRecording;
      source: Variant<RecordingSource, "workcell">;
    }>
  | Readonly<{
      recording: PhysicsSequence;
      source: Readonly<{
        kind: "workcell";
        input: Exclude<AnyCycleInput, RackCycleInput>;
      }>;
    }>
  | Readonly<{
      recording: PhysicsRackSequence;
      source: Readonly<{ kind: "workcell"; input: RackCycleInput }>;
    }>;

type SavedRecording =
  | Readonly<{
      kind: "empty";
      recording?: never;
      source?: never;
      cursor?: never;
      doorPreviewDegrees?: never;
      selection?: never;
    }>
  | (Readonly<{
      kind: "ready";
      doorPreviewDegrees?: never;
      cursor: Bookmark;
      selection: WorkcellSelection | null;
    }> &
      RecordingContent);

type RecordingClock =
  | Readonly<{ doorPreviewDegrees: null; cursor: ReplayState }>
  | Readonly<{
      doorPreviewDegrees: number;
      cursor: ReplayState & Readonly<{ playback: "paused" }>;
    }>;

export type PlaybackSession = Readonly<{ [sessionState]: true }> &
  (
    | Readonly<{
        kind: "workflow";
        cursor: ReplayState;
        savedRecording: SavedRecording;
        workflow?: never;
        recording?: never;
        source?: never;
        selection?: never;
        doorPreviewDegrees?: never;
      }>
    | Readonly<{
        kind: "recording-empty";
        workflow: Bookmark;
        cursor?: never;
        recording?: never;
        source?: never;
        savedRecording?: never;
        selection?: never;
        doorPreviewDegrees?: never;
      }>
    | (Readonly<{
        kind: "recording";
        selection: WorkcellSelection | null;
        workflow: Bookmark;
        savedRecording?: never;
      }> &
        RecordingContent &
        RecordingClock)
  );

export type RecordingDocument =
  | Readonly<{ kind: "empty"; selection?: never; doorPreviewDegrees?: never }>
  | (Readonly<{
      kind: "ready";
      replay: ReplayState;
      doorPreviewDegrees: number | null;
      selection: WorkcellSelection | null;
    }> &
      RecordingContent);

export type RecordingReplayView = Readonly<{
  open: boolean;
  document: RecordingDocument;
}>;

export function initialPlaybackSession(): PlaybackSession {
  return workflowSession(pausedCursor({ time: 0, speed: 120 }), {
    kind: "empty",
  });
}

export function workflowReplay(session: PlaybackSession): ReplayState {
  switch (session.kind) {
    case "workflow":
      return session.cursor;
    case "recording-empty":
    case "recording":
      return pausedCursor(session.workflow);
    default:
      return assertNever(session, "Unexpected playback session");
  }
}

export function recordingReplayView(
  session: PlaybackSession,
): RecordingReplayView {
  switch (session.kind) {
    case "workflow": {
      const saved = session.savedRecording;
      return {
        open: false,
        document:
          saved.kind === "empty"
            ? { kind: "empty" }
            : {
                kind: "ready",
                ...recordingContent(saved),
                selection: saved.selection,
                doorPreviewDegrees: null,
                replay: pausedCursor(saved.cursor),
              },
      };
    }
    case "recording-empty":
      return { open: true, document: { kind: "empty" } };
    case "recording":
      return {
        open: true,
        document: {
          kind: "ready",
          ...recordingContent(session),
          selection: session.selection,
          doorPreviewDegrees: session.doorPreviewDegrees,
          replay: session.cursor,
        },
      };
    default:
      return assertNever(session, "Unexpected playback session");
  }
}

export function openPhysicsReplay(session: PlaybackSession): PlaybackSession {
  if (session.kind !== "workflow") return session;
  const workflow = bookmark(session.cursor);
  if (session.savedRecording.kind === "empty") {
    return { [sessionState]: true, kind: "recording-empty", workflow };
  }
  return recordingSession(
    workflow,
    session.savedRecording,
    pausedCursor(session.savedRecording.cursor),
    session.savedRecording.selection,
    null,
  );
}

export function closePhysicsReplay(
  session: PlaybackSession,
): Variant<PlaybackSession, "workflow"> {
  switch (session.kind) {
    case "workflow":
      return session;
    case "recording-empty":
      return workflowSession(pausedCursor(session.workflow), { kind: "empty" });
    case "recording":
      return workflowSession(pausedCursor(session.workflow), {
        kind: "ready",
        ...recordingContent(session),
        selection: session.selection,
        cursor: bookmark(session.cursor),
      });
    default:
      return assertNever(session, "Unexpected playback session");
  }
}

export function loadPhysicsReplay(
  session: PlaybackSession,
  recording: PhysicsReplay,
): PlaybackSession {
  if (session.kind === "workflow") return session;
  return recordingSession(
    session.workflow,
    { recording, source: { kind: "standalone" } },
    pausedCursor({ time: 0, speed: 1 }),
    null,
    null,
  );
}

// A production native task replays its accepted recording on the run clock.
export function loadWorkcellReplay(
  session: PlaybackSession,
  attempt: CompletedAttempt | HeldAttempt | AwaitingReturnAttempt,
): PlaybackSession {
  const workflow =
    session.kind === "workflow" ? bookmark(session.cursor) : session.workflow;
  if (attempt.mode === "rack-cycle")
    return recordingSession(
      workflow,
      {
        recording: attempt.recording,
        source: { kind: "workcell", input: attempt.input },
      },
      pausedCursor({ time: 0, speed: 1 }),
      null,
      null,
    );
  if (attempt.mode === "oven-cycle")
    return recordingSession(
      workflow,
      {
        recording: attempt.recording,
        source: { kind: "workcell", input: attempt.input },
      },
      pausedCursor({ time: 0, speed: 1 }),
      null,
      null,
    );
  return recordingSession(
    workflow,
    {
      recording: attempt.recording,
      source: { kind: "workcell", input: attempt.input },
    },
    pausedCursor({ time: 0, speed: 1 }),
    null,
    null,
  );
}

export function sessionPlaybackSnapshot(
  session: PlaybackSession,
  workflowEnd: number,
): PlaybackSnapshot {
  switch (session.kind) {
    case "workflow":
      return {
        time: session.cursor.time,
        speed: session.cursor.speed,
        playback: session.cursor.playback,
        end: workflowEnd,
      };
    case "recording-empty":
      return { time: 0, speed: 1, playback: "paused", end: 0 };
    case "recording":
      return {
        time: session.cursor.time,
        speed: session.cursor.speed,
        playback: session.cursor.playback,
        end: sourceEnd(session.source, session.recording),
      };
    default:
      return assertNever(session, "Unexpected playback session");
  }
}

export function updateActivePlayback(
  session: PlaybackSession,
  update: PlaybackUpdate,
): PlaybackSession {
  if (session.kind === "recording-empty") return session;
  return replaceCursor(session, {
    time: update.time,
    speed: session.cursor.speed,
    playback: update.playback,
  });
}

export function seekActivePlayback(
  session: PlaybackSession,
  time: number,
  workflowEnd: number,
): PlaybackSession {
  if (!Number.isFinite(time)) return session;
  const snapshot = sessionPlaybackSnapshot(session, workflowEnd);
  const cursor: ReplayState = {
    time: Math.max(0, Math.min(snapshot.end, time)),
    speed: snapshot.speed,
    playback: "paused",
  };
  if (session.kind === "recording")
    return recordingSession(
      session.workflow,
      session,
      cursor,
      session.selection,
      null,
    );
  return updateActivePlayback(session, cursor);
}

export function changePlaybackSpeed(
  session: PlaybackSession,
  speed: number,
): PlaybackSession {
  if (session.kind === "recording-empty") return session;
  const choices =
    session.kind === "workflow" ? [30, 120] : recordingSpeeds(session.source);
  if (!choices.includes(speed)) return session;
  return replaceCursor(session, {
    time: session.cursor.time,
    speed,
    playback: session.cursor.playback,
  });
}

export function resetWorkflowPlayback(
  session: PlaybackSession,
): PlaybackSession {
  const workflow = closePhysicsReplay(session);
  return workflowSession(
    pausedCursor({ time: 0, speed: workflow.cursor.speed }),
    workflow.savedRecording,
  );
}

export function recordingDuration(recording: PhysicsReplay): number {
  return physicsDuration(recording);
}

export function recordingReplayStart(
  document: Variant<RecordingDocument, "ready">,
): number {
  return sourceStart(document.source);
}

export function recordingReplayEnd(
  document: Variant<RecordingDocument, "ready">,
): number {
  return sourceEnd(document.source, document.recording);
}

export type RecordingNavigation = Readonly<{
  [navigationState]: true;
  from: Variant<RecordingDocument, "ready">;
  selection: WorkcellSelection;
  time: number;
}>;

export function prepareRecordingNavigation(
  from: Variant<RecordingDocument, "ready">,
  view: Variant<BakerySurfaceCommandV1, "set_view">["view"],
): RecordingNavigation | null {
  const time = view.cursorSeconds;
  if (!Number.isFinite(time) || time < 0 || time > recordingReplayEnd(from))
    return null;
  const target = view.selection;
  switch (target.kind) {
    case "task": {
      const task = physicsTasks(from.recording).find(
        hasId.bind(null, target.id),
      );
      return task === undefined
        ? null
        : {
            [navigationState]: true,
            from,
            time,
            selection: { kind: "task", id: task.id },
          };
    }
    case "resource": {
      const resource = physicsResources(from.recording).find(
        hasId.bind(null, target.id),
      );
      return resource === undefined
        ? null
        : {
            [navigationState]: true,
            from,
            time,
            selection: { kind: "resource", id: resource.id },
          };
    }
    case "batch":
    case "station":
    case "operation":
      return null;
    default:
      return assertNever(target);
  }
}

export function navigateRecording(
  session: Variant<PlaybackSession, "recording">,
  navigation: RecordingNavigation,
): Variant<PlaybackSession, "recording"> {
  const from = navigation.from;
  if (
    session.recording !== from.recording ||
    session.source.kind !== from.source.kind ||
    (session.source.kind === "workcell" &&
      from.source.kind === "workcell" &&
      session.source.input !== from.source.input)
  )
    return session;
  return recordingSession(
    session.workflow,
    session,
    {
      time: navigation.time,
      speed: session.cursor.speed,
      playback: "paused",
    },
    navigation.selection,
    null,
  );
}

export function recordingHasDoor(recording: PhysicsReplay): boolean {
  return physicsLegAt(recording, 0).recording.fixture.kind !== "rack";
}

export function previewRecordingDoor(
  session: Variant<PlaybackSession, "recording">,
  degrees: number | null,
): Variant<PlaybackSession, "recording"> {
  if (!recordingHasDoor(session.recording)) return session;
  return recordingSession(
    session.workflow,
    session,
    session.cursor,
    session.selection,
    degrees,
  );
}

function hasId(id: string, value: Readonly<{ id: string }>): boolean {
  return value.id === id;
}

function sourceEnd(source: RecordingSource, recording: PhysicsReplay): number {
  if (source.kind === "standalone") return recordingDuration(recording);
  return workcellEnd(source.input, recording);
}

export function recordingSampleTime(
  document: Variant<RecordingDocument, "ready">,
): number {
  return Math.max(
    0,
    Math.min(
      recordingDuration(document.recording),
      document.replay.time - recordingReplayStart(document),
    ),
  );
}

export function recordingSpeeds(source: RecordingSource): readonly number[] {
  return source.kind === "workcell"
    ? [0.25, 0.5, 1, 2, 30, 120]
    : [0.25, 0.5, 1, 2];
}

function sourceStart(source: RecordingSource): number {
  switch (source.kind) {
    case "standalone":
      return 0;
    case "workcell":
      return source.input.dispatch.time;
    default:
      return assertNever(source, "Unexpected playback session");
  }
}

function replaceCursor(
  session: Exclude<PlaybackSession, { kind: "recording-empty" }>,
  cursor: ReplayState,
): PlaybackSession {
  switch (session.kind) {
    case "workflow":
      return workflowSession(cursor, session.savedRecording);
    case "recording":
      return recordingSession(
        session.workflow,
        session,
        cursor,
        session.selection,
        cursor.playback === "playing" || cursor.time !== session.cursor.time
          ? null
          : session.doorPreviewDegrees,
      );
    default:
      return assertNever(session, "Unexpected playback session");
  }
}

function workflowSession(
  cursor: ReplayState,
  savedRecording: SavedRecording,
): Variant<PlaybackSession, "workflow"> {
  return { [sessionState]: true, kind: "workflow", cursor, savedRecording };
}

function recordingSession(
  workflow: Bookmark,
  content: RecordingContent,
  cursor: ReplayState,
  selection: WorkcellSelection | null,
  doorPreviewDegrees: number | null,
): Variant<PlaybackSession, "recording"> {
  if (doorPreviewDegrees !== null)
    return {
      [sessionState]: true,
      kind: "recording",
      workflow,
      ...recordingContent(content),
      selection,
      doorPreviewDegrees,
      cursor: { time: cursor.time, speed: cursor.speed, playback: "paused" },
    };
  return {
    [sessionState]: true,
    kind: "recording",
    workflow,
    ...recordingContent(content),
    selection,
    doorPreviewDegrees,
    cursor,
  };
}

function recordingContent(content: RecordingContent): RecordingContent {
  if (content.source.kind === "standalone")
    return {
      recording: content.recording,
      source: { kind: "standalone" },
    };
  if (content.recording.kind === "bakery-physics-recording")
    return {
      recording: content.recording,
      source: content.source,
    };
  if (
    content.recording.kind === "bakery-physics-rack-sequence" &&
    content.source.input.kind === "rack-cycle"
  )
    return {
      recording: content.recording,
      source: { kind: "workcell", input: content.source.input },
    };
  if (
    content.recording.kind === "bakery-physics-sequence" &&
    content.source.input.kind !== "transfer" &&
    content.source.input.kind !== "rack-cycle"
  )
    return {
      recording: content.recording,
      source: { kind: "workcell", input: content.source.input },
    };
  throw new Error("Cycle playback requires its prepared cycle input.");
}

function bookmark(cursor: ReplayState): Bookmark {
  return { time: cursor.time, speed: cursor.speed };
}

function pausedCursor(cursor: Bookmark): ReplayState {
  return { time: cursor.time, speed: cursor.speed, playback: "paused" };
}
