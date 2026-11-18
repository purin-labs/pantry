import { parseInventory, type InventoryData } from "@seams/contracts";
import { MEDIA_CONTENT_TYPES, MEDIA_MAX_BYTES } from "@seams/commerce-client";
import { ArrowLeft, ArrowRight, ImagePlus, Trash2 } from "lucide-react";
import React from "react";
import { toast } from "sonner";
import {
  ControlApiError,
  controlMutation,
  controlRead,
  controlUpload,
} from "../../../control-client";
import { formatMoneyMinor } from "../../../formatting";

type SaleDetails = InventoryData["untrackedProducts"][number] | null;
type PhotoWork = Readonly<
  { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string }
>;
type Attempt = Readonly<{ key: string; fingerprint: string }>;
/** Where focus goes once a change ends, because saving disables the buttons. */
type FocusTarget =
  Readonly<{ mediaId: string; control: "earlier" | "later" }> | "add" | null;

const PHOTO_RULE =
  "Choose a JPEG, PNG, WebP, AVIF or GIF photo of 20 MB or less.";

/**
 * What a buyer sees for one product: its photos, its description and its
 * price. The commerce graph has no attributes for a product, so this reads the
 * same stock overview as the Products page. It shows nothing while it reads
 * and nothing when the product is not on sale. An owner or admin adds,
 * reorders and removes the photos here.
 */
