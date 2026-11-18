import React from "react";
import {
  KITCHEN_SURFACE,
  PASTRY_BENCH_VIEW_COMMANDS,
  type PortalPageViewV1,
  type SurfacePageCommandV1,
} from "@seams/control-api";
import { Select } from "../../../ui/select";
import { BakeryAppearanceControl } from "../../../preferences/appearance-controls";
import {
  registerSurfaceView,
  type SurfaceCommandOutcome,
} from "../../surface-observation";
import {
  RecipeBackButton,
  RecipeSplitDivider,
  RecipeSurfaceSwitch,
  RecipeWorkflow,
  RunIcon,
  type RecipeSurface,
} from "../recipe-workflow";
import {
  CRIMP_FORCE_ITEMS,
  FAULT_CHECK_ITEMS,
  PIE_TYPE_ITEMS,
  THICKNESS_ITEMS,
  executePastryBenchRecipeInWorker,
  samplePastryBenchRunAtTime,
  type PastryBenchCompletedRun,
  type PastryBenchFaultCheck,
  type PastryBenchFrame,
  type PastryBenchRecipeConfig,
  type PastryBenchStage,
} from "./pastry-bench-model";
import {
  PastryBenchScene,
  type PastryBenchCameraPreset,
} from "./pastry-bench-scene";
import "../oven-workspace.css";
import "./pastry-bench.css";
import type { RecipeClock } from "../recipe-workflow";
import { Live, LiveText } from "../shared/live";
import {
  deriveLive,
  LiveValue,
  sameItems,
  type LiveSource,
} from "../shared/live-value";
import { RecipeRunFooter } from "../recipe-run-footer";

/** The pastry frame at the playback cursor. */
type PastryLive = Readonly<{ frame: PastryBenchFrame }>;

type ViewProps = Readonly<{
  /** Null until the run arrives from the worker. */
  frames: LiveSource<PastryLive> | null;
  stages: readonly PastryBenchStage[];
  loading: boolean;
  faultHandled: boolean;
  timelineOpen: boolean;
  camera: PastryBenchCameraPreset;
  onSelectCamera(camera: PastryBenchCameraPreset): void;
}>;

type ViewState = Readonly<{
  error: string | null;
  wireframe: boolean;
}>;

/** Interactive Three.js MuJoCo 4.0.0 deformable pastry bench & Maruzen oven view. */
export class PastryBenchPhysicsView extends React.Component<
  ViewProps,
  ViewState
