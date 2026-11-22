import React from "react";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import type { CommerceMutationTransport } from "./entity-plane/api";

/** What the Products page knows about one product when a person acts on it. */
export type ProductRecord = Readonly<{
  productId: string;
  title: string;
  revision: number;
  status: "active" | "archived";
  deleteBlock: "sold" | "on_menu" | null;
  /** The row's variant and price; an archived row has no edit form. */
  sale: Readonly<{
    description: string;
    variantId: string;
    variantTitle: string;
    variantRevision: number;
    offerId: string;
    offerRevision: number;
    price: Readonly<{ amountMinor: number; currency: string }>;
  }> | null;
}>;
export type ProductAction = "edit" | "archive" | "restore" | "delete";

type Props = Readonly<{
  organisationId: string;
  product: ProductRecord;
  action: ProductAction;
  mutate: CommerceMutationTransport;
  close: () => void;
  changed: () => void;
  switchAction: (action: ProductAction) => void;
}>;
type Attempt = Readonly<{ key: string; fingerprint: string }>;

const TITLES: Record<ProductAction, string> = {
  edit: "Edit product",
  archive: "Archive product",
  restore: "Restore product",
  delete: "Delete product",
};
const BLOCKS = {
  sold: "has order history, so it can’t be deleted. Archive it to take it off sale.",
  on_menu:
    "is on the published menu, so it can’t be deleted. Remove it from the menu first, or archive it.",
};
const REFUSALS: Record<string, string> = {
  sold: `This product ${BLOCKS.sold}`,
  on_menu: `This product ${BLOCKS.on_menu}`,
  open_checkout:
    "A customer is paying for it now. Try again when the checkout has closed.",
  reserved_stock:
    "Some of its stock is reserved. Try again when the reservation has ended.",
  draft_order: "A draft order includes it. Remove it from the draft first.",
  price_list:
    "A market or company price list includes it. Remove it there first.",
  discount: "A discount names it. Remove it from the discount first.",
  linked_record:
    "Another record links to it. Remove the link first, or archive the product.",
};

