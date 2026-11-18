import React from "react";

// Measured from the supplied 30fps, 500-frame video. This timeline belongs to
// the demonstration, never to live agent activity.
const frameCount = 500;
const duration = (frameCount / 30) * 1000;
const sceneStarts = [0, 1.5, 2.6, 3.65, 4.7, 5.75, 6.85, 7.9, 9, 10.05, 11.1];
const overviewStart = 370 / 30;
const overviewEnd = 398 / 30;
const sceneFade = 0.2;
// First-card bounds measured in every source frame, normalized from 1680px
// to 420px. These samples retain the video's quick middle and soft landing.
const zoomSamples = [
  { frame: 370, progress: 0 },
  { frame: 374, progress: 0.04 },
  { frame: 378, progress: 0.206 },
  { frame: 382, progress: 0.533 },
  { frame: 386, progress: 0.779 },
  { frame: 390, progress: 0.91 },
  { frame: 394, progress: 0.97 },
  { frame: 398, progress: 1 },
];

type FocusTransform = {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
};

type ReplayState =
  | { readonly kind: "overview"; readonly frame?: never }
  | { readonly kind: "playing" | "paused"; readonly frame: number };

export class TraceReferenceReplay extends React.Component<
  {
    readonly children: React.ReactNode;
  },
  ReplayState
