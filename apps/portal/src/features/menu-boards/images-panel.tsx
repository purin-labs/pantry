import React from "react";
import { ImagePlus, Plus, Trash2 } from "lucide-react";
import {
  MENU_BOARD_DEFAULT_CONSTRAINTS,
  MENU_BOARD_LAYOUTS,
  MENU_BOARD_SCREEN_SIZES,
  isMenuBoardMediaId,
  type MenuBoardElement,
  type MenuBoardLayout,
  type MenuBoardRect,
} from "@seams/menu-board-crdt/board";
import { isRecord } from "@seams/std";
import { controlAnswer, controlRead, controlUpload, controlWrite } from "../../control-client";
import { controlPath } from "./menu-board-requests";
import "./images-panel.css";

/**
 * The Images panel of the board editor (Plan 40B, the image element). It
 * lists the shop's media library, the same images that the Products page
 * shows on products, and an admin uploads a new one here. A person drags an
 * image onto a free canvas, or presses its +, and the board shows it in a
 * rect; the inspector names it and sets how it fills the rect.
 */

/** What an image drag carries. */
export const IMAGE_DRAG_TYPE = "application/x-satyr-board-image";

export type ShopImage = Readonly<{ mediaId: string; altText: string; url: string | null }>;

type ShopImages = Readonly<{
  /** Where the shop serves its media, ending in "/"; null with no shop. */
  mediaBase: string | null;
  images: readonly ShopImage[];
  state: "loading" | "ready" | "failed";
  reload: () => Promise<void>;
}>;

/** The shop's images, read once and again after an upload. */
export function useShopImages(organisationId: string): ShopImages {
  const [read, setRead] = React.useState<Omit<ShopImages, "reload">>({ mediaBase: null, images: [], state: "loading" });
  const reload = React.useCallback(async () => {
    // A fresh read, so that an upload shows at once.
    const answer = await controlAnswer(controlRead(controlPath(organisationId, "commerce/media"), new AbortController().signal));
    setRead(answer.ok ? parseShopImages(answer.body) : { mediaBase: null, images: [], state: "failed" });
  }, [organisationId]);
  React.useEffect(() => {
    void reload();
  }, [reload]);
  return { ...read, reload };
}

function parseShopImages(raw: unknown): Omit<ShopImages, "reload"> {
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.images)) return { mediaBase: null, images: [], state: "failed" };
  const mediaBase = typeof raw.mediaBase === "string" && raw.mediaBase.endsWith("/") ? raw.mediaBase : null;
  const images: ShopImage[] = [];
  for (const item of raw.images) {
    if (!isRecord(item) || !isMenuBoardMediaId(item.mediaId) || typeof item.altText !== "string") continue;
    images.push({ mediaId: item.mediaId, altText: item.altText, url: typeof item.url === "string" ? item.url : null });
  }
  return { mediaBase, images, state: "ready" };
}

