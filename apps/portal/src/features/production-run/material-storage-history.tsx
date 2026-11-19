import type React from "react";
import type {
  MaterialStorageHistoryView,
  MaterialStorageUsage,
  MaterialStorageInterval,
} from "@purin-labs/production-simulation";
import { seconds, type TaskSelection } from "./oven-logistics";

type Props = TaskSelection & Readonly<{ view: MaterialStorageHistoryView }>;

export function MaterialStorageHistory(props: Props): React.ReactNode {
  if (props.view.kind === "unavailable")
    return <p>This retained build does not expose material-storage history.</p>;
  return (
    <section
      aria-label="Material storage history"
      data-time={props.view.through}
    >
      <h3>Material storage history</h3>
      <p>
        Quantities from {seconds(props.view.after)} to{" "}
        {seconds(props.view.through)} seconds. Held material stays occupied.
        Executing tasks reserve their output space until completion or failure.
      </p>
      <p>
        Quantity-seconds measure stored or reserved quantities multiplied by
        elapsed seconds. Products and units remain separate.
      </p>
      <div className="oven-logistics-scroll" tabIndex={0}>
        <table className="oven-workspace-cells">
          <caption>Material storage accounting</caption>
          <thead>
            <tr>
              <th>Storage</th>
              <th>Product / unit</th>
              <th>Capacity</th>
              <th>Present</th>
              <th>Held</th>
              <th>Reserved</th>
              <th>Occupied quantity-s</th>
              <th>Reserved quantity-s</th>
              <th>Free quantity-s</th>
              <th>Peak committed</th>
              <th>Full (s)</th>
            </tr>
          </thead>
          <tbody>{props.view.storages.map(storageRow)}</tbody>
        </table>
      </div>
      {props.view.storages.map(storageDetails.bind(null, props))}
    </section>
  );
}
function storageRow(store: MaterialStorageUsage): React.ReactNode {
  let reserved = 0;
  for (const item of store.current.reservations) reserved += item.quantity;
  return (
    <tr key={store.storage} data-material-storage={store.storage}>
      <td>{store.storage}</td>
      <td>
        {store.product} / {store.unit}
      </td>
      <td>{store.capacity}</td>
      <td data-quantity="occupied">{store.current.occupied}</td>
      <td data-quantity="held">{store.current.held}</td>
      <td data-quantity="reserved">{reserved}</td>
      <td>{store.occupiedQuantitySeconds.toFixed(3)}</td>
      <td>{store.reservedQuantitySeconds.toFixed(3)}</td>
      <td>{store.freeQuantitySeconds.toFixed(3)}</td>
      <td>{store.peakCommitted}</td>
      <td>{store.fullSeconds.toFixed(3)}</td>
    </tr>
  );
}
function storageDetails(
  props: Props,
  store: MaterialStorageUsage,
): React.ReactNode {
  return (
    <details key={store.storage} data-material-storage-history={store.storage}>
      <summary>
        {store.storage}: {store.intervals.length} accepted intervals
      </summary>
      <div className="oven-logistics-scroll" tabIndex={0}>
        <table className="oven-workspace-cells">
          <caption>
            {store.storage} quantities in {store.unit}
          </caption>
          <thead>
            <tr>
              <th>Start (s)</th>
              <th>End (s)</th>
              <th>Present</th>
              <th>Held</th>
              <th>Reserved output by task</th>
            </tr>
          </thead>
          <tbody>{store.intervals.map(intervalRow.bind(null, props))}</tbody>
        </table>
      </div>
    </details>
  );
}
function intervalRow(
  props: Props,
  span: MaterialStorageInterval,
): React.ReactNode {
  return (
    <tr key={span.start}>
      <td>{seconds(span.start)}</td>
      <td>
        {seconds(span.end)}
        {span.ongoing ? " (current)" : ""}
      </td>
      <td>{span.occupied}</td>
      <td>{span.held}</td>
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
  item: MaterialStorageInterval["reservations"][number],
): React.ReactNode {
  return (
    <button
      key={item.task}
      type="button"
      aria-pressed={props.selected === item.task}
      onClick={props.select.bind(null, item.task)}
    >
      {item.task}: {item.quantity}
    </button>
  );
}