> {
  state: ReplayState = { kind: "overview" };
  private readonly container = React.createRef<HTMLDivElement>();
  private animations: Animation[] = [];
  private tickId: number | null = null;
  private observer: ResizeObserver | null = null;
  private motionFactor = 1;

  componentDidMount(): void {
    this.observer = new ResizeObserver(this.resize.bind(this));
    if (this.container.current) this.observer.observe(this.container.current);
  }

  componentWillUnmount(): void {
    this.clear();
    this.observer?.disconnect();
  }

  private clear(): void {
    if (this.tickId !== null) cancelAnimationFrame(this.tickId);
    this.tickId = null;
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }

  private build(): void {
    this.clear();
    const root = this.container.current;
    if (root === null) return;
    const gallery = root.querySelector<HTMLElement>(".trace-preview-gallery");
    if (gallery === null) return;
    const bounds = gallery.getBoundingClientRect();
    const examples = gallery.querySelectorAll<HTMLElement>(
      ".trace-preview-example",
    );
    const factor = getComputedStyle(document.documentElement).getPropertyValue(
      "--agent-motion-factor",
    );
    this.motionFactor = Number.parseFloat(factor) || 1;

    for (const [index, example] of examples.entries()) {
      const rect = example.getBoundingClientRect();
      const scale = Math.min(
        (bounds.width * 0.84) / rect.width,
        (bounds.height * 0.9) / rect.height,
      );
      const x =
        (bounds.width - rect.width * scale) / 2 - (rect.left - bounds.left);
      const y =
        (bounds.height - rect.height * scale) / 2 - (rect.top - bounds.top);
      const focus: FocusTransform = { x, y, scale };
      if (index === 0) this.animateBackdrop(example, focus);
      this.addAnimation(example, exampleOpacityFrames(index));
      this.addAnimation(example, exampleTransformFrames(index, focus));
      const surface = example.querySelector(".trace-preview-card-surface");
      if (surface !== null) {
        const reveal = index === 0 ? overviewEnd : gridRevealTime(index);
        this.addAnimation(surface, [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: (reveal - 0.001) / (duration / 1000) },
          { opacity: 1, offset: reveal / (duration / 1000) },
          { opacity: 1, offset: 1 },
        ]);
      }
      const caption = example.querySelector("h2");
      if (caption !== null) {
        if (index === 0)
          this.addAnimation(caption, [
            { opacity: 1, offset: 0 },
            { opacity: 1, offset: (overviewStart - 0.001) / (duration / 1000) },
            { opacity: 0, offset: overviewStart / (duration / 1000) },
            { opacity: 0, offset: overviewEnd / (duration / 1000) },
            { opacity: 1, offset: (overviewEnd + 0.15) / (duration / 1000) },
            { opacity: 1, offset: 1 },
          ]);
        this.addAnimation(caption, [
          { transform: `scale(${Math.min(1, 1.65 / scale)})`, offset: 0 },
          {
            transform: `scale(${Math.min(1, 1.65 / scale)})`,
            offset: overviewStart / (duration / 1000),
          },
          { transform: "scale(1)", offset: overviewEnd / (duration / 1000) },
          { transform: "scale(1)", offset: 1 },
        ]);
      }
    }

    // Terminal lines fade in at 100ms intervals during the scene entrance
    // (frames 266–285). Existing output remains in place.
    const lines = gallery.querySelectorAll(".trace-preview-terminal-line");
    for (const [index, line] of lines.entries()) {
      const start = 8.85 + index * 0.1;
      this.addAnimation(line, [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: start / (duration / 1000) },
        { opacity: 1, offset: (start + 0.15) / (duration / 1000) },
        { opacity: 1, offset: 1 },
      ]);
    }
    for (const spinner of gallery.querySelectorAll("[data-spinning]")) {
      this.addAnimation(spinner, [
        { transform: "rotate(0deg)", offset: 0 },
        { transform: `rotate(${(duration / 1000) * 360}deg)`, offset: 1 },
      ]);
    }
  }

  private animateBackdrop(example: HTMLElement, focus: FocusTransform): void {
    const root = this.container.current;
    const card = example.querySelector(".trace-preview-card");
    const backdrop = root?.querySelector<HTMLElement>(
      ".trace-reference-backdrop",
    );
    if (!root || !card || !backdrop) return;
    const rootRect = root.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    backdrop.style.left = `${cardRect.left - rootRect.left}px`;
    backdrop.style.top = `${cardRect.top - rootRect.top}px`;
    backdrop.style.width = `${cardRect.width}px`;
    backdrop.style.height = `${cardRect.height}px`;
    this.addAnimation(backdrop, exampleTransformFrames(0, focus));
    this.addAnimation(backdrop, [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: overviewEnd / (duration / 1000) },
      { opacity: 0, offset: (overviewEnd + 0.001) / (duration / 1000) },
      { opacity: 0, offset: 1 },
    ]);
  }

  private addAnimation(element: Element, frames: Keyframe[]): void {
    const animation = element.animate(frames, {
      duration: duration * this.motionFactor,
      fill: "both",
    });
    animation.pause();
    this.animations.push(animation);
  }

  private resize(): void {
    if (this.state.kind === "overview") return;
    const state = this.state;
    this.build();
    this.setTime(state.frame);
    if (state.kind === "playing") this.resume();
  }

  private setTime(frame: number): void {
    for (const animation of this.animations) {
      animation.currentTime = (frame / 30) * 1000 * this.motionFactor;
    }
  }

  private resume(): void {
    const startTime = document.timeline.currentTime;
    const currentTime = this.animations[0]?.currentTime ?? 0;
    for (const animation of this.animations) {
      animation.play();
      if (typeof startTime === "number" && typeof currentTime === "number") {
        animation.startTime = startTime - currentTime;
      }
    }
    this.tickId = requestAnimationFrame(this.tick.bind(this));
  }

  private play(): void {
    if (this.state.kind === "paused") {
      this.setState({ kind: "playing", frame: this.state.frame });
    } else {
      this.build();
      this.setTime(0);
      this.setState({ kind: "playing", frame: 0 });
    }
    this.resume();
  }

  private tick(): void {
    const time = this.animations[0]?.currentTime;
    if (typeof time !== "number") return;
    const frame = Math.floor((time / this.motionFactor / 1000) * 30);
    if (frame >= frameCount) {
      this.showAll();
      return;
    }
    this.setState({ kind: "playing", frame });
    this.tickId = requestAnimationFrame(this.tick.bind(this));
  }

  private pause(): void {
    if (this.tickId !== null) cancelAnimationFrame(this.tickId);
    this.tickId = null;
    for (const animation of this.animations) animation.pause();
    if (this.state.kind === "playing")
      this.setState({ kind: "paused", frame: this.state.frame });
  }

  private seek(event: React.ChangeEvent<HTMLInputElement>): void {
    const frame = event.currentTarget.valueAsNumber;
    this.pause();
    if (this.animations.length === 0) this.build();
    this.setTime(frame);
    this.setState({ kind: "paused", frame });
  }

  private showAll(): void {
    this.clear();
    this.setState({ kind: "overview" });
  }

  render(): React.ReactNode {
    const playing = this.state.kind === "playing";
    const overview = this.state.kind === "overview";
    return (
      <section aria-label="Reference examples">
        <div className="trace-reference-controls trace-preview-controls">
          <label>
            Reference frame
            <input
              type="range"
              min="0"
              max="499"
              step="1"
              value={overview ? 499 : this.state.frame}
              onChange={this.seek.bind(this)}
            />
            <output aria-live="off">
              {overview ? "499" : this.state.frame} / 499
            </output>
          </label>
          <button
            type="button"
            onClick={playing ? this.pause.bind(this) : this.play.bind(this)}
          >
            {playing ? "Pause reference" : "Replay reference"}
          </button>
          <button
            type="button"
            onClick={this.showAll.bind(this)}
            disabled={overview}
          >
            Show all examples
          </button>
        </div>
        <div
          ref={this.container}
          className="trace-reference-stage"
          data-replaying={!overview || undefined}
          data-overview={
            this.state.kind === "overview" ||
            this.state.frame >= 390 ||
            undefined
          }
          inert={!overview}
        >
          <div
            className="trace-preview-card-surface trace-reference-backdrop"
            aria-hidden="true"
          >
            <div className="trace-preview-dots">
              <i />
              <i />
              <i />
            </div>
          </div>
          {this.props.children}
        </div>
      </section>
    );
  }
}

