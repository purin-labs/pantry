import { Select } from "@purin-labs/ui/select";
import React from "react";
import {
  parseInventoryReceiptContext,
  parseInventoryQuantityText,
  type InventoryReceiptContext,
} from "@purin-labs/kitchen-control-api";
import {
  parseMutationResult,
  type CommerceInventoryLotInputV1,
} from "@purin-labs/commerce-client";
import { errorMessage, isRecord } from "@purin-labs/std";
import { controlRead } from "@purin-labs/control/portal/control-client";
import { cancelDialog, DialogHeading, syncDialog } from "@purin-labs/ui/dialog";
import type { CommerceMutationTransport } from "./entity-plane/api";
import {
  StockDialogCancel,
  StockDialogContext,
  StockDialogDone,
  StockDialogRetry,
} from "./stock-dialog";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  organisationId: string;
  positionId: string;
  mutate: CommerceMutationTransport;
  close: () => void;
  received: () => void;
}>;

type Draft = Readonly<{
  quantity: string;
  receiptId: string;
  receiptLineId: string;
  purchase: string;
  lotCode: string;
  expiry: string;
}>;

type State =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{
      kind: "editing" | "refreshing" | "saving";
      context: InventoryReceiptContext;
      draft: Draft;
      message: string | null;
    }>
  | Readonly<{ kind: "received" }>;

