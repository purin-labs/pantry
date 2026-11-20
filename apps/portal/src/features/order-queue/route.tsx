import React from "react";
import type {
  OrderQueueAction,
  OrderQueueEntry,
  SoldOutItem,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import { ControlApiError } from "../../control-client";
import { Button, useLatestRead, useMutation } from "../../ui";
import {
  advanceOrder,
  readOrderQueue,
  readSoldOutItems,
  writeSoldOut,
} from "./requests";
import "./order-queue.css";

/**
 * The staff order queue (Plan 40B phase 3): one list of the shop's open
 * pickups for a tablet at the counter. Each order shows its code and what to
 * make, and has one main action. The list reads the shop again every few
 * seconds, so that a new QR order appears with no reload, and a second tablet
 * sees what the first one did. After an action the list reads again, and a
 * poll that started before the action can no longer show the old stage.
 */

const POLL = { everyMs: 5_000 } as const;

export function OrderQueueRoute(props: Readonly<{ organisationId: string }>): React.ReactNode {
  const { organisationId } = props;
  const readQueue = React.useCallback(
    (signal: AbortSignal) => readOrderQueue(organisationId, signal),
    [organisationId],
  );
  const { read: queue, reload } = useLatestRead(readQueue, POLL);
  const advance = useMutation(
    (action: OrderQueueAction, idempotencyKey: string, fulfillmentId: string) =>
      advanceOrder(organisationId, fulfillmentId, action, idempotencyKey),
    reload,
  );

  if (queue.kind === "loading") return <p className="order-queue-note">Reading the open orders…</p>;
  if (queue.kind === "failed")
    return <p className="order-queue-note" role="alert">The open orders could not be read. This page tries again.</p>;
  const preparing = queue.value.filter((entry) => entry.stage === "preparing");
  const ready = queue.value.filter((entry) => entry.stage === "ready");
  const row = (entry: OrderQueueEntry): React.ReactNode => {
    const state = advance.state(entry.fulfillmentId);
    return <OrderRow
      key={entry.fulfillmentId}
      entry={entry}
      now={queue.readAt}
      busy={state.kind === "running"}
      refusal={state.kind === "failed" ? refusalMessage(state.error) : null}
      advance={(target, action) => advance.run(target.fulfillmentId, action).then(ignore)}
    />;
  };
  return <div className="order-queue">
    <section aria-label="To prepare">
      <h2>To prepare <span>{preparing.length}</span></h2>
      {preparing.length === 0
        ? <p className="order-queue-note">No order waits. A new QR order appears here.</p>
        : <ul>{preparing.map(row)}</ul>}
    </section>
    <section aria-label="Ready to collect">
      <h2>Ready to collect <span>{ready.length}</span></h2>
      {ready.length === 0
        ? <p className="order-queue-note">No order is ready.</p>
        : <ul>{ready.map(row)}</ul>}
    </section>
    <SoldOutToday organisationId={props.organisationId} />
  </div>;
}

/**
 * Items that staff can mark as sold out, for a drink with no stock count. The
 * mark ends at the shop's next midnight, on this device's clock zone.
 */
function SoldOutToday(props: Readonly<{ organisationId: string }>): React.ReactNode {
  const { organisationId } = props;
  const readItems = React.useCallback(
    (signal: AbortSignal) => readSoldOutItems(organisationId, signal),
    [organisationId],
  );
  const { read, reload } = useLatestRead(readItems, POLL);
  const change = useMutation(
    (item: SoldOutItem, idempotencyKey: string) =>
      writeSoldOut(organisationId, item, idempotencyKey),
    reload,
  );
  const items = read.kind === "ready" ? read.value : null;
  const failed = items?.find((item) => change.state(item.variantId).kind === "failed");

  if (items === null || items.length === 0) return null;
  return <section aria-label="Sold out today" className="order-queue-sold-out">
    <h2>Sold out today</h2>
    <p className="order-queue-note">A mark ends at midnight. Items with a stock count also show as sold out when their stock ends.</p>
    <ul>
      {items.map((item) => <li key={item.variantId} className="order-queue-sold-out-row" data-sold-out={item.soldOutUntil === null ? undefined : "true"}>
        <span>{item.title}</span>
        <Button disabled={change.state(item.variantId).kind === "running"} onClick={() => void change.run(item.variantId, item)}>
          {item.soldOutUntil === null ? "Mark sold out" : "Put back on sale"}
        </Button>
      </li>)}
    </ul>
    {failed === undefined ? null : <p className="order-queue-refusal" role="alert">{failed.title} did not change. Try again.</p>}
  </section>;
}

function OrderRow(props: Readonly<{
  entry: OrderQueueEntry;
  now: number;
  busy: boolean;
  refusal: string | null;
  advance: (entry: OrderQueueEntry, action: OrderQueueAction) => Promise<void>;
}>): React.ReactNode {
  const { entry } = props;
  const started = entry.preparation === "preparing" || entry.preparation === "completed";
  const canStart = entry.stage === "preparing" && !started && entry.preparation !== "not_needed";
  return <li className="order-queue-row" data-code={entry.code}>
    <div className="order-queue-code">
      <strong>{entry.code}</strong>
      <span>{waitLabel(entry.since, props.now)}</span>
      <span>{entry.channel === "online" ? "QR order" : "Counter"}</span>
    </div>
    <ul className="order-queue-lines">
      {entry.lines.map((line, index) => <li key={index}>
        <b>{line.quantity} ×</b> {line.title}
        {line.modifiers.length > 0 ? <small>{line.modifiers.join(", ")}</small> : null}
      </li>)}
    </ul>
    <div className="order-queue-actions">
      {entry.stage === "ready"
        ? <Button variant="primary" disabled={props.busy} onClick={() => void props.advance(entry, "hand_over")}>
            {props.busy ? "Saving…" : "Hand over"}
          </Button>
        : <>
            {canStart
              ? <Button disabled={props.busy} onClick={() => void props.advance(entry, "start")}>Start</Button>
              : started ? <span className="order-queue-started">Started</span> : null}
            <Button variant="primary" disabled={props.busy} onClick={() => void props.advance(entry, "ready")}>
              {props.busy ? "Saving…" : "Ready"}
            </Button>
          </>}
    </div>
    {props.refusal === null ? null : <p className="order-queue-refusal" role="alert">{props.refusal}</p>}
  </li>;
}

function ignore(): void {}

function waitLabel(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function refusalMessage(error: unknown): string {
  const code = error instanceof ControlApiError && isRecord(error.details) ? error.details.error : null;
  switch (code) {
    case "order_queue_changed":
      return "Another screen moved this order. The list now shows its new state.";
    case "order_queue_payment_missing":
      return "This order has no card payment on record. Check its payment in Orders.";
    case "order_queue_busy":
      return "The shop is busy. Try again.";
    case "order_queue_refused":
      return error instanceof ControlApiError &&
        isRecord(error.details) &&
        error.details.field === "pickupCompletion.lotAvailability"
        ? "This order's stock has expired. Receive fresh stock, or cancel the order in Orders."
        : "The shop refused this step. Check the stock for this order and its balance in Orders.";
    default:
      return error instanceof Error ? error.message : "This order did not move. Try again.";
  }
}
