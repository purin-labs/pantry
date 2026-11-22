// The port of a commerce system (Refactor 17, step A2.5). An Organisation
// selects one commerce system: the built-in commerce engine or Shopify. Each
// system gives one `CommerceProvider`, and `commerce-providers.ts` holds the
// one list of them. Code outside a provider asks the provider; it does not
// branch on the system kind.
import type { CommerceSystemKind } from "@purin-labs/contracts";
import type {
  CanonicalCommerceDelivery,
  CommerceProjection,
} from "@purin-labs/commerce-contracts";
import type {
  CommerceEngineProviderReceipt,
  CommerceLabProviderReceipt,
  CommerceShopifyProviderReceipt,
} from "@purin-labs/control-api";
import type { Variant, VariantBy } from "@purin-labs/type-utils";
import { definePort } from "@purin-labs/kernel/port";
import type {
  ActionExecutionRetryEvidence,
  ActionLedgerEntry,
  ExecutingActionLedgerEntry,
} from "@purin-labs/authority/actors/action-ledger";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { CommerceMerchantBinding } from "@purin-labs/connections/data/commerce-merchant-binding";
import type { ActiveProviderAccountContext } from "@purin-labs/connections/data/integration-account";
import type { CommerceSystem } from "@purin-labs/connections/data/organisation-commerce-system";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
} from "@purin-labs/kernel/ids";
import type { FlowDecision } from "@purin-labs/authority/policy/index";
import type { Result } from "@purin-labs/kernel/result";
import type { CommerceActionError, CommerceActionPath } from "../action-model";

export type CommerceProviderExecutionError =
  | CommerceActionError
  | { readonly code: "commerce_action_authority_superseded" }
  | { readonly code: "commerce_action_capability_inactive" }
  | { readonly code: "commerce_action_flow_binding_invalid" }
  | { readonly code: "commerce_action_flow_denied" }
  | { readonly code: "commerce_action_provider_indeterminate" }
  | { readonly code: "commerce_action_provider_execution_failed" }
  | { readonly code: "commerce_action_order_has_prepared_lines" };

type ApprovedCommerceActionEntry = VariantBy<
  ActionLedgerEntry,
  "state",
  "executing" | "indeterminate"
>;

/** The live credential of a provider that an approved action runs with. */
type CommerceProviderCredential =
  | Readonly<{
      kind: "shopify";
      accountContext: ActiveProviderAccountContext;
    }>
  | Readonly<{
      kind: "commerce";
      merchantBinding: CommerceMerchantBinding;
    }>;

type CommerceEffectGateCommon = Readonly<{
  current: CommerceProjection;
  flowDecision: Variant<FlowDecision, "allow">;
  approval: ApprovedCommerceActionEntry["approval"];
}>;

export type CommerceEffectGatePermit =
  | (Readonly<{ kind: "lab" }> & CommerceEffectGateCommon)
  | (CommerceProviderCredential & CommerceEffectGateCommon);

/** The permit of a commerce system; a `lab` permit has no provider. */
export type CommerceProviderPermit = Exclude<
  CommerceEffectGatePermit,
  Readonly<{ kind: "lab" }>
>;

export type CommerceProviderReconciliation =
  | Readonly<{
      kind: "settled";
      receipt: CommerceShopifyProviderReceipt | CommerceEngineProviderReceipt;
    }>
  | Readonly<{
      kind: "retryable";
      evidence: ActionExecutionRetryEvidence;
    }>
  | Readonly<{ kind: "unresolved" }>;

export type CommerceProviderOperation =
  | {
      readonly kind: "projection_delivery";
      readonly delivery: CanonicalCommerceDelivery;
      readonly receipt: CommerceLabProviderReceipt;
    }
  | {
      readonly kind: "provider_receipt";
      readonly receipt:
        CommerceShopifyProviderReceipt | CommerceEngineProviderReceipt;
    };

/** The sources of a commerce graph read for the selected system. */
type CommerceGraphSourcePlan =
  | Readonly<{ kind: "commerce_engine" }>
  | Readonly<{
      kind: "provider_backed";
      integrationAccountId: IntegrationAccountId;
    }>;

export type CommerceProviderExecuteInput = Readonly<{
  env: Env;
  action: ExecutingActionLedgerEntry;
  path: CommerceActionPath;
  permit: CommerceProviderPermit;
  currentRevision: number;
  now: number;
  fetcher: typeof fetch | undefined;
}>;

export type CommerceProviderReconcileInput = Readonly<{
  env: Env;
  action: VariantBy<ActionLedgerEntry, "state", "indeterminate">;
  path: CommerceActionPath;
  permit: CommerceProviderPermit;
  now: number;
  fetcher: typeof fetch | undefined;
}>;

export interface CommerceProvider<
  K extends CommerceSystemKind = CommerceSystemKind,
> {
  readonly kind: K;
  /** The control API shape of the selected system. */
  wire(system: Variant<CommerceSystem, K>): unknown;
  /** The sources that a commerce graph read of this system uses. */
  graphSource(system: Variant<CommerceSystem, K>): CommerceGraphSourcePlan;
  /**
   * The live credential of an approved action on a record of this system.
   * An error is `commerce_action_provider_execution_failed`.
   */
  resolveActionCredential(
    input: Readonly<{
      db: OrganisationDatabase;
      organisationId: OrganisationId;
      integrationAccountId: IntegrationAccountId;
    }>,
  ): Promise<
    Result<CommerceProviderCredential, CommerceProviderExecutionError>
  >;
  /** Runs an approved action after the effect gate passed. */
  executeAction(
    input: CommerceProviderExecuteInput,
  ): Promise<Result<CommerceProviderOperation, CommerceProviderExecutionError>>;
  /** Reads the provider for the outcome of an action with no receipt. */
  reconcileAction(
    input: CommerceProviderReconcileInput,
  ): Promise<
    Result<CommerceProviderReconciliation, CommerceProviderExecutionError>
  >;
}

export function commerceProviderUnsupported(): Result<
  never,
  CommerceProviderExecutionError
> {
  return { ok: false, error: { code: "commerce_action_provider_unsupported" } };
}

/** The revision of a projection, which a provider action compares. */
export function commerceProjectionRevision(
  projection: CommerceProjection,
): number {
  return projection.projection.provenance.revision;
}

/**
 * The commerce providers that a connection gives, such as Shopify. The
 * built-in engine is the provider of commerce itself. The Worker registers
 * the others (`worker-ports.ts`), so commerce imports no provider module.
 */
export type ConnectedCommerceProviders = {
  readonly [
    K in Exclude<CommerceSystemKind, "builtin_commerce">
  ]: CommerceProvider<K>;
};

export const connectedCommerceProviders =
  definePort<ConnectedCommerceProviders>("connected_commerce_providers");
