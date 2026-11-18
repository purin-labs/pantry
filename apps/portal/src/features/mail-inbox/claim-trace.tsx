import React from "react";
import type { MailReplySource } from "@seams/control-api";
import {
  recordHref,
  recordLinkLabel,
  sourceKindLabel,
  type MailSourceLinks,
} from "./draft-sources";

/**
 * One claim of a reply draft: a run of words that a record supports, or a
 * sentence with a detail (a number, a day, a price, "free") that no record
 * supports. The second kind has no numbers.
 */
export type DraftClaim = Readonly<{
  key: string;
  start: number;
  end: number;
  text: string;
  /** The numbered sources that support the words. */
  numbers: readonly number[];
}>;

/** What the person points at: one claim, or one source and all its words. */
export type ClaimFocus =
  | Readonly<{ kind: "claim"; key: string }>
  | Readonly<{ kind: "source"; number: number }>;

/**
 * The claims of a draft, in the order of their words. Each cited span is a
 * claim. The words of a sentence outside its cited spans that state a detail
 * are a claim with no source: the reviewer checks it before approval.
 */
export function draftClaims(
  body: string,
  sources: readonly MailReplySource[],
): readonly DraftClaim[] {
  const cited = new Map<
    string,
    { start: number; end: number; numbers: Set<number> }
  >();
  for (const source of sources) {
    if (source.number === null) continue;
    for (const span of source.spans) {
      if (span.start < 0 || span.end > body.length || span.end <= span.start)
        continue;
      const key = `${String(span.start)}:${String(span.end)}`;
      const claim = cited.get(key) ?? {
        start: span.start,
        end: span.end,
        numbers: new Set<number>(),
      };
      claim.numbers.add(source.number);
      cited.set(key, claim);
    }
  }
  const claims: DraftClaim[] = [...cited.entries()].map(([key, claim]) => ({
    key,
    start: claim.start,
    end: claim.end,
    text: body.slice(claim.start, claim.end),
    numbers: [...claim.numbers].sort((left, right) => left - right),
  }));
  const spans = [...claims];
  for (const sentence of sentences(body)) {
    if (!hasDetail(sentence.text)) continue;
    for (const run of uncited(body, sentence, spans))
      if (hasDetail(run.text))
        claims.push({ key: String(run.start), ...run, numbers: [] });
  }
  return claims.sort((left, right) => left.start - right.start);
}

/**
 * The parts of a sentence outside its cited spans, without the joining
 * punctuation and conjunctions at their edges.
 */
function uncited(
  body: string,
  sentence: Run,
  spans: readonly DraftClaim[],
): readonly Run[] {
  const inside = spans
    .filter((span) => span.start < sentence.end && sentence.start < span.end)
    .sort((left, right) => left.start - right.start);
  const runs: Run[] = [];
  let from = sentence.start;
  for (const span of [...inside, { start: sentence.end, end: sentence.end }]) {
    const raw = body.slice(from, Math.max(from, span.start));
    const lead = raw.match(EDGE_START)?.[0].length ?? 0;
    const text = raw.slice(lead).replace(EDGE_END, "");
    if (text.length > 0)
      runs.push({ start: from + lead, end: from + lead + text.length, text });
    from = Math.max(from, span.end);
  }
  return runs;
}

const EDGE_START = /^[\s,;:–—-]*(?:(?:and|but|so|or)\b[\s,]*)?/i;
const EDGE_END = /[\s,;:–—-]*(?:\b(?:and|but|so|or))?[\s,;:–—-]*$/i;

/**
 * The sources of `original`, moved to where their words are in `body`. A
 * span whose words are gone is left out, and so is a source with no span.
 * The numbers stay, so a source keeps its number while the person edits.
 */
export function relocateSources(
  original: string,
  sources: readonly MailReplySource[],
  body: string,
): readonly MailReplySource[] {
  if (original === body) return sources;
  return sources.flatMap((source) => {
    if (source.number === null) return [source];
    const spans = source.spans.flatMap((span) => {
      const words = original.slice(span.start, span.end);
      const start = nearest(body, words, span.start);
      return start < 0 ? [] : [{ start, end: start + words.length }];
    });
    return spans.length === 0 ? [] : [{ ...source, spans }];
  });
}

function nearest(body: string, words: string, from: number): number {
  if (words.length === 0) return -1;
  let best = -1;
  for (
    let index = body.indexOf(words);
    index >= 0;
    index = body.indexOf(words, index + 1)
  )
    if (best < 0 || Math.abs(index - from) < Math.abs(best - from))
      best = index;
  return best;
}

type Run = Readonly<{ start: number; end: number; text: string }>;

