import React from "react";

export function ThreadTitle({
  title,
}: {
  readonly title: string;
}): React.ReactNode {
  const viewport = React.useRef<HTMLSpanElement>(null);
  React.useEffect(observeTitle.bind(null, viewport), [title]);
  return (
    <span className="chat-title-viewport" ref={viewport} title={title}>
      <span className="chat-title-text">{title}</span>
    </span>
  );
}

function measureTitle(viewport: HTMLSpanElement): void {
  const text = viewport.firstElementChild;
  if (!(text instanceof HTMLElement)) return;
  // A sidebar row gives the viewport a left padding that the title slides into.
  const inset = parseFloat(getComputedStyle(viewport).paddingInlineStart) || 0;
  const overflow = Math.max(0, text.scrollWidth + inset - viewport.clientWidth);
  viewport.dataset.overflow = String(overflow > 0);
  viewport.style.setProperty("--title-travel", `${-(overflow + 24)}px`);
  viewport.style.setProperty(
    "--title-duration",
    `${Math.max(2, overflow / 35)}s`,
  );
}

function observeTitle(
  ref: React.RefObject<HTMLSpanElement | null>,
): (() => void) | undefined {
  const viewport = ref.current;
  if (viewport === null) return;
  const observer = new ResizeObserver(measureTitle.bind(null, viewport));
  observer.observe(viewport);
  if (viewport.firstElementChild !== null)
    observer.observe(viewport.firstElementChild);
  measureTitle(viewport);
  return observer.disconnect.bind(observer);
}
