import { isNormalizedText } from "@purin-labs/std";
import {
  MEDIA_CONTENT_TYPES,
  MEDIA_MAX_BYTES,
  commerceCommandInput,
  type CommerceClientResult,
  type CommerceMediaContentType,
  type CommerceMediaLibraryV1,
  type CommerceMutationResultV1,
  type CommerceProductMediaV1,
} from "@purin-labs/commerce-client";
import { controlMediaBase, deleteCafeImage } from "@purin-labs/area-cafe-contract/server/media";
import type { Env } from "@purin-labs/kernel/env";
import { controlError, controlJson, readJsonRecord } from "@purin-labs/control/worker/http";
import { readImageForm } from "@purin-labs/control/worker/image-form";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlAccess,
} from "@purin-labs/area-kitchen-contract/server/inventory-control";

/**
 * `add` and `arrange` change one product's photos; `library` lists the
 * shop's media library and `library_add` adds an image to it with no
 * product, for a board's image element (Plan 40B); `library_delete`
 * deletes an image that no board and no product shows.
 */
export type ProductPhotoAction =
  | "add"
  | "arrange"
  | "library"
  | "library_add"
  | "library_delete";

type PhotoUpload = Readonly<{
  /** Empty for an image of the library alone. */
  productId: string;
  expectedPhotoRevision: number;
  altText: string;
  contentType: CommerceMediaContentType;
  bytes: Uint8Array;
  sha256: string;
}>;

type Arrangement = Readonly<{
  productId: string;
  expectedPhotoRevision: number;
  mediaIds: readonly string[];
}>;

const ALT_TEXT_MAX = 512;

/**
 * An owner's or admin's photos for one product, from the product page, under
 * the same receipts as a stock count. Commerce keeps each image under its
 * SHA-256 and each product's ordered list, which the shop's catalog and the
 * Portal both read.
 */
export async function handleProductPhotoAction(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  action: ProductPhotoAction,
): Promise<Response> {
  if (action === "library") {
    if (request.method !== "GET")
      return controlError("method_not_allowed", 405);
    const access = await resolveInventoryAccess(
      request,
      env,
      organisationIdRaw,
      "viewer",
    );
    if (!access.ok) return access.response;
    return listLibrary(access.value);
  }
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationIdRaw,
    "admin",
  );
  if (!access.ok) return access.response;
  switch (action) {
    case "add":
      return addPhoto(request, env, access.value);
    case "arrange":
      return arrangePhotos(request, env, access.value);
    case "library_add":
      return addLibraryImage(request, env, access.value);
    case "library_delete":
      return deleteLibraryImage(request, env, access.value);
    default:
      return action satisfies never;
  }
}

/**
 * The shop's images, at the café storefront's address, for the board
 * editor's Images panel. `mediaBase` is null when Commerce has no
 * address here.
 */
async function listLibrary(
  access: InventoryControlAccess,
): Promise<Response> {
  const merchantId = access.binding.merchantId;
  const library = await access.client.listMedia(merchantId);
  if (!library.ok) return controlError("commerce_unavailable", 503);
  // The editor reads each image through the Platform, under the person's
  // session: the shop serves only the images that listed products show.
  const mediaBase = controlMediaBase(String(access.authorized.organisationId));
  return controlJson({
    ok: true,
    mediaBase,
    images: library.value.media.map((item) => ({
      mediaId: item.id,
      altText: item.altText,
      url: `${mediaBase}${encodeURIComponent(item.id)}`,
    })),
  });
}

/**
 * One library image's bytes for the board editor, under the person's
 * session; a viewer may read it, as the board's draft.
 */
