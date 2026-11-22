import React from "react";
import { ChevronDown } from "lucide-react";
import "./agent-components.css";

export type MessageScrollerProps = {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly onEndReached?: () => void;
  readonly initialScrollTop?: number;
};

export class MessageScroller extends React.Component<
  MessageScrollerProps,
  { atEnd: boolean }
> {
  state = { atEnd: true };
  private readonly viewport = React.createRef<HTMLDivElement>();
  private readonly content = React.createRef<HTMLDivElement>();
  private observer: ResizeObserver | null = null;
  private following = true;

  componentDidMount(): void {
    this.observer = new ResizeObserver(this.contentChanged.bind(this));
    if (this.viewport.current) this.observer.observe(this.viewport.current);
    if (this.content.current) this.observer.observe(this.content.current);
    if (this.props.initialScrollTop === undefined) this.scrollToEnd();
    else if (this.viewport.current !== null) {
      this.following = false;
      this.viewport.current.scrollTop = this.props.initialScrollTop;
      this.updatePosition();
    }
  }

  scrollPosition(): number | undefined {
    return this.viewport.current?.scrollTop;
  }

  componentDidUpdate(): void {
    this.contentChanged();
  }

  componentWillUnmount(): void {
    this.observer?.disconnect();
  }

  isAtEnd(): boolean {
    const viewport = this.viewport.current;
    return (
      viewport !== null &&
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24
    );
  }

  scrollToEnd(): void {
    const viewport = this.viewport.current;
    if (viewport === null) return;
    this.following = true;
    viewport.scrollTop = viewport.scrollHeight;
    this.updatePosition();
  }

  private contentChanged(): void {
    if (this.following) this.scrollToEnd();
    else this.updatePosition();
  }

  private jumpToEnd(): void {
    this.viewport.current?.focus({ preventScroll: true });
    this.scrollToEnd();
  }

  private scrolled(): void {
    this.following = this.isAtEnd();
    this.updatePosition();
  }

  private updatePosition(): void {
    const atEnd = this.isAtEnd();
    if (atEnd !== this.state.atEnd) this.setState({ atEnd });
    if (atEnd) this.props.onEndReached?.();
  }

  render(): React.ReactNode {
    return (
      <div className={`message-scroller ${this.props.className ?? ""}`}>
        <div
          ref={this.viewport}
          className="message-scroller-viewport"
          role="region"
          aria-label={this.props.label}
          tabIndex={0}
          onScroll={this.scrolled.bind(this)}
        >
          <div
            ref={this.content}
            className={`message-scroller-content ${this.props.contentClassName ?? ""}`}
            role="log"
            aria-label={`${this.props.label} entries`}
            aria-live="polite"
            aria-relevant="additions"
          >
            {this.props.children}
          </div>
        </div>
        <div className="message-scroller-controls">
          <button
            type="button"
            aria-label="Latest messages"
            className="message-scroller-latest"
            data-visible={!this.state.atEnd}
            aria-hidden={this.state.atEnd}
            disabled={this.state.atEnd}
            tabIndex={this.state.atEnd ? -1 : 0}
            onClick={this.jumpToEnd.bind(this)}
          >
            <ChevronDown size={20} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
}
