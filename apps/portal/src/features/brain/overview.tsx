import React from "react";

import type { EvalView, MemoryView } from "@purin-labs/control-api";

import { isPrimaryNavigationClick } from "@purin-labs/ui/console-sidebar";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@purin-labs/ui/formatting";
import { EmptyState } from "@purin-labs/ui/page-components";
import type { KnowledgeState } from "./address";
import { openEvalCandidate } from "./evals-model";
import { KnowledgeRows, type KnowledgeLinks } from "./knowledge";
import { evalRow, memoryRow, type KnowledgeRow } from "./knowledge-model";
import type { LearningEvent } from "./learning-model";
import { openCandidate, overviewCounts } from "./model";
import type { SeenRecords } from "./seen";

/**
 * The present state in one sentence, then what waits for a decision.
 *
 * `toDecide` is how many items wait for this person. It is null while the
 * page does not know it.
 */
export function BrainOverview(props: {
  readonly memories: readonly MemoryView[];
  readonly evals: readonly EvalView[] | null;
  readonly toDecide: number | null;
  readonly canManage: boolean;
  /** The newest line of the learning log, or null when the log is empty. */
  readonly latest: LearningEvent | null;
  readonly seen: SeenRecords;
  readonly onSeen: (key: string, changedAt: number | null) => void;
  readonly links: KnowledgeLinks;
  readonly stateHref: (state: KnowledgeState) => string;
  readonly onState: (state: KnowledgeState) => void;
  readonly evalsHref: string;
  readonly onOpenEvals: () => void;
}): React.ReactNode {
  const counts = overviewCounts(props.memories);
  const evalsToReview =
    props.evals === null
      ? null
      : props.evals.filter((entry) => openEvalCandidate(entry) !== null).length;
  // What waits for a decision, of both kinds, the most recent change first.
  const waiting: KnowledgeRow[] = [];
  for (const memory of props.memories) {
    const row = openCandidate(memory) === null ? null : memoryRow(memory);
    if (row !== null) waiting.push(row);
  }
  for (const entry of props.evals ?? []) {
    const row = openEvalCandidate(entry) === null ? null : evalRow(entry);
    if (row !== null) waiting.push(row);
  }
  waiting.sort((left, right) => (right.changedAt ?? 0) - (left.changedAt ?? 0));
  return (
    <>
      <section className="brain-status" aria-labelledby="brain-status-line">
        {/* The rings are a quiet backdrop. They say nothing and do not move. */}
        <svg
          className="brain-status-rings"
          viewBox="-320 -320 640 640"
          aria-hidden="true"
        >
          <circle r="150" />
          <circle r="225" />
          <circle r="300" />
        </svg>
        <p className="brain-status-label">
          {statusLabel(props.toDecide, props.canManage)}
        </p>
        <h2 className="brain-status-line" id="brain-status-line">
          {statusLine(props.toDecide, props.canManage)}
        </h2>
        {props.latest === null ? null : (
          <p className="brain-status-latest">
            <span className="brain-status-latest-label">Latest</span>{" "}
            {props.latest.sentence}{" "}
            <time
              dateTime={new Date(props.latest.at).toISOString()}
              title={formatAbsoluteTime(props.latest.at)}
            >
              {formatRelativeTime(props.latest.at)}
            </time>
          </p>
        )}
      </section>
      <section aria-labelledby="brain-summary">
        <h2 className="visually-hidden" id="brain-summary">
          At a glance
        </h2>
        <ul className="brain-counts">
          <BrainCount
            label="Waiting for review"
            value={counts.needsReview}
            href={props.stateHref("review")}
            onOpen={() => props.onState("review")}
          />
          <BrainCount
            label="In use"
            value={counts.inUse}
            href={props.stateHref("in_use")}
            onOpen={() => props.onState("in_use")}
          />
          <BrainCount
            label="Not in use"
            value={counts.notInUse}
            href={props.stateHref("not_in_use")}
            onOpen={() => props.onState("not_in_use")}
          />
          {evalsToReview === null ? null : (
            <BrainCount
              label="Evals to review"
              value={evalsToReview}
              href={props.evalsHref}
              onOpen={props.onOpenEvals}
            />
          )}
        </ul>
      </section>
      <section className="brain-kind" aria-labelledby="brain-review">
        <h2 className="brain-kind-heading" id="brain-review">
          Waiting for review
          <span className="brain-kind-count">{waiting.length}</span>
        </h2>
        {waiting.length === 0 ? (
          <EmptyState
            title="Nothing to review"
            detail="A proposed memory or eval appears here. The agent does not use it until an owner or admin accepts it."
          />
        ) : (
          <KnowledgeRows
            label="Records that wait for review"
            rows={waiting}
            seen={props.seen}
            showKind
            links={props.links}
            onSeen={props.onSeen}
          />
        )}
      </section>
    </>
  );
}

function statusLabel(toDecide: number | null, canManage: boolean): string {
  if (toDecide === null || toDecide === 0) return "Now";
  return canManage ? "Waiting for you" : "Waiting for review";
}

function statusLine(toDecide: number | null, canManage: boolean): string {
  if (toDecide === null) return "Review status is unavailable.";
  if (toDecide === 0) return "Nothing awaits review.";
  if (!canManage) {
    return toDecide === 1
      ? "1 item awaits review by an owner or admin."
      : `${String(toDecide)} items await review by an owner or admin.`;
  }
  return toDecide === 1
    ? "1 item waits for your decision."
    : `${String(toDecide)} items wait for your decision.`;
}

function BrainCount(props: {
  readonly label: string;
  readonly value: number;
  readonly href: string;
  readonly onOpen: () => void;
}): React.ReactNode {
  return (
    <li>
      <a
        className="brain-count"
        href={props.href}
        onClick={(event) => {
          if (!isPrimaryNavigationClick(event)) return;
          event.preventDefault();
          props.onOpen();
        }}
      >
        <span className="brain-count-label">{props.label}</span>
        <span className="brain-count-value">{props.value}</span>
      </a>
    </li>
  );
}
