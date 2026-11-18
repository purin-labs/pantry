import type { AccessGrantTarget, CommerceReadGrantScope } from "./index.ts";
import type {
  CommerceGraphQuery,
  PublishedCommerceSelector,
} from "@seams/commerce-contracts";
declare const selector: PublishedCommerceSelector;
declare const context: Extract<
  CommerceGraphQuery,
  { kind: "underclerk_context" }
>;
const invalidScope: CommerceReadGrantScope = {
  kind: "saved_selector",
  selector: {
    ...selector,
    // @ts-expect-error Grant selectors cannot contain a context request.
    query: context,
  },
};
declare const target: Extract<AccessGrantTarget, { kind: "commerce_read" }>;
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
