// The café shop's media library on boards (Plan 40B, the image element). A
// board's image names a media ID of the library. The shop serves an image
// only while a listed product shows it, so the Platform serves a board's
// image itself: to the board editor under the person's session, and to a
// TV only while a published board names it.
import type { Env } from "../../env";
import { readOrganisationEnvironment } from "../../control/organisation-runtime";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import type { OrganisationId } from "../../ids";
import { OrganisationExecutionScope } from "../../organisation-execution-scope";
import { createCommerceClient } from "../../commerce/contract/client";
import { commerceCommandInput, type CommerceAdminClient } from "@purin-labs/commerce-client";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Result } from "../../result";
import type { MenuBoardCommand, MenuBoardCommandReply } from "../../actors/menu-board-commands";
import { CAFE_STOREFRONT_ID } from "./menu-publication";
import type { Variant } from "@purin-labs/type-utils";

/** The café storefront's media address for a merchant, ending in "/". */
export function cafeMediaBaseFor(
  commerceBase: string,
  merchantId: string,
): string {
  const base = commerceBase.trim().replace(/\/+$/u, "");
  return `${base}/v1/public/merchants/${encodeURIComponent(merchantId)}/storefronts/${encodeURIComponent(CAFE_STOREFRONT_ID)}/media/`;
}

/**
 * Where a TV reads a board's images: the Platform's screen media route, as
 * a path on the Portal's own origin, ending in "/". It serves an image only
 * while a published board of the Organisation names it.
 */
export function screenMediaBase(organisationId: OrganisationId): string {
  return `/v1/screens/media/${encodeURIComponent(String(organisationId))}/`;
}

/** Where the board editor reads the shop's images, with the person's session. */
export function controlMediaBase(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/media/content/`;
}

/** One library image's bytes, read for the Organisation's shop; null when absent. */
export async function readCafeImageContent(
  env: Env,
  organisationId: OrganisationId,
  mediaId: string,
): Promise<Readonly<{ bytes: Uint8Array; contentType: string; etag: string | null }> | null> {
  const shop = await cafeShopClient(env, organisationId);
  if (shop === null) return null;
  const content = await shop.client.readMediaContent(shop.merchantId, mediaId);
  return content.ok ? content.value : null;
}

async function cafeShopClient(
  env: Env,
  organisationId: OrganisationId,
): Promise<Readonly<{ client: CommerceAdminClient; merchantId: string }> | null> {
  try {
    const scope = await OrganisationExecutionScope.resolve(env, organisationId);
    if (!scope.ok) return null;
    const environment = await readOrganisationEnvironment(scope.value.database, organisationId);
    if (environment === null) return null;
    const binding = await resolveOrganisationCommerceMerchantBinding({
      db: scope.value.database,
      organisationId,
      environment,
    });
    if (!binding.ok) return null;
    const client = createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(organisationId),
    });
    return client === null ? null : { client, merchantId: binding.value.merchantId };
  } catch {
    return null;
  }
}

/** One image of the shop's media library, as an agent names it. */
type CafeImage = Readonly<{ mediaId: string; altText: string }>;

/**
 * The images of an Organisation's shop library, for an agent that places
 * one on a board; null when the shop or Commerce does not answer.
 */
export async function readCafeImages(
  env: Env,
  organisationId: OrganisationId,
): Promise<readonly CafeImage[] | null> {
  const shop = await cafeShopClient(env, organisationId);
  if (shop === null) return null;
  const library = await shop.client.listMedia(shop.merchantId);
  if (!library.ok) return null;
  return library.value.media.map((item) => ({
    mediaId: item.id,
    altText: item.altText,
  }));
}

type CafeImageDeletion = Result<
  Readonly<{ mediaId: string }>,
  | Readonly<{ code: "media_on_board"; boards: readonly string[] }>
  | Readonly<{
      code:
        | "media_missing"
        | "media_on_product"
        | "commerce_unavailable"
        | "organisation_placement_conflict";
    }>
>;

/**
 * Deletes one image of the shop's library (Plan 40B, image removal). A
 * board that shows it, in its draft or its newest release, keeps it: a
 * person takes it off the board first. Commerce keeps an image that a
 * product shows. The deletion cannot be undone.
 */
export async function deleteCafeImage(
  env: Env,
  input: Readonly<{
    organisationId: OrganisationId;
    client: CommerceAdminClient;
    merchantId: string;
    mediaId: string;
    idempotencyKey: string;
  }>,
): Promise<CafeImageDeletion> {
  let boards: readonly string[];
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: input.organisationId,
      now: Date.now(),
    });
    const command: MenuBoardCommand = { kind: "media_on_boards", mediaId: input.mediaId };
    const shown = (await organisation.menuBoardCommand({
      organisationId: input.organisationId,
      command,
    })) as MenuBoardCommandReply<Variant<MenuBoardCommand, "media_on_boards">>;
    if (!shown.ok) return { ok: false, error: { code: "organisation_placement_conflict" } };
    boards = shown.value.boards;
  } catch {
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  }
  if (boards.length > 0) return { ok: false, error: { code: "media_on_board", boards } };
  const library = await input.client.listMedia(input.merchantId);
  if (!library.ok) return { ok: false, error: { code: "commerce_unavailable" } };
  const current = library.value.media.find((item) => item.id === input.mediaId);
  if (current === undefined) return { ok: false, error: { code: "media_missing" } };
  const deleted = await input.client.deleteMedia(
    commerceCommandInput({
      merchantId: input.merchantId,
      idempotencyKey: input.idempotencyKey,
      mediaId: input.mediaId,
      expectedRevision: current.revision,
    }),
  );
  const refusedCode = !deleted.ok
    ? deleted.error.kind === "rejected"
      ? deleted.error.error.code
      : null
    : deleted.value.outcome === "rejected"
      ? deleted.value.error.code
      : undefined;
  if (refusedCode === undefined) return { ok: true, value: { mediaId: input.mediaId } };
  if (refusedCode === "resource_relationship_invalid")
    return { ok: false, error: { code: "media_on_product" } };
  if (refusedCode === "resource_not_found")
    return { ok: false, error: { code: "media_missing" } };
  return { ok: false, error: { code: "commerce_unavailable" } };
}
