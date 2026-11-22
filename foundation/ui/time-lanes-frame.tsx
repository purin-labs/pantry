import React from "react";

import { EmptyState, PageSkeleton, RecoverableError } from "./page-components";
import { Button } from "./button";
import {
  FitPeriod,
  PeriodPicker,
  type PeriodControl,
  type TimePeriod,
  type TimeRange,
} from "./time-lanes";
import { useLatestRead } from "./use-latest-read";

/**
 * What a page with a timeline shares: the toolbar stays in place while a period
 * loads, so a person can step through periods, and the loading, failed and empty
 * states sit under it. A list and its timeline change places with one switch.
 */

/** How the read of the period in view stands. */
export type TimeLanesStatus =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "loading"; label: string }>
  | Readonly<{ kind: "failed"; message: string; retry: () => void }>;

const READY: TimeLanesStatus = { kind: "ready" };

export function TimeLanesFrame(props: {
  /** A page's own class, for its place on that page. */
  readonly className?: string;
  readonly control: PeriodControl;
  /** The time now, if the period holds it. */
  readonly now: number | null;
  /** Lets the arrows pass today, for records that are still to come. */
  readonly future?: boolean;
  readonly status?: TimeLanesStatus;
  readonly range: TimeRange | null;
  readonly onFit: () => void;
  /** The figures at the end of the toolbar. */
  readonly summary: React.ReactNode;
  /** What needs attention, above the timeline. */
  readonly notices?: React.ReactNode;
  /** What explains the view, under the timeline. */
  readonly notes?: React.ReactNode;
  /** The words when the read holds nothing, and null when it holds something. */
  readonly empty: Readonly<{
    title: string;
    detail: string;
    action?: React.ReactNode;
  }> | null;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const { control, empty } = props;
  const status = props.status ?? READY;
  const ready = status.kind === "ready";
  return (
    <div
      className={`time-lanes-frame${props.className === undefined ? "" : ` ${props.className}`}`}
    >
      <div className="time-lanes-toolbar">
        <PeriodPicker
          control={control}
          now={props.now}
          {...(props.future === true ? { future: true } : {})}
        />
        {ready && empty === null ? (
          <FitPeriod
            span={control.period.span}
            fitted={props.range === null}
            onFit={props.onFit}
          />
        ) : null}
        {ready ? (
          <span className="time-lanes-summary">{props.summary}</span>
        ) : null}
      </div>
      {status.kind === "loading" ? (
        <PageSkeleton label={status.label} />
      ) : status.kind === "failed" ? (
        <RecoverableError
          message={status.message}
          action={<Button onClick={status.retry}>Try again</Button>}
        />
      ) : (
        <>
          {props.notices}
          {empty === null ? (
            props.children
          ) : (
            <EmptyState
              title={empty.title}
              detail={empty.detail}
              {...(empty.action === undefined ? {} : { action: empty.action })}
            />
          )}
          {props.notes}
        </>
      )}
    </div>
  );
}

/** A note beside a timeline: why a figure is missing, or what is cut off. */
export function TimeLanesNote(props: {
  readonly children: React.ReactNode;
}): React.ReactNode {
  return <p className="time-lanes-note">{props.children}</p>;
}

/** The start and the end of a period, in milliseconds. */
export type PeriodWindow = Readonly<{ from: number; to: number }>;

/**
 * Reads the period in view when it opens and on each change. An earlier answer
 * never replaces a later one. `read` keeps its identity while its inputs do.
 */
export function usePeriodRead<Value>(
  period: TimePeriod,
  read: (window: PeriodWindow, signal: AbortSignal) => Promise<Value>,
  words: Readonly<{
    loading: string;
    failed: string | ((cause: unknown) => string);
  }>,
): Readonly<{
  value: Value | null;
  /** The window that `value` answers; null until it has an answer. */
  window: PeriodWindow | null;
  status: TimeLanesStatus;
}> {
  const { from, to } = period;
  const readWindow = React.useCallback(
    async (signal: AbortSignal) => ({
      window: { from, to },
      value: await read({ from, to }, signal),
    }),
    [from, to, read],
  );
  const { read: answer, retry } = useLatestRead(readWindow);
  switch (answer.kind) {
    case "loading":
      return {
        value: null,
        window: null,
        status: { kind: "loading", label: words.loading },
      };
    case "failed":
      return {
        value: null,
        window: null,
        status: {
          kind: "failed",
          message:
            typeof words.failed === "string"
              ? words.failed
              : words.failed(answer.error),
          retry: () => void retry(),
        },
      };
    case "ready":
      return {
        value: answer.value.value,
        window: answer.value.window,
        status: READY,
      };
  }
}

/** Two ways to see one set of records, such as a list and its timeline. */
export function ViewSwitch<View extends string>(props: {
  /** What the group chooses: "Show stock as". */
  readonly label: string;
  readonly className?: string;
  readonly value: View;
  readonly views: readonly Readonly<{ view: View; name: string }>[];
  readonly onChange: (view: View) => void;
}): React.ReactNode {
  return (
    <span
      className={`time-lanes-spans${props.className === undefined ? "" : ` ${props.className}`}`}
      role="group"
      aria-label={props.label}
    >
      {props.views.map(({ view, name }) => (
        <button
          key={view}
          type="button"
          aria-pressed={props.value === view}
          onClick={() => props.onChange(view)}
        >
          {name}
        </button>
      ))}
    </span>
  );
}