export function ImagesPanel(props: Readonly<{
  organisationId: string;
  shop: ShopImages;
  editable: boolean;
  onAdd: (image: ShopImage) => void;
}>): React.ReactNode {
  const [upload, setUpload] = React.useState<"idle" | "uploading" | "failed" | "refused">("idle");
  // Image removal: the image that waits for its second click, and the
  // answer of the last delete.
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [removal, setRemoval] = React.useState<Readonly<{ busy: boolean; message: string | null }>>({ busy: false, message: null });
  const remove = async (image: ShopImage): Promise<void> => {
    setRemoval({ busy: true, message: null });
    const answer = await controlAnswer(controlWrite(
      controlPath(props.organisationId, "commerce/media/delete"),
      "POST",
      { mediaId: image.mediaId },
    ));
    setConfirming(null);
    if (answer.ok) {
      setRemoval({ busy: false, message: null });
      await props.shop.reload();
      return;
    }
    const body = isRecord(answer.body) ? answer.body : {};
    const boards = Array.isArray(body.boards) ? body.boards.filter((title): title is string => typeof title === "string") : [];
    setRemoval({
      busy: false,
      message: body.error === "media_on_board"
        ? `A board shows this image: ${boards.join(", ")}. Take it off the board first.`
        : body.error === "media_on_product"
          ? "A product shows this image. Take it off the product on the Products page first."
          : answer.status === 403 || answer.status === 404 && body.error !== "media_missing"
            ? "Only admins and owners can delete images."
            : "The image could not be deleted. Try again.",
    });
  };
  const input = React.useRef<HTMLInputElement | null>(null);
  const send = async (file: File): Promise<void> => {
    setUpload("uploading");
    const form = new FormData();
    form.set("altText", file.name.replace(/\.[^.]+$/u, "").replace(/[-_]+/gu, " ").trim());
    form.set("photo", file);
    const answer = await controlAnswer(controlUpload(controlPath(props.organisationId, "commerce/media/add"), form, `portal-${crypto.randomUUID()}`));
    if (!answer.ok) {
      setUpload(answer.status === 403 ? "refused" : "failed");
      return;
    }
    setUpload("idle");
    await props.shop.reload();
  };
  return <section className="menu-board-images" aria-label="Images">
    <button
      type="button"
      className="menu-board-images-upload"
      disabled={!props.editable || upload === "uploading"}
      onClick={() => input.current?.click()}
    >
      <ImagePlus size={15} aria-hidden="true" />
      {upload === "uploading" ? "Uploading…" : "Upload an image"}
    </button>
    <input
      ref={input}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
      hidden
      aria-label="Image file"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file !== undefined) void send(file);
      }}
    />
    {upload === "failed" ? <p className="description-draft-error" role="alert">The image could not be uploaded. Use a PNG, JPEG, WebP, AVIF or GIF file of at most 20 MB.</p> : null}
    {upload === "refused" ? <p className="description-draft-error" role="alert">Only admins and owners can upload images.</p> : null}
    {props.shop.state === "failed" ? <p className="description-draft-error" role="alert">The shop's images could not be loaded.</p> : null}
    {removal.message === null ? null : <p className="description-draft-error" role="alert">{removal.message}</p>}
    <ul className="menu-board-images-grid">
      {props.shop.images.map((image) => <li
        key={image.mediaId}
        className="menu-board-image-tile"
        draggable={props.editable}
        title={props.editable ? "Drag onto the board" : undefined}
        onDragStart={(event) => {
          event.dataTransfer.setData(IMAGE_DRAG_TYPE, JSON.stringify(image));
          event.dataTransfer.effectAllowed = "copy";
        }}
      >
        {image.url === null ? <span className="menu-board-image-tile-empty" /> : <img src={image.url} alt={image.altText} draggable={false} />}
        <button
          type="button"
          className="menu-board-icon-button"
          aria-label={`Add ${image.altText.length > 0 ? image.altText : "this image"} to the board`}
          disabled={!props.editable}
          onClick={() => props.onAdd(image)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        {confirming === image.mediaId
          ? <span className="menu-board-image-confirm" role="group" aria-label="Delete this image?">
            <button type="button" disabled={removal.busy} onClick={() => void remove(image)}>Delete</button>
            <button type="button" disabled={removal.busy} onClick={() => setConfirming(null)}>Keep</button>
          </span>
          : <button
            type="button"
            className="menu-board-icon-button menu-board-image-delete"
            aria-label={`Delete ${image.altText.length > 0 ? image.altText : "this image"} from the shop`}
            disabled={!props.editable || removal.busy}
            onClick={() => setConfirming(image.mediaId)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>}
      </li>)}
    </ul>
    {props.shop.state === "ready" && props.shop.images.length === 0
      ? <p className="menu-boards-drawer-note">No images yet. Upload one, or add photos to products on the Products page.</p>
      : null}
    <p className="menu-board-products-note">The shop keeps these images. Product photos show here too. A deleted image cannot be restored.</p>
  </section>;
}

/** Reads an image drag. */
export function parseShopImage(raw: string): ShopImage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isMenuBoardMediaId(value.mediaId) || typeof value.altText !== "string") return null;
    return { mediaId: value.mediaId, altText: value.altText, url: typeof value.url === "string" ? value.url : null };
  } catch {
    return null;
  }
}

/** An image element on a free canvas, where a person put it. */
export function imageElement(
  board: Readonly<{ layout: MenuBoardLayout; elements: readonly MenuBoardElement[]; unplaced: readonly MenuBoardElement[] }>,
  image: ShopImage,
  point: Readonly<{ x: number; y: number }> | null,
): MenuBoardElement {
  const id = `element_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const size = MENU_BOARD_SCREEN_SIZES[MENU_BOARD_LAYOUTS[board.layout].shape];
  const width = Math.round(Math.min(size.width, size.height) / 2.4);
  const height = Math.round(width * 0.75);
  const center = point ?? { x: size.width / 2, y: size.height / 2 };
  const rect: MenuBoardRect = {
    x: Math.round(Math.max(0, Math.min(size.width - width, center.x - width / 2))),
    y: Math.round(Math.max(0, Math.min(size.height - height, center.y - height / 2))),
    width,
    height,
  };
  const order = [...board.elements, ...board.unplaced].reduce((highest, element) => Math.max(highest, element.placement.order + 1), 0);
  return {
    id,
    kind: "image",
    placement: { frameId: "canvas", order, rect, constraints: MENU_BOARD_DEFAULT_CONSTRAINTS },
    mediaId: image.mediaId,
    altText: image.altText,
    fit: "cover",
  };
}
