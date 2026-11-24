import React from "react";
import { toast } from "sonner";
import type {
  CommerceEntity,
  CommerceListEntry,
} from "@purin-labs/commerce-contracts";

import { Notice } from "@purin-labs/ui/page-components";
import { cancelDialog, DialogHeading, syncDialog } from "@purin-labs/ui/dialog";
import {
  activatePurchasing,
  createSupplier,
  entityTypePageQuery,
  readCommerceGraph,
  reconcilePurchasing,
  updatePurchaseRequest,
  type CommerceGraphFetch,
  type CommerceMutationTransport,
  type PurchaseRequestUpdate,
} from "./api";
import type {
  CommerceCollectionRow,
  CommercePublishedCollectionModel,
} from "./models";
import {
  CommerceBoardEntryDrawer,
  type CommerceBoardListColumn,
  type CommerceBoardListFact,
} from "./board-list";
import {
  supplierIdFromName,
  type PermissionRequired,
} from "@purin-labs/control-api";
import { type SupplierCreation } from "@purin-labs/commerce-control-api";
import {
  PermissionRequiredPrompt,
  permissionRequiredOf,
} from "@purin-labs/area-organisation/ui/features/access/permission-required-prompt";

type PurchasingControlIntent =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "saving"; action: "activate" | "reconcile" | "create" }>
  | Readonly<{ kind: "saved"; message: string }>
  | Readonly<{
      kind: "failed";
      message: string;
      /** The permission that the refusal named, and the save to run again. */
      permission?: Readonly<{
        required: PermissionRequired;
        retry: () => void;
      }> | null;
    }>;

type InventoryItemsState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; items: readonly CommerceEntity[] }>
  | Readonly<{ kind: "failed" }>;

type PurchasingControlsProps = Readonly<{
  organisationId: string;
  active: boolean;
  canManage: boolean;
  canOperate: boolean;
  mutate: CommerceMutationTransport | undefined;
  fetcher: CommerceGraphFetch | undefined;
  refresh: React.Dispatch<React.SetStateAction<number>>;
}>;

/**
 * The purchasing actions for this workspace. The directory itself is the page's
 * content and renders below; adding a supplier is one action here rather than a
 * standing form, because a directory is read far more often than appended to.
 */
