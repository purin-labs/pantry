import type { ProductionDemandExtension } from "../built-in-ports.ts";
import { PRODUCTION_DEMAND_PRESET } from "./production-demand-preset.ts";

export const productionDemandExtension: ProductionDemandExtension = {
  preset: PRODUCTION_DEMAND_PRESET,
};
export {
  PRODUCTION_DEMAND_BUYER_ROUTE_KINDS,
  PRODUCTION_DEMAND_ROUTE_ACCESS,
  PRODUCTION_DEMAND_ROUTES,
  type ProductionDemandRoute,
} from "./routes.ts";
