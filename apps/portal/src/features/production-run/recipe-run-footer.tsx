import React from "react";
import { TimelineLabel, type RecipeClock } from "./recipe-workflow";
import { LiveText, useLive, useLiveEffect } from "./shared/live";
import { sameItems, type LiveSource } from "./shared/live-value";

type Stage = Readonly<{
  id: string;
  label: string;
  startS: number;
  endS: number;
}>;

type Props = Readonly<{
  clock: LiveSource<RecipeClock>;
  stages: readonly Stage[];
  /** The planned end of the run; the scale grows past it when the run does. */
  horizonS: number;
  completed: boolean;
  status: string;
  /** The run control: start, pause, resume or run again. */
  control: React.ReactNode;
  /** More actions before the Timeline toggle, for example a schedule handoff. */
  actions?: React.ReactNode;
  /** A note after the playback row. */
  after?: React.ReactNode;
  /** The labels of a workspace that names its timeline and clocks itself. */
  labels?: Readonly<{
    title: string;
    scaleDigits: number;
    /** Replaces "Committed: <time> s" in the timeline header. */
    header: React.ReactNode;
    /** Follows "Simulation seconds" under the clock. */
    clockNote: React.ReactNode;
    span(stage: Stage): string;
    /** The smallest span width in percent of the scale. */
    minSpanPct: number;
  }>;
  timeline: boolean;
  toggleTimeline(): void;
  seek(timeS: number): void;
}>;

/**
 * The footer of a recipe workspace: the task timeline, the simulation clock
 * and the run control. The clock text and the timeline cursor follow the
 * playback clock by DOM writes; a stage span renders again only when its
 * phase changes.
 */
export function RecipeRunFooter(props: Props): React.ReactNode {
  const { clock, stages, timeline, labels } = props;
  const scaleS = useLive(clock, (value) =>
    Math.max(props.horizonS, value.reachedS),
  );
  const phases = useLive(
    clock,
    (value) => stages.map(stagePhase.bind(null, props.completed, value.timeS)),
    sameItems,
  );
  return (
    <footer className="factory-bottom" data-timeline-open={timeline}>
      <div
        className="factory-timeline-shell"
        data-open={timeline}
        inert={!timeline}
      >
        <div className="factory-timeline-inner">
          <section
            className="factory-timeline-panel"
            aria-label="Factory timeline"
          >
            <div className="production-timeline-header">
              <h3>{labels?.title ?? "Task timeline"}</h3>
              <span>
                Scale: 0–{scaleS.toFixed(labels?.scaleDigits ?? 0)} s ·{" "}
                {labels?.header ?? (
                  <>
                    Committed: <LiveText source={clock} text={committedText} />{" "}
                    s
                  </>
                )}
              </span>
            </div>
            <div
              className="oven-task-timeline oven-logistics-scroll"
              tabIndex={0}
              aria-label="Task timeline"
            >
              {stages.map((stage, index) => {
                const [phase, active] = (phases[index] ?? "reserved:").split(
                  ":",
                );
                const leftPct = (stage.startS / scaleS) * 100;
                const widthPct = Math.max(
                  labels?.minSpanPct ?? 1.5,
                  ((stage.endS - stage.startS) / scaleS) * 100,
                );
                return (
                  <div key={stage.id} className="oven-task-track">
                    <button
                      type="button"
                      aria-pressed={active === "active"}
                      onClick={props.seek.bind(null, stage.startS)}
                    >
                      {stage.label}
                    </button>
                    <div className="oven-task-lane">
                      <button
                        type="button"
                        className="oven-task-span"
                        data-phase={phase}
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                        onClick={props.seek.bind(null, stage.startS)}
                      >
                        {labels?.span(stage) ??
                          `${stage.startS}–${stage.endS} s`}
                      </button>
                      <TimelineCursor clock={clock} scaleS={scaleS} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
      <div className="factory-playback">
        <div className="factory-clock">
          <LiveText
            as="output"
            aria-label="Simulation seconds"
            source={clock}
            text={committedText}
          />
          <span>
            Simulation seconds{labels?.clockNote} ·{" "}
            <output aria-label="Execution status">{props.status}</output>
          </span>
        </div>
        {props.control}
        <div className="factory-playback-actions">
          {props.actions}
          <button
            type="button"
            className="production-timeline-toggle"
            aria-expanded={timeline}
            onClick={props.toggleTimeline}
          >
            <TimelineLabel open={timeline} />
          </button>
        </div>
      </div>
      {props.after}
    </footer>
  );
}

function committedText(clock: RecipeClock): string {
  return clock.timeS.toFixed(2);
}

/** The span phase and the pressed state of a stage, as one comparable key. */
function stagePhase(completed: boolean, timeS: number, stage: Stage): string {
  const active = timeS >= stage.startS && timeS < stage.endS;
  const phase =
    completed || timeS >= stage.endS
      ? "completed"
      : active
        ? "active"
        : "reserved";
  return `${phase}:${active ? "active" : ""}`;
}

/** The playback cursor of one timeline lane, moved by a style write. */
function TimelineCursor(
  props: Readonly<{ clock: LiveSource<RecipeClock>; scaleS: number }>,
): React.ReactNode {
  const cursor = React.useRef<HTMLDivElement>(null);
  useLiveEffect(props.clock, (clock) => {
    if (cursor.current !== null)
      cursor.current.style.left = `${Math.min(100, (clock.timeS / props.scaleS) * 100)}%`;
  });
  return <div ref={cursor} className="oven-task-cursor" />;
}

/**
 * A range input on the playback clock. The thumb and the reachable end follow
 * the clock by DOM writes; a person's input seeks.
 */
export function RecipeScrubber<T>(
  props: Readonly<{
    source: LiveSource<T>;
    label: string;
    value: (value: T) => number;
    max: (value: T) => number;
    step: string;
    seek(timeS: number): void;
  }>,
): React.ReactNode {
  const input = React.useRef<HTMLInputElement>(null);
  useLiveEffect(props.source, (value) => {
    const node = input.current;
    if (node === null) return;
    const max = String(props.max(value));
    if (node.max !== max) node.max = max;
    node.value = String(props.value(value));
  });
  return (
    <input
      ref={input}
      type="range"
      aria-label={props.label}
      min="0"
      step={props.step}
      onChange={(event) => props.seek(Number(event.currentTarget.value))}
    />
  );
}
