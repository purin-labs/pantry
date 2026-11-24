import type { MerchantControlContext } from "@purin-labs/area-commerce-contract/server/merchant-control";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

/**
 * One counter sale as the Café reads it: the Register's wire form of the
 * sale without its after-sale state, which `CounterSaleView` adds.
 * `collectable` is false whenever the payment's outcome is unknown or
 * already settled: an unresolved payment is recovered, never re-collected.
 * `recoverable` names the attempt an operator recovers, and is present
 * exactly when there is something to reconcile. `quote` is the quote as rung
 * up, for the receipt and for the amount to present.
 */
export type CounterSaleReadback = Readonly<{
  schemaVersion: "pantry.counter-sale.v1";
}> &
  Omit<CounterSale, "afterSale">;

// The Commerce types of a counter sale, read through the commerce contract.
type CommerceAdminClient = MerchantControlContext["client"];
type CommerceClientError = Extract<
  Awaited<ReturnType<CommerceAdminClient["readCounterSale"]>>,
  Readonly<{ ok: false }>
>["error"];
type CommerceResources = Extract<
  Awaited<ReturnType<CommerceAdminClient["readSnapshot"]>>,
  Readonly<{ ok: true }>
>["value"]["resources"];
type CommerceOrderV1 = CommerceResources["orders"][number];
type CommercePaymentV1 = CommerceResources["payments"][number];
type CommercePickupFulfillmentV1 = Extract<
  CommerceResources["fulfillments"][number],
  Readonly<{ kind: "pickup" }>
>;

type CounterSaleAfterSale = Readonly<{
  order: Readonly<{
    id: string;
    revision: number;
    state: CommerceOrderV1["lifecycle"]["state"];
  }>;
  payment: Readonly<{
    id: string;
    revision: number;
    state: CommercePaymentV1["lifecycle"]["state"];
  }>;
  fulfillment: Readonly<{
    id: string;
    revision: number;
    state: CommercePickupFulfillmentV1["lifecycle"]["state"];
  }>;
  refundState: "none" | "pending" | "completed" | "failed";
}>;

export type CounterSaleView = CounterSaleReadback &
  Readonly<{
    afterSale: CounterSaleAfterSale | null;
  }>;

export type CounterRegisterDeps = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  organisationId: OrganisationId;
  merchantId: string;
  client: CommerceAdminClient;
}>;

export type CounterRegisterFailure =
  | Readonly<{ kind: "commerce"; error: CommerceClientError }>
  | Readonly<{
      kind: "error";
      code: string;
      status: number;
      extra?: Record<string, unknown>;
    }>;

export type CounterRegisterResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: CounterRegisterFailure }>;
