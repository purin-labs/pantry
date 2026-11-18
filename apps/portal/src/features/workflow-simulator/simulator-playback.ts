import React from "react";
import type {
  PlaybackSnapshot,
  PlaybackUpdate,
} from "@seams/production-simulation/simulator/playback-state";
import type { Run } from "@seams/production-simulation/recipes/bakery/schedule";
import { PlaybackController } from "./playback-controller";
import {
  LiveValue,
  type LiveSource,
} from "../production-run/shared/live-value";

type Host = Readonly<{
  /** The playback state that React holds: its time changes only coarsely. */
  snapshot(): PlaybackSnapshot;
  /** The run that plays; its events are the coarse steps of the clock. */
  run(): Run | null;
  /** Writes a coarse playback change to React state. */
  commit(update: PlaybackUpdate): void;
  /**
   * false while a view still reads the time from React state: the
   * recording viewer draws its robot from it, so it commits each frame.
   */
  coarse(): boolean;
}>;

/**
 * The playback clock of the simulator. Each animation frame moves the live
 * time, which the scenes, the clocks and the timeline cursors read without
 * React. React state receives the time only when playback starts or stops,
 * or when the clock passes an event of the run, so the task states, the
 * captions and the inspector change with the run and not on each frame.
 */
export class SimulatorPlayback {
  readonly time = new LiveValue(0);
  private readonly controller: PlaybackController;
  private committed = 0;
  private boundaries: Readonly<{ run: Run; times: Float64Array }> | null = null;

  constructor(private readonly host: Host) {
    this.controller = new PlaybackController(
      this.snapshot.bind(this),
      this.update.bind(this),
    );
  }

  /** While it plays, the live time is ahead of the time in React state. */
  snapshot(): PlaybackSnapshot {
    const snapshot = this.host.snapshot();
    return snapshot.playback === "playing"
      ? { ...snapshot, time: this.time.get() }
      : snapshot;
  }

  /** React state changed its time (a seek, a restart, a new run): follow it. */
  synced(): void {
    const snapshot = this.host.snapshot();
    if (snapshot.playback === "playing") this.controller.play();
    else this.controller.stop();
    if (snapshot.time !== this.committed) {
      this.committed = snapshot.time;
      this.time.set(snapshot.time);
    }
  }

  stop(): void {
    this.controller.stop();
  }

  pause(): void {
    this.controller.pause();
  }

  private update(update: PlaybackUpdate): void {
    this.time.set(update.time);
    const commit =
      !this.host.coarse() ||
      update.playback !== this.host.snapshot().playback ||
      this.step(update.time) !== this.step(this.committed);
    if (!commit) return;
    this.committed = update.time;
    this.host.commit(update);
  }

  /** The number of run events at or before a time. */
  private step(time: number): number {
    const times = this.eventTimes();
    let low = 0;
    let high = times.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((times[middle] ?? Infinity) <= time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private eventTimes(): Float64Array {
    const run = this.host.run();
    if (run === null) return new Float64Array();
    if (this.boundaries?.run !== run) {
      const times = new Set<number>(run.events);
      for (const interval of run.intervals) {
        times.add(interval.start);
        times.add(interval.end);
      }
      this.boundaries = {
        run,
        times: Float64Array.from([...times].sort((a, b) => a - b)),
      };
    }
    return this.boundaries.times;
  }
}

/** The live playback time of the simulator, for a clock or a cursor. */
export const PlaybackTimeContext = React.createContext<LiveSource<number>>(
  new LiveValue(0),
);
