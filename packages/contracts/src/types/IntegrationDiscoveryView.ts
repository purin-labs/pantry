import type { IntegrationDiscoveryAccount } from "./IntegrationDiscoveryAccount";

export type IntegrationDiscoveryView = {
  observedAt: number;
  accounts: Array<IntegrationDiscoveryAccount>;
  truncated: boolean;
};
