import type React from "react";
import type { RecipeClock } from "../recipe-workflow";
import { deriveLive, LiveValue, type LiveSource } from "./live-value";

import {
  ORIGINAL_ANIMATION,
  warpedEngine,
  type AnimationPlan,
  type AnimationPlanBuilder,
  type RecipeEngine,
} from "../recipe-clock";

export type RecipeRunStatus =
  "review" | "running" | "paused" | "completed" | "blocked";

type RecipeRunOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type RecipeRunSample = Readonly<{
  timeS: number;
  outcome: RecipeRunOutcome | null;
}>;

/** The frames of a recipe run. They live outside React state. */
export type RecipeFrames<Sample> = Readonly<{
  sample: Sample;
  /** The samples of the last tick, for a scene that plays them smoothly. */
  samples: readonly Sample[];
  history: readonly Sample[];
}>;

/** The part of a recipe view's React state that its run owns: coarse values only. */
export type RecipeRunState = Readonly<{
  status: RecipeRunStatus;
  notice: string;
}>;

export function recipeFrames<Sample>(sample: Sample): RecipeFrames<Sample> {
  return { sample, samples: [sample], history: [sample] };
}

/** The clock of the workflow cards, the timeline and the notice. */
export function recipeClock<Sample extends RecipeRunSample>(
  frames: LiveSource<RecipeFrames<Sample>>,
): LiveSource<RecipeClock> {
  return deriveLive(frames, clockOf);
}

function clockOf<Sample extends RecipeRunSample>(
  frames: RecipeFrames<Sample>,
): RecipeClock {
  return {
    timeS: frames.sample.timeS,
    reachedS: frames.history.at(-1)?.timeS ?? frames.sample.timeS,
  };
}

type RecipePlaybackOptions<Sample extends RecipeRunSample, Recipe> = Readonly<{
  /** The recipe that a restart and a new animation plan run. */
  recipe: () => Recipe;
  /** A new model engine for a recipe. */
  model: (recipe: Recipe) => RecipeEngine<Sample>;
  /** The timeline stages that an animation plan maps a draft onto. */
  stages: (recipe: Recipe) => Parameters<AnimationPlanBuilder>[0];
  /** The notice when the run ends. */
  outcomeNotice: (outcome: NonNullable<Sample["outcome"]>) => string;
  /** The notice after Run again. */
  resetNotice: string;
}>;

/** The batch that one timer tick plays, and the time between ticks. */
const STEPS_PER_TICK = 5;
const TICK_MS = 36;
/** The model step of a warped animation, in seconds. */
const WARP_STEP_S = 0.04;

/**
 * The run of a recipe view: its engine, its animation plan and its timer.
 * A timer tick writes the frames, which the scene, the clocks and the
 * timeline read outside React. Start, pause, the outcome, Run again, a new
 * scenario, a new animation plan and a scrub set the view's coarse state.
 */
export class RecipePlayback<Sample extends RecipeRunSample, Recipe> {
  private engine: RecipeEngine<Sample>;
  private plan: AnimationPlan = ORIGINAL_ANIMATION;
  private timer: number | null = null;
  readonly frames: LiveValue<RecipeFrames<Sample>>;
  readonly clock: LiveSource<RecipeClock>;

  constructor(
    private readonly view: React.Component<unknown, RecipeRunState>,
    private readonly options: RecipePlaybackOptions<Sample, Recipe>,
    recipe: Recipe,
  ) {
    this.engine = this.animated(recipe);
    this.frames = new LiveValue(recipeFrames(this.engine.initialSample()));
    this.clock = recipeClock(this.frames);
  }

  /** The animation plan that the view draws the timeline with. */
  get animation(): AnimationPlan {
    return this.plan;
  }

  initialSample(): Sample {
    return this.engine.initialSample();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  start(): void {
    if (this.view.state.status === "running") return;
    this.view.setState({ status: "running", notice: "" });
    this.stop();
    this.timer = window.setInterval(() => {
      const batch = this.engine.stepBatch(STEPS_PER_TICK);
      const last = batch.at(-1);
      if (last === undefined) {
        this.stop();
        return;
      }
      const prev = this.frames.get();
      this.frames.set({
        sample: last,
        samples: batch,
        history: [...prev.history, ...batch],
      });
      if (last.outcome !== null) {
        this.stop();
        this.view.setState({
          status: last.outcome.kind === "completed" ? "completed" : "blocked",
          notice: this.options.outcomeNotice(last.outcome),
        });
      }
    }, TICK_MS);
  }

  pause(): void {
    this.stop();
    this.view.setState({ status: "paused" });
  }

  restart(): void {
    this.stop();
    this.engine = this.animated(this.options.recipe());
    this.frames.set(recipeFrames(this.engine.initialSample()));
    this.view.setState({ status: "review", notice: this.options.resetNotice });
    this.start();
  }

  /** A new scenario plays the original animation from its prepared state. */
  applyScenario(next: Recipe): void {
    this.stop();
    this.plan = ORIGINAL_ANIMATION;
    this.engine = this.animated(next);
    this.frames.set(recipeFrames(this.engine.initialSample()));
  }

  /** A draft ran: the next start plays it, as far as this animation can. */
  planned(build: AnimationPlanBuilder): void {
    this.stop();
    const recipe = this.options.recipe();
    this.plan = build(this.options.stages(recipe));
    this.engine = this.animated(recipe);
    this.frames.set(recipeFrames(this.engine.initialSample()));
    this.view.setState({ status: "review" });
  }

  scrubToTime(targetS: number): void {
    this.stop();
    const frames = this.frames.get();
    let best = frames.history[0];
    if (best === undefined) return;
    for (const item of frames.history) {
      if (Math.abs(item.timeS - targetS) < Math.abs(best.timeS - targetS)) {
        best = item;
      }
    }
    this.frames.set({ sample: best, samples: [best], history: frames.history });
    // The view reads the outcome of the shown sample when it renders. A scrub
    // away from the outcome sample, or back to it, renders the view again.
    if (this.view.state.status === "running")
      this.view.setState({ status: "paused" });
    else if (best.outcome !== frames.sample.outcome) this.view.forceUpdate();
  }

  private animated(recipe: Recipe): RecipeEngine<Sample> {
    return warpedEngine(this.options.model(recipe), this.plan, WARP_STEP_S);
  }
}
