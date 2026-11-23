import React from "react";
import type { VoiceStatus } from "./session";

type VoiceWaveState = "listening" | "hearing" | "transcribing";

/** The wave's state, or null while voice control does not listen. */
export function voiceWaveState(status: VoiceStatus): VoiceWaveState | null {
  switch (status.kind) {
    case "listening":
      return "listening";
    case "capturing":
      return "hearing";
    case "transcribing":
      return "transcribing";
    default:
      return null;
  }
}

/**
 * Five bars: a slow ripple while voice control waits for the wake phrase, the
 * microphone's loudness while it hears a command, and a pulse from left to
 * right while the command is transcribed. Without a `level`, the bars of a
 * heard command bounce at their own pace. Decorative: the status line says
 * the same in words.
 */
export function VoiceWave(
  props: Readonly<{ state: VoiceWaveState; level?: () => number }>,
): React.ReactNode {
  const { state, level } = props;
  const wave = React.useRef<HTMLSpanElement>(null);
  const live =
    state === "hearing" &&
    level !== undefined &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  React.useEffect(() => {
    const element = wave.current;
    if (!live || element === null || level === undefined) return;
    return followLevel(element, level);
  }, [live, level]);
  return (
    <span
      ref={wave}
      className="voice-wave"
      data-state={state}
      data-live={live ? "" : undefined}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/** A bar's resting height, as a share of the wave's height (styles.css). */
const REST = 0.25;
/** Each frame keeps this share of the last loudness, so the bars fall slowly. */
const RELEASE = 0.9;

/**
 * Each frame, each bar takes the loudness times its own peak, and sways at its
 * own pace so that the bars do not move as one. The style goes straight to the
 * element: no React render per frame.
 */
function followLevel(element: HTMLElement, level: () => number): () => void {
  const bars = [...element.children].filter(
    (bar): bar is HTMLElement => bar instanceof HTMLElement,
  );
  const shapes = bars.map((bar) => {
    const style = getComputedStyle(bar);
    return {
      peak: Number(style.getPropertyValue("--voice-wave-peak")) || 1,
      pace:
        Number.parseFloat(style.getPropertyValue("--voice-wave-pace")) || 500,
    };
  });
  let loudness = 0;
  let frame = requestAnimationFrame(function draw(time: number) {
    loudness = Math.max(level(), loudness * RELEASE);
    bars.forEach((bar, index) => {
      const { peak, pace } = shapes[index]!;
      const sway = 0.7 + 0.3 * Math.sin((time / pace) * 3 + index * 1.7);
      const scale = REST + (1 - REST) * loudness * peak * sway;
      bar.style.scale = `1 ${scale.toFixed(3)}`;
    });
    frame = requestAnimationFrame(draw);
  });
  return () => {
    cancelAnimationFrame(frame);
    for (const bar of bars) bar.style.removeProperty("scale");
  };
}
