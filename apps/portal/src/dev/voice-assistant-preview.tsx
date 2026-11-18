import React from "react";
import { createRoot } from "react-dom/client";
import {
  VoiceAssistantCard,
  type VoiceAssistantState,
} from "../ui/voice-assistant-card";
import "../styles.css";
import "./voice-assistant-preview.css";

const transcript =
  "Find me a quiet café nearby with good wifi for this afternoon";
const words = transcript.split(" ");

type PreviewState = {
  readonly voice: VoiceAssistantState;
  readonly count: number;
  readonly theme: "dark" | "light";
};

class VoiceAssistantPreview extends React.Component<object, PreviewState> {
  state: PreviewState = {
    voice: { kind: "idle" },
    count: words.length,
    theme: "dark",
  };

  private timer = 0;
  private readonly toggle = this.toggleVoice.bind(this);
  private readonly reset = this.resetVoice.bind(this);
  private readonly switchTheme = this.toggleTheme.bind(this);
  private readonly nextWord = this.appendWord.bind(this);
  private readonly process = this.startProcessing.bind(this);
  private readonly finish = this.finishProcessing.bind(this);
  private readonly level = simulatedVoiceLevel;

  componentWillUnmount(): void {
    window.clearTimeout(this.timer);
  }

  private toggleVoice(): void {
    window.clearTimeout(this.timer);
    if (this.state.voice.kind === "listening") {
      this.setState({ count: words.length });
      this.startProcessing();
      return;
    }
    this.setState({
      voice: { kind: "listening", input: { kind: "level", level: this.level } },
      count: 0,
    });
    this.timer = window.setTimeout(this.nextWord, 400);
  }

  private appendWord(): void {
    const count = this.state.count + 1;
    this.setState({ count });
    if (count < words.length) {
      this.timer = window.setTimeout(this.nextWord, 280);
    } else {
      this.timer = window.setTimeout(this.process, 780);
    }
  }

  private startProcessing(): void {
    this.setState({ voice: { kind: "processing" } });
    this.timer = window.setTimeout(this.finish, 1800);
  }

  private finishProcessing(): void {
    this.setState({ voice: { kind: "idle" } });
  }

  private resetVoice(): void {
    window.clearTimeout(this.timer);
    this.setState({ voice: { kind: "idle" }, count: words.length });
  }

  private toggleTheme(): void {
    this.setState({ theme: this.state.theme === "dark" ? "light" : "dark" });
  }

  render(): React.ReactNode {
    return (
      <main className="voice-preview" data-theme={this.state.theme}>
        <header className="voice-preview-heading">
          <p>COMPONENT STUDY · 01</p>
          <h1>Voice assistant</h1>
          <p>A soft light that follows the voice.</p>
        </header>
        <div className="voice-preview-stage">
          <VoiceAssistantCard
            name="Aria"
            initials="AR"
            description="Voice assistant"
            message="How can I help you today?"
            transcript={
              <p aria-live="polite">
                {words.map(renderWord.bind(null, this.state.count))}
              </p>
            }
            state={this.state.voice}
            theme={this.state.theme}
            onToggle={this.toggle}
          />
        </div>
        <div className="voice-preview-controls">
          <button type="button" onClick={this.switchTheme}>
            {this.state.theme === "dark" ? "Light theme" : "Dark theme"}
          </button>
          <button type="button" onClick={this.reset}>
            Reset demo
          </button>
        </div>
        <p className="voice-preview-help">
          Press the voice button to play a simulated conversation.
          <br />
          Press it again to stop or restart. The demo uses no microphone.
        </p>
        <footer className="voice-preview-credit">
          Reference: <a href="https://transitions.dev/">Transitions.dev</a>
          <span> / </span>
          Glow: <a href="https://libraries.dev/">voice-glow</a> by Jakub Antalik
        </footer>
      </main>
    );
  }
}

function simulatedVoiceLevel(): number {
  const time = Date.now();
  const level =
    0.55 +
    Math.sin(time / 150) * 0.22 +
    Math.sin(time / 61) * 0.12 +
    Math.sin(time / 37) * 0.08;
  return Math.max(0.06, Math.min(1, level)) * 0.6;
}

function renderWord(
  count: number,
  word: string,
  index: number,
): React.ReactNode {
  return (
    <React.Fragment key={index}>
      <span
        className="voice-preview-word"
        data-visible={index < count}
        aria-hidden={index >= count}
      >
        {word}
      </span>
      {index < words.length - 1 ? " " : ""}
    </React.Fragment>
  );
}

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<VoiceAssistantPreview />);
