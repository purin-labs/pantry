import type {
  AccessGrantTarget,
  CommerceReadGrantScope,
} from "@purin-labs/contracts";
import type {
  CommerceGraphQuery,
  PublishedCommerceSelector,
} from "@purin-labs/commerce-contracts";
import type { Variant } from "@purin-labs/type-utils";
declare const selector: PublishedCommerceSelector;
declare const context: Variant<CommerceGraphQuery, "commerce_context">;
const invalidScope: CommerceReadGrantScope = {
  kind: "saved_selector",
  selector: {
    ...selector,
    // @ts-expect-error Grant selectors cannot contain a context request.
    query: context,
  },
};
declare const target: Variant<AccessGrantTarget, "commerce_read">;
const invalidTarget: AccessGrantTarget = {
  ...target,
  scope: {
    kind: "saved_selector",
    selector: {
      ...selector,
      // @ts-expect-error A broad target spread cannot restore an invalid selector.
      query: context,
    },
  },
};
void invalidScope;
void invalidTarget;