/** The sentences of a body, with their offsets. Quoted lines are left out. */
function sentences(body: string): readonly Run[] {
  const runs: Run[] = [];
  for (const match of body.matchAll(/[^.!?\n]+(?:[.!?]+|$)/gm)) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length === 0) continue;
    const start = match.index + lead;
    const lineStart = body.lastIndexOf("\n", start - 1) + 1;
    if (
      body
        .slice(lineStart, start + 1)
        .trimStart()
        .startsWith(">")
    )
      continue;
    runs.push({ start, end: start + text.length, text });
  }
  return runs;
}

const ADDRESSES = /\S+@\S+|https?:\/\/\S+|\+?\d[\d ()-]{7,}\d/g;
const DETAIL =
  /\d|[¥$€£%]|\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\b(?:today|tonight|tomorrow|free|guaranteed?|refund(?:ed)?|discount(?:ed)?)\b/i;

/** A request asks for a detail; it does not state one. */
const ASKS = /^(?:please|could|can|would|will you|let us know|let me know)\b/i;

/**
 * True when a sentence states a detail that a customer can hold the shop to.
 * Addresses, links and telephone numbers are not details.
 */
function hasDetail(text: string): boolean {
  if (text.endsWith("?") || ASKS.test(text)) return false;
  return DETAIL.test(text.replace(ADDRESSES, " "));
}

/** The source whose words the draft marks for the focus. */
export function focusNumber(
  focus: ClaimFocus | null,
  claims: readonly DraftClaim[],
): number | null {
  if (focus === null) return null;
  if (focus.kind === "source") return focus.number;
  return claims.find((claim) => claim.key === focus.key)?.numbers[0] ?? null;
}

/** One line that counts the claims, and the button that opens the trace. */
export function ClaimSummary(
  props: Readonly<{
    claims: readonly DraftClaim[];
    open: boolean;
    controls: string;
    onToggle: () => void;
  }>,
): React.ReactNode {
  const total = props.claims.length;
  if (total === 0) return null;
  const sourced = props.claims.filter(
    (claim) => claim.numbers.length > 0,
  ).length;
  const unsourced = total - sourced;
  return (
    <div className="mail-claim-summary">
      <p data-unsourced={unsourced > 0 ? "true" : undefined}>
        {summaryText(total, sourced)}
      </p>
      <button
        type="button"
        aria-expanded={props.open}
        aria-controls={props.controls}
        onClick={props.onToggle}
      >
        {props.open ? "Hide sources" : "Show sources"}
      </button>
    </div>
  );
}

function summaryText(total: number, sourced: number): string {
  if (sourced === total)
    return total === 1
      ? "The claim has a source."
      : `All ${String(total)} claims have a source.`;
  if (sourced === 0)
    return total === 1
      ? "The claim has no source. Check it before you approve."
      : `No claim has a source. Check all ${String(total)} before you approve.`;
  const missing = total - sourced;
  const count = `${String(sourced)} of ${String(total)} claims have a source.`;
  return missing === 1
    ? `${count} Check the one without a source.`
    : `${count} Check the ${String(missing)} without a source.`;
}

type Line = Readonly<{
  key: string;
  d: string;
  x: number;
  y: number;
  unsourced: boolean;
}>;

/**
 * The claims of a draft beside the records that support them. A curved line
 * joins each claim to its record. A claim with no source joins a marked card
 * that asks the person to check it. Pointing at a claim lights its record,
 * and pointing at a record lights its claims.
 */
