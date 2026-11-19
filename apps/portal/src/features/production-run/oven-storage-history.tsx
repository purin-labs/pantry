import type {
  StorageHistoryView,
  StorageInterval,
  StorageUsage,
} from "@purin-labs/production-simulation";
import type React from "react";
import { seconds, type TaskSelection } from "./oven-logistics";

type Props = TaskSelection & Readonly<{ view: StorageHistoryView }>;

export function OvenStorageHistory(props: Props): React.ReactNode {
  const { view } = props;
  if (view.kind === "unavailable")
    return (
      <p>This retained execution build does not expose storage history.</p>
    );
  return (
    <section aria-label="Carrier storage history" data-time={view.through}>
      <h3>Carrier storage history</h3>
      <p>
        Accepted occupancy and reservations from {seconds(view.after)} to{" "}
        {seconds(view.through)} seconds. A reserved slot holds space for an
        arriving carrier. Full time counts occupied and reserved slots together.
      </p>
      <p>
        Slot-seconds measure slots multiplied by elapsed seconds. Peaks include
        states that last for a positive interval. Material quantities use
        separate accounting.
      </p>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label="Carrier storage accounting"
      >
        <table className="oven-workspace-cells">
          <caption>Carrier storage accounting</caption>
          <thead>
            <tr>
              <th>Storage</th>
              <th>Slots</th>
              <th>Occupied slot-s</th>
              <th>Reserved slot-s</th>
              <th>Free slot-s</th>
              <th>Peak occupied</th>
              <th>Peak reserved</th>
              <th>Peak occupied + reserved</th>
              <th>Full (s)</th>
            </tr>
          </thead>
          <tbody>{view.storages.map(usageRow)}</tbody>
        </table>
      </div>
      {view.storages.map(storageDetails.bind(null, props))}
    </section>
  );
}

function metric(name: string, value: number): React.ReactNode {
  return (
    <td data-metric={name} data-value={value}>
      {Number.isInteger(value) ? value : value.toFixed(3)}
    </td>
  );
}

function usageRow(storage: StorageUsage): React.ReactNode {
  return (
    <tr key={storage.storage} data-storage-usage={storage.storage}>
      <td>{storage.storage}</td>
      {metric("slots", storage.slots)}
      {metric("occupiedSlotSeconds", storage.occupiedSlotSeconds)}
      {metric("reservedSlotSeconds", storage.reservedSlotSeconds)}
      {metric("freeSlotSeconds", storage.freeSlotSeconds)}
      {metric("peakOccupiedSlots", storage.peakOccupiedSlots)}
      {metric("peakReservedSlots", storage.peakReservedSlots)}
      {metric("peakCommittedSlots", storage.peakCommittedSlots)}
      {metric("fullSeconds", storage.fullSeconds)}
    </tr>
  );
}

function storageDetails(props: Props, storage: StorageUsage): React.ReactNode {
  return (
    <details key={storage.storage} data-storage-history={storage.storage}>
      <summary>
        {storage.storage}: {storage.intervals.length} accepted intervals
      </summary>
      <div
        className="oven-logistics-scroll"
        tabIndex={0}
        aria-label={`${storage.storage} storage intervals`}
      >
        <table className="oven-workspace-cells">
          <caption>
            {storage.storage} occupancy and reservation intervals
          </caption>
          <thead>
            <tr>
              <th>Start (s)</th>
              <th>End (s)</th>
              <th>Occupants</th>
              <th>Reservations</th>
            </tr>
          </thead>
          <tbody>{storage.intervals.map(intervalRow.bind(null, props))}</tbody>
        </table>
        {storage.intervals.length === 0 && <p>No elapsed storage intervals.</p>}
      </div>
    </details>
  );
}

function intervalRow(props: Props, span: StorageInterval): React.ReactNode {
  return (
    <tr
      key={span.start}
      data-storage-start={span.start}
      data-end={span.end}
      data-ongoing={span.ongoing}
      data-occupants={JSON.stringify(span.occupants)}
      data-reservations={JSON.stringify(span.reservations)}
    >
      <td>{seconds(span.start)}</td>
      <td>
        {seconds(span.end)}
        {span.ongoing && " (current)"}
      </td>
      <td>{span.occupants.join(", ") || "Empty"}</td>
      <td>
        {span.reservations.length === 0
          ? "None"
          : span.reservations.map(reservationButton.bind(null, props))}
      </td>
    </tr>
  );
}

function reservationButton(
  props: Props,
  reservation: StorageInterval["reservations"][number],
): React.ReactNode {
  return (
    <button
      key={reservation.carrier}
      aria-pressed={props.selected === reservation.task}
      onClick={props.select.bind(null, reservation.task)}
    >
      {reservation.carrier} · {reservation.task}
    </button>
  );
}