> {
  state: ViewState = {
    error: null,
    wireframe: true,
  };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly station = React.createRef<HTMLElement>();
  private visual: PastryBenchScene | null = null;
  private unsubscribe: (() => void) | null = null;

  componentDidMount(): void {
    const element = this.element.current;
    if (element === null) return;
    this.visual = new PastryBenchScene(element);
    this.visual.setCameraPreset(this.props.camera);
    this.subscribe();
    void this.load(this.visual);
  }

  private async load(visual: PastryBenchScene): Promise<void> {
    try {
      await visual.load();
      this.subscribe();
    } catch (error) {
      if (this.visual === visual) {
        this.setState({
          error:
            error instanceof Error
              ? error.message
              : "The pastry bench visual is unavailable.",
        });
      }
    }
  }

  componentDidUpdate(prevProps: ViewProps): void {
    if (prevProps.camera !== this.props.camera) {
      this.visual?.setCameraPreset(this.props.camera);
    }
    if (prevProps.frames !== this.props.frames) this.subscribe();
  }

  /** The scene and the station attributes follow each frame outside React. */
  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.visual?.setWireframeVisible(this.state.wireframe);
    const frames = this.props.frames;
    if (frames === null) {
      this.showFrame(null);
      return;
    }
    this.unsubscribe = frames.subscribe(({ frame }) => this.showFrame(frame));
    this.showFrame(frames.get().frame);
  }

  private showFrame(frame: PastryBenchFrame | null): void {
    const station = this.station.current;
    if (station !== null)
      for (const [name, value] of Object.entries(stationAttributes(frame)))
        if (station.getAttribute(name) !== value)
          station.setAttribute(name, value);
    if (frame !== null) this.visual?.setFrame(frame);
  }

  private selectCamera(camera: PastryBenchCameraPreset): void {
    this.props.onSelectCamera(camera);
    this.visual?.setCameraPreset(camera);
  }

  private toggleWireframe(): void {
    const wireframe = !this.state.wireframe;
    this.setState({ wireframe });
    this.visual?.setWireframeVisible(wireframe);
  }

  componentWillUnmount(): void {
    this.unsubscribe?.();
    this.visual?.dispose();
    this.visual = null;
  }

  render(): React.ReactNode {
    const { frames, stages, loading, faultHandled, timelineOpen, camera } =
      this.props;
    return (
      <section
        ref={this.station}
        aria-label="Accepted pastry bench deformable state"
        className="pastry-bench-station"
        data-timeline-open={timelineOpen}
      >
        <div className="pastry-bench-canvas" ref={this.element} />
        <div
          className="pastry-bench-camera-bar"
          role="group"
          aria-label="Camera view"
        >
          <BakeryAppearanceControl />
          {(
            [
              ["bench", "Bench view"],
              ["dough-block", "3D dough block"],
              ["tin-cavity", "12 cm tin cavity"],
              ["roller", "Rolling pin"],
              ["overhead", "Overhead sheet"],
              ["oven", "Maruzen oven"],
            ] as const
          ).map(([preset, label]) => (
            <button
              key={preset}
              type="button"
              data-surface-target={`pastry-bench:camera:${preset}`}
              aria-pressed={camera === preset}
              onClick={this.selectCamera.bind(this, preset)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={this.state.wireframe}
            onClick={this.toggleWireframe.bind(this)}
          >
            FEM mesh
          </button>
        </div>
        {this.state.error !== null && <p role="status">{this.state.error}</p>}
        <div className="pastry-bench-status">
          {frames === null ? null : (
            <Live source={frames} select={({ frame }) => frame.phase}>
              {(phase) => (
                <>
                  {(phase === "rejected-unfloured" || faultHandled) && (
                    <p role="alert" data-pastry-fault="pastry-bench-unfloured">
                      {phase === "rejected-unfloured"
                        ? "Unfloured marble bench: high roller shear rejects shortcrust sheeting before the 14 mm cavity gate. Dusting 14 g T55 flour before recovery."
                        : "Unfloured bench fault verified and recovered: 14 g T55 flour restored shortcrust sheeting, puff-lid crimp seal, and Maruzen oven bake."}
                    </p>
                  )}
                </>
              )}
            </Live>
          )}
          <Live
            source={frames ?? NO_FRAME}
            select={(live) => stages.map(stagePillState.bind(null, live))}
            equal={sameItems}
          >
            {(states) => (
              <div
                className="pastry-bench-steps"
                aria-label="Pastry bench stages"
              >
                {stages.map((stage, index) => {
                  const state = states[index] ?? "pending";
                  return (
                    <div
                      key={stage.id}
                      className="pastry-bench-step-pill"
                      data-step-state={state}
                    >
                      <span>{stage.label}</span>
                      <strong>{stage.target}</strong>
                    </div>
                  );
                })}
              </div>
            )}
          </Live>
          {loading || frames === null ? (
            <p role="status">
              Running MuJoCo 4.0.0 <code>flexcomp</code> &amp; Maruzen MBCO-5E
              solver in browser worker…
            </p>
          ) : (
            <dl>
              <dt>Active stage</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) => `${frame.stageLabel}`}
              />
              <dt>3D dough block</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) =>
                  `${frame.doughBlockHeightMm.toFixed(1)} mm height · ${frame.doughBlockSpanMm.toFixed(1)} mm span`
                }
              />
              <dt>Cavity drape</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) =>
                  `${frame.cavityDrapeMm.toFixed(2)} mm / 28.0 mm tin depth`
                }
              />
              <dt>Rim seal</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) =>
                  `${frame.sealCoveragePct.toFixed(1)}% coverage · ${frame.rimCrimpForceN.toFixed(1)} N crimp`
                }
              />
              <dt>Maruzen MBCO-5E</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) =>
                  `${frame.ovenChamberC.toFixed(0)} °C · ${(frame.crustBrowning * 100).toFixed(0)}% Maillard · +${frame.puffLiftMm.toFixed(1)} mm puff`
                }
              />
              <dt>Marble &amp; batch</dt>
              <LiveText
                as="dd"
                source={frames}
                text={({ frame }) =>
                  `${frame.benchC.toFixed(1)} °C slab (${frame.benchFloured ? "floured" : "unfloured"}) · ${frame.doughMassG.toFixed(0)} g @ ${frame.doughTempC.toFixed(1)} °C`
                }
              />
              <dt>MuJoCo 4.0.0 flex</dt>
              <LiveText as="dd" source={frames} text={flexText} />
            </dl>
          )}
        </div>
        <p className="pastry-bench-note">
          MuJoCo 4.0.0 <code>flexcomp</code> (
          <code>elastic2d=&quot;both&quot;</code>) deformable butter shortcrust
          &amp; puff-pastry lid over a 12 cm fluted tin into the Maruzen MBCO-5E
          convection oven.
        </p>
      </section>
    );
  }
}

