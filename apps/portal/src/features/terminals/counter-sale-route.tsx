import React from "react";
import { toast } from "sonner";
import { assertNever } from "@purin-labs/std";
import { formatMoneyMinor } from "../../formatting";
import { PageSkeleton, RecoverableError } from "../../page-components";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";

import {
  collectCounterSale,
  counterSaleGuidance,
  handOverCounterSale,
  markCounterSalePickupReady,
  readCounterSale,
  reconcileCounterSale,
  refundCounterSale,
  type CounterSaleMutationTransport,
} from "./counter-sale-api";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";
import "./styles.css";

type SaleState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; sale: CounterSale }>;

type CounterSaleRouteProps = Readonly<{
  organisationId: string;
  checkoutId: string;
  onUpdated?: () => Promise<void>;
  collection:
    | Readonly<{ kind: "read_only" }>
    | Readonly<{ kind: "enabled"; mutate: CounterSaleMutationTransport }>;
}>;

/**
 * One counter sale: its receipt, and what the till may do next.
 *
 * The panel never decides for itself whether a payment may be taken. It shows
 * the platform's `collectable` and its own guidance line, so the answer an
 * operator sees is the same answer the collection endpoint would give. A
 * disabled button that disagreed with the server would teach operators to
 * retry until something worked.
 */
export function CounterSaleRoute(
  props: CounterSaleRouteProps,
): React.ReactNode {
  const [state, setState] = React.useState<SaleState>({ kind: "loading" });
  const [readRevision, setReadRevision] = React.useState(0);
  const [refundReview, setRefundReview] = React.useState<CounterSale | null>(
    null,
  );
  const receipt = React.useRef<HTMLElement>(null);

  React.useEffect(
    loadSaleEffect.bind(null, props.organisationId, props.checkoutId, setState),
    [props.organisationId, props.checkoutId, readRevision],
  );
  React.useEffect(setRefundReview.bind(null, null), [props.checkoutId]);

  if (state.kind === "loading") {
    return <PageSkeleton label="Loading sale" />;
  }
  if (state.kind === "failed") {
    return (
      <RecoverableError
        message={state.message}
        action={
          <button
            type="button"
            onClick={setReadRevision.bind(null, nextReadRevision)}
          >
            Try again
          </button>
        }
      />
    );
  }

  const { sale } = state;
  return (
    <section ref={receipt} className="terminal-panel counter-sale">
      <header className="terminal-panel-heading">
        <h2>Counter sale</h2>
        <span className={`terminal-badge terminal-badge-${saleTone(sale)}`}>
          {saleLabel(sale)}
        </span>
      </header>

      <p className="counter-sale-guidance">{counterSaleGuidance(sale)}</p>

      <dl className="counter-sale-facts">
        <div>
          <dt>Sale reference</dt>
          <dd>{sale.checkoutId}</dd>
        </div>
        <div>
          <dt>Counter</dt>
          <dd>{sale.pantryLocationId}</dd>
        </div>
        {sale.quote === null ? null : (
          <div>
            <dt>Line items</dt>
            <dd>{sale.quote.lineCount}</dd>
          </div>
        )}
        {sale.quote === null ? null : (
          <div>
            <dt>Total</dt>
            <dd>
              <bdi>
                {formatMoneyMinor(
                  sale.quote.amount.amountMinor,
                  sale.quote.amount.currency,
                )}
              </bdi>
            </dd>
          </div>
        )}
        {sale.orderId === null ? null : (
          <div>
            <dt>Order</dt>
            <dd>{sale.orderId}</dd>
          </div>
        )}
        {sale.capturedPaymentReference === null ? null : (
          <div>
            <dt>Payment</dt>
            <dd>{sale.capturedPaymentReference}</dd>
          </div>
        )}
        {sale.afterSale === null ? null : (
          <div>
            <dt>Pickup</dt>
            <dd>{sale.afterSale.fulfillment.state.replaceAll("_", " ")}</dd>
          </div>
        )}
        {sale.afterSale === null ? null : (
          <div>
            <dt>Refund</dt>
            <dd>{sale.afterSale.refundState.replaceAll("_", " ")}</dd>
          </div>
        )}
      </dl>

      {sale.recoverable === null ? null : (
        <div className="counter-sale-recovery">
          <p>
            Payment {sale.recoverable.paymentAttemptId} is unresolved (
            {sale.recoverable.reasonCode}). Purin Checkout will reconcile it
            from{" "}
            {new Date(sale.recoverable.reconcileAfter).toLocaleTimeString()}.
            Recover this attempt rather than starting a new one.
          </p>
        </div>
      )}

      <div className="counter-sale-actions">
        {props.collection.kind === "enabled" && sale.collectable ? (
          <button
            type="button"
            onClick={takePayment.bind(null, props, sale, setState)}
          >
            Take payment
          </button>
        ) : null}
        {sale.state !== "complete" && sale.state !== "expired" ? (
          <button
            type="button"
            onClick={refreshSale.bind(null, props, setState)}
          >
            {props.collection.kind === "enabled"
              ? "Reconcile payment"
              : "Refresh status"}
          </button>
        ) : null}
        {sale.state === "complete" || sale.state === "captured_unplaced" ? (
          <button
            type="button"
            onClick={printCounterSaleReceipt.bind(null, receipt)}
          >
            Print receipt
          </button>
        ) : null}
        {props.collection.kind === "enabled" &&
        sale.afterSale?.fulfillment.state === "requested" ? (
          <button
            type="button"
            onClick={runAfterSale.bind(null, props, setState, "ready")}
          >
            Mark pickup ready
          </button>
        ) : null}
        {props.collection.kind === "enabled" &&
        sale.afterSale?.fulfillment.state === "ready_for_pickup" ? (
          <button
            type="button"
            onClick={runAfterSale.bind(null, props, setState, "handover")}
          >
            Hand to customer
          </button>
        ) : null}
        {props.collection.kind === "enabled" &&
        sale.afterSale?.payment.state === "captured" &&
        (sale.afterSale.refundState === "none" ||
          sale.afterSale.refundState === "pending") ? (
          <button
            type="button"
            onClick={
              sale.afterSale.refundState === "pending"
                ? runAfterSale.bind(null, props, setState, "refund")
                : setRefundReview.bind(null, sale)
            }
          >
            {sale.afterSale.refundState === "pending"
              ? "Reconcile refund"
              : "Refund full amount"}
          </button>
        ) : null}
      </div>

      {sale.state === "complete" || sale.state === "captured_unplaced" ? (
        <p className="counter-sale-print-note">
          Use your browser to print or save this receipt. Open this sale again
          whenever you need another copy.
        </p>
      ) : null}
      {refundReview === null ? null : (
        <CounterRefundReview
          sale={refundReview}
          close={setRefundReview.bind(null, null)}
          confirm={confirmCounterRefund.bind(
            null,
            props,
            setState,
            setRefundReview,
          )}
        />
      )}
    </section>
  );
}

