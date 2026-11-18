import type { IntegrationDiscoveryConnection } from "./IntegrationDiscoveryConnection";
import type { IntegrationDiscoveryDataClass } from "./IntegrationDiscoveryDataClass";
import type { IntegrationDiscoveryProvider } from "./IntegrationDiscoveryProvider";

export type IntegrationDiscoveryAccount = {
  accountRef: string;
  provider: IntegrationDiscoveryProvider;
  displayName: string;
  connection: IntegrationDiscoveryConnection;
  configuredDataClasses: Array<IntegrationDiscoveryDataClass>;
  readableDataClasses: Array<IntegrationDiscoveryDataClass>;
};
