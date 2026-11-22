import React from "react";
import { Popover } from "@base-ui/react/popover";
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink, X } from "lucide-react";
import "./agent-components.css";

export type CitationSource = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly href: URL | null;
  readonly publisher?: string;
  readonly publishedAt?: string;
};

export type InlineCitationsProps = {
  readonly sources: readonly CitationSource[];
};

export function InlineCitations(
  props: InlineCitationsProps,
): React.ReactNode {
  const first = props.sources[0];
  if (first === undefined) return null;
  return (
    <Popover.Root>
      <Popover.Trigger
        className="inline-citations"
        aria-label={`Sources: ${props.sources.map(sourceLabel).join(", ")}`}
      >
        <BookOpen size={13} aria-hidden="true" />
        <span>{first.publisher ?? first.label}</span>
        {props.sources.length > 1 && (
          <span className="citation-count">+{props.sources.length - 1}</span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="citation-positioner"
        >
          <Popover.Popup className="citation-popup">
            <Popover.Title className="agent-ui-sr-only">Sources</Popover.Title>
            <CitationPages sources={props.sources} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

class CitationPages extends React.Component<
  InlineCitationsProps,
  { index: number; height: number | null }
> {
  state: { index: number; height: number | null } = { index: 0, height: null };
  private readonly pages = new Map<number, HTMLDivElement>();
  private observer: ResizeObserver | null = null;

  componentDidMount(): void {
    this.observer = new ResizeObserver(this.measure.bind(this));
    for (const page of this.pages.values()) this.observer.observe(page);
    this.measure();
  }
  componentDidUpdate(): void {
    this.measure();
  }
  componentWillUnmount(): void {
    this.observer?.disconnect();
  }
  private activeIndex(): number {
    return Math.max(
      0,
      Math.min(this.state.index, this.props.sources.length - 1),
    );
  }
  private registerPage(index: number, page: HTMLDivElement | null): void {
    const previous = this.pages.get(index);
    if (previous) this.observer?.unobserve(previous);
    if (page === null) this.pages.delete(index);
    else {
      this.pages.set(index, page);
      this.observer?.observe(page);
    }
  }
  private measure(): void {
    const page = this.pages.get(this.activeIndex());
    if (page === undefined) return;
    const height = page.offsetHeight;
    if (height !== this.state.height) this.setState({ height });
  }
  private navigate(offset: number): void {
    const index = this.activeIndex() + offset;
    if (index < 0 || index >= this.props.sources.length) return;
    this.setState({ index });
  }
  private keyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    this.navigate(event.key === "ArrowLeft" ? -1 : 1);
  }
  private renderPage(source: CitationSource, index: number): React.ReactNode {
    const active = this.activeIndex();
    return (
      <div
        key={source.id}
        ref={this.registerPage.bind(this, index)}
        className="citation-page"
        data-position={
          index === active ? "active" : index < active ? "before" : "after"
        }
        inert={index !== active}
        aria-hidden={index !== active}
      >
        {source.publisher && (
          <p className="citation-publisher">
            <BookOpen size={13} aria-hidden="true" />
            {source.publisher}
          </p>
        )}
        {source.href === null ? (
          <p className="citation-title">{source.label}</p>
        ) : (
          <a
            className="citation-title"
            href={source.href.href}
            target="_blank"
            rel="noreferrer"
          >
            {source.label}
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
        {source.description && (
          <p className="citation-description">{source.description}</p>
        )}
        {source.publishedAt && (
          <p className="citation-date">{source.publishedAt}</p>
        )}
      </div>
    );
  }
  render(): React.ReactNode {
    const index = this.activeIndex();
    return (
      <div onKeyDown={this.keyDown.bind(this)}>
        <div className="citation-heading">
          <div className="citation-navigation">
            <button
              type="button"
              aria-label="Previous source"
              aria-disabled={index === 0}
              tabIndex={index === 0 ? -1 : 0}
              onClick={this.navigate.bind(this, -1)}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next source"
              aria-disabled={index === this.props.sources.length - 1}
              tabIndex={index === this.props.sources.length - 1 ? -1 : 0}
              onClick={this.navigate.bind(this, 1)}
            >
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          </div>
          <span
            className="citation-page-count"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {index + 1}/{this.props.sources.length}
          </span>
          <Popover.Close className="citation-close" aria-label="Close sources">
            <X size={16} aria-hidden="true" />
          </Popover.Close>
        </div>
        <div
          className="citation-pages"
          style={{ height: this.state.height ?? undefined }}
        >
          {this.props.sources.map(this.renderPage.bind(this))}
        </div>
      </div>
    );
  }
}

function sourceLabel(source: CitationSource): string {
  return source.publisher ?? source.label;
}
