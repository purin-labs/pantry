import type { PlaybackSnapshot, PlaybackUpdate } from "@seams/production-simulation/simulator/playback-state";

export type FrameClock = Readonly<{
  request(callback: FrameRequestCallback): number;
  cancel(frame: number): void;
}>;

export class PlaybackController {
  private readonly read: () => PlaybackSnapshot;
  private readonly commit: (update: PlaybackUpdate) => void;
  private readonly clock: FrameClock;
  private frame: number | null = null;
  private last: number | null = null;
  private running = false;
  private generation = 0;

  constructor(
    read: () => PlaybackSnapshot,
    commit: (update: PlaybackUpdate) => void,
    clock: FrameClock = browserFrameClock,
  ) {
    this.read = read;
    this.commit = commit;
    this.clock = clock;
  }

  toggle(): void {
    const snapshot = this.read();
    if (this.running || snapshot.playback === "playing") {
      this.stop();
      this.commit({ time: snapshot.time, playback: "paused" });
      return;
    }

    this.play();
  }

  play(): void {
    if (this.running) return;
    const snapshot = this.read();
    if (snapshot.end <= 0) return;

    const time = snapshot.time >= snapshot.end ? 0 : snapshot.time;
    this.running = true;
    this.commit({ time, playback: "playing" });
    this.frame = this.clock.request(this.tick.bind(this, this.generation));
  }

  pause(): void {
    const snapshot = this.read();
    this.stop();
    this.commit({ time: snapshot.time, playback: "paused" });
  }

  stop(): void {
    this.generation++;
    this.running = false;
    if (this.frame !== null) {
      this.clock.cancel(this.frame);
    }
    this.frame = null;
    this.last = null;
  }

  private tick(generation: number, now: number): void {
    if (generation !== this.generation) return;
    const snapshot = this.read();
    this.frame = null;
    if (!this.running || snapshot.playback !== "playing") {
      return;
    }
    const last = this.last ?? now;
    this.last = now;
    const deltaSeconds = Math.max(0, Math.min(0.1, (now - last) / 1_000));
    const elapsed = deltaSeconds * snapshot.speed;
    const time = Math.min(snapshot.end, snapshot.time + elapsed);
    const playback = time >= snapshot.end ? "paused" : "playing";
    this.commit({ time, playback });

    if (playback === "playing") {
      this.frame = this.clock.request(this.tick.bind(this, generation));
      return;
    }
    this.frame = null;
    this.last = null;
    this.running = false;
  }
}

const browserFrameClock: FrameClock = {
  request: requestBrowserFrame,
  cancel: cancelBrowserFrame,
};

function requestBrowserFrame(callback: FrameRequestCallback): number {
  return requestAnimationFrame(callback);
}

function cancelBrowserFrame(frame: number): void {
  cancelAnimationFrame(frame);
}
