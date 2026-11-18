import { isNonEmptyString, isNonNegativeInteger, isRecord } from "@seams/std";

type ProductDescriptionResponseProduct = Readonly<{
  productId: string;
  title: string;
  description: string;
  revision: number;
}>;

type ProductDescriptionDraftSnapshot =
  | Readonly<{ kind: "not_started" }>
  | Readonly<{
      kind: "active";
      description: string;
      initializedFromProductRevision: number;
    }>;

export type ProductDescriptionResponse = Readonly<{
  canonicalProductId: string;
  product: ProductDescriptionResponseProduct;
  draft: ProductDescriptionDraftSnapshot;
}>;

export function parseProductDescriptionResponse(
  raw: unknown,
  productId: string,
): ProductDescriptionResponse {
  if (
    !isRecord(raw) ||
    raw.ok !== true ||
    !isRecord(raw.product) ||
    !isRecord(raw.draft)
  ) {
    throw new Error("The product description response is invalid.");
  }
  const product = raw.product;
  if (
    !isNonEmptyString(raw.canonicalProductId) ||
    product.productId !== productId ||
    !isNonEmptyString(product.title) ||
    typeof product.description !== "string" ||
    !isNonNegativeInteger(product.revision)
  ) {
    throw new Error("The product description response is invalid.");
  }
  const draft = parseProductDescriptionDraft(raw.draft);
  return {
    canonicalProductId: raw.canonicalProductId,
    product: {
      productId: product.productId,
      title: product.title,
      description: product.description,
      revision: product.revision,
    },
    draft,
  };
}

function parseProductDescriptionDraft(
  raw: Record<string, unknown>,
): ProductDescriptionDraftSnapshot {
  switch (raw.kind) {
    case "not_started":
      return { kind: "not_started" };
    case "active":
      if (
        typeof raw.description !== "string" ||
        !isNonNegativeInteger(raw.initializedFromProductRevision)
      ) {
        throw new Error("The product description response is invalid.");
      }
      return {
        kind: "active",
        description: raw.description,
        initializedFromProductRevision: raw.initializedFromProductRevision,
      };
    default:
      throw new Error("The product description response is invalid.");
  }
}
