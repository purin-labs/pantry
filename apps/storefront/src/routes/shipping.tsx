import type { ReactNode } from "react";

import { StorefrontApp, storefrontConfiguration } from "../storefront.tsx";

export function StorefrontRoute(): ReactNode {
  return <StorefrontApp config={storefrontConfiguration("/store/shipping")} />;
}