function flexText({ frame }: PastryLive): string {
  const flexMesh = frame.flexMesh;
  const doughBlockMesh = frame.doughBlockMesh;
  const triangleCount =
    flexMesh !== null ? Math.floor(flexMesh.faces.length / 3) : 0;
  const doughBlockTriangleCount =
    doughBlockMesh !== null ? Math.floor(doughBlockMesh.faces.length / 3) : 0;
  return flexMesh !== null && doughBlockMesh !== null
    ? `3D ${doughBlockMesh.vertexCount}v/${doughBlockTriangleCount}t + 2D ${flexMesh.vertexCount}v/${triangleCount}t`
    : flexMesh !== null
      ? `${flexMesh.vertexCount} vertices · ${triangleCount} elastic2d triangles`
      : "Rigid bodies";
}

const NO_FRAME: LiveSource<PastryLive | null> = {
  get: () => null,
  subscribe: () => () => undefined,
};

function stagePillState(
  live: PastryLive | null,
  stage: PastryBenchStage,
): "active" | "done" | "pending" {
  const frame = live?.frame;
  if (frame === undefined) return "pending";
  if (frame.timeS >= stage.startS && frame.timeS < stage.endS) return "active";
  return frame.timeS >= stage.endS ? "done" : "pending";
}

/** The station attributes that the journeys and the page view read. */
function stationAttributes(
  frame: PastryBenchFrame | null,
): Readonly<Record<string, string>> {
  const flexMesh = frame?.flexMesh ?? null;
  const doughBlockMesh = frame?.doughBlockMesh ?? null;
  return {
    "data-pastry-phase": frame?.phase ?? "loading",
    "data-pastry-vertices": String(flexMesh?.vertexCount ?? 0),
    "data-pastry-triangles": String(
      flexMesh !== null ? Math.floor(flexMesh.faces.length / 3) : 0,
    ),
    "data-pastry-dough-vertices": String(doughBlockMesh?.vertexCount ?? 0),
    "data-pastry-dough-triangles": String(
      doughBlockMesh !== null ? Math.floor(doughBlockMesh.faces.length / 3) : 0,
    ),
    "data-pastry-dough-height-mm":
      frame?.doughBlockHeightMm.toFixed(2) ?? "31.60",
    "data-pastry-dough-span-mm": frame?.doughBlockSpanMm.toFixed(2) ?? "73.60",
    "data-pastry-drape-mm": frame?.cavityDrapeMm.toFixed(2) ?? "0.00",
    "data-pastry-seal-pct": frame?.sealCoveragePct.toFixed(1) ?? "0.0",
    "data-pastry-oven-c": frame?.ovenChamberC.toFixed(1) ?? "22.0",
    "data-pastry-browning-pct": ((frame?.crustBrowning ?? 0) * 100).toFixed(1),
    "data-pastry-puff-lift-mm": frame?.puffLiftMm.toFixed(2) ?? "0.00",
  };
}

type WorkspaceProps = Readonly<{
  organisationId?: string;
  recipe: PastryBenchRecipeConfig;
  close(): void;
}>;

type WorkspaceState = Readonly<{
  recipe: PastryBenchRecipeConfig;
  camera: PastryBenchCameraPreset;
  status: "loading" | "running" | "paused" | "completed" | "failed";
  surface: RecipeSurface;
  panel: "scenario" | "results" | null;
  timeline: boolean;
  run: PastryBenchCompletedRun | null;
  error: string | null;
  notice: string;
}>;

export class PastryBenchWorkspace extends React.Component<
  WorkspaceProps,
  WorkspaceState
