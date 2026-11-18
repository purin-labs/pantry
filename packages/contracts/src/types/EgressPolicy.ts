import type { GatewayModelRoute } from "./GatewayModelRoute";
import type { InjectionRule } from "./InjectionRule";

export type EgressPolicy = {
  allowedHosts: Array<string>;
  injections: Array<InjectionRule>;
  modelRoute: GatewayModelRoute;
};
