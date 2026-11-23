import React from "react";
import { assertNever } from "@purin-labs/std";
import type { ChatWork } from "@purin-labs/control-api/portal/chat";
import type {
  VoiceSession,
  VoiceStatus,
} from "@purin-labs/surface-voice/ui/features/voice/session";
import type { ChatStreamState } from "./delivery";
import "./composer-glow.css";

type Props = Readonly<{
  work: ChatWork | null;
  stream: ChatStreamState;
  sending: boolean;
  /** Read only. The glow never starts the microphone or loads a model. */
  voice: VoiceSession;
}>;

/** What the composer's edge says about voice control. */
type VoiceGlow = "off" | "listening" | "hearing" | "transcribing";

/**
 * The composer's edge. A ring breathes while voice control listens for the
 * wake phrase, a halo glows while it hears a command, and a light crosses the
 * edge while a command is transcribed or the agent works. Decorative: the
 * voice status line and the send button say the same in words.
 */
export function ComposerGlow(props: Props): React.ReactNode {
  const status = React.useSyncExternalStore(
    props.voice.subscribe,
    props.voice.status,
  );
  const working = useWorkIsActive(props);
  return (
    <div
      className="composer-glow"
      data-voice={voiceGlow(status)}
      data-work={working ? "on" : "off"}
      aria-hidden="true"
    >
      <span className="composer-glow-halo" />
      <span className="composer-glow-ring" />
      <span className="composer-glow-sweep" />
    </div>
  );
}

function voiceGlow(status: VoiceStatus): VoiceGlow {
  switch (status.kind) {
    case "listening":
      return "listening";
    case "capturing":
      return "hearing";
    case "transcribing":
      return "transcribing";
    // The status line explains each of these. The edge stays still.
    case "off":
    case "starting":
    case "needs_tap":
    case "blocked":
      return "off";
    default:
      return assertNever(status, "Unknown voice status");
  }
}

/** A running turn without a stream ends at its lease, so the glow ends then too. */
function useWorkIsActive(props: Props): boolean {
  const [, expire] = React.useReducer((count: number) => count + 1, 0);
  const expiresAt =
    props.work?.kind === "running" ? props.work.expiresAt : null;
  React.useEffect(() => {
    if (expiresAt === null || expiresAt <= Date.now()) return;
    const timer = setTimeout(expire, expiresAt - Date.now());
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return workIsActive(props, Date.now());
}

function workIsActive(props: Props, now: number): boolean {
  const { work, stream, sending } = props;
  if (sending) return true;
  if (work === null) return false;
  switch (work.kind) {
    case "ready":
    case "failed":
    case "cancelling":
    case "awaiting_permission":
      return false;
    case "running":
      if (work.expiresAt <= now) return false;
      if (stream.kind === "idle" || stream.requestId !== work.requestId)
        return true;
      switch (stream.kind) {
        case "active":
        case "reconnecting":
          return true;
        case "failed":
        case "paused":
          return false;
        default:
          return assertNever(stream, "Unknown chat stream state");
      }
    default:
      return assertNever(work, "Unknown chat work state");
  }
}