> {
  state: WorkspaceState = {
    recipe: this.props.recipe,
    camera: "bench",
    status: "loading",
    surface: "factory",
    panel: null,
    timeline: false,
    run: null,
    error: null,
    notice: "",
  };

  private rafId = 0;
  /** The playback cursor. It lives outside React state. */
  private readonly time = new LiveValue(0);
  private live: Readonly<{
    run: PastryBenchCompletedRun;
    frames: LiveSource<PastryLive>;
    clock: LiveSource<RecipeClock>;
  }> | null = null;
  private lastTickMs = 0;
  private runToken = 0;
  private unregisterSurfaceView: (() => void) | null = null;

  componentDidMount(): void {
    this.syncSurfaceViewRegistration();
    void this.executeRun(this.state.recipe, true);
  }

  componentDidUpdate(prevProps: WorkspaceProps): void {
    if (prevProps.organisationId !== this.props.organisationId) {
      this.syncSurfaceViewRegistration();
    }
  }

  componentWillUnmount(): void {
    this.runToken += 1;
    cancelAnimationFrame(this.rafId);
    this.unregisterSurfaceView?.();
    this.unregisterSurfaceView = null;
  }

  private syncSurfaceViewRegistration(): void {
    this.unregisterSurfaceView?.();
    this.unregisterSurfaceView = null;
    const organisationId = this.props.organisationId;
    if (organisationId === undefined) return;
    this.unregisterSurfaceView = registerSurfaceView({
      pageOrganisationId: () => organisationId,
      surfacePage: () => KITCHEN_SURFACE,
      capturePageView: () => this.capturePageView(),
      surfaceCommands: () => PASTRY_BENCH_VIEW_COMMANDS,
      runSurfaceCommand: (command) => this.runSurfaceCommand(command),
    });
  }

  private capturePageView(): PortalPageViewV1 {
    const { recipe, camera, status, run, error } = this.state;
    const sections: PortalPageViewV1["sections"] = [
      {
        title: "Pie pastry bench configuration",
        facts: [
          { label: "Pie variety", value: recipe.pieType },
          {
            label: "Shortcrust target thickness",
            value: `${recipe.targetThicknessMm.toFixed(1)} mm`,
          },
          { label: "Rim crimp force", value: `${recipe.crimpForceN} N` },
          { label: "Process check", value: recipe.faultCheck },
          { label: "Active camera view", value: camera },
          { label: "Execution status", value: status },
          ...(error === null ? [] : [{ label: "Error", value: error }]),
        ],
        table: null,
      },
    ];
    if (run !== null) {
      sections.push(
        {
          title: "MuJoCo 4.0.0 flexcomp deformable shell telemetry",
          facts: [
            {
              label: "3D dough block slab",
              value: `${run.doughBlockTelemetry.doughBlockHeightMm.toFixed(2)} mm height · ${run.doughBlockTelemetry.doughBlockSpanMm.toFixed(2)} mm span (${run.doughBlockTelemetry.doughBlockVertexCount} vertices · ${run.doughBlockTelemetry.doughBlockTriangleCount} boundary triangles)`,
            },
            {
              label: "Shortcrust cavity drape",
              value: `${run.shortcrustTelemetry.cavityDrapeMm.toFixed(2)} mm`,
            },
            {
              label: "Puff-lid cavity drape",
              value: `${run.puffLidTelemetry.cavityDrapeMm.toFixed(2)} mm`,
            },
            {
              label: "Rim crimp seal coverage",
              value: `${run.puffLidTelemetry.sealCoveragePct.toFixed(1)}%`,
            },
            {
              label: "Deformable mesh",
              value: `${run.shortcrustTelemetry.vertexCount} vertices · ${run.shortcrustTelemetry.triangleCount} triangles`,
            },
            ...(run.rejectedAttemptTelemetry === null
              ? []
              : [
                  {
                    label: "Rejected unfloured attempt drape",
                    value: `${run.rejectedAttemptTelemetry.cavityDrapeMm.toFixed(2)} mm`,
                  },
                ]),
          ],
          table: null,
        },
        {
          title: "Maruzen MBCO-5E oven bake",
          facts: [
            {
              label: "Peak convection chamber",
              value: `${run.ovenTelemetry.peakChamberC.toFixed(1)} °C`,
            },
            {
              label: "Puff lamination lift",
              value: `+${run.ovenTelemetry.puffLiftMm.toFixed(2)} mm`,
            },
            {
              label: "Maillard crust browning",
              value: `${run.ovenTelemetry.finalBrowningPct.toFixed(1)}%`,
            },
            {
              label: "Moisture steam loss",
              value: `${run.ovenTelemetry.steamLossG.toFixed(1)} g`,
            },
            {
              label: "Batch heat exchange",
              value: `${run.ovenTelemetry.loadExchangeJ.toFixed(1)} J`,
            },
          ],
          table: null,
        },
      );
    }
    return {
      kind: "portal-page-view",
      schemaVersion: 1,
      page: KITCHEN_SURFACE,
      title: "Pie Pastry Bench",
      path: "/workflow-simulator",
      capturedAt: Date.now(),
      sections,
    };
  }

  private async runSurfaceCommand(
    command: SurfacePageCommandV1["command"],
  ): Promise<SurfaceCommandOutcome> {
    if (
      command.name !== "configure_pastry_bench" &&
      command.name !== "prepare_pastry_bench"
    ) {
      return {
        kind: "rejected",
        message: "The Pie Pastry Bench does not support that command.",
      };
    }
    if (command.name === "configure_pastry_bench") {
      const nextCamera = command.cameraPreset ?? this.state.camera;
      const recipeChanged =
        command.pieType !== undefined ||
        command.targetThicknessMm !== undefined ||
        command.crimpForceN !== undefined ||
        command.faultCheck !== undefined;
      if (!recipeChanged && this.state.run !== null) {
        await new Promise<void>((resolve) => {
          this.setState({ camera: nextCamera }, resolve);
        });
        return { kind: "done" };
      }
      if (command.cameraPreset !== undefined) {
        this.setState({ camera: nextCamera });
      }
      const current = this.state.recipe;
      return this.executeRun(
        {
          pieType: command.pieType ?? current.pieType,
          targetThicknessMm:
            command.targetThicknessMm ?? current.targetThicknessMm,
          crimpForceN: command.crimpForceN ?? current.crimpForceN,
          faultCheck: command.faultCheck ?? current.faultCheck,
        },
        false,
      );
    }
    return this.executeRun(this.state.recipe, false);
  }

  private async executeRun(
    recipe: PastryBenchRecipeConfig,
    autoPlay: boolean,
  ): Promise<SurfaceCommandOutcome> {
    const token = ++this.runToken;
    cancelAnimationFrame(this.rafId);
    this.setState({
      recipe,
      status: "loading",
      error: null,
      notice: "Executing MuJoCo 4.0.0 deformable flexcomp solver…",
    });
    try {
      const completed = await executePastryBenchRecipeInWorker(recipe);
      if (token !== this.runToken) {
        return {
          kind: "rejected",
          message: "A newer Pastry Bench run superseded this command.",
        };
      }
      this.time.set(autoPlay ? 0 : completed.totalDurationS);
      await new Promise<void>((resolve) => {
        this.setState(
          {
            run: completed,
            status: autoPlay ? "running" : "completed",
            notice: `Verified ${completed.frames.length} MuJoCo 4.0.0 flexcomp samples (bundle ${completed.executionBundleId.slice(0, 12)}…).`,
          },
          () => {
            if (autoPlay) this.startPlaybackLoop();
            resolve();
          },
        );
      });
      return { kind: "done" };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Pastry bench simulation failed.";
      if (token === this.runToken) {
        await new Promise<void>((resolve) => {
          this.setState(
            {
              status: "failed",
              error: message,
              notice: "",
            },
            resolve,
          );
        });
      }
      return { kind: "rejected", message };
    }
  }

  private startPlaybackLoop(): void {
    cancelAnimationFrame(this.rafId);
    this.lastTickMs = performance.now();
    const tick = (nowMs: number) => {
      const { run, status } = this.state;
      const timeS = this.time.get();
      if (run === null || status !== "running") return;
      const dtS = Math.min(0.08, Math.max(0, (nowMs - this.lastTickMs) / 1000));
      this.lastTickMs = nowMs;
      const nextTimeS = timeS + dtS;
      if (nextTimeS >= run.totalDurationS) {
        this.time.set(run.totalDurationS);
        this.setState({ status: "completed" });
        return;
      }
      this.time.set(nextTimeS);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private pausePlayback(): void {
    cancelAnimationFrame(this.rafId);
    if (this.state.status === "running") {
      this.setState({ status: "paused" });
    }
  }

  private resumeOrRestart(): void {
    const { run } = this.state;
    const timeS = this.time.get();
    if (run === null) {
      void this.executeRun(this.state.recipe, true);
      return;
    }
    const startFrom = timeS >= run.totalDurationS - 0.02 ? 0 : timeS;
    this.time.set(startFrom);
    this.setState({ status: "running" }, () => this.startPlaybackLoop());
  }

  private seekTo(targetS: number): void {
    const { run } = this.state;
    if (run === null) return;
    cancelAnimationFrame(this.rafId);
    const clamped = Math.max(0, Math.min(run.totalDurationS, targetS));
    this.time.set(clamped);
    this.setState({
      status: clamped >= run.totalDurationS ? "completed" : "paused",
    });
  }

  private togglePanel(next: "scenario" | "results"): void {
    this.setState({ panel: this.state.panel === next ? null : next });
  }

  private toggleTimeline(): void {
    this.setState({ timeline: !this.state.timeline });
  }

  private primaryControl(): React.ReactNode {
    const { status } = this.state;
    if (status === "loading") {
      return (
        <button type="button" className="factory-primary" disabled>
          Solving flexcomp…
        </button>
      );
    }
    if (status === "running") {
      return (
        <button
          type="button"
          className="factory-primary"
          onClick={this.pausePlayback.bind(this)}
        >
          <RunIcon action="pause" />
          Pause replay
        </button>
      );
    }
    if (status === "completed") {
      return (
        <button
          type="button"
          className="factory-primary"
          onClick={this.resumeOrRestart.bind(this)}
        >
          <RunIcon action="again" />
          Run again
        </button>
      );
    }
    return (
      <button
        type="button"
        className="factory-primary"
        onClick={this.resumeOrRestart.bind(this)}
      >
        <RunIcon action="start" />
        Start replay
      </button>
    );
  }

  /** One live frame source for each run, so the views keep their subscriptions. */
  private liveRun(run: PastryBenchCompletedRun | null) {
    if (run === null) return null;
    if (this.live?.run !== run) {
      const frames = deriveLive(this.time, (timeS) => ({
        frame: samplePastryBenchRunAtTime(run, timeS),
      }));
      const clock = deriveLive(this.time, (timeS) => ({
        timeS,
        reachedS: run.totalDurationS,
      }));
      this.live = { run, frames, clock };
    }
    return this.live;
  }

  private idleClock(maxS: number): LiveSource<RecipeClock> {
    return deriveLive(this.time, (timeS) => ({ timeS, reachedS: maxS }));
  }

  render(): React.ReactNode {
    const {
      recipe,
      camera,
      status,
      surface,
      panel,
      timeline,
      run,
      error,
      notice,
    } = this.state;
    const stages = run?.stages ?? [];
    const maxS = run?.totalDurationS ?? 8.8;
    const live = this.liveRun(run);
    const clock = live?.clock ?? this.idleClock(maxS);

    return (
      <section
        className="production-workspace persistent-production"
        data-surface={surface}
        aria-label="Persistent production"
        data-lifecycle={
          status === "running" || status === "loading" ? "running" : "settled"
        }
      >
        <div className="factory-main-canvas" hidden={surface === "workflow"}>
          <PastryBenchPhysicsView
            frames={live?.frames ?? null}
            stages={stages}
            loading={status === "loading"}
            faultHandled={run !== null && run.rejectedAttemptTelemetry !== null}
            timelineOpen={timeline}
            camera={camera}
            onSelectCamera={(nextCamera) =>
              this.setState({ camera: nextCamera })
            }
          />
        </div>
        <header className="factory-toolbar">
          <RecipeBackButton close={this.props.close} />
          <div className="factory-title">
            <div>
              <span>
                Factory simulation · MuJoCo 4.0.0 flexcomp + Maruzen MBCO-5E
              </span>
              <h2>
                Pie Pastry Bench ·{" "}
                {run?.productTitle ?? "Deformable Shortcrust & Puff Lid"}
              </h2>
            </div>
          </div>
          <nav aria-label="Factory workspace">
            <RecipeSurfaceSwitch
              value={surface}
              select={(nextSurface) => this.setState({ surface: nextSurface })}
            />
            <div
              className="factory-panel-pills"
              role="group"
              aria-label="Detail panels"
            >
              <button
                type="button"
                data-surface-target="pastry-bench:controls"
                aria-expanded={panel === "scenario"}
                onClick={this.togglePanel.bind(this, "scenario")}
              >
                Scenario
              </button>
              <button
                type="button"
                aria-expanded={panel === "results"}
                onClick={this.togglePanel.bind(this, "results")}
              >
                Results
              </button>
            </div>
          </nav>
        </header>
        {run !== null && status === "completed" && (
          <button
            type="button"
            className="factory-summary"
            onClick={this.togglePanel.bind(this, "results")}
          >
            <strong>
              {run.shortcrustTelemetry.cavityDrapeMm.toFixed(1)} mm
            </strong>{" "}
            shortcrust drape ·{" "}
            <strong>{run.puffLidTelemetry.sealCoveragePct.toFixed(0)}%</strong>{" "}
            crimp seal ·{" "}
            <strong>+{run.ovenTelemetry.puffLiftMm.toFixed(1)} mm</strong>{" "}
            Maruzen puff
          </button>
        )}
        {error !== null && (
          <p role="alert" className="factory-summary">
            {error}
          </p>
        )}
        <aside
          className="production-panel factory-drawer"
          aria-label="Factory details"
          hidden={panel === null}
        >
          <div className="factory-drawer-heading">
            <h3>
              {panel === "results"
                ? "MuJoCo 4.0.0 deformable shell & oven results"
                : "Pastry bench scenario controls"}
            </h3>
            <button
              type="button"
              onClick={() => this.setState({ panel: null })}
            >
              Close details
            </button>
          </div>
          <div hidden={panel !== "scenario"}>
            <PastryBenchScenarioForm
              recipe={recipe}
              notice={notice}
              apply={(next) => void this.executeRun(next, true)}
            />
          </div>
          <div hidden={panel !== "results"}>
            {run === null ? (
              <p>Waiting for MuJoCo 4.0.0 solver output…</p>
            ) : (
              <>
                <h4>
                  3D shortcrust dough block (330 g · dim=3 tetrahedral flexcomp)
                </h4>
                <dl>
                  <dt>Pressed slab height</dt>
                  <dd>
                    {run.doughBlockTelemetry.doughBlockHeightMm.toFixed(2)} mm
                    (from 31.60 mm)
                  </dd>
                  <dt>Poisson lateral span</dt>
                  <dd>
                    {run.doughBlockTelemetry.doughBlockSpanMm.toFixed(2)} mm
                    (from 73.60 mm)
                  </dd>
                  <dt>3D solid topology</dt>
                  <dd>
                    {run.doughBlockTelemetry.doughBlockVertexCount} vertices ·{" "}
                    {run.doughBlockTelemetry.doughBlockTriangleCount} boundary
                    triangles
                  </dd>
                </dl>
                <h4>Shortcrust tin lining (330 g · 3 × 110 g shells)</h4>
                <dl>
                  <dt>Final cavity drape</dt>
                  <dd>{run.shortcrustTelemetry.cavityDrapeMm.toFixed(2)} mm</dd>
                  <dt>Rolled sheet gauge</dt>
                  <dd>
                    {run.shortcrustTelemetry.sheetThicknessMm.toFixed(2)} mm
                  </dd>
                  <dt>Rim contact coverage</dt>
                  <dd>{run.shortcrustTelemetry.sealCoveragePct.toFixed(1)}%</dd>
                  <dt>Roller mechanical work</dt>
                  <dd>
                    {run.shortcrustTelemetry.rollerWorkJoules.toFixed(2)} J
                  </dd>
                </dl>
                <h4>Puff-pastry lid crimp (240 g · 3 × 80 g lids)</h4>
                <dl>
                  <dt>Lid drape depth</dt>
                  <dd>{run.puffLidTelemetry.cavityDrapeMm.toFixed(2)} mm</dd>
                  <dt>Fluted crimp force</dt>
                  <dd>{run.puffLidTelemetry.rimCrimpForceN.toFixed(1)} N</dd>
                  <dt>Steam-lock seal coverage</dt>
                  <dd>{run.puffLidTelemetry.sealCoveragePct.toFixed(1)}%</dd>
                  <dt>Flexcomp mesh topology</dt>
                  <dd>
                    {run.puffLidTelemetry.vertexCount} vertices ·{" "}
                    {run.puffLidTelemetry.triangleCount} triangles
                  </dd>
                </dl>
                <h4>Maruzen MBCO-5E convection bake (200 °C · middle rack)</h4>
                <dl>
                  <dt>Peak convection chamber</dt>
                  <dd>{run.ovenTelemetry.peakChamberC.toFixed(1)} °C</dd>
                  <dt>Puff-lamination dome lift</dt>
                  <dd>+{run.ovenTelemetry.puffLiftMm.toFixed(2)} mm</dd>
                  <dt>Maillard egg-wash crust</dt>
                  <dd>{run.ovenTelemetry.finalBrowningPct.toFixed(1)}%</dd>
                  <dt>Steam evaporation</dt>
                  <dd>
                    {run.ovenTelemetry.steamLossG.toFixed(1)} g (
                    {run.ovenTelemetry.heaterInputKJ.toFixed(0)} kJ heater)
                  </dd>
                </dl>
                {run.rejectedAttemptTelemetry !== null && (
                  <>
                    <h4>Injected unfloured fault &amp; recovery</h4>
                    <dl>
                      <dt>Unfloured attempt drape</dt>
                      <dd>
                        {run.rejectedAttemptTelemetry.cavityDrapeMm.toFixed(2)}{" "}
                        mm (rejected by 14 mm gate)
                      </dd>
                      <dt>Recovered floured drape</dt>
                      <dd>
                        {run.shortcrustTelemetry.cavityDrapeMm.toFixed(2)} mm
                        (passed)
                      </dd>
                    </dl>
                  </>
                )}
              </>
            )}
          </div>
        </aside>
        <div className="factory-workflow-canvas" hidden={surface === "factory"}>
          <RecipeWorkflow
            graph={{ kind: "savoury-pies", pie: recipe.pieType }}
            stages={stages}
            clock={clock}
            running={status === "running"}
            prepared={status === "paused" && this.time.get() === 0}
            outcome={
              status === "failed"
                ? "failed"
                : status === "completed"
                  ? "completed"
                  : null
            }
            seek={this.seekTo.bind(this)}
          />
        </div>
        <RecipeSplitDivider surface={surface} />
        <RecipeRunFooter
          clock={clock}
          stages={stages}
          horizonS={Math.max(0.1, maxS)}
          completed={status === "completed"}
          status={status}
          control={
            <div data-surface-target="pastry-bench:prepare">
              {this.primaryControl()}
            </div>
          }
          labels={{
            title: "Task timeline",
            scaleDigits: 1,
            header: (
              <>
                Cursor:{" "}
                <LiveText source={clock} text={(c) => c.timeS.toFixed(2)} /> s
              </>
            ),
            clockNote: null,
            span: (stage) =>
              `${stage.startS.toFixed(1)}–${stage.endS.toFixed(1)} s`,
            minSpanPct: 3,
          }}
          timeline={timeline}
          toggleTimeline={this.toggleTimeline.bind(this)}
          seek={this.seekTo.bind(this)}
        />
      </section>
    );
  }
}

function PastryBenchScenarioForm(props: {
  readonly recipe: PastryBenchRecipeConfig;
  readonly notice: string;
  readonly apply: (next: PastryBenchRecipeConfig) => void;
}): React.ReactNode {
  const [pieType, setPieType] = React.useState(props.recipe.pieType);
  const [thickness, setThickness] = React.useState<2.5 | 3.0 | 3.5>(
    props.recipe.targetThicknessMm,
  );
  const [crimpForce, setCrimpForce] = React.useState<36 | 42 | 52>(
    props.recipe.crimpForceN,
  );
  const [faultCheck, setFaultCheck] = React.useState<PastryBenchFaultCheck>(
    props.recipe.faultCheck,
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        props.apply({
          pieType,
          targetThicknessMm: thickness,
          crimpForceN: crimpForce,
          faultCheck,
        });
      }}
    >
      <p>
        16 °C tempered marble pastry slab with stainless rolling pin, 12 cm
        fluted aluminium pie tin (28 mm cavity), and fluted rim crimping ring.
      </p>
      <label>
        Savoury pie variety
        <Select.Root
          items={PIE_TYPE_ITEMS}
          value={pieType}
          onValueChange={(v) => {
            if (v === "steak-and-pepper" || v === "beef-bourguignon") {
              setPieType(v);
            }
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{PIE_TYPE_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Shortcrust target thickness
        <Select.Root
          items={THICKNESS_ITEMS}
          value={thickness.toFixed(1)}
          onValueChange={(v) => {
            if (v === "2.5") setThickness(2.5);
            else if (v === "3.5") setThickness(3.5);
            else if (v === "3.0") setThickness(3.0);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{THICKNESS_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Puff-pastry rim crimp force
        <Select.Root
          items={CRIMP_FORCE_ITEMS}
          value={String(crimpForce)}
          onValueChange={(v) => {
            if (v === "36") setCrimpForce(36);
            else if (v === "52") setCrimpForce(52);
            else if (v === "42") setCrimpForce(42);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{CRIMP_FORCE_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <label>
        Process check
        <Select.Root
          items={FAULT_CHECK_ITEMS}
          value={faultCheck}
          onValueChange={(v) => {
            if (v === "none" || v === "unfloured-bench") setFaultCheck(v);
          }}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{FAULT_CHECK_ITEMS.map(renderItem)}</Select.Popup>
        </Select.Root>
      </label>
      <button type="submit">Run MuJoCo 4.0.0 flexcomp</button>
      <p role="status">{props.notice}</p>
    </form>
  );
}

function renderItem(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}
