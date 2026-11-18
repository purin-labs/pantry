import React from "react";
import { LiveText, useLiveEffect } from "../production-run/shared/live";
import { PlaybackTimeContext } from "./simulator-playback";

export { PlaybackTimeContext };

/** The playback cursor of a timeline lane, moved by a style write on each frame. */
export function PlaybackCursor(
  props: Readonly<{ end: number }>,
): React.ReactNode {
  const time = React.useContext(PlaybackTimeContext);
  const cursor = React.useRef<HTMLSpanElement>(null);
  useLiveEffect(time, (seconds) => {
    if (cursor.current !== null)
      cursor.current.style.left = `${(seconds / props.end) * 100}%`;
  });
  return <span ref={cursor} className="workflow-cursor" />;
}

/** Text of the live playback time, written to the DOM on each frame. */
export function PlaybackTimeText(
  props: Readonly<{
    text: (seconds: number) => string;
    as?: "output" | "span" | "strong";
  }> &
    Omit<React.HTMLAttributes<HTMLElement>, "children">,
): React.ReactNode {
  const time = React.useContext(PlaybackTimeContext);
  return <LiveText source={time} {...props} />;
}

/**
 * A range input on the live playback time. Its thumb, its value text and its
 * progress fill follow the clock; a person's input seeks.
 */
export function PlaybackScrubber(
  props: Readonly<{
    end: number;
    valueText?: (seconds: number) => string;
    progressProperty?: string;
  }> &
    Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "type">,
): React.ReactNode {
  const { end, valueText, progressProperty, ...rest } = props;
  const time = React.useContext(PlaybackTimeContext);
  const input = React.useRef<HTMLInputElement>(null);
  useLiveEffect(time, (seconds) => {
    const node = input.current;
    if (node === null) return;
    node.value = String(seconds);
    if (valueText !== undefined)
      node.setAttribute("aria-valuetext", valueText(seconds));
    if (progressProperty !== undefined)
      node.style.setProperty(
        progressProperty,
        `${(seconds / Math.max(1, end)) * 100}%`,
      );
  });
  return <input ref={input} type="range" max={end} {...rest} />;
}

/** A playback time in seconds with two decimals, as the production shows it. */
export function secondsText(seconds: number): string {
  return seconds.toFixed(2);
}
