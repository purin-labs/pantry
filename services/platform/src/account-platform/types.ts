import {
  exactObject as accountObject,
  textValue as accountText,
  integer,
} from "@seams-internal/console-shared/accountPlatform/boundary";
import {
  readPlatformScopeV1 as parseAccountScope,
  platformScopeFieldsEqual as sameAccountScope,
  readSatyrFeePolicyV1 as parsePantryFeePolicy,
  type SatyrFeePolicyV1 as PantryFeePolicy,
  type AccountServiceErrorV1 as AccountPlatformError,
  type DurableSourceEvidenceV1 as AccountSourceEvidence,
} from "@seams-internal/console-shared/accountPlatform";
import type { Result } from "../result";

// Plan 95: the Console wire types of the provisioning route and the instance
// release. Step 4 deletes them with the route.
export {
  accountObject,
  accountText,
  parseAccountScope,
  sameAccountScope,
  parsePantryFeePolicy,
};
export type { PantryFeePolicy, AccountPlatformError, AccountSourceEvidence };

export function accountInteger(input: unknown, minimum = 0): number {
  return integer(input, "account integer", minimum);
}

export function accountUnavailable<T>(): Result<T, AccountPlatformError> {
  return { ok: false, error: { code: "authority_unavailable" } };
}
