import type { WorkspaceCameraView } from "./simulator-state";
import { ROBOTS } from "@purin-labs/bakery-model/bakery-robots";
import { physicsOutcome } from "@purin-labs/production-simulation/recipes/bakery/physics-playback";
import React from "react";
import {
  continuationPrefix,
  type NativeBakeryTask,
} from "@purin-labs/production-simulation/recipes/bakery/schedule";
import { PhysicsSceneHost } from "./spatial/physics-scene-host";
import { PlaybackTimeContext } from "./simulator-playback";
import { LiveText } from "../production-run/shared/live";
import type { LiveSource } from "../production-run/shared/live-value";
import {
  initialPlaybackSession,
  loadWorkcellReplay,
  seekActivePlayback,
  recordingReplayView,
} from "@purin-labs/production-simulation/simulator/playback-state";
import { workcellView } from "@purin-labs/production-simulation/simulator/workcell-view";

type Props = Readonly<{
  cameraView: WorkspaceCameraView;
  task: NativeBakeryTask;
  inspect(): void;
}>;
export class ProductionNativeScene extends React.Component<
  Props,
  { unavailable: boolean }
> {
  static contextType = PlaybackTimeContext;
  declare context: LiveSource<number>;
  state = { unavailable: false };
  private unsubscribe: (() => void) | null = null;
  private readonly host = React.createRef<HTMLDivElement>();
  private readonly sceneHost = new PhysicsSceneHost({
    fallback: "message",
    camera: "cell",
    select: this.inspect.bind(this),
    changed: this.sceneChanged.bind(this),
    inspectEvent: null,
    pause: null,
  });
  private get scene() {
    return this.sceneHost.webgl;
  }
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
    // The robot follows the live playback time, outside React state.
    this.unsubscribe = this.context.subscribe(this.updateScene.bind(this));
    void this.load();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.task !== this.props.task) {
      void this.load();
    } else this.updateScene();
    if (
      previous.cameraView.camera !== this.props.cameraView.camera ||
      previous.cameraView.cameraResetRevision !==
        this.props.cameraView.cameraResetRevision
    )
      this.applyCamera();
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.unsubscribe?.();
    this.dispose();
  }
  private dispose(): void {
    this.sceneHost.dispose();
  }
  private inspect(): void {
    this.props.inspect();
  }
  private sceneChanged(
    status: "empty" | "loading" | "ready" | "unavailable",
  ): void {
    if (!this.mounted) return;
    this.setState({ unavailable: status === "unavailable" });
    this.updateScene();
    if (status === "ready" && this.props.cameraView.camera === "overhead")
      this.applyCamera();
  }
  private applyCamera(): void {
    this.scene?.setCamera(
      this.props.cameraView.camera === "overhead" ? "overhead" : "perspective",
    );
  }
  private async load(): Promise<void> {
    if (this.host.current !== null)
      await this.sceneHost.load(this.host.current, this.props.task.recording);
  }
  private updateScene(): void {
    const { task } = this.props;
    const time = this.context.get();
    // A continuation replays only its own motion within the cumulative recording.
    const prefix = continuationPrefix(task.operation);
    const seconds =
      prefix + Math.max(0, Math.min(task.end - task.start, time - task.start));
    const session = seekActivePlayback(
      loadWorkcellReplay(initialPlaybackSession(), task.operation.attempt),
      seconds,
      0,
    );
    const view = workcellView(
      task.operation.attempt,
      { kind: "task", id: task.operation.attempt.input.taskInstanceId },
      recordingReplayView(session),
    );
    // A tray moved by a layout experiment replays with its applied rack.
    this.scene?.update({
      seconds,
      workcell: view,
      layout: {
        applied: task.operation.attempt.input.request.layout,
        draft: null,
        move: null,
        setup: false,
        checks: [],
      },
      trays: null,
    });
  }
  render(): React.ReactNode {
    const { task } = this.props;
    const duration = Math.max(0, task.end - task.start);
    const robotLabel = ROBOTS[task.operation.attempt.input.request.robot].label;
    const outcome = physicsOutcome(task.recording).kind;
    return (
      <section
        aria-label="Recorded native task"
        className="production-native-preview"
      >
        <header className="production-native-header">
          <p className="production-native-title">
            {task.operation.attempt.input.bindings.cell} · independent model
            frame
          </p>
          <div className="production-native-pills">
            <span className="production-native-pill">{robotLabel}</span>
            <span
              className="production-native-pill"
              data-outcome={outcome}
            >
              {outcome}
            </span>
            <span className="production-native-pill">
              <LiveText
                source={this.context}
                text={(time) =>
                  Math.max(0, Math.min(duration, time - task.start)).toFixed(1)
                }
              />{" "}
              / {duration.toFixed(1)} s
            </span>
          </div>
        </header>
        <div className="production-native-viewport" ref={this.host} />
        {this.state.unavailable && (
          <p role="status">
            Robot 3D unavailable. The task timing, result and recording controls
            remain available.
          </p>
        )}
      </section>
    );
  }
}