export async function handleLibraryImageContent(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  mediaId: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(request, env, organisationIdRaw, "viewer");
  if (!access.ok) return access.response;
  const content = await access.value.client.readMediaContent(
    access.value.binding.merchantId,
    mediaId,
  );
  if (!content.ok)
    return content.error.kind === "http" && content.error.status === 404
      ? controlError("not_found", 404)
      : controlError("commerce_unavailable", 503);
  return new Response(content.value.bytes, {
    status: 200,
    headers: {
      "content-type": content.value.contentType,
      "cache-control": "private, max-age=300",
      ...(content.value.etag === null ? {} : { etag: content.value.etag }),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * Deletes one library image for an owner or admin, under the same
 * receipts. A board or a product that shows it keeps it, and the answer
 * names the boards.
 */
async function deleteLibraryImage(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
): Promise<Response> {
  const body = await readJsonRecord(request);
  const mediaId = body.ok ? body.value.mediaId : undefined;
  if (typeof mediaId !== "string" || !/^media_[0-9a-f]{32}$/u.test(mediaId))
    return controlError("media_delete_invalid", 422);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access,
    { mediaId },
    "commerce.media.delete",
  );
  if (!mutation.ok) return mutation.response;
  const deleted = await deleteCafeImage(env, {
    organisationId: mutation.value.authorized.organisationId,
    client: mutation.value.client,
    merchantId: mutation.value.binding.merchantId,
    mediaId,
    idempotencyKey: `${mutation.value.boundary.idempotencyKey}:media-delete`,
  });
  if (!deleted.ok) {
    switch (deleted.error.code) {
      case "media_on_board":
        return controlJson(
          { ok: false, error: deleted.error.code, boards: deleted.error.boards },
          409,
        );
      case "media_on_product":
        return controlError(deleted.error.code, 409);
      case "media_missing":
        return controlError(deleted.error.code, 404);
      case "commerce_unavailable":
      case "organisation_placement_conflict":
        return controlError(deleted.error.code, 503);
      default:
        return deleted.error satisfies never;
    }
  }
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    mediaId,
  });
}

/** An image for the shop's library alone, under the same receipts. */
async function addLibraryImage(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
): Promise<Response> {
  const upload = await readPhotoUpload(request, false);
  if (upload === null) return controlError("product_photo_invalid", 422);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access,
    {
      altText: upload.altText,
      contentType: upload.contentType,
      sha256: upload.sha256,
    },
    "commerce.media.add",
  );
  if (!mutation.ok) return mutation.response;
  const { client, binding, boundary } = mutation.value;
  const merchantId = binding.merchantId;
  const stored = await client.uploadMedia(
    merchantId,
    upload.bytes,
    upload.contentType,
  );
  if (!stored.ok)
    return stored.error.kind === "http" &&
      (stored.error.status === 413 || stored.error.status === 415)
      ? controlError("product_photo_invalid", 422)
      : controlError("commerce_unavailable", 503);
  if (stored.value.sha256 !== upload.sha256)
    return controlError("commerce_scope_mismatch", 502);
  const library = await client.listMedia(merchantId);
  if (!library.ok) return controlError("commerce_unavailable", 503);
  // The same bytes keep one record, as for a product's photo.
  let mediaId = library.value.media.find(
    (item) => item.sha256 === upload.sha256,
  )?.id;
  if (mediaId === undefined) {
    mediaId = `media_${upload.sha256.slice(0, 32)}`;
    const created = await client.createMedia(
      commerceCommandInput({
        merchantId,
        idempotencyKey: `${boundary.idempotencyKey}:media`,
        mediaId,
        sha256: upload.sha256,
        altText: upload.altText,
      }),
    );
    const refused = refusal(created, merchantId);
    if (refused !== null) return refused;
  }
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    mediaId,
  });
}

async function addPhoto(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
): Promise<Response> {
  const upload = await readPhotoUpload(request, true);
  if (upload === null) return controlError("product_photo_invalid", 422);
  // The receipt keys on the bytes' digest, so a retry with the same key and
  // photo replays and a different photo under that key conflicts.
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access,
    {
      productId: upload.productId,
      expectedPhotoRevision: upload.expectedPhotoRevision,
      altText: upload.altText,
      contentType: upload.contentType,
      sha256: upload.sha256,
    },
    "commerce.product.photo.add",
  );
  if (!mutation.ok) return mutation.response;
  const { client, binding, boundary } = mutation.value;
  const merchantId = binding.merchantId;
  const stored = await client.uploadMedia(
    merchantId,
    upload.bytes,
    upload.contentType,
  );
  // Commerce reads the bytes themselves: a file whose bytes are not the
  // image type that it names is the person's to fix, not an outage.
  if (!stored.ok)
    return stored.error.kind === "http" &&
      (stored.error.status === 413 || stored.error.status === 415)
      ? controlError("product_photo_invalid", 422)
      : controlError("commerce_unavailable", 503);
  if (stored.value.sha256 !== upload.sha256)
    return controlError("commerce_scope_mismatch", 502);
  const library = await client.listMedia(merchantId);
  if (!library.ok) return controlError("commerce_unavailable", 503);
  const current = productMedia(library.value, upload.productId);
  // The same bytes keep one record, whichever product showed them first.
  let mediaId = library.value.media.find(
    (item) => item.sha256 === upload.sha256,
  )?.id;
  if (mediaId === undefined) {
    if (current.revision !== upload.expectedPhotoRevision) return stale();
    mediaId = `media_${upload.sha256.slice(0, 32)}`;
    const created = await client.createMedia(
      commerceCommandInput({
        merchantId,
        idempotencyKey: `${boundary.idempotencyKey}:media`,
        mediaId,
        sha256: upload.sha256,
        altText: upload.altText,
      }),
    );
    const refused = refusal(created, merchantId);
    if (refused !== null) return refused;
  }
  if (!current.media.some((item) => item.mediaId === mediaId)) {
    if (current.revision !== upload.expectedPhotoRevision) return stale();
    const set = await client.setProductMedia(
      commerceCommandInput({
        merchantId,
        idempotencyKey: `${boundary.idempotencyKey}:product`,
        productId: upload.productId,
        expectedRevision: upload.expectedPhotoRevision,
        media: [...current.media, { mediaId, variantIds: [] }],
      }),
    );
    const refused = refusal(set, merchantId);
    if (refused !== null) return refused;
  }
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    mediaId,
  });
}

