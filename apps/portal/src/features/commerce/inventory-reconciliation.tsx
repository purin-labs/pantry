import { Select } from "@purin-labs/ui/select";
import React from "react";
import {
  parseInventoryReceiptContext,
  type InventoryReceiptContext,
} from "@purin-labs/kitchen-control-api";
import {
  parseMutationResult,
  type ReconcileCommerceInventoryV1,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";
import { controlRead } from "@purin-labs/control/portal/control-client";
import { cancelDialog, DialogHeading, syncDialog } from "@purin-labs/ui/dialog";
import { parseInventoryQuantityText as inventoryQuantityInput } from "@purin-labs/kitchen-control-api";
import type { CommerceMutationTransport } from "./entity-plane/api";
import {
  StockDialogCancel,
  StockDialogContext,
  StockDialogDone,
  StockDialogRetry,
} from "./stock-dialog";

import {
  readReconciliationSubmission,
  storeReconciliationSubmission,
  clearReconciliationSubmission,
  reconciliationFailure,
  type ReconciliationScope,
  type ReconciliationSubmission,
} from "./inventory-reconciliation-submission";

type Props = Readonly<{
  userId: string;
  organisationId: string;
  positionId: string;
  kind: "count" | "adjustment";
  mutate: CommerceMutationTransport;
  close: () => void;
  changed: () => void;
}>;

type Draft = Readonly<{
  quantity: string;
  lot: string;
  explanation: string;
  direction: string;
  reason: string;
}>;

export type ReconciliationState =
  | Readonly<{ kind: "loading"; submission?: never }>
  | Readonly<{ kind: "unavailable"; message: string; submission?: never }>
  | Readonly<{
      kind: "editing" | "refreshing";
      submission?: never;
      context: InventoryReceiptContext;
      draft: Draft;
      message: string | null;
    }>
  | Readonly<{
      kind: "saving" | "uncertain";
      context: InventoryReceiptContext;
      draft: Draft;
      submission: ReconciliationSubmission;
      message: string | null;
    }>
  | Readonly<{ kind: "saved"; submission?: never }>;

export class InventoryReconciliationDialog extends React.Component<
  Props,
  ReconciliationState
> {
  state: ReconciliationState = { kind: "loading" };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly requestedAt = new Date().toISOString();
  private active = true;
  private dirty = false;
  private discard = false;
  componentDidMount() {
    syncDialog(this.dialog, true);
    void this.load();
  }
  componentWillUnmount() {
    this.active = false;
    syncDialog(this.dialog, false);
  }
  async load() {
    if (
      this.state.kind === "refreshing" ||
      this.state.kind === "saving" ||
      this.state.kind === "uncertain"
    ) {
      return;
    }
    const preserved = this.state.kind === "editing" ? this.state : null;
    if (preserved !== null) {
      this.setState({
        kind: "refreshing",
        context: preserved.context,
        draft: preserved.draft,
        message: null,
      });
    }
    try {
      const submission =
        preserved === null ? readReconciliationSubmission(this.scope()) : null;
      const context = parseInventoryReceiptContext(
        await controlRead(
          `${reconciliationPath(this.props.organisationId)}?position=${encodeURIComponent(this.props.positionId)}`,
        ),
      );
      if (context.onHandQuantity === null) {
        throw new Error(
          "On-hand stock has not been reported. Configure an accounted stock position before recording a count.",
        );
      }
      if (this.active && submission !== null) {
        this.setState({
          kind: "uncertain",
          context,
          draft: submittedDraft(submission),
          submission,
          message:
            "A previous stock update has an unknown outcome. Check it before making another change.",
        });
        return;
      }
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft: preserved?.draft ?? {
            quantity: "",
            lot: context.lots[0]?.id ?? "",
            explanation: "",
            direction: "decrease",
            reason: "correction",
          },
          message: null,
        });
      }
    } catch (error) {
      if (this.active) {
        this.setState(
          preserved === null
            ? { kind: "unavailable", message: reconciliationError(error) }
            : {
                kind: "editing",
                context: preserved.context,
                draft: preserved.draft,
                message: reconciliationError(error),
              },
        );
      }
    }
  }
  edit(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    this.change(event.target.name, event.target.value);
  }
  change(name: string, value: string | null) {
    if (this.state.kind !== "editing" || value === null) {
      return;
    }
    const draft = {
      ...this.state.draft,
      [name]: value,
    };
    if (draft.direction === "increase") {
      draft.reason = "correction";
    }
    this.dirty = true;
    this.discard = false;
    this.setState({
      kind: "editing",
      context: this.state.context,
      draft,
      message: null,
    });
  }
  close() {
    if (this.state.kind === "saving" || this.state.kind === "refreshing") {
      return;
    }
    if (this.dirty && this.state.kind === "editing") {
      this.discard = true;
      this.setState({
        kind: "editing",
        context: this.state.context,
        draft: this.state.draft,
        message:
          "You have unsaved changes. Keep editing or discard the changes below.",
      });
      return;
    }
    this.props.close();
  }
  private scope(): ReconciliationScope {
    return {
      userId: this.props.userId,
      organisationId: this.props.organisationId,
      positionId: this.props.positionId,
      kind: this.props.kind,
    };
  }
  async submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (this.state.kind !== "editing") {
      return;
    }
    const { context, draft } = this.state;
    let submission: ReconciliationSubmission;
    try {
      submission = {
        idempotencyKey: `portal-${crypto.randomUUID()}`,
        body: reconciliationBody(
          this.props.kind,
          context,
          draft,
          this.requestedAt,
        ),
      };
      storeReconciliationSubmission(this.scope(), submission);
    } catch (error) {
      this.setState({
        kind: "editing",
        context,
        draft,
        message: reconciliationError(error),
      });
      return;
    }
    await this.sendSubmission(context, draft, submission);
  }
  async retry() {
    if (this.state.kind !== "uncertain") {
      return;
    }
    await this.sendSubmission(
      this.state.context,
      this.state.draft,
      this.state.submission,
    );
  }
  private async sendSubmission(
    context: InventoryReceiptContext,
    draft: Draft,
    submission: ReconciliationSubmission,
  ) {
    this.setState({
      kind: "saving",
      context,
      draft,
      submission,
      message: null,
    });
    try {
      const response = await this.props.mutate(
        reconciliationPath(this.props.organisationId),
        submission.body,
        { kind: "prepared", idempotencyKey: submission.idempotencyKey },
      );
      if (!isRecord(response) || response.ok !== true) {
        throw new Error(
          "The stock update has an unknown outcome. Check the update to recover its result.",
        );
      }
      const result = parseMutationResult(response.result);
      if (result.outcome === "rejected") {
        throw new Error("The stock update could not be confirmed.");
      }
      clearReconciliationSubmission(this.scope());
      this.dirty = false;
      this.props.changed();
      if (this.active) {
        this.setState({ kind: "saved" });
      }
    } catch (error) {
      if (reconciliationFailure(error).kind === "rejected") {
        try {
          clearReconciliationSubmission(this.scope());
          if (this.active) {
            this.setState({
              kind: "editing",
              context,
              draft,
              message: reconciliationError(error),
            });
          }
          return;
        } catch {
          // Keep the frozen submission until browser recovery storage can be cleared.
        }
      }
      if (this.active) {
        this.setState({
          kind: "uncertain",
          context,
          draft,
          submission,
          message:
            "The stock update could not be settled. Check it before making another change.",
        });
      }
    }
  }
  render(): React.ReactNode {
    const state = this.state;
    const counting = this.props.kind === "count";
    const title = counting ? "Count stock" : "Adjust stock";
    return (
      <dialog
        ref={this.dialog}
        className="stock-dialog"
        aria-labelledby="stock-reconciliation-heading"
        onCancel={cancelDialog.bind(null, this.close.bind(this))}
      >
        <DialogHeading
          id="stock-reconciliation-heading"
          title={title}
          close={this.close.bind(this)}
        />
        {state.kind === "loading" && (
          <div className="stock-dialog-body" role="status">
            Loading current stock…
          </div>
        )}
        {state.kind === "unavailable" && (
          <StockDialogRetry
            message={state.message}
            close={this.close.bind(this)}
            retry={this.load.bind(this)}
          />
        )}
        {state.kind === "saved" && (
          <StockDialogDone close={this.close.bind(this)}>
            <p role="status">Stock updated.</p>
          </StockDialogDone>
        )}
        {(state.kind === "editing" ||
          state.kind === "refreshing" ||
          state.kind === "saving" ||
          state.kind === "uncertain") && (
          <form
            className="stock-dialog-form"
            onSubmit={this.submit.bind(this)}
            aria-busy={state.kind === "saving" || state.kind === "refreshing"}
          >
            <div className="stock-dialog-body">
              <StockDialogContext
                label="Current stock"
                name={state.context.itemName}
                detail={state.context.locationName}
              >
                <dl>
                  <div>
                    <dt>On hand</dt>
                    <dd>{state.context.onHand}</dd>
                  </div>
                  <div>
                    <dt>Reserved</dt>
                    <dd>{state.context.allocated}</dd>
                  </div>
                </dl>
              </StockDialogContext>
              {state.kind === "uncertain" && (
                <p className="stock-dialog-notice" role="alert">
                  {state.message}
                </p>
              )}
              <fieldset
                className="stock-dialog-fields"
                disabled={state.kind !== "editing"}
              >
                {state.context.tracking.kind === "lot_tracked" && (
                  <label className="stock-dialog-full-width">
                    Lot *
                    <Select.Root
                      name="lot"
                      required
                      items={state.context.lots.map(reconciliationLotItem)}
                      value={state.draft.lot}
                      onValueChange={this.change.bind(this, "lot")}
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {state.context.lots.map(reconciliationLotOption)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                )}
                {!counting && (
                  <label>
                    Change *
                    <Select.Root
                      name="direction"
                      items={RECONCILIATION_DIRECTIONS}
                      value={state.draft.direction}
                      onValueChange={this.change.bind(this, "direction")}
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {RECONCILIATION_DIRECTIONS.map(
                          renderReconciliationItem,
                        )}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                )}
                <label>
                  {counting
                    ? "Observed physical quantity"
                    : "Quantity to change"}{" "}
                  ({state.context.unit}) *
                  <input
                    name="quantity"
                    type="number"
                    inputMode="decimal"
                    min={counting ? "0" : "0.000001"}
                    step="any"
                    required
                    autoFocus
                    value={state.draft.quantity}
                    onChange={this.edit.bind(this)}
                  />
                </label>
                {!counting && (
                  <label>
                    Reason *
                    <Select.Root
                      name="reason"
                      items={RECONCILIATION_REASONS}
                      value={state.draft.reason}
                      onValueChange={this.change.bind(this, "reason")}
                    >
                      <Select.Trigger>
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {RECONCILIATION_REASONS.filter(
                          reasonAllowed.bind(null, state.draft.direction),
                        ).map(renderReconciliationItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                )}
                <label className="stock-dialog-full-width">
                  Explanation *
                  <textarea
                    name="explanation"
                    required
                    maxLength={1000}
                    rows={3}
                    value={state.draft.explanation}
                    onChange={this.edit.bind(this)}
                  />
                </label>
              </fieldset>
              {state.kind !== "uncertain" && (
                <div className="stock-dialog-preview" role="status">
                  {reconciliationPreview(counting, state.context, state.draft)}
                </div>
              )}
              <p className="stock-footnote">
                * Required. Stock is rechecked before saving. Counts below
                reservations require resolving the shortage first.
              </p>
              {state.kind !== "uncertain" && state.message !== null && (
                <div className="stock-dialog-notice">
                  <p role="alert">{state.message}</p>
                  {state.kind === "editing" && (
                    <button type="button" onClick={this.load.bind(this)}>
                      Refresh stock and review
                    </button>
                  )}
                </div>
              )}
            </div>
            <footer className="stock-dialog-actions">
              <StockDialogCancel
                discard={this.discard}
                discardChanges={this.props.close}
                close={this.close.bind(this)}
                label={state.kind === "uncertain" ? "Close" : "Cancel"}
              />
              {state.kind === "uncertain" ? (
                <button
                  type="button"
                  className="connection-primary-action"
                  onClick={this.retry.bind(this)}
                >
                  Check stock update
                </button>
              ) : (
                <button
                  type="submit"
                  className="connection-primary-action"
                  disabled={state.kind !== "editing"}
                >
                  {state.kind === "refreshing"
                    ? "Refreshing stock…"
                    : counting
                      ? "Record count"
                      : "Save adjustment"}
                  {state.kind === "saving" ? "…" : ""}
                </button>
              )}
            </footer>
          </form>
        )}
      </dialog>
    );
  }
}

function submittedDraft(submission: ReconciliationSubmission): Draft {
  const { change, target } = submission.body;
  const quantity =
    change.kind === "count" ? change.observedQuantity : change.quantity;
  return {
    quantity: String(quantity.amount / 10 ** quantity.scale),
    lot: target.kind === "lot" ? target.lotId : "",
    explanation: change.explanation,
    direction: change.kind === "adjustment" ? change.direction : "decrease",
    reason: change.kind === "adjustment" ? change.reason : "correction",
  };
}

const RECONCILIATION_DIRECTIONS = [
  { value: "decrease", label: "Remove stock" },
  { value: "increase", label: "Add stock" },
];
const RECONCILIATION_REASONS = [
  { value: "correction", label: "Correction" },
  { value: "waste", label: "Waste" },
  { value: "damage", label: "Damage" },
];

function reasonAllowed(
  direction: string,
  reason: Readonly<{ value: string }>,
): boolean {
  return direction === "decrease" || reason.value === "correction";
}

function renderReconciliationItem(
  item: Readonly<{ value: string; label: string }>,
) {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function reconciliationLotItem(lot: InventoryReceiptContext["lots"][number]) {
  return {
    value: lot.id,
    label: `${lot.code} · ${lot.quantity.amount / 10 ** lot.quantity.scale} ${lot.quantity.unit}`,
  };
}

function reconciliationLotOption(lot: InventoryReceiptContext["lots"][number]) {
  return (
    <Select.Item key={lot.id} value={lot.id}>
      {lot.code} · {lot.quantity.amount / 10 ** lot.quantity.scale}{" "}
      {lot.quantity.unit}
    </Select.Item>
  );
}

function reconciliationBody(
  kind: Props["kind"],
  context: InventoryReceiptContext,
  draft: Draft,
  requestedAt: string,
) {
  const quantity = inventoryQuantityInput(
    draft.quantity,
    context.unit,
    kind === "count",
  );
  const explanation = draft.explanation.trim();
  if (explanation.length === 0) {
    throw new Error("Explain the stock change.");
  }
  let change: ReconcileCommerceInventoryV1["change"];
  if (kind === "count") {
    change = { kind: "count", observedQuantity: quantity, explanation };
  } else if (draft.direction === "increase") {
    change = {
      kind: "adjustment",
      direction: "increase",
      quantity,
      reason: "correction",
      explanation,
    };
  } else if (
    draft.reason === "correction" ||
    draft.reason === "waste" ||
    draft.reason === "damage"
  ) {
    change = {
      kind: "adjustment",
      direction: "decrease",
      quantity,
      reason: draft.reason,
      explanation,
    };
  } else {
    throw new Error("Select the stock adjustment reason.");
  }
  let target: ReconcileCommerceInventoryV1["target"] = { kind: "aggregate" };
  if (context.tracking.kind === "lot_tracked") {
    const lot = context.lots.find(lotIdMatches.bind(null, draft.lot));
    if (lot === undefined) {
      throw new Error("Select a recorded lot.");
    }
    target = { kind: "lot", lotId: lot.id, lotRevision: lot.revision };
  }
  return {
    merchantRevision: context.merchantRevision,
    inventoryPositionId: context.inventoryPositionId,
    inventoryPositionRevision: context.inventoryPositionRevision,
    requestedAt,
    target,
    change,
  };
}

function lotIdMatches(
  id: string,
  lot: InventoryReceiptContext["lots"][number],
): boolean {
  return lot.id === id;
}

function reconciliationPreview(
  counting: boolean,
  context: InventoryReceiptContext,
  draft: Draft,
): React.ReactNode {
  const current =
    context.tracking.kind === "aggregate"
      ? context.onHandQuantity
      : context.lots.find(lotIdMatches.bind(null, draft.lot))?.quantity;
  if (current === null || current === undefined || draft.quantity === "") {
    return "Enter a quantity to review the change.";
  }
  try {
    const quantity = inventoryQuantityInput(
      draft.quantity,
      context.unit,
      counting,
    );
    const value = quantity.amount / 10 ** quantity.scale;
    const existing = current.amount / 10 ** current.scale;
    const difference = counting
      ? value - existing
      : draft.direction === "increase"
        ? value
        : -value;
    return (
      <dl>
        <div>
          <dt>Current</dt>
          <dd>
            {existing.toLocaleString("en-US", { maximumFractionDigits: 6 })}{" "}
            {context.unit}
          </dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd>
            {difference > 0 ? "+" : ""}
            {difference.toLocaleString("en-US", {
              maximumFractionDigits: 6,
            })}{" "}
            {context.unit}
          </dd>
        </div>
        <div>
          <dt>After saving</dt>
          <dd>
            {(existing + difference).toLocaleString("en-US", {
              maximumFractionDigits: 6,
            })}{" "}
            {context.unit}
          </dd>
        </div>
      </dl>
    );
  } catch {
    return "Enter a supported quantity to review the change.";
  }
}

function reconciliationPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/reconciliations`;
}

function reconciliationError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Stock could not be changed. Refresh the balance and try again.";
}
