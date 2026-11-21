// The one list of the commerce providers (Refactor 17, step A2.5). The
// built-in engine is here; the Worker registers the providers of a connection
// (`worker-ports.ts`). A removal of Shopify deletes its line there and the
// folder `shopify/`.
import {
  commerceSystemKindOfSource,
  type CommerceSystemKind,
} from "@purin-labs/contracts";
import { builtInCommerceProvider } from "./built-in-commerce-provider";
import {
  connectedCommerceProviders,
  type CommerceProvider,
  type CommerceProviderPermit,
} from "./contract/commerce-provider";

type CommerceProviders = { [K in CommerceSystemKind]: CommerceProvider<K> };

// A function, not a constant: the providers import the execution module,
// which imports this list.
function commerceProviders(): CommerceProviders {
  return {
    builtin_commerce: builtInCommerceProvider,
    ...connectedCommerceProviders.use(),
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
