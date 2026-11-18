import React from "react";
import { Pause, Play } from "lucide-react";

type PlaybackToggleProps = {
  readonly playing: boolean;
  readonly playLabel: string;
  readonly pauseLabel: string;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
};

// Both labels share one grid cell, so the button keeps the wider width and the
// transport controls beside it stay put while the icon and label swap.
export function PlaybackToggle(props: PlaybackToggleProps): React.ReactNode {
  return (
    <button
      className="primary-button playback-toggle"
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      <span className="playback-toggle-icons" aria-hidden="true">
        <Play data-visible={!props.playing} />
        <Pause data-visible={props.playing} />
      </span>
      <span className="playback-toggle-labels">
        <span data-visible={!props.playing} aria-hidden={props.playing}>
          {props.playLabel}
        </span>
        <span data-visible={props.playing} aria-hidden={!props.playing}>
          {props.pauseLabel}
        </span>
      </span>
    </button>
  );
}