export function ProductSaleDetails(
  props: Readonly<{
    organisationId: string;
    productId: string;
    canEdit: boolean;
  }>,
): React.ReactNode {
  const [details, setDetails] = React.useState<SaleDetails>(null);
  const [work, setWork] = React.useState<PhotoWork>({ kind: "idle" });
  const latest = React.useRef<SaleDetails>(null);
  const attempt = React.useRef<Attempt | null>(null);
  const focusAfter = React.useRef<FocusTarget>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const gallery = React.useRef<HTMLDivElement>(null);
  const show = React.useCallback((next: SaleDetails) => {
    latest.current = next;
    setDetails(next);
  }, []);
  React.useEffect(() => {
    let current = true;
    readSaleDetails(props.organisationId, props.productId).then(
      (next) => {
        if (current) show(next);
      },
      () => {
        if (current) show(null);
      },
    );
    return () => {
      current = false;
    };
  }, [props.organisationId, props.productId, show]);
  React.useLayoutEffect(() => {
    const target = focusAfter.current;
    if (target === null || work.kind === "saving") return;
    focusAfter.current = null;
    const root = gallery.current;
    if (root === null) return;
    const buttons =
      target === "add"
        ? root.querySelectorAll<HTMLButtonElement>("[data-photo-add]")
        : root.querySelectorAll<HTMLButtonElement>(
            `[data-photo="${CSS.escape(target.mediaId)}"]`,
          );
    const preferred = [...buttons].find(
      (button) =>
        !button.disabled &&
        (target === "add" || button.dataset.control === target.control),
    );
    (preferred ?? [...buttons].find((button) => !button.disabled))?.focus();
  }, [details, work]);

  async function change(
    run: (idempotencyKey: string) => Promise<unknown>,
    fingerprint: string,
  ): Promise<boolean> {
    // The same change keeps one key, so a retry after a lost answer replays.
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { key: `portal-${crypto.randomUUID()}`, fingerprint };
    setWork({ kind: "saving" });
    let failure: unknown = null;
    try {
      await run(attempt.current.key);
      attempt.current = null;
    } catch (error) {
      failure = error;
    }
    // A refusal for an older view shows the newer photos with the message.
    if (failure === null || staleChange(failure))
      show(
        await readSaleDetails(props.organisationId, props.productId).catch(
          () => latest.current,
        ),
      );
    setWork(
      failure === null
        ? { kind: "idle" }
        : { kind: "failed", message: photoFailure(failure) },
    );
    return failure === null;
  }
  function arrange(
    product: NonNullable<SaleDetails>,
    mediaIds: readonly string[],
  ): Promise<boolean> {
    const body = {
      productId: product.productId,
      expectedPhotoRevision: product.photos.revision,
      mediaIds,
    };
    return change(
      (idempotencyKey) =>
        controlMutation(
          photoPath(props.organisationId, "arrange"),
          "POST",
          body,
          undefined,
          { kind: "prepared", idempotencyKey },
        ),
      JSON.stringify(["arrange", body]),
    );
  }
  function move(index: number, offset: -1 | 1): void {
    const product = latest.current;
    if (product === null) return;
    const ids = product.photos.items.map((photo) => photo.mediaId);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + offset, 0, moved);
    focusAfter.current = {
      mediaId: moved,
      control: offset < 0 ? "earlier" : "later",
    };
    void arrange(product, ids);
  }
  async function remove(index: number): Promise<void> {
    const product = latest.current;
    if (product === null) return;
    const before = product.photos.items.map((photo) => photo.mediaId);
    focusAfter.current = "add";
    if (
      await arrange(
        product,
        before.filter((_, position) => position !== index),
      )
    )
      toast.success("Photo removed.", {
        action: {
          label: "Undo",
          onClick: () => {
            const now = latest.current;
            if (now !== null) void arrange(now, before);
          },
        },
      });
  }
  async function add(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const product = latest.current;
    if (file === undefined || product === null) return;
    if (
      !(MEDIA_CONTENT_TYPES as readonly string[]).includes(file.type) ||
      file.size > MEDIA_MAX_BYTES
    ) {
      setWork({ kind: "failed", message: PHOTO_RULE });
      return;
    }
    focusAfter.current = "add";
    const added = await change(
      (idempotencyKey) => {
        const form = new FormData();
        form.set("productId", product.productId);
        form.set("expectedPhotoRevision", String(product.photos.revision));
        form.set("altText", product.productTitle);
        form.set("photo", file);
        return controlUpload(
          photoPath(props.organisationId, "add"),
          form,
          idempotencyKey,
        );
      },
      JSON.stringify([
        "add",
        product.productId,
        product.photos.revision,
        file.name,
        file.size,
        file.lastModified,
      ]),
    );
    if (added) toast.success("Photo added.");
  }

  if (details === null) return null;
  const photos = details.photos.items;
  const saving = work.kind === "saving";
  return (
    <div className="product-sale-details">
      {photos.length === 0 && !props.canEdit ? null : (
        <div className="product-photos" ref={gallery}>
          {photos.length === 0 ? (
            <p>No photos yet. Buyers see the photos that you add here.</p>
          ) : (
            <ol className="product-photo-list" aria-label="Photos">
              {photos.map((photo, index) => (
                <li key={photo.mediaId} className="product-photo">
                  <img
                    src={photo.url}
                    alt={
                      photo.altText.length > 0
                        ? photo.altText
                        : details.productTitle
                    }
                  />
                  {index === 0 && photos.length > 1 ? (
                    <span className="product-photo-main">Main photo</span>
                  ) : null}
                  {props.canEdit ? (
                    <span className="product-photo-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move photo ${index + 1} earlier`}
                        title="Move earlier"
                        data-photo={photo.mediaId}
                        data-control="earlier"
                        disabled={saving || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowLeft size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Move photo ${index + 1} later`}
                        title="Move later"
                        data-photo={photo.mediaId}
                        data-control="later"
                        disabled={saving || index === photos.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowRight size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove photo ${index + 1}`}
                        title="Remove"
                        data-photo={photo.mediaId}
                        data-control="remove"
                        disabled={saving}
                        onClick={() => void remove(index)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          {props.canEdit ? (
            <div className="product-photo-add">
              <input
                ref={fileInput}
                type="file"
                accept={MEDIA_CONTENT_TYPES.join(",")}
                hidden
                onChange={(event) => void add(event)}
              />
              <button
                type="button"
                className="secondary"
                data-photo-add
                disabled={saving}
                onClick={() => fileInput.current?.click()}
              >
                <ImagePlus size={16} aria-hidden="true" />
                {saving ? "Saving…" : "Add photo"}
              </button>
              {photos.length > 1 ? (
                <span>
                  The main photo shows in lists. Buyers see the photos in this
                  order.
                </span>
              ) : null}
            </div>
          ) : null}
          {work.kind === "failed" ? (
            <p className="product-photos-notice" role="alert">
              {work.message}
            </p>
          ) : null}
        </div>
      )}
      <div>
        <strong>
          {formatMoneyMinor(details.price.amountMinor, details.price.currency)}
        </strong>
        {details.description.length === 0 ? null : <p>{details.description}</p>}
      </div>
    </div>
  );
}

async function readSaleDetails(
  organisationId: string,
  productId: string,
): Promise<SaleDetails> {
  const data = parseInventory(
    await controlRead(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/inventory`,
    ),
  );
  for (const product of data.untrackedProducts)
    if (product.productId === productId) return product;
  for (const row of data.rows)
    if (row.kind === "product" && row.product.productId === productId)
      return { ...row.product, name: row.name, madeToOrder: false };
  return null;
}

function photoPath(organisationId: string, action: "add" | "arrange"): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/products/photos/${action}`;
}

function staleChange(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "error" in error.details &&
    error.details.error === "stale_resource_revision"
  );
}

function photoFailure(error: unknown): string {
  if (staleChange(error))
    return "Someone changed these photos. Check them and try again.";
  if (
    error instanceof ControlApiError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "error" in error.details &&
    error.details.error === "product_photo_invalid"
  )
    return PHOTO_RULE;
  return "The photos couldn’t be saved. Try again.";
}
