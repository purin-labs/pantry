import React from "react";
import type { LiveSource } from "./live-value";

/**
 * Reads a coarse value of a live source: the component renders again only
 * when the selected value changes, not on each playback frame.
 */
export function useLive<T, S>(
  source: LiveSource<T>,
  select: (value: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
): S {
  const cache = React.useRef<{ value: S } | null>(null);
  function snapshot(): S {
    const next = select(source.get());
    const last = cache.current;
    if (last !== null && equal(last.value, next)) return last.value;
    cache.current = { value: next };
    return next;
  }
  return React.useSyncExternalStore(source.subscribe, snapshot);
}

/** Runs a DOM write now and after each change of the source, with no render. */
export function useLiveEffect<T>(
  source: LiveSource<T>,
  write: (value: T) => void,
): void {
  const latest = React.useRef(write);
  latest.current = write;
  // A render with new props writes again: the write can depend on them.
  React.useLayoutEffect(() => {
    latest.current(source.get());
  });
  React.useLayoutEffect(
    () => source.subscribe((value) => latest.current(value)),
    [source],
  );
}

type LiveTextProps<T> = Readonly<{
  source: LiveSource<T>;
  text: (value: T) => string;
  /** Attributes that follow the source too, for example a data attribute. */
  attributes?: (value: T) => Readonly<Record<string, string>>;
  as?: "span" | "output" | "dd" | "strong" | "p";
}> &
  Omit<React.HTMLAttributes<HTMLElement>, "children">;

/**
 * Text that follows a live source by a direct DOM write. React renders the
 * element one time and never its text, so a playback frame commits nothing.
 */
export function LiveText<T>(props: LiveTextProps<T>): React.ReactNode {
  const { source, text, attributes, as = "span", ...rest } = props;
  const element = React.useRef<HTMLElement>(null);
  useLiveEffect(source, (value) => {
    const node = element.current;
    if (node === null) return;
    const next = text(value);
    if (node.textContent !== next) node.textContent = next;
    for (const [name, attribute] of Object.entries(attributes?.(value) ?? {}))
      if (node.getAttribute(name) !== attribute)
        node.setAttribute(name, attribute);
  });
  return React.createElement(as, { ...rest, ref: element });
}

/** A class component's way to read a coarse live value. */
export function Live<T, S>(
  props: Readonly<{
    source: LiveSource<T>;
    select: (value: T) => S;
    equal?: (a: S, b: S) => boolean;
    children: (value: S) => React.ReactNode;
  }>,
): React.ReactNode {
  return props.children(useLive(props.source, props.select, props.equal));
}
