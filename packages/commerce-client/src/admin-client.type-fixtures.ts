// Plan 78 step 2: each wire schema type equals the client type that its
// hand-written reader returns, for the types that commerce-resources.ts and
// mutations.ts still declare.
import type * as Admin from "@seams/commerce-contracts/records/api-admin";
import type * as Resources from "@seams/commerce-contracts/records/api-common";
import type * as ClientResources from "./commerce-resources.ts";
import type { CommerceMigrationInventoryV2 } from "./mutations.ts";
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
export type CommerceMigrationInventoryV2Parity = Assert<
  Equal<Admin.CommerceMigrationInventoryV2, CommerceMigrationInventoryV2>
>;
export type CommerceMoneyV1Parity = Assert<
  Equal<
    Resources.CommerceMoneyV1,
    ReturnType<typeof ClientResources.parseMoney>
  >
>;
export type CommerceQuantityV1Parity = Assert<
  Equal<Resources.CommerceQuantityV1, ClientResources.CommerceQuantityV1>
>;
export type CommerceLocationLifecycleParity = Assert<
  Equal<
    Resources.CommerceLocationLifecycle,
    ClientResources.CommerceLocationLifecycle
  >
>;
export type CommerceLocationV1Parity = Assert<
  Equal<Resources.CommerceLocationV1, ClientResources.CommerceLocationV1>
>;
export type CommerceSalesChannelV1Parity = Assert<
  Equal<
    Resources.CommerceSalesChannelV1,
    ClientResources.CommerceSalesChannelV1
  >
>;
export type CommerceOfferV1Parity = Assert<
  Equal<Resources.CommerceOfferV1, ClientResources.CommerceOfferV1>
>;
export type CommerceBuyerV1Parity = Assert<
  Equal<Resources.CommerceBuyerV1, ClientResources.CommerceBuyerV1>
>;
export type CommerceProtectedBuyerContactV1Parity = Assert<
  Equal<
    Resources.CommerceProtectedBuyerContactV1,
    ClientResources.CommerceProtectedBuyerContactV1
  >
>;
export type CommerceInventoryReceiptPurchaseParity = Assert<
  Equal<
    Resources.CommerceInventoryReceiptPurchase,
    ClientResources.CommerceInventoryReceiptPurchase
  >
>;
export type CommerceInventoryLotExpiryV1Parity = Assert<
  Equal<
    Resources.CommerceInventoryLotExpiryV1,
    ClientResources.CommerceInventoryLotV1["expiry"]
  >
>;
