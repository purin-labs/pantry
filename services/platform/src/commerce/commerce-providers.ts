// The one list of the commerce providers (Refactor 17, step A2.5). A removal of
// Shopify deletes its line here and the folder `shopify/`.
import {
  commerceSystemKindOfSource,
  type CommerceSystemKind,
} from "@purin-labs/contracts";
import { shopifyCommerceProvider } from "../shopify/commerce-provider";
import { builtInCommerceProvider } from "./built-in-commerce-provider";
import type {
  CommerceProvider,
  CommerceProviderPermit,
} from "./commerce-provider";

type CommerceProviders = { [K in CommerceSystemKind]: CommerceProvider<K> };

// A function, not a constant: the providers import the execution module,
// which imports this list.
function commerceProviders(): CommerceProviders {
  return {
    satyr_commerce: builtInCommerceProvider,
    shopify: shopifyCommerceProvider,
  };
}

/** The provider of a commerce system. */
export function commerceProvider<K extends CommerceSystemKind>(
  kind: K,
): CommerceProvider<K> {
  return commerceProviders()[kind];
}

/** The provider whose credential made this permit. */
export function commerceProviderOfPermit(
  permit: CommerceProviderPermit,
): CommerceProvider | null {
  const kind = commerceSystemKindOfSource(permit.kind);
  return kind === null ? null : commerceProvider(kind);
}
