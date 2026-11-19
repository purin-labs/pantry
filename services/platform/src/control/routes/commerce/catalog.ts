import { pantryCommerceAccess } from "../../../commerce/app-access";
import type { Env } from "../../../env";
import {
  connectedStockOverview,
  productPhotos,
} from "../../../commerce/inventory-overview";
import type { Result } from "../../../result";
import {
  createPublishedResourceClient,
  enumeratePublishedResources,
  type PublishedResourceBoundaryError,
} from "../../../commerce/entity-plane/published-resources";
import { ensureCommerceLowStockCueSnapshot } from "../../../cues/engine";
import {
  commerceCanonicalResourceId,
  commerceProviderResourceId,
} from "../../../commerce/provider";
import {
  applyOfferPriceAllowance,
  parseOfferPriceAllowanceCommand,
  type OfferPriceAllowanceCommand,
  type OfferPriceAllowanceError,
} from "../../../data/offer-price-allowance";
import type {
  CommerceClientResult,
  CommerceOfferPriceResultV1,
} from "@purin-labs/commerce-client";
import {
  parseTrackingBatchPreviewRequest,
  previewTrackingBatch,
  readCommerceExceptionInbox,
} from "../../../commerce/operations-workbench";
import {
  admitControlMutation,
  recordSessionMutationReceipt,
} from "../../admission/control-mutation";
import {
  resolveMerchantBinding,
  resolveMerchantControlContext,
} from "../../commerce-merchant";
import { authorizeOrganisationRequest } from "../../authorization";
import { controlError, controlJson, readJsonRecord } from "../../http";

// Stock quantities and thresholds are absent from the entity graph attributes.
export async function handleCommerceInventory(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  const { client } = merchant;
  const snapshot = await client.readStockSnapshot(merchant.merchantId);
  if (!snapshot.ok) return controlError("underclerk_unavailable", 503);
  if (snapshot.value.commerce.merchantId !== merchant.merchantId)
    return controlError("underclerk_scope_mismatch", 502);
  // A missing photo must not hide the stock, so a failed read leaves none.
  const [library, storefronts] = await Promise.all([
    client.listMedia(merchant.merchantId),
    client.listStorefrontIds(merchant.merchantId),
  ]);
  const base = env.UNDERCLERK_BASE_URL?.trim().replace(/\/+$/u, "");
  const storefrontId = storefronts.ok ? storefronts.value[0] : undefined;
  const photos =
    library.ok && base !== undefined && storefrontId !== undefined
      ? productPhotos(
          library.value,
          `${base}/v1/public/merchants/${encodeURIComponent(merchant.merchantId)}/storefronts/${encodeURIComponent(storefrontId)}/media`,
        )
      : undefined;
  return controlJson({
    ok: true,
    ...connectedStockOverview(snapshot.value, photos),
  });
}

// Offer prices are available in the merchant snapshot, not in the entity graph.
export async function handleCommercePricedOffers(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  const { client } = merchant;
  const snapshot = await client.readSnapshot(merchant.merchantId);
  if (!snapshot.ok) return controlError("underclerk_unavailable", 503);
  return controlJson({
    ok: true,
    // Canonical ids, because that is how the price-policy route and every
    // other Portal commerce address name a record.
    offers: snapshot.value.resources.offers
      .filter((offer) => offer.lifecycle.state === "listed")
      .map((offer) => ({
        offerId: commerceCanonicalResourceId(merchant.merchantId, offer.id),
        variantId: commerceCanonicalResourceId(
          merchant.merchantId,
          offer.variantId,
        ),
        salesChannelId: commerceCanonicalResourceId(
          merchant.merchantId,
          offer.salesChannelId,
        ),
        revision: offer.revision,
        priceMinor: offer.price.amountMinor,
        currency: offer.price.currency,
      })),
  });
}

