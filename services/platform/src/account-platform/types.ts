import {
  exactObject as accountObject,
  textValue as accountText,
  integer,
} from "@seams-internal/console-shared/accountPlatform/boundary";
import {
  readPlatformScopeV1 as parseAccountScope,
  platformScopeFieldsEqual as sameAccountScope,
  readSatyrFeePolicyV1 as parsePantryFeePolicy,
  readServiceIdentityResolutionV1,
  readLinkedServiceUserV1 as readLinkedUser,
  type PlatformScopeFieldsV1 as AccountScope,
  type SatyrFeePolicyV1 as PantryFeePolicy,
  type AccountServiceErrorV1 as AccountPlatformError,
  type LinkedServiceUserV1 as LinkedPantryAccountUser,
  type PlatformIdentityLinkV1,
  type PlatformPrincipalV1,
  type ServiceIdentityResolutionV1,
  type DurableSourceEvidenceV1 as AccountSourceEvidence,
} from "@seams-internal/console-shared/accountPlatform";
import type { Result } from "../result";
import type { Variant } from "@purin-labs/type-utils";

export {
  accountObject,
  accountText,
  parseAccountScope,
  sameAccountScope,
  parsePantryFeePolicy,
  readLinkedUser,
};
export type {
  AccountScope,
  AccountPlatformError,
  LinkedPantryAccountUser,
  AccountSourceEvidence,
};

export type PantryAccountBinding = Readonly<{
  version: 1;
  instanceId: string;
  scope: AccountScope;
  nativeOrganisationId: string;
  deploymentId: string;
  feePolicy: PantryFeePolicy;
}>;
export type AccountPrincipal =
  | Variant<PlatformPrincipalV1, "automation">
  | (Omit<Variant<PlatformPrincipalV1, "user">, "identity"> & {
      readonly identity: Variant<
        PlatformIdentityLinkV1,
        "verified_provider_subject"
      > & { readonly issuer: "https://accounts.google.com" };
    });
export type AccountIdentityResolution = Omit<
  Pick<ServiceIdentityResolutionV1, keyof ServiceIdentityResolutionV1>,
  "principal"
> & { readonly principal: AccountPrincipal };
export function accountInteger(input: unknown, minimum = 0): number {
  return integer(input, "account integer", minimum);
}

/** Pantry admits verified Google subjects; the shared wire format supports other services too. */
function assertPantryPrincipal(
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
