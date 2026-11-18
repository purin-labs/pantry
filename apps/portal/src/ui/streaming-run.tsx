import React from "react";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type Props = { readonly text: string; readonly streaming: boolean };

// Animate only appended graphemes. The browser interpolates between arrivals;
// React never drives animation frames or replays the already-visible prefix.
export class StreamingRun extends React.Component<
  Props,
  { settledText: string | null }
> {
  state = { settledText: this.props.streaming ? null : this.props.text };
  private root = React.createRef<HTMLSpanElement>();
  private previousText = "";
  private nextStart = 0;
  private mounted = false;

  componentDidMount(): void {
    this.mounted = true;
    this.reveal();
  }
  componentDidUpdate(previous: Props): void {
    if (previous.text === this.props.text) return;
    if (previous.streaming || this.props.streaming) this.reveal();
    else {
      this.previousText = this.props.text;
      this.settle(this.props.text);
    }
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }

  private settle(text: string): void {
    if (this.mounted && this.props.text === text)
      this.setState({ settledText: text });
  }

  private reveal(): void {
    const root = this.root.current;
    const text = this.props.text;
    const previous = Array.from(graphemes.segment(this.previousText));
    const current = Array.from(graphemes.segment(text));
    this.previousText = text;
    if (!root || this.state.settledText === text) return;
    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      root.closest('[data-agent-preview-motion="reduced"]')
    ) {
      this.settle(text);
      return;
    }
    let start = 0;
    while (
      start < previous.length &&
      start < current.length &&
      previous[start]?.segment === current[start]?.segment
    )
      start += 1;
    const now = performance.now();
    const factor = root.closest('[data-agent-preview-motion="slow"]') ? 10 : 1;
    const interval =
      Math.min(8, 160 / Math.max(1, current.length - start)) * factor;
    this.nextStart = Math.max(
      now,
      Math.min(this.nextStart, now + 120 * factor),
    );
    const ink = getComputedStyle(root).color;
    const finished: Promise<unknown>[] = [];
    for (const [index, character] of [...root.children].entries()) {
      if (index >= start) {
        for (const animation of character.getAnimations()) animation.cancel();
        character.animate(
          [
            { opacity: 0, color: "#b8d9ff", offset: 0 },
            { opacity: 0.55, color: "#b4a3f4", offset: 0.3 },
            { opacity: 0.88, color: "#be668f", offset: 0.65 },
            { opacity: 1, color: ink, offset: 1 },
          ],
          {
            duration: 420 * factor,
            delay: this.nextStart - now,
            easing: "linear",
            fill: "backwards",
          },
        );
        this.nextStart += interval;
      }
      for (const animation of character.getAnimations())
        finished.push(animation.finished.catch(ignoreCancelledReveal));
    }
    void Promise.all(finished).then(this.settle.bind(this, text));
  }

  render(): React.ReactNode {
    return (
      <span ref={this.root} className="streaming-run">
        {this.state.settledText === this.props.text
          ? this.props.text
          : Array.from(graphemes.segment(this.props.text)).map(renderGrapheme)}
      </span>
    );
  }
}

function renderGrapheme(part: Intl.SegmentData): React.ReactNode {
  return <span key={part.index}>{part.segment}</span>;
}
function ignoreCancelledReveal(): void {}
