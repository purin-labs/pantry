import React from "react";
import { ChevronRight } from "lucide-react";

import { isPrimaryNavigationClick } from "../../console-sidebar";
import { formatAbsoluteTime } from "../../formatting";
import {
  learningEventLabel,
  type LearningEvent,
  type LearningFlow,
} from "./learning-model";

/** Where the parts of the Learning view lead. */
export type LearningLinks = Readonly<{
  /** The Knowledge list, limited to what is in use or not limited. */
  knowledgeHref: (inUse: boolean) => string;
  onOpenKnowledge: (inUse: boolean) => void;
  evalsHref: string;
  onOpenEvals: () => void;
  eventHref: (event: LearningEvent) => string;
  onOpenEvent: (event: LearningEvent) => void;
}>;

export const LEARNING_LOG_ID = "brain-learning-log";

const CARD_WIDTH = 264;
const CARD_HEIGHT = 64;
const CARD_GAP = 14;
/** The least and the greatest room between two columns of the flow. */
const MIN_COLUMN_GAP = 96;
const MAX_COLUMN_GAP = 300;
const MIN_FLOW_WIDTH = 3 * CARD_WIDTH + 2 * MIN_COLUMN_GAP;

type FlowCard = Readonly<{
  key: string;
  title: string;
  detail: string;
  /** Where the card leads, or null for a card that only states a count. */
  href: string | null;
  onOpen: (() => void) | null;
}>;

