import {
  MEDIA_MAX_BYTES,
  type CommerceMutationResultV1,
} from "@seams/commerce-client";
import { mediaObjectKey, storeMediaUpload } from "../../plugins/media/index.ts";
import type { BuyerRoute, CommerceRoute } from "../../http-routes.ts";
import { errorMessage, isRecord } from "@seams/std";
import type { HttpRouteContext } from "../context.ts";
import { hasMerchantId, readJsonBody } from "../request-body.ts";
import { jsonResponse } from "../responses.ts";

// The media commands. A new record names bytes the store must hold; the
// last record of some bytes takes them out of the store after it commits.
async function mediaCommand(
  ctx: HttpRouteContext,
  route: Readonly<{
    kind:
      "create_media" | "update_media" | "delete_media" | "set_product_media";
    merchantId: string;
  }>,
  command: Readonly<Record<string, unknown>>,
): Promise<CommerceMutationResultV1> {
  switch (route.kind) {
    case "create_media": {
      const sha256 = command.sha256;
      const uploaded =
        ctx.media === undefined ||
        typeof sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(sha256)
          ? null
          : await ctx.media.head(mediaObjectKey(route.merchantId, sha256));
      return ctx.authority.createMedia(command, uploaded);
    }
    case "update_media":
      return ctx.authority.updateMedia(command);
    case "set_product_media":
      return ctx.authority.setProductMedia(command);
    case "delete_media": {
      const before =
        typeof command.mediaId === "string"
          ? ctx.authority.readMedia(route.merchantId, command.mediaId)
          : undefined;
      const result = ctx.authority.deleteMedia(command);
      if (
        result.outcome === "applied" &&
        before !== undefined &&
        ctx.media !== undefined &&
        ctx.authority.mediaUsingBytes(route.merchantId, before.sha256) === 0
      ) {
        // A failure leaves unused bytes in the store; nothing reads them.
        await ctx.media
          .delete(mediaObjectKey(route.merchantId, before.sha256))
          .catch((error: unknown) =>
            console.warn("underclerk.media_delete_failed", errorMessage(error)),
          );
      }
      return result;
    }
  }
}

export async function uploadMediaRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "upload_media" }
  >,
): Promise<Response> {
  if (ctx.media === undefined)
    return jsonResponse(503, {
      message: "Media storage is not configured",
    });
  if (!ctx.authority.hasMerchant(route.merchantId))
    return jsonResponse(404, { message: "Merchant not found" });
  if (Number(request.headers.get("content-length") ?? 0) > MEDIA_MAX_BYTES)
    return jsonResponse(413, {
      message: "An image must be 1 byte to 20 MB",
    });
  const outcome = await storeMediaUpload(
    ctx.media,
    route.merchantId,
    new Uint8Array(await request.arrayBuffer()),
    request.headers.get("content-type") ?? "",
  );
  return outcome.kind === "stored"
    ? jsonResponse(200, outcome.upload)
    : jsonResponse(outcome.status, { message: outcome.message });
}

export async function mediaCommandRoute(
  ctx: HttpRouteContext,
  request: Request,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    {
      kind:
        "create_media" | "update_media" | "delete_media" | "set_product_media";
    }
  >,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  if (
    !hasMerchantId(body.value, route.merchantId) ||
    !isRecord(body.value) ||
    ((route.kind === "update_media" || route.kind === "delete_media") &&
      body.value.mediaId !== route.mediaId) ||
    (route.kind === "set_product_media" &&
      body.value.productId !== route.productId)
  ) {
    return jsonResponse(400, {
      message: "Merchant path and command must match",
    });
  }
  return jsonResponse(200, await mediaCommand(ctx, route, body.value));
}

export async function listMediaRoute(
  ctx: HttpRouteContext,
  route: Extract<Exclude<CommerceRoute, BuyerRoute>, { kind: "list_media" }>,
): Promise<Response> {
  return jsonResponse(200, ctx.authority.readMediaLibrary(route.merchantId));
}

/**
 * The bytes of one library image, for the merchant's own app: a board that
 * shows an image that no listed product shows yet reads it here, and the
 * app decides who else may see it.
 */
export async function readMediaContentRoute(
  ctx: HttpRouteContext,
  route: Extract<
    Exclude<CommerceRoute, BuyerRoute>,
    { kind: "read_media_content" }
  >,
): Promise<Response> {
  const media =
    ctx.media === undefined
      ? undefined
      : ctx.authority.readMedia(route.merchantId, route.mediaId);
  if (ctx.media === undefined || media === undefined)
    return jsonResponse(404, { message: "Image not found" });
  const object = await ctx.media.get(
    mediaObjectKey(route.merchantId, media.sha256),
  );
  if (object === null) return jsonResponse(404, { message: "Image not found" });
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": media.contentType,
      etag: `"${media.sha256}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