export class InventoryReceiptDialog extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private readonly dialog = React.createRef<HTMLDialogElement>();
  private readonly receivedAt = new Date().toISOString();
  private readonly lotId = `inventory_lot_${crypto.randomUUID()}`;
  private active = true;
  private dirty = false;
  private discard = false;
  markDirty() {
    this.dirty = true;
    this.discard = false;
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
  componentDidMount() {
    syncDialog(this.dialog, true);
    void this.load();
  }
  componentWillUnmount() {
    this.active = false;
    syncDialog(this.dialog, false);
  }
  edit(event: React.ChangeEvent<HTMLInputElement>) {
    if (this.state.kind !== "editing") {
      return;
    }
    this.markDirty();
    this.setState({
      ...this.state,
      draft: { ...this.state.draft, [event.target.name]: event.target.value },
      message: null,
    });
  }
  editPurchase(purchase: string | null) {
    if (this.state.kind !== "editing" || purchase === null) {
      return;
    }
    this.markDirty();
    this.setState({
      ...this.state,
      draft: { ...this.state.draft, purchase },
      message: null,
    });
  }
  async load() {
    if (this.state.kind === "refreshing" || this.state.kind === "saving") {
      return;
    }
    const preserved = this.state.kind === "editing" ? this.state : null;
    if (preserved !== null) {
      this.setState({ ...preserved, kind: "refreshing", message: null });
    }
    try {
      const context = parseInventoryReceiptContext(
        await controlRead(
          `${receiptPath(this.props.organisationId)}?position=${encodeURIComponent(this.props.positionId)}`,
        ),
      );
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft: preserved?.draft ?? {
            quantity: "",
            receiptId: "",
            receiptLineId: "1",
            purchase: "",
            lotCode: "",
            expiry: "",
          },
          message: null,
        });
      }
    } catch (error) {
      if (this.active) {
        this.setState(
          preserved === null
            ? {
                kind: "unavailable",
                message: errorMessage(
                  error,
                  "The delivery could not be recorded. Retry with the same receipt reference.",
                ),
              }
            : {
                ...preserved,
                kind: "editing",
                message: errorMessage(
                  error,
                  "The delivery could not be recorded. Retry with the same receipt reference.",
                ),
              },
        );
      }
    }
  }
  async submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (this.state.kind !== "editing") {
      return;
    }
    const { context, draft } = this.state;
    const form = new FormData(event.currentTarget);
    let body;
    try {
      body = {
        merchantRevision: context.merchantRevision,
        inventoryItemId: context.inventoryItemId,
        inventoryItemRevision: context.inventoryItemRevision,
        inventoryPositionId: context.inventoryPositionId,
        inventoryPositionRevision: context.inventoryPositionRevision,
        locationId: context.locationId,
        receivedQuantity: parseInventoryQuantityText(
          formText(form, "quantity"),
          context.unit,
        ),
        lot: receiptLot(context, form, this.lotId),
        receiptId: formText(form, "receiptId"),
        receiptLineId: formText(form, "receiptLineId"),
        receivedAt: this.receivedAt,
        purchase: receiptPurchase(context, form),
      };
    } catch (error) {
      this.setState({
        kind: "editing",
        context,
        draft,
        message: errorMessage(
          error,
          "The delivery could not be recorded. Retry with the same receipt reference.",
        ),
      });
      return;
    }
    this.setState({ kind: "saving", context, draft, message: null });
    try {
      const response = await this.props.mutate(
        receiptPath(this.props.organisationId),
        body,
        `inventory.receive:${body.receiptId}:${body.receiptLineId}`,
      );
      if (!isRecord(response) || response.ok !== true) {
        throw new Error(
          "The receipt result is unavailable. Retry with the same receipt reference.",
        );
      }
      const result = parseMutationResult(response.result);
      if (result.outcome === "rejected") {
        throw new Error("The delivery could not be recorded.");
      }
      this.props.received();
      if (this.active) {
        this.setState({ kind: "received" });
      }
    } catch (error) {
      if (this.active) {
        this.setState({
          kind: "editing",
          context,
          draft,
          message: errorMessage(
            error,
            "The delivery could not be recorded. Retry with the same receipt reference.",
          ),
        });
      }
    }
  }
  render(): React.ReactNode {
    const state = this.state;
    return (
      <dialog
        ref={this.dialog}
        className="stock-dialog"
        aria-labelledby="stock-receipt-heading"
        onCancel={cancelDialog.bind(null, this.close.bind(this))}
      >
        <DialogHeading
          id="stock-receipt-heading"
          title="Receive supplies"
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
        {state.kind === "received" && (
          <StockDialogDone close={this.close.bind(this)}>
            <p role="status">Delivery recorded. Stock has been updated.</p>
          </StockDialogDone>
        )}
        {(state.kind === "editing" ||
          state.kind === "refreshing" ||
          state.kind === "saving") && (
          <form
            className="stock-dialog-form"
            onSubmit={this.submit.bind(this)}
            aria-busy={state.kind !== "editing"}
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
                    <dd>{state.context.onHand ?? "Not reported"}</dd>
                  </div>
                  <div>
                    <dt>Available</dt>
                    <dd>{state.context.available}</dd>
                  </div>
                </dl>
              </StockDialogContext>
              <fieldset
                className="stock-dialog-fields"
                disabled={state.kind !== "editing"}
              >
                <label className="stock-dialog-full-width">
                  Quantity received ({state.context.unit}) *
                  <input
                    name="quantity"
                    value={state.draft.quantity}
                    onChange={this.edit.bind(this)}
                    type="number"
                    inputMode="decimal"
                    min={state.context.unit === "each" ? 1 : 0.000001}
                    step={state.context.unit === "each" ? 1 : "any"}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Receipt reference *
                  <input
                    name="receiptId"
                    value={state.draft.receiptId}
                    onChange={this.edit.bind(this)}
                    required
                    maxLength={128}
                    spellCheck={false}
                  />
                </label>
                <label>
                  Receipt line *
                  <input
                    name="receiptLineId"
                    value={state.draft.receiptLineId}
                    onChange={this.edit.bind(this)}
                    required
                    maxLength={128}
                    spellCheck={false}
                  />
                </label>
                {purchaseFields(
                  state.context,
                  state.draft,
                  this.editPurchase.bind(this),
                )}
                {lotFields(state.context, state.draft, this.edit.bind(this))}
              </fieldset>
              {state.kind === "editing" && state.message !== null && (
                <div className="stock-dialog-notice">
                  <p role="alert">{state.message}</p>
                  <button type="button" onClick={this.load.bind(this)}>
                    Refresh stock and review
                  </button>
                </div>
              )}
              <p className="stock-footnote">
                * Required. Record only the quantity delivered. The receipt
                reference and line protect against duplicate deliveries.
              </p>
            </div>
            <footer className="stock-dialog-actions">
              <StockDialogCancel
                discard={this.discard}
                discardChanges={this.props.close}
                close={this.close.bind(this)}
              />
              <button
                type="submit"
                className="connection-primary-action"
                disabled={state.kind !== "editing"}
              >
                {state.kind === "refreshing"
                  ? "Refreshing stock…"
                  : state.kind === "saving"
                    ? "Record delivery…"
                    : "Record delivery"}
              </button>
            </footer>
          </form>
        )}
      </dialog>
    );
  }
}

