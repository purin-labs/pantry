import {
  exactObject as accountObject,
  textValue as accountText,
  integer,
} from "@seams-internal/console-shared/accountPlatform/boundary";
import {
  readPlatformScopeV1 as parseAccountScope,
  platformScopeFieldsEqual as sameAccountScope,
  readSatyrFeePolicyV1 as parsePantryFeePolicy,
  readFundsReservationV1 as readAccountFundsReservation,
  readServiceIdentityResolutionV1,
  readPlatformUsageReceiptV1 as readAccountUsageReceipt,
  readLinkedServiceUserV1 as readLinkedUser,
  type PlatformScopeFieldsV1 as AccountScope,
  type SatyrFeePolicyV1 as PantryFeePolicy,
  type AccountServiceErrorV1 as AccountPlatformError,
  type LinkedServiceUserV1 as LinkedPantryAccountUser,
  type PlatformIdentityLinkV1,
  type PlatformPrincipalV1,
  type ServiceIdentityResolutionV1,
  type ServiceEligibilityV1,
  type DurableSourceEvidenceV1 as AccountSourceEvidence,
  type PlatformScopeV1,
  type FundsReservationV1,
  type ReserveFundsRequestV1,
  type MarkFundsIndeterminateRequestV1,
  type FundsTerminalDeliveryDataV1 as AccountTerminalDelivery,
  type SatyrFundingSelectionV1 as AccountExecutionFunding,
  type PlatformUsageEventDataV1,
  type SatyrTurnUsageV1 as PantryTurnUsageV1,
  type SatyrJevInputTokensUsageV1 as PantryJevInputTokensUsageV1,
  type PlatformUsageReceiptV1 as AccountUsageReceipt,
} from "@seams-internal/console-shared/accountPlatform";
import type { Result } from "../result";

export {
  accountObject,
  accountText,
  parseAccountScope,
  sameAccountScope,
  parsePantryFeePolicy,
  readAccountFundsReservation,
  readAccountUsageReceipt,
  readLinkedUser,
};
export type {
  AccountScope,
  PantryFeePolicy,
  AccountPlatformError,
  LinkedPantryAccountUser,
  AccountSourceEvidence,
  AccountTerminalDelivery,
  AccountExecutionFunding,
  AccountUsageReceipt,
};

export type PantryAccountBinding = Readonly<{
  version: 1;
  instanceId: string;
  scope: AccountScope;
  nativeOrganisationId: string;
  deploymentId: string;
  feePolicy: PantryFeePolicy;
}>;
export type LinkedPantryAccountAutomation = Readonly<{
  nativePrincipalId: string;
  automationId: string;
  grantId: string;
  authorityRevision: number;
  accessRevision: number;
}>;
type StoredAccountScope<T> = T extends { readonly scope: PlatformScopeV1 }
  ? Omit<T, "scope"> & { readonly scope: AccountScope }
  : never;
export type AccountPrincipal =
  | Extract<PlatformPrincipalV1, { readonly kind: "automation" }>
  | (Omit<
      Extract<PlatformPrincipalV1, { readonly kind: "user" }>,
      "identity"
    > & {
      readonly identity: Extract<
        PlatformIdentityLinkV1,
        { readonly kind: "verified_provider_subject" }
      > & { readonly issuer: "https://accounts.google.com" };
    });
export type AccountIdentityResolution = Omit<
  Pick<ServiceIdentityResolutionV1, keyof ServiceIdentityResolutionV1>,
  "principal"
> & { readonly principal: AccountPrincipal };
export type AccountEligibility = Omit<ServiceEligibilityV1, "principal"> & {
  readonly principal: AccountPrincipal;
};
export type AccountFundsReservation = StoredAccountScope<FundsReservationV1>;
export type AccountReserveRequest = Pick<
  ReserveFundsRequestV1,
  keyof ReserveFundsRequestV1
>;
export type AccountIndeterminateRequest = Pick<
  MarkFundsIndeterminateRequestV1,
  keyof MarkFundsIndeterminateRequestV1
>;
/** One Pantry turn on the test meter. */
export type AccountTurnUsageRequest = PlatformUsageEventDataV1 & PantryTurnUsageV1;
/** One UTC hour of Jev input tokens for one feature (Plan 88). */
export type AccountJevUsageRequest = PlatformUsageEventDataV1 &
  PantryJevInputTokensUsageV1;
export type AccountUsageRequest =
  | AccountTurnUsageRequest
  | AccountJevUsageRequest;

export function accountInteger(input: unknown, minimum = 0): number {
  return integer(input, "account integer", minimum);
}

/** Pantry admits verified Google subjects; the shared wire format supports other services too. */
export function assertPantryPrincipal(
  principal: PlatformPrincipalV1,
): asserts principal is AccountPrincipal {
  if (
    principal.kind === "user" &&
    (principal.identity.kind !== "verified_provider_subject" ||
      principal.identity.issuer !== "https://accounts.google.com")
  ) {
    throw new Error("Unsupported Satyr principal");
  }
}
export function readAccountIdentityResolution(
  input: unknown,
): AccountIdentityResolution {
  const resolution = readServiceIdentityResolutionV1(input);
  assertPantryPrincipal(resolution.principal);
  return {
    version: 1,
    scope: resolution.scope,
    instanceId: resolution.instanceId,
    nativePrincipalId: resolution.nativePrincipalId,
    principal: resolution.principal,
    authorityRevision: resolution.authorityRevision,
  };
}
export function accountUnavailable<T>(): Result<T, AccountPlatformError> {
  return { ok: false, error: { code: "authority_unavailable" } };
}

export function parsePantryAccountBinding(
  input: unknown,
): Result<PantryAccountBinding, AccountPlatformError> {
  try {
    const r = accountObject(input, [
      "version",
      "instanceId",
      "scope",
      "nativeOrganisationId",
      "deploymentId",
      "feePolicy",
    ]);
    if (r.version !== 1) throw new Error("Invalid binding version");
    return {
      ok: true,
      value: {
        version: 1,
        instanceId: accountText(r.instanceId),
        scope: parseAccountScope(r.scope),
        nativeOrganisationId: accountText(r.nativeOrganisationId),
        deploymentId: accountText(r.deploymentId),
        feePolicy: parsePantryFeePolicy(r.feePolicy),
      },
    };
  } catch {
    return accountUnavailable();
  }
}