export async function handleCommerceOfferPricePolicy(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  offerIdRaw: string,
): Promise<Response> {
  const mutation = request.method === "PUT" || request.method === "DELETE";
  if (request.method !== "GET" && !mutation)
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    mutation ? "owner" : "viewer",
    mutation,
  );
  if (!authorized.ok) return authorized.response;
  const merchant = await resolveMerchantControlContext(env, authorized);
  if (merchant instanceof Response) return merchant;
  const { client } = merchant;
  // Portal names Offers by their canonical id; Commerce knows its own.
  const offerId = commerceProviderResourceId(merchant.merchantId, offerIdRaw);
  if (offerId === null)
    return controlError("commerce_action_projection_invalid", 422);
  const now = Date.now();

  if (request.method === "GET") {
    return offerPricePolicyResponse(
      await client.readOfferPricePolicy(merchant.merchantId, offerId),
    );
  }
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("offer_price_policy_invalid", 422);
  const command = parseOfferPricePolicyCommand(
    request.method,
    offerIdRaw,
    body.value,
  );
  if (!command.ok) return controlError("offer_price_policy_invalid", 422);
  // Retrying a write that already landed must report what it did rather than
  // re-driving it: a second attempt reads a policy revision the first one
  // advanced and refuses as stale, telling the owner a change failed when it
  // succeeded. The Portal path had this hole; the Slack draft path does not.
  const admitted = await admitControlMutation({
    request,
    authorized,
    body: body.value,
    boundary: "unversioned",
    route: `/v1/control/organisations/${authorized.organisationId}/commerce/offers/${offerIdRaw}/price-policy`,
    operation: `commerce.offer_price_policy.${command.value.kind}`,
  });
  if (admitted instanceof Response) return admitted;
  // The same boundary a confirmed Slack draft applies, so the two surfaces
  // cannot write an allowance differently.
  const result = await applyOfferPriceAllowance(
    env,
    authorized.organisationId,
    command.value,
    now,
  );
  const response = offerPriceAllowanceResponse(result);
  // Only a settled outcome is recorded. An unreachable Commerce left this
  // attempt undecided, and recording it would refuse the retry that should
  // carry it through.
  if (result.ok) {
    await recordSessionMutationReceipt(
      authorized,
      admitted,
      { status: response.status, body: await response.clone().json() },
      now,
    );
  }
  return response;
}

/**
 * Reads one allowance change from a request body.
 *
 * Kept whole so the receipt operation can name what was asked for before
 * anything is sent to Commerce. The offer id comes from the path, so the
 * body only carries what the change itself is.
 */
function parseOfferPricePolicyCommand(
  method: string,
  offerId: string,
  body: Readonly<Record<string, unknown>>,
): Result<
  OfferPriceAllowanceCommand,
  { readonly code: "offer_price_policy_invalid" }
> {
  const parsed = parseOfferPriceAllowanceCommand(
    method === "DELETE"
      ? {
          kind: "withdraw_offer_price_allowance",
          offerId,
          expectedRevision: body.expectedRevision,
        }
      : {
          kind: "set_offer_price_allowance",
          offerId,
          expectedRevision: body.expectedRevision ?? null,
          maxMovementBps: body.maxMovementBps,
        },
  );
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "offer_price_policy_invalid" } };
}

/** Maps one allowance outcome onto a response. */
function offerPriceAllowanceResponse(
  result: Result<unknown, OfferPriceAllowanceError>,
): Response {
  if (result.ok) return controlJson({ ok: true, pricePolicy: result.value });
  switch (result.error.code) {
    case "offer_price_allowance_stale":
      // Commerce's answer about state the caller named, not a bad request.
      return controlJson({ ok: false, code: "offer_price_policy_stale" }, 409);
    case "offer_price_allowance_price_moved":
      // The Offer's price changed after the owner was shown it; the band they
      // approved would be measured from a price they never saw.
      return controlJson({ ok: false, code: "offer_price_moved" }, 409);
    case "offer_price_allowance_invalid":
      return controlError("offer_price_policy_invalid", 422);
    case "offer_price_allowance_unavailable":
      return controlError("underclerk_unavailable", 503);
  }
}

