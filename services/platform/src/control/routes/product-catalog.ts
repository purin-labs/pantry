import { isNormalizedText, isPositiveInteger, isRecord } from "@purin-labs/std";
import {
  commerceCommandInput,
  type CommerceClientResult,
  type CommerceMutationResultV1,
} from "@purin-labs/commerce-client";
import type { Env } from "../../env";
import { controlError, controlJson, readJsonRecord } from "../http";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlMutation,
} from "../../kitchen/contract/inventory-control";

export type ProductCatalogAction = "edit" | "status" | "delete";

type ProductEdit = Readonly<{
  productId: string;
  expectedProductRevision: number;
  title: string | null;
  description: string | null;
  /** The variant that carries the product's name, when the name changes. */
  variant: Readonly<{
    variantId: string;
    expectedRevision: number;
    title: string;
  }> | null;
  offer: Readonly<{
    offerId: string;
    expectedRevision: number;
    amountMinor: number;
    currency: string;
  }> | null;
}>;

/**
 * The person's own click on the Products page, under the same receipts as a
 * stock count. An owner or admin changes what buyers see, so an operator's
 * role does not reach it. Each Commerce command takes its key from the one
 * request, so a retry replays what already landed and finishes the rest.
 */
export async function handleProductCatalogAction(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  action: ProductCatalogAction,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    organisationIdRaw,
    "admin",
  );
  if (!access.ok) return access.response;
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("product_action_invalid", 422);
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    `commerce.product.${action}`,
  );
  if (!mutation.ok) return mutation.response;
  const outcomes = await runProductAction(mutation.value, action, body.value);
  if (outcomes === null) return controlError("product_action_invalid", 422);
  for (const outcome of outcomes) {
    if (!outcome.ok) return controlError("underclerk_unavailable", 503);
    if (outcome.value.outcome === "rejected")
      return controlJson(
        {
          ok: false,
          error: outcome.value.error.code,
          ...(outcome.value.error.code === "product_delete_refused"
            ? { reason: outcome.value.error.reason }
            : {}),
        },
        409,
      );
    if (outcome.value.receipt.merchantId !== mutation.value.binding.merchantId)
      return controlError("underclerk_scope_mismatch", 502);
  }
  return finishInventoryOperation(request, env, mutation.value, { ok: true });
}

async function runProductAction(
  context: InventoryControlMutation,
  action: ProductCatalogAction,
  body: Readonly<Record<string, unknown>>,
): Promise<
  readonly CommerceClientResult<CommerceMutationResultV1>[] | null
> {
  const { client, binding, boundary } = context;
  const merchantId = binding.merchantId;
  const key = boundary.idempotencyKey;
  switch (action) {
    case "delete": {
      if (
        !isNormalizedText(body.productId) ||
        !isPositiveInteger(body.expectedProductRevision)
      )
        return null;
      return [
        await client.deleteProduct(
          commerceCommandInput({
            merchantId,
            idempotencyKey: `${key}:delete`,
            productId: body.productId,
            expectedProductRevision: body.expectedProductRevision,
          }),
        ),
      ];
    }
    case "status": {
      if (
        !isNormalizedText(body.productId) ||
        !isPositiveInteger(body.expectedProductRevision) ||
        (body.status !== "active" && body.status !== "archived")
      )
        return null;
      const status: "active" | "archived" = body.status;
      return [
        await client.updateProduct(
          commerceCommandInput({
            merchantId,
            idempotencyKey: `${key}:status`,
            productId: body.productId,
            expectedProductRevision: body.expectedProductRevision,
            changes: { status },
          }),
        ),
      ];
    }
    case "edit": {
      const edit = parseProductEdit(body);
      if (edit === null) return null;
      const outcomes = [];
      if (edit.title !== null || edit.description !== null) {
        const product = await client.updateProduct(
          commerceCommandInput({
            merchantId,
            idempotencyKey: `${key}:product`,
            productId: edit.productId,
            expectedProductRevision: edit.expectedProductRevision,
            changes: {
              ...(edit.title === null ? {} : { title: edit.title }),
              ...(edit.description === null
                ? {}
                : { description: edit.description }),
            },
          }),
        );
        outcomes.push(product);
        if (!settled(product)) return outcomes;
      }
      if (edit.variant !== null) {
        const variant = await client.updateVariant(
          commerceCommandInput({
            merchantId,
            idempotencyKey: `${key}:variant`,
            variantId: edit.variant.variantId,
            expectedVariantRevision: edit.variant.expectedRevision,
            changes: { title: edit.variant.title },
          }),
        );
        outcomes.push(variant);
        if (!settled(variant)) return outcomes;
      }
      if (edit.offer !== null)
        outcomes.push(
          await client.updateOffer(
            commerceCommandInput({
              merchantId,
              idempotencyKey: `${key}:offer`,
              offerId: edit.offer.offerId,
              expectedOfferRevision: edit.offer.expectedRevision,
              changes: {
                price: {
                  amountMinor: edit.offer.amountMinor,
                  currency: edit.offer.currency,
                },
              },
            }),
          ),
        );
      return outcomes;
    }
  }
}

function settled(
  outcome: CommerceClientResult<CommerceMutationResultV1>,
): boolean {
  return outcome.ok && outcome.value.outcome !== "rejected";
}

function parseProductEdit(
  body: Readonly<Record<string, unknown>>,
): ProductEdit | null {
  if (
    !isNormalizedText(body.productId) ||
    !isPositiveInteger(body.expectedProductRevision) ||
    !(body.title === null || isNormalizedText(body.title)) ||
    !(body.description === null || typeof body.description === "string")
  )
    return null;
  const variant = parseVariantEdit(body.variant);
  const offer = parseOfferEdit(body.offer);
  if (variant === undefined || offer === undefined) return null;
  if (body.title === null && body.description === null && offer === null)
    return null;
  return {
    productId: body.productId,
    expectedProductRevision: body.expectedProductRevision,
    title: body.title,
    description: body.description,
    variant,
    offer,
  };
}

function parseVariantEdit(value: unknown): ProductEdit["variant"] | undefined {
  if (value === null) return null;
  return isRecord(value) &&
    isNormalizedText(value.variantId) &&
    isPositiveInteger(value.expectedRevision) &&
    isNormalizedText(value.title)
    ? {
        variantId: value.variantId,
        expectedRevision: value.expectedRevision,
        title: value.title,
      }
    : undefined;
}

function parseOfferEdit(value: unknown): ProductEdit["offer"] | undefined {
  if (value === null) return null;
  return isRecord(value) &&
    isNormalizedText(value.offerId) &&
    isPositiveInteger(value.expectedRevision) &&
    Number.isSafeInteger(value.amountMinor) &&
    Number(value.amountMinor) >= 0 &&
    isNormalizedText(value.currency)
    ? {
        offerId: value.offerId,
        expectedRevision: value.expectedRevision,
        amountMinor: Number(value.amountMinor),
        currency: value.currency,
      }
    : undefined;
}
