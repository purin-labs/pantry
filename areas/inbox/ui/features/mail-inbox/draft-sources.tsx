import React from "react";
import type {
  MailReplySource,
  MailReplySourceRecord,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import "./claim-trace.css";

/** The pages that a source's record opens. */
export type MailSourceLinks = Readonly<{
  orderHref: (orderId: string) => string;
  supplierHref: (supplierId: string) => string;
  memoryHref: (memoryId: string) => string;
}>;

type Segment = Readonly<{
  text: string;
  /** The sources whose words include this run. */
  numbers: readonly number[];
  /** The sources whose words end with this run. */
  ends: readonly number[];
  /** The claim with no source that holds this run, if any. */
  unsourced: string | null;
}>;

/** A sentence of the draft with a detail that no record supports. */
type UnsourcedRun = Readonly<{
  key: string;
  start: number;
  end: number;
}>;

type DraftBodyProps = Readonly<{
  body: string;
  sources: readonly MailReplySource[];
  active: number | null;
  showNumbers: boolean;
  /** Sentences with a detail that no record supports. */
  unsourced?: readonly UnsourcedRun[];
  /** The claim with no source that is in focus. */
  activeUnsourced?: string | null;
}>;

/**
 * The draft body, with each run of words that a record supports underlined.
 * The words of the active source are marked. Each run's source numbers show
 * only while the sources are open.
 */
export function MailDraftBody(props: DraftBodyProps): React.ReactNode {
  return (
    <div className="mail-draft-body">
      <DraftBodyMarks {...props} />
    </div>
  );
}

/** The marked text of a draft body, for a caller that owns the frame. */
export function DraftBodyMarks(props: DraftBodyProps): React.ReactNode {
  return (
    <>
      {draftSegments(props.body, props.sources, props.unsourced ?? []).map(
        (segment, index) =>
          segment.numbers.length === 0 ? (
            segment.unsourced === null ? (
              <React.Fragment key={index}>{segment.text}</React.Fragment>
            ) : (
              <mark
                key={index}
                className="mail-draft-unsourced"
                data-claim={segment.unsourced}
                data-active={
                  props.activeUnsourced === segment.unsourced
                    ? "true"
                    : undefined
                }
              >
                {segment.text}
              </mark>
            )
          ) : (
            <mark
              key={index}
              className="mail-draft-claim"
              data-sources={segment.numbers.join(" ")}
              data-active={
                props.active !== null && segment.numbers.includes(props.active)
                  ? "true"
                  : undefined
              }
            >
              {segment.text}
              {props.showNumbers && segment.ends.length > 0 ? (
                <sup className="mail-draft-claim-number">
                  {segment.ends.join(",")}
                </sup>
              ) : null}
            </mark>
          ),
      )}
    </>
  );
}

/**
 * The records the agent checked. Pointing at a source, or moving focus into
 * it, marks its words in the draft.
 */
export function MailDraftSources(
  props: Readonly<{
    sources: readonly MailReplySource[];
    active: number | null;
    links: MailSourceLinks;
    onActive: (number: number | null) => void;
  }>,
): React.ReactNode {
  if (props.sources.length === 0)
    return <p className="mail-inbox-note">The draft cites no records.</p>;
  return (
    <ol className="mail-sources" aria-label="Sources">
      {props.sources.map((source) => {
        const number = source.number;
        const activate =
          number === null ? undefined : props.onActive.bind(null, number);
        const clear =
          number === null ? undefined : props.onActive.bind(null, null);
        return (
          <li
            key={sourceKey(source.record)}
            className="mail-source"
            data-source-kind={source.record.kind}
            data-active={
              number !== null && number === props.active ? "true" : undefined
            }
            onMouseEnter={activate}
            onMouseLeave={clear}
            onFocus={activate}
            onBlur={clear}
          >
            <span className="mail-source-number" aria-hidden="true">
              {number ?? ""}
            </span>
            <span className="mail-source-text">
              <span>
                <strong>{source.title}</strong>
                <span className="mail-source-kind">
                  {" "}
                  · {sourceKindLabel(source.record)}
                </span>
              </span>
              {source.detail.length === 0 ? null : (
                <span className="mail-source-detail">{source.detail}</span>
              )}
              <a href={recordHref(props.links, source.record)}>
                {recordLinkLabel(source.record)}
              </a>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Splits the body where any span starts or ends. */
function draftSegments(
  body: string,
  sources: readonly MailReplySource[],
  unsourced: readonly UnsourcedRun[],
): readonly Segment[] {
  const spans = sources.flatMap((source) =>
    source.number === null
      ? []
      : source.spans.map((span) => ({ ...span, number: source.number })),
  );
  const cuts = [
    ...new Set([
      0,
      body.length,
      ...spans.flatMap((s) => [s.start, s.end]),
      ...unsourced.flatMap((run) => [run.start, run.end]),
    ]),
  ]
    .filter((cut) => cut >= 0 && cut <= body.length)
    .sort((left, right) => left - right);
  const segments: Segment[] = [];
  for (let index = 0; index + 1 < cuts.length; index++) {
    const start = cuts[index] ?? 0;
    const end = cuts[index + 1] ?? body.length;
    if (end <= start) continue;
    const covering = spans.filter(
      (span) => span.start <= start && end <= span.end,
    );
    segments.push({
      text: body.slice(start, end),
      numbers: uniqueNumbers(covering),
      ends: uniqueNumbers(covering.filter((span) => span.end === end)),
      unsourced:
        unsourced.find((run) => run.start <= start && end <= run.end)?.key ??
        null,
    });
  }
  return segments;
}

function uniqueNumbers(
  spans: readonly Readonly<{ number: number | null }>[],
): readonly number[] {
  return [
    ...new Set(
      spans.flatMap((span) => (span.number === null ? [] : [span.number])),
    ),
  ].sort((left, right) => left - right);
}

function sourceKey(record: MailReplySourceRecord): string {
  switch (record.kind) {
    case "order":
      return `order:${record.orderId}`;
    case "purchase_request":
      return `purchase_request:${record.purchaseRequestId}`;
    case "memory":
      return `memory:${record.memoryId}:${record.revision}`;
    default:
      return assertNever(record);
  }
}

export function sourceKindLabel(record: MailReplySourceRecord): string {
  switch (record.kind) {
    case "order":
      return "Order";
    case "purchase_request":
      return "Purchase request";
    case "memory":
      // The Portal names the page of memories "Knowledge".
      return "Memory";
    default:
      return assertNever(record);
  }
}

export function recordHref(
  links: MailSourceLinks,
  record: MailReplySourceRecord,
): string {
  switch (record.kind) {
    case "order":
      return links.orderHref(record.orderId);
    case "purchase_request":
      return links.supplierHref(record.supplierId);
    case "memory":
      return links.memoryHref(record.memoryId);
    default:
      return assertNever(record);
  }
}

export function recordLinkLabel(record: MailReplySourceRecord): string {
  switch (record.kind) {
    case "order":
      return "Open order";
    case "purchase_request":
      return "Open supplier";
    case "memory":
      return "Open in Knowledge";
    default:
      return assertNever(record);
  }
}