function offerPricePolicyResponse(
  result: CommerceClientResult<CommerceOfferPriceResultV1>,
): Response {
  if (!result.ok) return controlError("underclerk_unavailable", 503);
  return result.value.outcome === "accepted"
    ? controlJson({ ok: true, pricePolicy: result.value.value })
    : // A refusal is Commerce's answer about state the caller named, so it is
      // reported as a conflict rather than a malformed request.
      controlJson({ ok: false, code: result.value.refusal.code }, 409);
}

export async function handleCommerceTrackingBatchPreview(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("tracking_batch_invalid", 422);
  const parsed = parseTrackingBatchPreviewRequest(body.value);
  if (!parsed.ok) return controlError(parsed.error.code, 422);
  const inbox = await readCommerceExceptionInbox(
    env,
    authorized.organisationId,
  );
  const preview = await previewTrackingBatch(inbox, parsed.value, Date.now());
  return preview.ok
    ? controlJson({ ok: true, preview: preview.value })
    : controlError(preview.error.code, 503);
}

export async function handleCommerceCueRefresh(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return controlError("method_not_allowed", 405);
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "admin",
    true,
  );
  if (!authorized.ok) {
    return authorized.response;
  }

  const refreshed = await ensureCommerceLowStockCueSnapshot({
    db: authorized.executionScope.database,
    kv: env.POLICY_KV,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  const inventoryLowStock = refreshed.subscriptions.find(
    (subscription) =>
      subscription.source === "commerce" &&
      subscription.eventType === "inventory_low_stock",
  );
  if (
    inventoryLowStock === undefined ||
    inventoryLowStock.surfaceScope.kind !== "slack"
  ) {
    return controlError("commerce_cue_surface_missing", 409);
  }
  return controlJson({
    ok: true,
    organisationId: authorized.organisationId,
    cueVersion: refreshed.version,
    subscriptionId: "onboarding-commerce-inventory-low-stock",
  });
}

export async function handleCommercePublishedResources(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    "viewer",
    false,
  );
  if (!authorized.ok) return authorized.response;
  const binding = await resolveMerchantBinding(authorized);
  if (binding instanceof Response) return binding;
  if (
    env.UNDERCLERK_BASE_URL === undefined ||
    env.UNDERCLERK_SERVICE_TOKEN === undefined
  ) {
    return controlError("underclerk_unavailable", 503);
  }
  const client = createPublishedResourceClient({
    baseUrl: env.UNDERCLERK_BASE_URL,
    ...pantryCommerceAccess(
      env.UNDERCLERK_SERVICE_TOKEN,
      String(authorized.organisationId),
      env.UNDERCLERK.fetch.bind(env.UNDERCLERK),
      String(authorized.membership.personId),
    ),
  });
  if (client === null) return controlError("underclerk_unavailable", 503);
  const result = await enumeratePublishedResources({
    client,
    organisationId: authorized.organisationId,
    merchantId: binding.merchantId,
  });
  return result.ok
    ? controlJson({ ok: true, metadata: result.value })
    : publishedResourceBoundaryErrorResponse(result.error);
}

function publishedResourceBoundaryErrorResponse(
  error: PublishedResourceBoundaryError,
): Response {
  switch (error.code) {
    case "invalid_reference":
      return controlError("published_resource_invalid", 422);
    case "not_published":
      return controlError("published_resource_not_found", 404);
    case "revision_conflict":
      return controlJson(
        {
          ok: false,
          error: error.code,
          expected: error.expected,
          actual: error.actual,
        },
        409,
      );
    case "organisation_mismatch":
    case "merchant_mismatch":
      return controlError("published_resource_authority_mismatch", 503);
    case "unavailable":
      return controlError("underclerk_unavailable", 503);
  }
}