function nextReadRevision(revision: number): number {
  return revision + 1;
}

function CounterRefundReview(
  props: Readonly<{
    sale: CounterSale;
    close: () => void;
    confirm: () => void;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const cancel = React.useRef<HTMLButtonElement>(null);
  React.useLayoutEffect(openRefundReview.bind(null, dialog, cancel), []);
  return (
    <dialog
      ref={dialog}
      className="access35-dialog terminal-confirm"
      aria-labelledby="counter-refund-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <div className="terminal-confirm-content">
        <DialogHeading
          id="counter-refund-title"
          title="Refund this payment?"
          close={props.close}
        />
        <p>The full captured payment will be returned to the customer.</p>
        <dl className="counter-sale-facts">
          <div>
            <dt>Sale</dt>
            <dd>{props.sale.checkoutId}</dd>
          </div>
          {props.sale.quote === null ? null : (
            <div>
              <dt>Amount</dt>
              <dd>
                <bdi>
                  {formatMoneyMinor(
                    props.sale.quote.amount.amountMinor,
                    props.sale.quote.amount.currency,
                  )}
                </bdi>
              </dd>
            </div>
          )}
        </dl>
        <div className="terminal-confirm-actions">
          <button ref={cancel} type="button" onClick={props.close}>
            Keep payment
          </button>
          <button
            type="button"
            className="terminal-confirm-proceed"
            onClick={props.confirm}
          >
            Refund full amount
          </button>
        </div>
      </div>
    </dialog>
  );
}

function openRefundReview(
  dialog: React.RefObject<HTMLDialogElement | null>,
  cancel: React.RefObject<HTMLButtonElement | null>,
): () => void {
  syncDialog(dialog, true);
  cancel.current?.focus();
  return syncDialog.bind(null, dialog, false);
}

function confirmCounterRefund(
  props: CounterSaleRouteProps,
  setState: (state: SaleState) => void,
  setReview: React.Dispatch<React.SetStateAction<CounterSale | null>>,
): void {
  setReview(null);
  void runAfterSale(props, setState, "refund");
}

function printCounterSaleReceipt(
  receipt: React.RefObject<HTMLElement | null>,
): void {
  if (receipt.current === null) return;
  receipt.current.dataset.counterReceipt = "";
  window.addEventListener(
    "afterprint",
    clearCounterReceipt.bind(null, receipt.current),
    { once: true },
  );
  window.print();
}

function clearCounterReceipt(receipt: HTMLElement): void {
  delete receipt.dataset.counterReceipt;
}

async function takePayment(
  props: CounterSaleRouteProps,
  sale: CounterSale,
  setState: (state: SaleState) => void,
): Promise<void> {
  if (props.collection.kind !== "enabled" || sale.quote === null) return;
  try {
    await collectCounterSale(
      props.organisationId,
      sale,
      sale.quote.amount,
      props.collection.mutate,
    );
    setState({
      kind: "ready",
      sale: await readCounterSale(props.organisationId, props.checkoutId),
    });
    await props.onUpdated?.();
    toast.success("Payment presented on the Square terminal.");
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? cause.message
        : "Payment could not be presented.",
    );
  }
}