export function PurchasingControls(
  props: PurchasingControlsProps,
): React.ReactNode {
  const [intent, setIntent] = React.useState<PurchasingControlIntent>({
    kind: "idle",
  });
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<InventoryItemsState>({
    kind: "loading",
  });
  const [itemsRevision, setItemsRevision] = React.useState(0);
  const error = React.useRef<HTMLParagraphElement>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(syncDialog.bind(null, dialog, open), [open]);
  React.useEffect(focusSupplierError.bind(null, error, open, intent), [
    open,
    intent,
  ]);
  React.useEffect(
    loadInventoryItemsEffect.bind(
      null,
      props.organisationId,
      props.fetcher,
      props.active,
      setItems,
    ),
    [props.organisationId, props.fetcher, props.active, itemsRevision],
  );
  if (props.mutate === undefined) return null;
  if (!props.active) {
    return props.canManage ? (
      <section
        className="commerce-actions"
        aria-labelledby="purchasing-activation-title"
      >
        <div className="commerce-actions-lead">
          <h3 id="purchasing-activation-title">Set up purchasing</h3>
          <p>
            Track who you buy from and what needs reordering. This adds a
            supplier directory and a replenishment queue to this workspace.
          </p>
        </div>
        <button
          type="button"
          className="connection-primary-action"
          disabled={intent.kind === "saving"}
          onClick={activatePurchasingFromPanel.bind(null, props, setIntent)}
        >
          {intent.kind === "saving" ? "Setting up…" : "Set up purchasing"}
        </button>
        {renderPurchasingIntent(intent)}
      </section>
    ) : (
      <Notice tone="warning" announcement="polite">
        A workspace administrator needs to set up purchasing before this page
        can be used.
      </Notice>
    );
  }
  if (!props.canOperate) {
    return (
      <Notice tone="neutral" announcement="polite">
        Your role can view purchasing but cannot change it.
      </Notice>
    );
  }
  const close = closeSupplierDialog.bind(null, setOpen);
  const saving = intent.kind === "saving";
  return (
    <section className="commerce-actions" aria-label="Purchasing actions">
      <div className="commerce-actions-row">
        <button
          type="button"
          className="connection-primary-action"
          onClick={openSupplierDialog.bind(null, setOpen)}
        >
          Add supplier
        </button>
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={reconcilePurchasingFromPanel.bind(null, props, setIntent)}
        >
          {intent.kind === "saving" && intent.action === "reconcile"
            ? "Checking stock…"
            : "Recheck stock"}
        </button>
      </div>
      {open ? null : renderPurchasingIntent(intent)}
      <dialog
        className="access35-dialog"
        ref={dialog}
        aria-labelledby="supplier-creation-title"
        onCancel={cancelDialog.bind(null, close)}
      >
        <form
          onSubmit={submitSupplierFromPanel.bind(
            null,
            props,
            setIntent,
            setOpen,
          )}
        >
          <DialogHeading
            id="supplier-creation-title"
            title="Add supplier"
            close={close}
          />
          <p>
            Record who you buy from, how long they take, and which items they
            supply.
          </p>
          <div className="commerce-dialog-fields">
            <label>
              <span>Supplier name</span>
              <input
                name="displayName"
                required
                autoComplete="off"
                placeholder="Aoyama Packaging Co."
              />
            </label>
            <label>
              <span>Registered name</span>
              <input
                name="legalName"
                required
                autoComplete="off"
                placeholder="Aoyama Packaging Co., Ltd."
              />
            </label>
            <label>
              <span>Contact</span>
              <input name="contactName" autoComplete="off" />
            </label>
            <label>
              <span>Email</span>
              <input name="email" type="email" autoComplete="off" />
            </label>
            <label>
              <span>Phone</span>
              <input name="phone" type="tel" autoComplete="off" />
            </label>
            <label>
              <span>Country</span>
              <input
                name="countryCode"
                maxLength={2}
                placeholder="JP"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Lead time (days)</span>
              <input
                name="leadTimeDays"
                type="number"
                min={0}
                max={365}
                required
                placeholder="5"
              />
            </label>
            <label>
              <span>Minimum order</span>
              <input
                name="minimumOrderQuantity"
                inputMode="decimal"
                placeholder="10"
              />
            </label>
            <label>
              <span>Minimum order unit</span>
              <input
                name="minimumOrderUnit"
                placeholder="case"
                autoComplete="off"
              />
            </label>
          </div>
          <fieldset className="commerce-supplier-items">
            <legend>Items they supply</legend>
            {items.kind === "loading" ? (
              <p role="status">Loading inventory items…</p>
            ) : null}
            {items.kind === "failed" ? (
              <>
                <p role="alert">Inventory items could not be loaded.</p>
                <button
                  type="button"
                  onClick={setItemsRevision.bind(null, incrementRevision)}
                >
                  Try again
                </button>
              </>
            ) : null}
            {items.kind === "ready" && items.items.length === 0 ? (
              <p>Add inventory items before you add a supplier.</p>
            ) : null}
            {items.kind === "ready"
              ? items.items.map(renderInventoryItemChoice)
              : null}
          </fieldset>
          <label>
            <span>Purchasing notes</span>
            <textarea
              name="purchasingNotes"
              rows={3}
              placeholder="Order before Thursday for Monday delivery."
            />
          </label>
          {intent.kind === "failed" ? (
            <p className="error-text" role="alert" ref={error} tabIndex={-1}>
              {intent.message}
            </p>
          ) : null}
          <div className="access35-dialog-actions">
            <button type="button" className="secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="connection-primary-action"
              disabled={
                saving || items.kind !== "ready" || items.items.length === 0
              }
            >
              {saving ? "Adding supplier…" : "Add supplier"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}

function renderInventoryItemChoice(entity: CommerceEntity): React.ReactNode {
  const id = String(entity.reference.entityId);
  return (
    <label key={id}>
      <input
        type="checkbox"
        name="inventoryItemIds"
        value={id}
        defaultChecked={
          new URLSearchParams(window.location.search).get("inventoryItem") ===
          id
        }
      />
      <span>{entity.displayName}</span>
    </label>
  );
}

function focusSupplierError(
  error: React.RefObject<HTMLParagraphElement | null>,
  open: boolean,
  intent: PurchasingControlIntent,
): void {
  if (open && intent.kind === "failed") error.current?.focus();
}

/**
 * Loads the inventory items a supplier can be linked to, so the operator picks
 * from what exists rather than typing identifiers they cannot know.
 */
function loadInventoryItemsEffect(
  organisationId: string,
  fetcher: CommerceGraphFetch | undefined,
  active: boolean,
  setItems: React.Dispatch<React.SetStateAction<InventoryItemsState>>,
): () => void {
  if (!active) return noInventoryCleanup;
  setItems({ kind: "loading" });
  const state = { cancelled: false };
  void loadInventoryItems(organisationId, fetcher, state, setItems);
  return cancelInventoryLoad.bind(null, state);
}

async function loadInventoryItems(
  organisationId: string,
  fetcher: CommerceGraphFetch | undefined,
  state: { cancelled: boolean },
  setItems: React.Dispatch<React.SetStateAction<InventoryItemsState>>,
): Promise<void> {
  try {
    const result = await readCommerceGraph(
      organisationId,
      entityTypePageQuery("inventory_item"),
      fetcher,
    );
    if (!state.cancelled) setItems({ kind: "ready", items: result.entities });
  } catch {
    if (!state.cancelled) setItems({ kind: "failed" });
  }
}

function cancelInventoryLoad(state: { cancelled: boolean }): void {
  state.cancelled = true;
}

function noInventoryCleanup(): void {}

function openSupplierDialog(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(true);
}

function closeSupplierDialog(
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setOpen(false);
}

/**
 * The list row of one purchase request: the supplier under the item, then the
 * amount, the due day and who orders it.
 */
export function purchaseRequestRowSummary(
  entry: CommerceListEntry,
  /** The value as the board shows it, or "" when the entry has none. */
  text: (attributeId: string) => string,
): Readonly<{
  secondary: string | null;
  columns: readonly CommerceBoardListColumn[];
}> {
  const supplier = text("supplier_id");
  const required = text("required_quantity");
  const owner = text("owner");
  return {
    secondary: supplier.length === 0 ? null : supplier,
    columns: [
      {
        id: "required_quantity",
        text:
          required.length === 0
            ? "—"
            : `${required} ${text("quantity_unit")}`.trim(),
        numeric: true,
      },
      {
        id: "expected_delivery_at",
        text: purchaseRequestDue(entry),
        numeric: false,
      },
      {
        id: "owner",
        text: owner.length === 0 ? "No owner yet" : owner,
        numeric: false,
      },
    ],
  };
}

/** "Due 3 Sep", or that the request has no date yet. */
function purchaseRequestDue(entry: CommerceListEntry): string {
  const delivery = listEntryLocalTimestamp(entry, "expected_delivery_at");
  if (delivery.length === 0) return "No date yet";
  const day = new Date(delivery).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return `Due ${day}`;
}

/** The facts that the order form edits, so the drawer shows them one time. */
const ORDER_FORM_FACTS: ReadonlySet<string> = new Set([
  "owner",
  "expected_delivery_at",
  "notes",
]);

/**
 * One purchase request in a drawer: its facts, its lane and, for a person who
 * may operate purchasing, the order: who orders it, the expected delivery and
 * notes, saved from the footer.
 */
export function PurchaseRequestDrawer(
  props: Readonly<{
    open: boolean;
    close: () => void;
    model: CommercePublishedCollectionModel;
    row: CommerceCollectionRow;
    href: string | null;
    facts: readonly CommerceBoardListFact[];
    laneControl: React.ReactNode;
    organisationId: string;
    canOperate: boolean;
    mutate: CommerceMutationTransport | undefined;
    refresh: React.Dispatch<React.SetStateAction<number>>;
  }>,
): React.ReactNode {
  const [intent, setIntent] = React.useState<PurchasingControlIntent>({
    kind: "idle",
  });
  const formId = React.useId();
  const canOrder =
    props.model.list !== null && props.canOperate && props.mutate !== undefined;
  const saving = intent.kind === "saving";
  return (
    <CommerceBoardEntryDrawer
      open={props.open}
      close={props.close}
      title={props.row.entity.displayName}
      href={props.href}
      facts={
        canOrder
          ? props.facts.filter(isNotOrderFormFact)
          : props.facts
      }
      laneControl={props.laneControl}
      footer={
        canOrder ? (
          <button
            type="submit"
            form={formId}
            className="connection-primary-action"
            disabled={saving}
          >
            {saving ? "Saving…" : "Save order"}
          </button>
        ) : undefined
      }
    >
      {canOrder ? (
        <form
          id={formId}
          className="commerce-order-form"
          aria-label={`Order ${props.row.entity.displayName}`}
          onSubmit={submitPurchaseRequestCard.bind(
            null,
            { ...props, saved: props.close },
            setIntent,
          )}
        >
          <label>
            <span>Who is ordering</span>
            <input
              name="owner"
              required
              autoComplete="off"
              defaultValue={listEntryText(props.row.entry, "owner")}
            />
          </label>
          <label>
            <span>Expected delivery</span>
            <input
              name="expectedDeliveryAt"
              type="datetime-local"
              defaultValue={listEntryLocalTimestamp(
                props.row.entry,
                "expected_delivery_at",
              )}
            />
          </label>
          <label>
            <span>Notes</span>
            <textarea
              name="notes"
              rows={3}
              defaultValue={listEntryText(props.row.entry, "notes")}
            />
          </label>
          {renderPurchasingIntent(intent, props.organisationId, setIntent)}
        </form>
      ) : null}
    </CommerceBoardEntryDrawer>
  );
}

function isNotOrderFormFact(fact: CommerceBoardListFact): boolean {
  return !ORDER_FORM_FACTS.has(fact.id);
}

/**
 * The purchase request needs a stable identifier, but an operator has no way to
 * know one. An existing request keeps its identifier; a new one takes the
 * queue entry's, which is already unique per requirement.
 */
function purchaseRequestIdFor(entry: CommerceListEntry): string {
  const existing = listEntryText(entry, "purchase_request_id");
  return existing.length > 0 ? existing : `pr-${String(entry.entryId)}`;
}

async function activatePurchasingFromPanel(
  props: PurchasingControlsProps,
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
): Promise<void> {
  if (props.mutate === undefined) return;
  setIntent({ kind: "saving", action: "activate" });
  try {
    await activatePurchasing(props.organisationId, props.mutate);
    setIntent({ kind: "idle" });
    toast.success("Purchasing is ready.");
    props.refresh(incrementRevision);
  } catch (error) {
    setIntent({ kind: "failed", message: purchasingErrorMessage(error) });
  }
}

async function reconcilePurchasingFromPanel(
  props: PurchasingControlsProps,
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
): Promise<void> {
  if (props.mutate === undefined) return;
  setIntent({ kind: "saving", action: "reconcile" });
  try {
    await reconcilePurchasing(props.organisationId, props.mutate);
    setIntent({ kind: "idle" });
    toast.success("Stock checked. The queue is up to date.");
    props.refresh(incrementRevision);
  } catch (error) {
    setIntent({ kind: "failed", message: purchasingErrorMessage(error) });
  }
}

async function submitSupplierFromPanel(
  props: PurchasingControlsProps,
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
  setOpen: React.Dispatch<React.SetStateAction<boolean>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  if (props.mutate === undefined) return;
  const form = event.currentTarget;
  let supplier: SupplierCreation;
  try {
    supplier = supplierCreationFromForm(new FormData(form));
  } catch (error) {
    setIntent({ kind: "failed", message: purchasingErrorMessage(error) });
    return;
  }
  setIntent({ kind: "saving", action: "create" });
  try {
    await createSupplier(props.organisationId, supplier, props.mutate);
    form.reset();
    setIntent({ kind: "idle" });
    setOpen(false);
    toast.success(`${supplier.displayName} was added.`);
    props.refresh(incrementRevision);
  } catch (error) {
    // The dialog stays open so the operator keeps everything they typed.
    setIntent({ kind: "failed", message: purchasingErrorMessage(error) });
  }
}

async function submitPurchaseRequestCard(
  props: Readonly<{
    model: CommercePublishedCollectionModel;
    row: CommerceCollectionRow;
    organisationId: string;
    mutate: CommerceMutationTransport | undefined;
    refresh: React.Dispatch<React.SetStateAction<number>>;
    /** Closes the drawer. A refused save keeps it open with the edits. */
    saved: () => void;
  }>,
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const list = props.model.list;
  if (list === null || props.mutate === undefined) return;
  let update: PurchaseRequestUpdate;
  try {
    update = purchaseRequestUpdateFromForm(
      new FormData(event.currentTarget),
      purchaseRequestIdFor(props.row.entry),
    );
  } catch (error) {
    setIntent({ kind: "failed", message: purchasingErrorMessage(error) });
    return;
  }
  await savePurchaseRequest(props, setIntent, update);
}

async function savePurchaseRequest(
  props: Parameters<typeof submitPurchaseRequestCard>[0],
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
  update: PurchaseRequestUpdate,
): Promise<void> {
  const list = props.model.list;
  if (list === null || props.mutate === undefined) return;
  setIntent({ kind: "saving", action: "reconcile" });
  try {
    await updatePurchaseRequest(
      props.organisationId,
      list,
      props.row.entry,
      update,
      props.mutate,
    );
    setIntent({ kind: "idle" });
    props.saved();
    toast.success("Order saved.");
    props.refresh(incrementRevision);
  } catch (error) {
    const permission = permissionRequiredOf(error);
    setIntent({
      kind: "failed",
      message:
        permission === null
          ? purchasingErrorMessage(error)
          : "Saving this order needs a permission that was not allowed.",
      permission:
        permission === null
          ? null
          : {
              required: permission,
              retry: retryPurchaseRequest.bind(null, props, setIntent, update),
            },
    });
  }
}

function retryPurchaseRequest(
  props: Parameters<typeof submitPurchaseRequestCard>[0],
  setIntent: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
  update: PurchaseRequestUpdate,
): void {
  void savePurchaseRequest(props, setIntent, update);
}

function supplierCreationFromForm(form: FormData): SupplierCreation {
  const displayName = requiredFormText(
    form,
    "displayName",
    "Enter the supplier's name.",
  );
  const inventoryItemIds = form
    .getAll("inventoryItemIds")
    .filter(isInventoryItemField)
    .map(normalizeInventoryItemId)
    .filter(nonemptyText);
  if (inventoryItemIds.length === 0) {
    throw new Error("Choose at least one item this supplier provides.");
  }
  if (new Set(inventoryItemIds).size !== inventoryItemIds.length) {
    throw new Error("Each item can only be listed once.");
  }
  const leadTimeDays = Number(
    requiredFormText(
      form,
      "leadTimeDays",
      "Enter how many days this supplier takes to deliver.",
    ),
  );
  if (
    !Number.isSafeInteger(leadTimeDays) ||
    leadTimeDays < 0 ||
    leadTimeDays > 365
  ) {
    throw new Error(
      "Lead time must be a whole number of days between 0 and 365.",
    );
  }
  const minimumOrderQuantity = optionalFormText(form, "minimumOrderQuantity");
  const minimumOrderUnit = optionalFormText(form, "minimumOrderUnit");
  if ((minimumOrderQuantity === null) !== (minimumOrderUnit === null)) {
    throw new Error(
      "Enter both the minimum order amount and its unit, or neither.",
    );
  }
  return {
    supplierId: requiredSupplierId(displayName),
    displayName,
    legalName: requiredFormText(
      form,
      "legalName",
      "Enter the supplier's registered name.",
    ),
    countryCode: optionalFormText(form, "countryCode"),
    contactName: optionalFormText(form, "contactName"),
    email: optionalFormText(form, "email"),
    phone: optionalFormText(form, "phone"),
    leadTimeDays,
    minimumOrderQuantity,
    minimumOrderUnit,
    purchasingNotes: optionalFormText(form, "purchasingNotes"),
    inventoryItemIds,
  };
}

function purchaseRequestUpdateFromForm(
  form: FormData,
  purchaseRequestId: string,
): PurchaseRequestUpdate {
  const expectedDelivery = optionalFormText(form, "expectedDeliveryAt");
  const expectedDeliveryAt =
    expectedDelivery === null ? null : new Date(expectedDelivery).toISOString();
  return {
    owner: requiredFormText(form, "owner", "Enter who is placing this order."),
    purchaseRequestId,
    expectedDeliveryAt,
    notes: optionalFormText(form, "notes"),
  };
}

function requiredFormText(
  form: FormData,
  field: string,
  message: string,
): string {
  const value = optionalFormText(form, field);
  if (value === null) throw new Error(message);
  return value;
}

function requiredSupplierId(displayName: string): string {
  const supplierId = supplierIdFromName(displayName);
  if (supplierId === null)
    throw new Error("Enter a supplier name that contains letters or numbers.");
  return supplierId;
}

function isInventoryItemField(value: FormDataEntryValue): value is string {
  return typeof value === "string";
}

function optionalFormText(form: FormData, field: string): string | null {
  const value = form.get(field);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function listEntryText(entry: CommerceListEntry, attributeId: string): string {
  const attribute = entry.attributeValues.find(
    listEntryAttributeHasId.bind(null, attributeId),
  );
  if (attribute === undefined) return "";
  return attribute.value.kind === "short_text" ||
    attribute.value.kind === "long_text"
    ? attribute.value.value
    : "";
}

function listEntryLocalTimestamp(
  entry: CommerceListEntry,
  attributeId: string,
): string {
  const attribute = entry.attributeValues.find(
    listEntryAttributeHasId.bind(null, attributeId),
  );
  if (attribute === undefined || attribute.value.kind !== "timestamp")
    return "";
  const instant = new Date(attribute.value.value);
  const local = new Date(
    instant.getTime() - instant.getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}

function listEntryAttributeHasId(
  attributeId: string,
  attribute: CommerceListEntry["attributeValues"][number],
): boolean {
  return attribute.attributeId === attributeId;
}

function normalizeInventoryItemId(value: string): string {
  return value.trim();
}

function nonemptyText(value: string): boolean {
  return value.length > 0;
}

function incrementRevision(value: number): number {
  return value + 1;
}

function renderPurchasingIntent(
  intent: PurchasingControlIntent,
  organisationId?: string,
  setIntent?: React.Dispatch<React.SetStateAction<PurchasingControlIntent>>,
): React.ReactNode {
  if (intent.kind === "idle" || intent.kind === "saving") return null;
  return intent.kind === "saved" ? (
    <Notice tone="success" announcement="polite">
      {intent.message}
    </Notice>
  ) : (
    <Notice tone="warning" announcement="polite">
      {intent.message}
      {intent.permission != null &&
      organisationId !== undefined &&
      setIntent !== undefined ? (
        <PermissionRequiredPrompt
          organisationId={organisationId}
          permission={intent.permission.required}
          action="Saving this order"
          grantScope="for this entry only"
          onAllowed={intent.permission.retry}
          onClose={setIntent.bind(null, { ...intent, permission: null })}
        />
      ) : null}
    </Notice>
  );
}

function purchasingErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Purchasing could not be updated. Try again.";
}