function lotFields(
  context: InventoryReceiptContext,
  draft: Draft,
  edit: (event: React.ChangeEvent<HTMLInputElement>) => void,
): React.ReactNode {
  if (context.tracking.kind === "aggregate") {
    return null;
  }
  const required = context.tracking.expiry === "required";
  return (
    <>
      <label>
        Lot code *
        <input
          name="lotCode"
          value={draft.lotCode}
          onChange={edit}
          required
          maxLength={128}
          spellCheck={false}
        />
      </label>
      <label>
        Expiry date and time{required ? " *" : " (optional)"}
        <input
          name="expiry"
          value={draft.expiry}
          onChange={edit}
          type="datetime-local"
          required={required}
        />
      </label>
    </>
  );
}

function receiptLot(
  context: InventoryReceiptContext,
  form: FormData,
  lotId: string,
): CommerceInventoryLotInputV1 {
  if (context.tracking.kind === "aggregate") {
    return { kind: "not_tracked" };
  }
  const expiry = form.get("expiry");
  if (
    context.tracking.expiry === "required" &&
    (typeof expiry !== "string" || expiry.length === 0)
  ) {
    throw new Error("Enter the lot expiry.");
  }
  return {
    kind: "tracked",
    lotId,
    lotCode: formText(form, "lotCode"),
    expiry:
      typeof expiry === "string" && expiry.length > 0
        ? { kind: "expires", expiresAt: new Date(expiry).toISOString() }
        : { kind: "not_tracked" },
  };
}

function formText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Complete the required receipt fields.");
  }
  return value.trim();
}

function receiptPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory/receipts`;
}

function purchaseFields(
  context: InventoryReceiptContext,
  draft: Draft,
  choose: (purchase: string | null) => void,
): React.ReactNode {
  if (context.purchases.kind === "unavailable") {
    return (
      <p className="stock-footnote">
        Purchase requests could not be loaded. This delivery will be recorded
        without a purchase link.
      </p>
    );
  }
  return (
    <label className="stock-dialog-full-width">
      Purchase request
      <Select.Root
        name="purchase"
        items={[
          { value: "", label: "Unlinked delivery" },
          ...context.purchases.entries.map(purchaseItem),
        ]}
        value={draft.purchase}
        onValueChange={choose}
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>
          <Select.Item value="">Unlinked delivery</Select.Item>
          {context.purchases.entries.map(purchaseOption)}
        </Select.Popup>
      </Select.Root>
    </label>
  );
}

type PurchaseEntry = Variant<
  InventoryReceiptContext["purchases"],
  "ready"
>["entries"][number];

function purchaseItem(entry: PurchaseEntry) {
  return {
    value: entry.id,
    label: `${entry.supplier} · ${entry.received} received / ${entry.required} requested`,
  };
}

function purchaseOption(entry: PurchaseEntry) {
  return (
    <Select.Item key={entry.id} value={entry.id}>
      {entry.supplier} · {entry.received} received / {entry.required} requested
    </Select.Item>
  );
}

function receiptPurchase(
  context: InventoryReceiptContext,
  form: FormData,
): import("@purin-labs/commerce-client").CommerceInventoryReceiptPurchase {
  const id = form.get("purchase");
  if (id === "" || id === null) {
    return { kind: "unlinked" };
  }
  if (context.purchases.kind === "ready") {
    for (const entry of context.purchases.entries) {
      if (entry.id === id) {
        return {
          kind: "replenishment",
          entryId: entry.id,
          entryRevision: entry.revision,
        };
      }
    }
  }
  throw new Error("Refresh purchase requests before receiving this delivery.");
}
