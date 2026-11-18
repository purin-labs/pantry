import React from "react";
import type {
  PhysicsOutcome,
  PhysicsReplay,
} from "@seams/bakery-model/bakery-physics";
import { PlaybackController } from "./playback-controller";
import type { PlaybackSnapshot, PlaybackUpdate } from "@seams/production-simulation/simulator/playback-state";
import {
  physicsDuration,
  physicsLegAt,
  physicsOutcome,
} from "@seams/production-simulation/recipes/bakery/physics-playback";
import { PhysicsSceneHost } from "./spatial/physics-scene-host";
import type { WorkcellSelection } from "@seams/production-simulation/simulator/selection";
import type { RecordedFitEvent } from "./spatial/floor-plan-geometry";
import "./recording-candidate-preview.css";
import { assertNever } from "@seams/std";

type Props = Readonly<{ recording: PhysicsReplay }>;
type State = Readonly<{
  time: number;
  playback: "paused" | "playing";
  scene: "loading" | "ready" | "unavailable";
}>;

export class RecordingCandidatePreview extends React.Component<Props, State> {
  state: State = { time: 0, playback: "paused", scene: "loading" };
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly playback = new PlaybackController(
    this.snapshot.bind(this),
    this.updatePlayback.bind(this),
  );
  private readonly sceneHost = new PhysicsSceneHost({
    fallback: "message",
    camera: "reset",
    select: ignoreSceneSelection,
    changed: this.sceneChanged.bind(this),
    inspectEvent: this.inspectFinding.bind(this),
    pause: this.pause.bind(this),
  });
  private get scene() {
    return this.sceneHost.webgl;
  }
  private mounted = false;

  componentDidMount(): void {
    this.mounted = true;
    void this.loadScene();
  }

  componentDidUpdate(previous: Props, previousState: State): void {
    if (previous.recording !== this.props.recording) {
      this.playback.stop();
      this.setState(
        { time: 0, playback: "paused", scene: "loading" },
        this.loadScene.bind(this),
      );
      return;
    }
    if (previousState.time !== this.state.time)
      this.scene?.update({
        seconds: this.state.time,
        workcell: { kind: "empty" },
        layout: null,
        trays: null,
      });
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.playback.stop();
    this.disposeScene();
  }

  private snapshot(): PlaybackSnapshot {
    return {
      time: this.state.time,
      playback: this.state.playback,
      speed: 1,
      end: physicsDuration(this.props.recording),
    };
  }

  private updatePlayback(update: PlaybackUpdate): void {
    if (this.mounted) this.setState(update);
  }

  private seek(event: React.ChangeEvent<HTMLInputElement>): void {
    this.playback.stop();
    this.setState({
      time: Number(event.currentTarget.value),
      playback: "paused",
    });
  }

  private restart(): void {
    this.playback.stop();
    this.setState({ time: 0, playback: "paused" });
  }

  private disposeScene(): void {
    this.sceneHost.dispose();
  }
  private sceneChanged(
    status: "empty" | "loading" | "ready" | "unavailable",
  ): void {
    if (!this.mounted) return;
    this.setState({ scene: status === "empty" ? "loading" : status });
    this.scene?.update({
      seconds: this.state.time,
      workcell: { kind: "empty" },
      layout: null,
      trays: null,
    });
  }
  private async loadScene(): Promise<void> {
    if (this.host.current !== null)
      await this.sceneHost.load(this.host.current, this.props.recording);
  }

  private inspectFinding(event: RecordedFitEvent): void {
    if (!this.mounted || event.recording !== this.props.recording) return;
    this.playback.stop();
    this.setState({ time: event.time, playback: "paused" });
  }

  private pause(): void {
    this.playback.stop();
    this.setState({ playback: "paused" });
  }

  render(): React.ReactNode {
    const recording = this.props.recording;
    const duration = physicsDuration(recording);
    const leg = physicsLegAt(recording, this.state.time);
    return (
      <section
        className="recording-candidate-preview"
        aria-label="Unaccepted native recording preview"
      >
        <p>
          Preview only · {outcomeLabel(physicsOutcome(recording))} ·{" "}
          {duration.toFixed(2)}s recorded
        </p>
        <div ref={this.host} className="recording-candidate-scene" />
        <p role="status">{sceneStatusMessage(this.state.scene)}</p>
        <div
          className="recording-candidate-controls"
          role="group"
          aria-label="Preview playback"
        >
          <button
            type="button"
            disabled={duration <= 0}
            onClick={this.playback.toggle.bind(this.playback)}
          >
            {this.state.playback === "playing"
              ? "Pause preview"
              : "Play preview"}
          </button>
          <button type="button" onClick={this.restart.bind(this)}>
            Restart preview
          </button>
          <label>
            Seek within recording preview
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.01)}
              step={0.01}
              value={this.state.time}
              onChange={this.seek.bind(this)}
            />
          </label>
        </div>
        <output aria-live="off">
          {leg.label} · {this.state.time.toFixed(2)} / {duration.toFixed(2)} s
        </output>
      </section>
    );
  }
}

function outcomeLabel(outcome: PhysicsOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "Completed result";
    case "failed":
      return `Failed result: ${outcome.reason}`;
    case "execution-error":
      return `Runner error: ${outcome.message}`;
    default:
      return assertNever(outcome, "Unexpected recording outcome");
  }
}

function sceneStatusMessage(scene: State["scene"]): string {
  switch (scene) {
    case "loading":
      return "Loading 3D preview…";
    case "ready":
      return "";
    case "unavailable":
      return "3D preview unavailable. Recording time and result remain available.";
    default:
      return assertNever(scene, "Unexpected recording outcome");
  }
}

function ignoreSceneSelection(_selection: WorkcellSelection): void {}