function records(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The top of each card of a column, with the column in the middle. */
function columnTops(cards: number, height: number): readonly number[] {
  const stack = cards * CARD_HEIGHT + (cards - 1) * CARD_GAP;
  const first = (height - stack) / 2;
  return Array.from(
    { length: cards },
    (_, index) => first + index * (CARD_HEIGHT + CARD_GAP),
  );
}

function curve(fromX: number, fromY: number, toX: number, toY: number): string {
  const bend = (toX - fromX) / 2;
  return `M ${String(fromX)} ${String(fromY)} C ${String(fromX + bend)} ${String(fromY)}, ${String(toX - bend)} ${String(toY)}, ${String(toX)} ${String(toY)}`;
}

/** The width that the flow has on the page, so that it can fit itself. */
function useElementWidth(): Readonly<{
  ref: React.RefObject<HTMLDivElement | null>;
  width: number | null;
}> {
  const ref = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Below this width the flow is a list: the curves need room to read. */
const FLOW_MIN_WIDTH = 640;

/**
 * How the agents learn, from the records: what they learned from at the
 * left, the stages of the loop in the middle, and what is in use at the
 * right. A log of the events is below.
 */
export function LearningView(
  props: LearningLinks &
    Readonly<{
      flow: LearningFlow;
      log: readonly LearningEvent[];
    }>,
): React.ReactNode {
  const { flow } = props;
  const sources: readonly FlowCard[] =
    flow.sources.length === 0
      ? [
          {
            key: "none",
            title: "No source yet",
            detail: "A correction of an email reply is the first source.",
            href: null,
            onOpen: null,
          },
        ]
      : flow.sources.map((source) => ({
          key: source.kind,
          title: source.label,
          detail: records(source.count, "record", "records"),
          href: props.knowledgeHref(false),
          onOpen: () => props.onOpenKnowledge(false),
        }));
  const stages: readonly FlowCard[] = [
    {
      key: "proposed",
      title: "Memories proposed",
      detail: records(flow.proposed, "version", "versions"),
      href: props.knowledgeHref(false),
      onOpen: () => props.onOpenKnowledge(false),
    },
    {
      key: "runs",
      title: "Eval runs",
      detail: records(flow.runs, "run", "runs"),
      href: props.evalsHref,
      onOpen: props.onOpenEvals,
    },
    {
      key: "decisions",
      title: "Decisions",
      detail: records(flow.decisions, "decision", "decisions"),
      href: `#${LEARNING_LOG_ID}`,
      onOpen: () => {
        const log = document.getElementById(LEARNING_LOG_ID);
        log?.scrollIntoView({ block: "start" });
        log?.focus({ preventScroll: true });
      },
    },
  ];
  const outputs: readonly FlowCard[] = [
    {
      key: "memories",
      title: "Memories in use",
      detail: records(flow.memoriesInUse, "memory", "memories"),
      href: props.knowledgeHref(true),
      onOpen: () => props.onOpenKnowledge(true),
    },
    {
      key: "evals",
      title: "Evals in use",
      detail: records(flow.evalsInUse, "eval", "evals"),
      href: props.evalsHref,
      onOpen: props.onOpenEvals,
    },
  ];
  const sourceCount = flow.sources.reduce(
    (sum, source) => sum + source.count,
    0,
  );
  const { ref, width } = useElementWidth();
  const asList = width !== null && width < FLOW_MIN_WIDTH;
  return (
    <section className="brain-learning" aria-labelledby="brain-learning">
      <h2 className="visually-hidden" id="brain-learning" tabIndex={-1}>
        Learning
      </h2>
      <dl className="brain-learning-stats">
        <div>
          <dt>Kinds of source</dt>
          <dd>{flow.sources.length}</dd>
        </div>
        <div>
          <dt>Records learned from</dt>
          <dd>{sourceCount}</dd>
        </div>
      </dl>
      <div ref={ref}>
        {asList ? (
          <div className="brain-flow-list">
            <FlowGroup label="Learned from" cards={sources} />
            <FlowGroup label="The loop" cards={stages} />
            <FlowGroup label="In use" cards={outputs} />
          </div>
        ) : (
          <FlowDiagram
            sources={sources}
            stages={stages}
            outputs={outputs}
            width={width ?? MIN_FLOW_WIDTH}
          />
        )}
      </div>
      <section className="brain-learning-log" aria-labelledby={LEARNING_LOG_ID}>
        <h3 className="brain-kind-heading" id={LEARNING_LOG_ID} tabIndex={-1}>
          Log
          <span className="brain-kind-count">{props.log.length}</span>
        </h3>
        {props.log.length === 0 ? (
          <p className="brain-kind-empty">
            Nothing is recorded yet. A proposal, a decision and an eval run each
            add a line.
          </p>
        ) : (
          <ol className="brain-log">
            {props.log.map((event) => (
              <li key={event.key}>
                <a
                  className="brain-log-row"
                  href={props.eventHref(event)}
                  onClick={(click) => {
                    if (!isPrimaryNavigationClick(click)) return;
                    click.preventDefault();
                    props.onOpenEvent(event);
                  }}
                >
                  <time
                    className="brain-log-time"
                    dateTime={new Date(event.at).toISOString()}
                  >
                    {formatAbsoluteTime(event.at)}
                  </time>
                  <span className="brain-log-kind">
                    {learningEventLabel(event.kind)}
                  </span>
                  <span className="brain-log-source">{event.source}</span>
                  <span className="brain-log-sentence">{event.sentence}</span>
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function FlowDiagram(props: {
  readonly sources: readonly FlowCard[];
  readonly stages: readonly FlowCard[];
  readonly outputs: readonly FlowCard[];
  /** The room on the page. The flow spreads over it, or shrinks to fit it. */
  readonly width: number;
}): React.ReactNode {
  const columnGap = Math.min(
    MAX_COLUMN_GAP,
    Math.max(MIN_COLUMN_GAP, (props.width - 3 * CARD_WIDTH) / 2),
  );
  const flowWidth = 3 * CARD_WIDTH + 2 * columnGap;
  const scale = Math.min(1, props.width / flowWidth);
  const rows = Math.max(
    props.sources.length,
    props.stages.length,
    props.outputs.length,
  );
  const height = rows * CARD_HEIGHT + (rows - 1) * CARD_GAP;
  const sourceTops = columnTops(props.sources.length, height);
  const stageTops = columnTops(props.stages.length, height);
  const outputTops = columnTops(props.outputs.length, height);
  const stageX = CARD_WIDTH + columnGap;
  const outputX = 2 * (CARD_WIDTH + columnGap);
  const middle = (top: number): number => top + CARD_HEIGHT / 2;
  const firstStage = stageTops[0] ?? 0;
  const lastStage = stageTops.at(-1) ?? 0;
  return (
    <div
      className="brain-flow"
      style={{ height: height * scale }}
      role="group"
      aria-label="The learning loop, from its sources to what is in use"
    >
      <div
        className="brain-flow-plane"
        style={{
          width: flowWidth,
          height,
          transform: `scale(${String(scale)})`,
        }}
      >
        {/* The curves are for the eye. Each card states its own count. */}
        <svg
          className="brain-flow-links"
          width={flowWidth}
          height={height}
          aria-hidden="true"
        >
          {sourceTops.map((top, index) => (
            <path
              key={`in:${String(index)}`}
              d={curve(CARD_WIDTH, middle(top), stageX, middle(firstStage))}
            />
          ))}
          {stageTops.slice(1).map((top, index) => (
            <path
              key={`step:${String(index)}`}
              d={`M ${String(stageX + CARD_WIDTH / 2)} ${String((stageTops[index] ?? 0) + CARD_HEIGHT)} L ${String(stageX + CARD_WIDTH / 2)} ${String(top)}`}
            />
          ))}
          {outputTops.map((top, index) => (
            <path
              key={`out:${String(index)}`}
              d={curve(
                stageX + CARD_WIDTH,
                middle(lastStage),
                outputX,
                middle(top),
              )}
            />
          ))}
        </svg>
        {props.sources.map((card, index) => (
          <FlowCardBox
            key={card.key}
            card={card}
            style={{ left: 0, top: sourceTops[index] }}
          />
        ))}
        {props.stages.map((card, index) => (
          <FlowCardBox
            key={card.key}
            card={card}
            style={{ left: stageX, top: stageTops[index] }}
          />
        ))}
        {props.outputs.map((card, index) => (
          <FlowCardBox
            key={card.key}
            card={card}
            style={{ left: outputX, top: outputTops[index] }}
          />
        ))}
      </div>
    </div>
  );
}

function FlowGroup(props: {
  readonly label: string;
  readonly cards: readonly FlowCard[];
}): React.ReactNode {
  return (
    <section>
      <h3 className="brain-kind-heading">{props.label}</h3>
      {props.cards.map((card) => (
        <FlowCardBox key={card.key} card={card} />
      ))}
    </section>
  );
}

function FlowCardBox(props: {
  readonly card: FlowCard;
  readonly style?: React.CSSProperties;
}): React.ReactNode {
  const { card } = props;
  const content = (
    <>
      <span className="brain-flow-card-text">
        <span className="brain-flow-card-title">{card.title}</span>
        <span className="brain-flow-card-detail">{card.detail}</span>
      </span>
      {card.href === null ? null : (
        <ChevronRight
          className="brain-row-chevron"
          size={16}
          strokeWidth={1.6}
          aria-hidden="true"
        />
      )}
    </>
  );
  const style = {
    ...props.style,
    ...(props.style === undefined
      ? {}
      : { width: CARD_WIDTH, height: CARD_HEIGHT }),
  };
  if (card.href === null || card.onOpen === null)
    return (
      <div className="brain-flow-card" style={style}>
        {content}
      </div>
    );
  const { onOpen } = card;
  return (
    <a
      className="brain-flow-card"
      style={style}
      href={card.href}
      onClick={(event) => {
        if (!isPrimaryNavigationClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      {content}
    </a>
  );
}