async function refreshSale(
  props: CounterSaleRouteProps,
  setState: (state: SaleState) => void,
): Promise<void> {
  try {
    const sale =
      props.collection.kind === "enabled"
        ? await reconcileCounterSale(
            props.organisationId,
            props.checkoutId,
            props.collection.mutate,
          )
        : await readCounterSale(props.organisationId, props.checkoutId);
    setState({ kind: "ready", sale });
    await props.onUpdated?.();
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? cause.message
        : "The sale status could not be refreshed.",
    );
  }
}

async function runAfterSale(
  props: CounterSaleRouteProps,
  setState: (state: SaleState) => void,
  action: "ready" | "handover" | "refund",
): Promise<void> {
  if (props.collection.kind !== "enabled") return;
  try {
    const sale =
      action === "ready"
        ? await markCounterSalePickupReady(
            props.organisationId,
            props.checkoutId,
            props.collection.mutate,
          )
        : action === "handover"
          ? await handOverCounterSale(
              props.organisationId,
              props.checkoutId,
              props.collection.mutate,
            )
          : await refundCounterSale(
              props.organisationId,
              props.checkoutId,
              props.collection.mutate,
            );
    setState({ kind: "ready", sale });
    await props.onUpdated?.();
    announceAfterSale(action, sale);
  } catch (cause) {
    if (action === "refund") {
      const refreshed = await readCounterSale(
        props.organisationId,
        props.checkoutId,
      );
      setState({ kind: "ready", sale: refreshed });
      if (refreshed.afterSale?.refundState === "pending") {
        toast.info(
          "The exact refund is processing. Reconcile this refund before retrying it.",
        );
        return;
      }
    }
    toast.error(
      cause instanceof Error ? cause.message : "The sale could not be updated.",
    );
  }
}

function announceAfterSale(
  action: "ready" | "handover" | "refund",
  sale: CounterSale,
): void {
  switch (action) {
    case "ready":
      toast.success("Pickup marked ready.");
      return;
    case "handover":
      toast.success("Order handed to the customer.");
      return;
    case "refund": {
      const refundState = sale.afterSale?.refundState;
      switch (refundState) {
        case "completed":
          toast.success("The full payment was refunded.");
          return;
        case "pending":
          toast.info(
            "The refund is processing. Reconcile this refund to check its outcome.",
          );
          return;
        case "failed":
          toast.error("The refund failed. Review the payment record.");
          return;
        case "none":
        case undefined:
          toast.info(
            "The refund is not confirmed. Refresh the sale to check its status.",
          );
          return;
        default:
          return assertNever(refundState);
      }
    }
    default:
      return assertNever(action);
  }
}

function saleLabel(sale: CounterSale): string {
  if (sale.afterSale?.refundState === "completed") return "Refunded";
  if (sale.afterSale?.refundState === "pending") return "Refund pending";
  if (sale.afterSale?.refundState === "failed") return "Refund failed";
  switch (sale.state) {
    case "awaiting_collection":
      return "Ready";
    case "collecting":
      return "Taking payment";
    case "submission_unknown":
      return "Unresolved";
    case "declined":
      return "Declined";
    case "captured_unplaced":
      return "Paid, not placed";
    case "complete":
      return "Paid";
    case "expired":
      return "Expired";
  }
}

function saleTone(sale: CounterSale): "ready" | "busy" | "caution" | "quiet" {
  if (sale.afterSale?.refundState === "completed") return "quiet";
  if (sale.afterSale?.refundState === "pending") return "busy";
  if (sale.afterSale?.refundState === "failed") return "caution";
  switch (sale.state) {
    case "awaiting_collection":
      return "ready";
    case "complete":
      return "ready";
    case "collecting":
      return "busy";
    case "submission_unknown":
      return "caution";
    case "captured_unplaced":
      return "caution";
    case "declined":
      return "caution";
    case "expired":
      return "quiet";
  }
}

function loadSaleEffect(
  organisationId: string,
  checkoutId: string,
  setState: (state: SaleState) => void,
): () => void {
  setState({ kind: "loading" });
  let cancelled = false;
  readCounterSale(organisationId, checkoutId).then(
    (sale) => {
      if (!cancelled) setState({ kind: "ready", sale });
    },
    (cause: unknown) => {
      if (cancelled) return;
      const message =
        cause instanceof Error ? cause.message : "This sale is unavailable.";
      setState({ kind: "failed", message });
      toast.error(message);
    },
  );
  return () => {
    cancelled = true;
  };
}
