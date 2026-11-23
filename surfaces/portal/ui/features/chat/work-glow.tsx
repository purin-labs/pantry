import React from "react";
import { assertNever } from "@purin-labs/std";
import { VoiceBeam } from "voice-glow";
import type { ChatWork } from "@purin-labs/control-api/portal/chat";
import type { ChatStreamState } from "./delivery";
import "./work-glow.css";

type Props = Readonly<{
  work: ChatWork | null;
  stream: ChatStreamState;
  sending: boolean;
}>;

type Theme = "dark" | "light";

/** Decorative work feedback. The existing status text remains accessible. */
export class ChatWorkGlow extends React.Component<
  Props,
  { readonly theme: Theme }
> {
  state = { theme: readTheme() };
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  componentDidMount(): void {
    this.observer = new MutationObserver(this.updateTheme.bind(this));
    this.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-portal-theme"],
    });
    this.updateTheme();
    this.scheduleExpiry();
  }

  componentDidUpdate(previous: Props): void {
    if (previous.work !== this.props.work) this.scheduleExpiry();
  }

  componentWillUnmount(): void {
    this.observer?.disconnect();
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private updateTheme(): void {
    const theme = readTheme();
    if (theme !== this.state.theme) this.setState({ theme });
  }

  private scheduleExpiry(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const work = this.props.work;
    if (work?.kind === "running" && work.expiresAt > Date.now()) {
      this.timer = setTimeout(
        this.expire.bind(this),
        work.expiresAt - Date.now(),
      );
    }
  }

  private expire(): void {
    this.timer = null;
    this.forceUpdate();
  }

  render(): React.ReactNode {
    const active = workIsActive(this.props, Date.now());
    return (
      <VoiceBeam
        className="chat-work-glow"
        theme={this.state.theme}
        active={active}
        processing={active}
        level={0.06}
        borderRadius={22}
        aria-hidden="true"
      >
        <div className="chat-work-glow-shape" />
      </VoiceBeam>
    );
  }
}

function readTheme(): Theme {
  return document.documentElement.dataset.portalTheme === "dark"
    ? "dark"
    : "light";
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
