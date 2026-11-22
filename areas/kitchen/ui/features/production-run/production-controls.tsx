import type React from "react";
import type {
  ArrivalView,
  DrainStatus,
  HostView,
} from "@purin-labs/production-simulation";
import { assertNever } from "@purin-labs/std";
import { seconds } from "./oven-logistics";

type Props = Readonly<{
  view: HostView;
  enabled: boolean;
  closeArrivals(source: string): void;
}>;
export function ProductionControls(props: Props): React.ReactNode {
  if (props.view.production.kind === "unavailable") return null;
  return (
    <section aria-label="Arrival and drain controls">
      <h3>Arrivals and drain</h3>
      <p>{drainDescription(props.view.production.drain)}</p>
      <p>
        Pause to review arrival closure. Closing a source stops future arrivals
        at the next committed tick. Existing orders and tray returns continue
        when you resume.
      </p>
      <ul>
        {props.view.production.arrivals.map(arrivalRow.bind(null, props))}
      </ul>
    </section>
  );
}
function arrivalRow(props: Props, source: ArrivalView): React.ReactNode {
  return (
    <li key={source.id} data-arrival-source={source.id}>
      {source.id}: {source.kind}; {source.next} arrivals admitted.
      {source.kind === "open" && (
        <>
          <p>
            Keep all admitted orders. Stop future orders from this source, then
            resume to drain the factory.
          </p>
          <button
            disabled={!props.enabled}
            onClick={props.closeArrivals.bind(null, source.id)}
          >
            Confirm close {source.id}
          </button>
        </>
      )}
    </li>
  );
}
function drainDescription(drain: DrainStatus): string {
  switch (drain.kind) {
    case "drained":
      return `Factory drained at ${seconds(drain.at)} seconds. No open arrivals, unfinished orders, or bound trays remain.`;
    case "draining":
      return `${drain.openSources.length} open arrival sources, ${drain.openInstances.length} unfinished instances, and ${drain.boundCarriers.length} bound or moving trays remain.`;
    case "blocked":
      return `Drain is blocked by ${drain.tasks.join(", ")}. Inspect these tasks before continuing.`;
    default:
      return assertNever(drain);
  }
}