function gridRevealTime(index: number): number {
  return 13.1 + (index - 1) * 0.1;
}

function focusTransform(focus: FocusTransform, progress: number): string {
  const remaining = 1 - progress;
  return `translate(${focus.x * remaining}px, ${focus.y * remaining}px) scale(${1 + (focus.scale - 1) * remaining})`;
}

function exampleTransformFrames(
  index: number,
  focus: FocusTransform,
): Keyframe[] {
  const seconds = duration / 1000;
  const frames: Keyframe[] = [
    {
      transform: focusTransform(focus, 0),
      transformOrigin: "top left",
      offset: 0,
    },
  ];
  if (index === 0) {
    for (const sample of zoomSamples) {
      frames.push({
        transform: focusTransform(focus, sample.progress),
        offset: sample.frame / frameCount,
      });
    }
  } else {
    const reveal = gridRevealTime(index);
    frames.push({
      transform: focusTransform(focus, 0),
      transformOrigin: "top left",
      offset: (reveal - 0.001) / seconds,
    });
    frames.push({
      transform: "scale(0.8)",
      transformOrigin: "center center",
      offset: reveal / seconds,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    frames.push({
      transform: "scale(1.04)",
      transformOrigin: "center center",
      offset: (reveal + 0.2) / seconds,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    frames.push({
      transform: "none",
      transformOrigin: "center center",
      offset: (reveal + 0.45) / seconds,
    });
  }
  frames.push({
    transform: "none",
    transformOrigin: index === 0 ? "top left" : "center center",
    offset: 1,
  });
  return frames;
}

function exampleOpacityFrames(index: number): Keyframe[] {
  const seconds = duration / 1000;
  const start = sceneStarts[index];
  const frames: Keyframe[] = [{ opacity: index === 0 ? 1 : 0, offset: 0 }];
  if (start !== undefined) {
    if (index > 0) {
      frames.push({ opacity: 0, offset: start / seconds });
      frames.push({ opacity: 1, offset: (start + sceneFade) / seconds });
    }
    const end = sceneStarts[index + 1] ?? 12.55;
    // The video clears the old text before the next scene appears. Overlapping
    // two half-visible paragraphs produces a distracting double image.
    frames.push({ opacity: 1, offset: (end - 0.1) / seconds });
    frames.push({ opacity: 0, offset: end / seconds });
  }
  const reveal = index === 0 ? 12.55 : gridRevealTime(index);
  frames.push({ opacity: 0, offset: reveal / seconds });
  frames.push({ opacity: 1, offset: (reveal + sceneFade) / seconds });
  frames.push({ opacity: 1, offset: 1 });
  return frames;
}
