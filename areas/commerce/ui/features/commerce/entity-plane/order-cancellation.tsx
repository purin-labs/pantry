import { Select } from "@purin-labs/ui/select";
import {
  COMMERCE_CANCELLATION_REASONS,
  COMMERCE_CANCELLATION_REFUNDS,
  renderCommerceSelectParts,
} from "./select-items";
import React from "react";
import { toast } from "sonner";
import type {
  CommerceEntity,
  SourceProvenance,
} from "@purin-labs/commerce-contracts";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "@purin-labs/area-organisation-contract/ui/features/access/permission-required-prompt";
import { cancelDialog, DialogHeading, syncDialog } from "@purin-labs/ui/dialog";
import { Notice } from "@purin-labs/ui/page-components";
import type {
  CommerceOperationsTransport,
  OrderCancellationAction,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/operations";
import {
  parseCommerceActionRecordResponse,
  type CommerceActionRecord,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { assertNever } from "@purin-labs/std";
import { findEntityAttribute } from "./entity-attribute-columns";
import type {
  CancellableOrderEntity,
  OrderCancellationControlState,
} from "./entity-plane-types";
import { commerceEntityName } from "./entity-plane-shared";

export function OrderCancellationControl(
  props: Readonly<{
    organisationId: string;
    page: "products" | "orders" | "suppliers";
    entity: CommerceEntity;
    canPropose: boolean;
    commerceOperations: CommerceOperationsTransport | undefined;
    onActionProposed: ((action: CommerceActionRecord) => void) | undefined;
    actionBusy: boolean;
  }>,
): React.ReactNode {
  const [state, setState] = React.useState<OrderCancellationControlState>({
    kind: "idle",
  });
  const [open, setOpen] = React.useState(false);
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, open), [open]);
  const transport = props.commerceOperations;
  const onActionProposed = props.onActionProposed;
  if (
    props.page !== "orders" ||
    !props.canPropose ||
    transport === undefined ||
    onActionProposed === undefined ||
    !isCancellableOrderEntity(props.entity) ||
    isClosedOrderEntity(props.entity)
  ) {
    return null;
  }
  const commerceEngine = props.entity.provenance.source === "commerce";
  const disabled =
    props.actionBusy ||
    state.kind === "submitting" ||
    state.kind === "submitted";
  const close = closeOrderCancellation.bind(null, setOpen);
  return (
    <section
      className="commerce-dossier-actions"
      aria-labelledby="commerce-order-cancellation-title"
    >
      <h3 id="commerce-order-cancellation-title" className="visually-hidden">
        Cancel order
      </h3>
      <button
        type="button"
        className="commerce-danger-action"
        onClick={openOrderCancellation.bind(null, setOpen)}
      >
        Cancel order
      </button>
      {state.kind === "submitted" ? (
        <Notice tone="neutral" announcement="polite">
          Cancellation proposal ready for review.
        </Notice>
      ) : null}
      {/* The dialog's children render unconditionally so the sheet's content is
          part of the document before it is shown. */}
      <dialog
        className="access35-dialog"
        ref={dialog}
        aria-labelledby="commerce-order-cancellation-dialog-title"
        onCancel={cancelDialog.bind(null, close)}
      >
        <form
          aria-busy={state.kind === "submitting"}
          onSubmit={submitOrderCancellationForm.bind(
            null,
            props.organisationId,
            props.entity,
            transport,
            onActionProposed,
            setState,
            setOpen,
          )}
        >
          <DialogHeading
            id="commerce-order-cancellation-dialog-title"
            title="Cancel order"
            close={close}
          />
          <p>
            This asks an owner or admin to approve the cancellation. Nothing
            changes at the connected store until they do.
          </p>
          <dl className="access35-dialog-review">
            <div>
              <dt>Order</dt>
              <dd>{commerceEntityName(props.entity)}</dd>
            </div>
          </dl>
          <label>
            <span>Reason</span>
            <Select.Root
              name="reason"
              items={COMMERCE_CANCELLATION_REASONS}
              defaultValue="customer_requested"
              disabled={disabled}
            >
              {renderCommerceSelectParts(COMMERCE_CANCELLATION_REASONS)}
            </Select.Root>
          </label>
          {commerceEngine ? (
            <dl className="access35-dialog-review">
              <div>
                <dt>Refund</dt>
                <dd>Full refund</dd>
              </div>
              <div>
                <dt>Inventory</dt>
                <dd>Restock items</dd>
              </div>
              <div>
                <dt>Customer notification</dt>
                <dd>Managed outside this cancellation</dd>
              </div>
            </dl>
          ) : (
            <>
              <label>
                <span>Refund</span>
                <Select.Root
                  name="refund"
                  items={COMMERCE_CANCELLATION_REFUNDS}
                  defaultValue="full"
                  disabled={disabled}
                >
                  {renderCommerceSelectParts(COMMERCE_CANCELLATION_REFUNDS)}
                </Select.Root>
              </label>
              <label className="commerce-dialog-check">
                <input
                  name="restock"
                  type="checkbox"
                  defaultChecked
                  disabled={disabled}
                />{" "}
                Restock items
              </label>
              <label className="commerce-dialog-check">
                <input
                  name="notifyCustomer"
                  type="checkbox"
                  defaultChecked
                  disabled={disabled}
                />{" "}
                Notify customer
              </label>
              <label>
                <span>Internal note (optional)</span>
                <textarea name="note" maxLength={500} disabled={disabled} />
              </label>
            </>
          )}
          {state.kind === "failed" ? (
            <p className="error-text" role="alert">
              {state.message}
            </p>
          ) : null}
          {state.kind === "failed" && state.permission !== null ? (
            <PermissionRequiredPrompt
              organisationId={props.organisationId}
              permission={state.permission.required}
              action="Review cancellation"
              grantScope="for this order only"
              onAllowed={retryOrderCancellation.bind(
                null,
                {
                  organisationId: props.organisationId,
                  entity: props.entity,
                  formData: state.permission.formData,
                  transport,
                },
                onActionProposed,
                setState,
                setOpen,
              )}
              onClose={setState.bind(null, { ...state, permission: null })}
            />
          ) : null}
          <div className="access35-dialog-actions">
            <button
              type="button"
              className="secondary"
              autoFocus
              onClick={close}
            >
              Keep order
            </button>
            <button
              type="submit"
              className="connection-primary-action"
              disabled={disabled}
            >
              {state.kind === "submitting"
                ? "Creating proposal…"
                : "Review cancellation"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

function openOrderCancellation(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(true);
}

function closeOrderCancellation(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(false);
}

export async function proposeOrderCancellation(
  input: Readonly<{
    organisationId: string;
    entity: CommerceEntity;
    formData: FormData;
    transport: CommerceOperationsTransport;
  }>,
): Promise<CommerceActionRecord> {
  if (!isCancellableOrderEntity(input.entity)) {
    throw new Error(
      "Order cancellation is unavailable for this commerce source.",
    );
  }
  const action = buildOrderCancellationAction(input.entity, input.formData);
  const raw = await input.transport.proposeAction(
    input.organisationId,
    action,
    `commerce-order-cancel:${action.resourceId}:${action.expectedRevision}`,
  );
  return parseCommerceActionRecordResponse(raw);
}

function submitOrderCancellationForm(
  organisationId: string,
  entity: CommerceEntity,
  transport: CommerceOperationsTransport,
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  setState({ kind: "submitting" });
  void submitOrderCancellation(
    {
      organisationId,
      entity,
      formData: new FormData(event.currentTarget),
      transport,
    },
    onActionProposed,
    setState,
    setOpen,
  );
}

/** Sends the same cancellation again after the permission was allowed. */
function retryOrderCancellation(
  input: Parameters<typeof proposeOrderCancellation>[0],
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setState({ kind: "submitting" });
  void submitOrderCancellation(input, onActionProposed, setState, setOpen);
}

async function submitOrderCancellation(
  input: Parameters<typeof proposeOrderCancellation>[0],
  onActionProposed: (action: CommerceActionRecord) => void,
  setState: React.Dispatch<React.SetStateAction<OrderCancellationControlState>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): Promise<void> {
  try {
    const action = await proposeOrderCancellation(input);
    onActionProposed(action);
    setState({ kind: "submitted" });
    setOpen(false);
    toast.success("Cancellation sent for approval.");
  } catch (error) {
    // The dialog stays open so the operator can retry without re-entering the
    // reason they already chose.
    const permission = permissionRequiredOf(error);
    setState({
      kind: "failed",
      message:
        permission !== null
          ? "Sending this cancellation for approval needs a permission that was not allowed."
          : "The cancellation could not be sent for approval. Refresh the order and try again.",
      permission:
        permission === null
          ? null
          : { required: permission, formData: input.formData },
    });
  }
}

function buildOrderCancellationAction(
  entity: CancellableOrderEntity,
  formData: FormData,
): OrderCancellationAction {
  const reason = orderCancellationReason(formText(formData, "reason"));
  if (reason === null) throw new Error("Order cancellation reason is invalid.");
  if (entity.provenance.source === "commerce") {
    return {
      kind: "cancel_order",
      resourceId: entity.provenance.resourceId,
      expectedRevision: entity.provenance.revision,
      reason,
      refund: "full",
      restock: true,
      notifyCustomer: false,
      note: null,
    };
  }
  const refund = orderCancellationRefund(formText(formData, "refund"));
  if (refund === null)
    throw new Error("Order cancellation refund choice is invalid.");
  const noteValue = formText(formData, "note");
  const note =
    noteValue === null || noteValue.trim().length === 0
      ? null
      : noteValue.trim();
  return {
    kind: "cancel_order",
    resourceId: entity.provenance.resourceId,
    expectedRevision: entity.provenance.revision,
    reason,
    refund,
    restock: formData.has("restock"),
    notifyCustomer: formData.has("notifyCustomer"),
    note,
  };
}

function isCancellableOrderEntity(
  entity: CommerceEntity,
): entity is CancellableOrderEntity {
  return (
    entity.reference.origin === "system" &&
    entity.reference.typeId === "order" &&
    "provenance" in entity &&
    entity.provenance !== undefined &&
    commerceSourceSupportsOrderCancellation(entity.provenance.source)
  );
}

/** A fulfilled or cancelled order has nothing left to cancel. */
function isClosedOrderEntity(entity: CommerceEntity): boolean {
  const lifecycle = findEntityAttribute(entity, "lifecycle");
  return (
    lifecycle?.value.kind === "status" &&
    (String(lifecycle.value.value) === "fulfilled" ||
      String(lifecycle.value.value) === "cancelled")
  );
}

function commerceSourceSupportsOrderCancellation(
  source: SourceProvenance["source"],
): boolean {
  switch (source) {
    case "lab":
    case "shopify":
    case "commerce":
      return true;
    case "stripe":
      return false;
    default:
      return assertNever(source, "Unhandled commerce graph value");
  }
}

function orderCancellationReason(
  value: string | null,
): OrderCancellationAction["reason"] | null {
  return value === "customer_requested" ||
    value === "fraud_suspected" ||
    value === "inventory_unavailable"
    ? value
    : null;
}

function orderCancellationRefund(
  value: string | null,
): OrderCancellationAction["refund"] | null {
  return value === "full" || value === "none" ? value : null;
}

function formText(formData: FormData, field: string): string | null {
  const value = formData.get(field);
  return typeof value === "string" ? value : null;
}