export function ClaimTrace(
  props: Readonly<{
    id: string;
    claims: readonly DraftClaim[];
    sources: readonly MailReplySource[];
    /** Null where the records have no page to open, such as a preview. */
    links: MailSourceLinks | null;
    focus: ClaimFocus | null;
    onFocus: (focus: ClaimFocus | null) => void;
    /** The action on a claim with no source, or null when there is none. */
    unsourcedAction: Readonly<{
      label: string;
      run: (claim: DraftClaim) => void;
    }> | null;
  }>,
): React.ReactNode {
  const root = React.useRef<HTMLDivElement>(null);
  const [lines, setLines] = React.useState<readonly Line[]>([]);
  const cited = props.sources
    .filter((source) => source.number !== null)
    .sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  const unsourced = props.claims.filter((claim) => claim.numbers.length === 0);
  const focus = props.focus;
  const claimLit = (claim: DraftClaim): boolean =>
    focus !== null &&
    (focus.kind === "claim"
      ? focus.key === claim.key
      : claim.numbers.includes(focus.number));
  const sourceLit = (number: number): boolean =>
    focus !== null &&
    (focus.kind === "source"
      ? focus.number === number
      : props.claims.some(
          (claim) => claim.key === focus.key && claim.numbers.includes(number),
        ));

  const measure = React.useCallback((): void => {
    const element = root.current;
    if (element === null) return;
    const frame = element.getBoundingClientRect();
    const anchor = (selector: string): DOMRect | null =>
      element.querySelector(selector)?.getBoundingClientRect() ?? null;
    const next: Line[] = [];
    for (const claim of props.claims) {
      const from = anchor(`[data-trace-claim="${claim.key}"]`);
      if (from === null) continue;
      const targets =
        claim.numbers.length === 0
          ? [`u:${claim.key}`]
          : claim.numbers.map((number) => `n:${String(number)}`);
      for (const target of targets) {
        const to = anchor(`[data-trace-record="${target}"]`);
        if (to === null) continue;
        const x1 = from.right - frame.left;
        const y1 = from.top + from.height / 2 - frame.top;
        const x2 = to.left - frame.left;
        const y2 = to.top + Math.min(to.height / 2, 28) - frame.top;
        const bend = Math.max((x2 - x1) / 2, 12);
        next.push({
          key: `${claim.key}>${target}`,
          d: `M${f(x1)} ${f(y1)} C${f(x1 + bend)} ${f(y1)} ${f(x2 - bend)} ${f(y2)} ${f(x2)} ${f(y2)}`,
          x: x1,
          y: y1,
          unsourced: claim.numbers.length === 0,
        });
      }
    }
    setLines((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, [props.claims]);

  React.useLayoutEffect(measure);
  React.useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  const litLine = (line: Line): boolean => {
    if (focus === null) return false;
    const [claimKey, target] = line.key.split(">");
    if (focus.kind === "claim") return focus.key === claimKey;
    return target === `n:${String(focus.number)}`;
  };
  const point = (next: ClaimFocus) => ({
    onMouseEnter: () => {
      props.onFocus(next);
    },
    onMouseLeave: () => {
      props.onFocus(null);
    },
    onFocus: () => {
      props.onFocus(next);
    },
    onBlur: () => {
      props.onFocus(null);
    },
  });

  return (
    <div className="mail-trace" id={props.id} ref={root}>
      <svg className="mail-trace-lines" aria-hidden="true">
        {lines.map((line) => {
          const lit = litLine(line);
          return (
            <g
              key={line.key}
              className="mail-trace-line"
              data-unsourced={line.unsourced ? "true" : undefined}
              data-lit={lit ? "true" : undefined}
            >
              <path d={line.d} />
              <circle cx={line.x} cy={line.y} r={3} />
            </g>
          );
        })}
      </svg>
      <ol className="mail-trace-claims" aria-label="Claims in the draft">
        {props.claims.map((claim) => (
          <li
            key={claim.key}
            className="mail-trace-claim"
            data-trace-claim={claim.key}
            data-unsourced={claim.numbers.length === 0 ? "true" : undefined}
            data-lit={claimLit(claim) ? "true" : undefined}
            tabIndex={0}
            {...point({ kind: "claim", key: claim.key })}
          >
            <q>{claim.text}</q>
            <span className="mail-trace-claim-refs">
              {claim.numbers.length === 0
                ? "No source"
                : claim.numbers.map((number) => (
                    <span key={number} className="mail-source-number">
                      {number}
                    </span>
                  ))}
            </span>
          </li>
        ))}
      </ol>
      <ul className="mail-trace-records" aria-label="Records behind the claims">
        {cited.map((source) => {
          const number = source.number ?? 0;
          return (
            <li
              key={number}
              className="mail-trace-record"
              data-trace-record={`n:${String(number)}`}
              data-source-kind={source.record.kind}
              data-lit={sourceLit(number) ? "true" : undefined}
              {...point({ kind: "source", number })}
            >
              <span className="mail-trace-record-head">
                <span className="mail-source-number">{number}</span>
                <span className="mail-trace-record-kind">
                  {sourceKindLabel(source.record)}
                </span>
              </span>
              <strong>{source.title}</strong>
              {source.detail.length === 0 ? null : (
                <span className="mail-trace-record-detail">
                  {source.detail}
                </span>
              )}
              {props.links === null ? null : (
                <a href={recordHref(props.links, source.record)}>
                  {recordLinkLabel(source.record)}
                </a>
              )}
            </li>
          );
        })}
        {unsourced.map((claim) => (
          <li
            key={claim.key}
            className="mail-trace-record"
            data-trace-record={`u:${claim.key}`}
            data-unsourced="true"
            data-lit={claimLit(claim) ? "true" : undefined}
            {...point({ kind: "claim", key: claim.key })}
          >
            <strong>No record supports this claim</strong>
            <span className="mail-trace-record-detail">
              Check it, or change it before you approve.
            </span>
            {props.unsourcedAction === null ? null : (
              <button
                type="button"
                onClick={props.unsourcedAction.run.bind(null, claim)}
              >
                {props.unsourcedAction.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function f(value: number): string {
  return value.toFixed(1);
}