async function arrangePhotos(
  request: Request,
  env: Env,
  access: InventoryControlAccess,
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("product_photo_invalid", 422);
  const arrangement = parseArrangement(body.value);
  if (arrangement === null) return controlError("product_photo_invalid", 422);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access,
    body.value,
    "commerce.product.photo.arrange",
  );
  if (!mutation.ok) return mutation.response;
  const { client, binding, boundary } = mutation.value;
  const merchantId = binding.merchantId;
  const libraryRead = await client.listMedia(merchantId);
  if (!libraryRead.ok) return controlError("commerce_unavailable", 503);
  const current = productMedia(libraryRead.value, arrangement.productId);
  const unchanged =
    current.media.length === arrangement.mediaIds.length &&
    current.media.every(
      (item, index) => item.mediaId === arrangement.mediaIds[index],
    );
  if (!unchanged) {
    if (current.revision !== arrangement.expectedPhotoRevision) return stale();
    const items = new Map(current.media.map((item) => [item.mediaId, item]));
    const library = new Set(libraryRead.value.media.map((item) => item.id));
    const media = [];
    // A photo keeps the variants it names; one back from Undo shows for all.
    for (const mediaId of arrangement.mediaIds) {
      const item =
        items.get(mediaId) ??
        (library.has(mediaId) ? { mediaId, variantIds: [] } : undefined);
      if (item === undefined) return controlError("product_photo_invalid", 422);
      media.push(item);
    }
    const set = await client.setProductMedia(
      commerceCommandInput({
        merchantId,
        idempotencyKey: `${boundary.idempotencyKey}:product`,
        productId: arrangement.productId,
        expectedRevision: arrangement.expectedPhotoRevision,
        media,
      }),
    );
    const refused = refusal(set, merchantId);
    if (refused !== null) return refused;
  }
  return finishInventoryOperation(request, env, mutation.value, { ok: true });
}

async function readPhotoUpload(
  request: Request,
  forProduct: boolean,
): Promise<PhotoUpload | null> {
  const read = await readImageForm(request, {
    field: "photo",
    maxBytes: MEDIA_MAX_BYTES,
    contentTypes: MEDIA_CONTENT_TYPES,
  });
  if (read === null) return null;
  const productId = forProduct ? read.form.get("productId") : "";
  const revision = forProduct
    ? Number(read.form.get("expectedPhotoRevision"))
    : 0;
  const altText = read.form.get("altText");
  if (
    (forProduct ? !isNormalizedText(productId) : productId !== "") ||
    typeof productId !== "string" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof altText !== "string" ||
    altText.length > ALT_TEXT_MAX
  )
    return null;
  return {
    productId,
    expectedPhotoRevision: revision,
    altText: altText.trim(),
    ...read.image,
  };
}

function parseArrangement(
  body: Readonly<Record<string, unknown>>,
): Arrangement | null {
  if (
    !isNormalizedText(body.productId) ||
    !Number.isSafeInteger(body.expectedPhotoRevision) ||
    Number(body.expectedPhotoRevision) < 1 ||
    !Array.isArray(body.mediaIds)
  )
    return null;
  const mediaIds: string[] = [];
  for (const mediaId of body.mediaIds) {
    if (!isNormalizedText(mediaId) || mediaIds.includes(mediaId)) return null;
    mediaIds.push(mediaId);
  }
  return {
    productId: body.productId,
    expectedPhotoRevision: Number(body.expectedPhotoRevision),
    mediaIds,
  };
}

function productMedia(
  library: CommerceMediaLibraryV1,
  productId: string,
): CommerceProductMediaV1 {
  return (
    library.products.find((product) => product.productId === productId) ?? {
      productId,
      revision: 0,
      media: [],
    }
  );
}

function stale(): Response {
  return controlJson({ ok: false, error: "stale_resource_revision" }, 409);
}

function refusal(
  outcome: CommerceClientResult<CommerceMutationResultV1>,
  merchantId: string,
): Response | null {
  if (!outcome.ok)
    return outcome.error.kind === "rejected"
      ? controlJson({ ok: false, error: outcome.error.error.code }, 409)
      : controlError("commerce_unavailable", 503);
  if (outcome.value.outcome === "rejected")
    return controlJson({ ok: false, error: outcome.value.error.code }, 409);
  if (outcome.value.receipt.merchantId !== merchantId)
    return controlError("commerce_scope_mismatch", 502);
  return null;
}