function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}
function priceText(amountMinor: number, digits: number): string {
  return (amountMinor / 10 ** digits).toFixed(digits);
}
function parsePrice(text: string, digits: number): number | null {
  const pattern =
    digits === 0 ? /^\d+$/u : new RegExp(`^\\d+(\\.\\d{1,${digits}})?$`, "u");
  const trimmed = text.trim();
  if (!pattern.test(trimmed)) return null;
  const minor = Math.round(Number(trimmed) * 10 ** digits);
  return Number.isSafeInteger(minor) ? minor : null;
}
function failureMessage(error: unknown): string {
  if (error instanceof ControlApiError && typeof error.details === "object") {
    const details = error.details as Readonly<{
      error?: unknown;
      reason?: unknown;
    }> | null;
    if (typeof details?.reason === "string")
      return REFUSALS[details.reason] ?? "This product can’t be deleted now.";
    if (details?.error === "stale_resource_revision")
      return "Someone changed this product. Close this window and try again.";
    if (details?.error === "resource_already_exists")
      return "Another product already uses this name’s address.";
  }
  return "The change couldn’t be saved. Try again.";
}
function productCatalogPath(
  organisationId: string,
  action: "edit" | "status" | "delete",
): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/products/${action}`;
}

/** The dialog behind the row menu on the Products page. */
export function ProductActionDialog(props: Props): React.ReactNode {
  const { product, action } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const attempt = React.useRef<Attempt | null>(null);
  const sale = product.sale;
  const digits = sale === null ? 0 : currencyDigits(sale.price.currency);
  const [title, setTitle] = React.useState(product.title);
  const [description, setDescription] = React.useState(sale?.description ?? "");
  const [price, setPrice] = React.useState(
    sale === null ? "" : priceText(sale.price.amountMinor, digits),
  );
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  React.useEffect(() => {
    syncDialog(dialog, true);
    return () => syncDialog(dialog, false);
  }, []);
  React.useEffect(() => setMessage(null), [action]);

  async function send(
    path: "edit" | "status" | "delete",
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    // The same request under one key, so a retry after a lost answer replays.
    const fingerprint = JSON.stringify([path, body]);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = {
        key: `portal-${crypto.randomUUID()}`,
        fingerprint,
      };
    setSaving(true);
    setMessage(null);
    try {
      await props.mutate(productCatalogPath(props.organisationId, path), body, {
        kind: "prepared",
        idempotencyKey: attempt.current.key,
      });
      props.changed();
      props.close();
    } catch (error) {
      setMessage(failureMessage(error));
      setSaving(false);
    }
  }
  function submitEdit(event: React.FormEvent): void {
    event.preventDefault();
    if (sale === null) return;
    const name = title.trim();
    const minor = parsePrice(price, digits);
    if (name.length === 0) {
      setMessage("Enter a product name.");
      return;
    }
    if (minor === null) {
      setMessage("Enter the price as a number.");
      return;
    }
    const renamed = name !== product.title;
    const redescribed = description !== sale.description;
    const repriced = minor !== sale.price.amountMinor;
    if (!renamed && !redescribed && !repriced) {
      props.close();
      return;
    }
    void send("edit", {
      productId: product.productId,
      expectedProductRevision: product.revision,
      title: renamed ? name : null,
      description: redescribed ? description : null,
      // A single-variant product shows the variant's name as its own.
      variant:
        renamed && sale.variantTitle === product.title
          ? {
              variantId: sale.variantId,
              expectedRevision: sale.variantRevision,
              title: name,
            }
          : null,
      offer: repriced
        ? {
            offerId: sale.offerId,
            expectedRevision: sale.offerRevision,
            amountMinor: minor,
            currency: sale.price.currency,
          }
        : null,
    });
  }
  function submitStatus(status: "active" | "archived"): void {
    void send("status", {
      productId: product.productId,
      expectedProductRevision: product.revision,
      status,
    });
  }
  function submitDelete(): void {
    void send("delete", {
      productId: product.productId,
      expectedProductRevision: product.revision,
    });
  }

  const notice =
    message === null ? null : (
      <p className="stock-dialog-notice" role="alert">
        {message}
      </p>
    );
  const cancel = (
    <button type="button" onClick={props.close} disabled={saving}>
      Cancel
    </button>
  );
  return (
    <dialog
      ref={dialog}
      className="stock-dialog"
      aria-labelledby="product-action-heading"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <DialogHeading
        id="product-action-heading"
        title={TITLES[action]}
        close={props.close}
      />
      {action === "edit" && sale !== null ? (
        <form className="stock-dialog-form" onSubmit={submitEdit}>
          <div className="stock-dialog-body">
            {notice}
            <fieldset className="stock-dialog-fields" disabled={saving}>
              <label className="stock-dialog-full-width">
                Name
                <input
                  value={title}
                  maxLength={255}
                  required
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label className="stock-dialog-full-width">
                Description
                <textarea
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className="stock-dialog-full-width">
                Price ({sale.price.currency})
                <input
                  value={price}
                  inputMode={digits === 0 ? "numeric" : "decimal"}
                  required
                  onChange={(event) => setPrice(event.target.value)}
                />
              </label>
            </fieldset>
          </div>
          <footer className="stock-dialog-actions">
            {cancel}
            <button
              type="submit"
              className="connection-primary-action"
              disabled={saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </footer>
        </form>
      ) : null}
      {action === "archive" ? (
        <>
          <div className="stock-dialog-body">
            {notice}
            <p>
              <strong>{product.title}</strong> leaves the shop and the menu. Its
              orders and stock stay, and you can restore it from Archived.
            </p>
          </div>
          <footer className="stock-dialog-actions">
            {cancel}
            <button
              type="button"
              className="connection-primary-action"
              disabled={saving}
              onClick={() => submitStatus("archived")}
            >
              {saving ? "Archiving…" : "Archive product"}
            </button>
          </footer>
        </>
      ) : null}
      {action === "restore" ? (
        <>
          <div className="stock-dialog-body">
            {notice}
            <p>
              <strong>{product.title}</strong> goes back on sale wherever its
              price is still listed.
            </p>
          </div>
          <footer className="stock-dialog-actions">
            {cancel}
            <button
              type="button"
              className="connection-primary-action"
              disabled={saving}
              onClick={() => submitStatus("active")}
            >
              {saving ? "Restoring…" : "Restore product"}
            </button>
          </footer>
        </>
      ) : null}
      {action === "delete" ? (
        <>
          <div className="stock-dialog-body">
            {notice}
            {product.deleteBlock === null ? (
              <p>
                This permanently deletes <strong>{product.title}</strong> and
                its prices. Any stock of it leaves your stock list. You can’t
                undo this.
              </p>
            ) : (
              <p>
                <strong>{product.title}</strong> {BLOCKS[product.deleteBlock]}
              </p>
            )}
          </div>
          <footer className="stock-dialog-actions">
            {product.deleteBlock === null ? (
              <>
                {cancel}
                <button
                  type="button"
                  className="danger"
                  disabled={saving}
                  onClick={submitDelete}
                >
                  {saving ? "Deleting…" : "Delete product"}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={props.close}>
                  Close
                </button>
                {product.status === "active" ? (
                  <button
                    type="button"
                    className="connection-primary-action"
                    onClick={() => props.switchAction("archive")}
                  >
                    Archive product
                  </button>
                ) : null}
              </>
            )}
          </footer>
        </>
      ) : null}
    </dialog>
  );
}
