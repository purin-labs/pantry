import type {
  ResourceHistoryView,
  ResourceInterval,
  ResourceUsage,
} from "@seams/production-simulation";
import type React from "react";
import { seconds, type TaskSelection } from "./oven-logistics";

type Props = TaskSelection & Readonly<{ view: ResourceHistoryView }>;

export function OvenResourceHistory(props: Props): React.ReactNode {
  const { view } = props;
  if (view.kind === "unavailable")
    return (
      <p>This retained execution build does not expose resource history.</p>
    );
  return (
    <section aria-label="Resource history" data-time={view.through}>
      <h3>Resource history</h3>
      <p>
        Accepted claims from {seconds(view.after)} to {seconds(view.through)}{" "}
        seconds. Released claims remain in history.
      </p>
      <p>
        Capacity time uses unit-seconds: two capacity units held for three
        seconds equal six unit-seconds. Claimed share divides occupied,
        reserved, and held time by total capacity time.
      </p>
      <p>
        The resource state table classifies unallocated capacity. Admission
        withholding appears separately and can overlap occupied time. Worker
        approach travel and task handling follow the recipe’s declared timing.
      </p>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Capacity accounting"
      >
        <table className="oven-workspace-cells">
          <caption>Capacity accounting (unit-seconds)</caption>
          <thead>
            <tr>
              <th>Resource</th>
              <th>Total</th>
              <th>Occupied</th>
              <th>Reserved</th>
              <th>Held</th>
              <th>Unallocated</th>
              <th>Admission withheld</th>
              <th>Claimed share</th>
            </tr>
          </thead>
          <tbody>{view.resources.map(usageRow)}</tbody>
        </table>
      </div>
      {view.resources.map(resourceDetails.bind(null, props))}
    </section>
  );
}

function amount(value: number): string {
  return value.toFixed(3);
}

function usageRow(resource: ResourceUsage): React.ReactNode {
  return (
    <tr key={resource.resource} data-resource-usage={resource.resource}>
      <td>{resource.resource}</td>
      <td
        data-metric="capacityUnitSeconds"
        data-value={resource.capacityUnitSeconds}
      >
        {amount(resource.capacityUnitSeconds)}
      </td>
      <td
        data-metric="occupiedUnitSeconds"
        data-value={resource.occupiedUnitSeconds}
      >
        {amount(resource.occupiedUnitSeconds)}
      </td>
      <td
        data-metric="reservedUnitSeconds"
        data-value={resource.reservedUnitSeconds}
      >
        {amount(resource.reservedUnitSeconds)}
      </td>
      <td data-metric="heldUnitSeconds" data-value={resource.heldUnitSeconds}>
        {amount(resource.heldUnitSeconds)}
      </td>
      <td
        data-metric="unallocatedUnitSeconds"
        data-value={resource.unallocatedUnitSeconds}
      >
        {amount(resource.unallocatedUnitSeconds)}
      </td>
      <td
        data-metric="withheldUnitSeconds"
        data-value={resource.withheldUnitSeconds}
      >
        {amount(resource.withheldUnitSeconds)}
      </td>
      <td>
        {resource.claimedShare === null
          ? "Unavailable"
          : `${(resource.claimedShare * 100).toFixed(1)}%`}
      </td>
    </tr>
  );
}

function resourceDetails(
  props: Props,
  resource: ResourceUsage,
): React.ReactNode {
  return (
    <details key={resource.resource} data-resource-history={resource.resource}>
      <summary>
        {resource.resource}: {resource.intervals.length} accepted intervals
      </summary>
      <p>
        Occupied time includes approach travel (
        {amount(resource.travelUnitSeconds)}), handling (
        {amount(resource.handlingUnitSeconds)}), and changeover (
        {amount(resource.changeoverUnitSeconds)}) unit-seconds.
      </p>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label={`${resource.resource} claim intervals`}
      >
        <table className="oven-workspace-cells">
          <caption>{resource.resource} claim intervals</caption>
          <thead>
            <tr>
              <th>Task</th>
              <th>Claim</th>
              <th>Units</th>
              <th>Start (s)</th>
              <th>End (s)</th>
            </tr>
          </thead>
          <tbody>{resource.intervals.map(intervalRow.bind(null, props))}</tbody>
        </table>
        {resource.intervals.length === 0 && <p>No accepted claim intervals.</p>}
      </div>
    </details>
  );
}

function intervalRow(props: Props, span: ResourceInterval): React.ReactNode {
  return (
    <tr
      key={`${span.task}:${span.start}:${span.kind}`}
      data-claim-task={span.task}
      data-kind={span.kind}
      data-start={span.start}
      data-end={span.end}
      data-units={span.units}
      data-ongoing={span.ongoing}
    >
      <td>
        <button
          aria-pressed={props.selected === span.task}
          onClick={props.select.bind(null, span.task)}
        >
          {span.task}
        </button>
      </td>
      <td>{span.kind === "travel" ? "approach travel" : span.kind}</td>
      <td>{span.units}</td>
      <td>{seconds(span.start)}</td>
      <td>
        {seconds(span.end)}
        {span.ongoing && " (ongoing)"}
      </td>
    </tr>
  );
}
