import type { CommerceActionRecord } from "@purin-labs/commerce-control-api/portal/commerce-actions";

/** The governed change of a product description that a draft proposes. */
type ProductDescriptionAction = Readonly<{
  kind: "update_product_description";
  productId: string;
  productRevision: number;
  description: string;
}>;

/** How the description editor proposes its change through the Portal. */
export type ProductDescriptionActionTransport = Readonly<{
  proposeAction: (
    organisationId: string,
    action: ProductDescriptionAction,
    intent: string,
  ) => Promise<CommerceActionRecord>;
}>;
