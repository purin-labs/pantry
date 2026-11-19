import type {
  CommerceObservationResult,
  CommerceEntityPlaneObservationV1,
} from "@purin-labs/commerce-contracts";
import { parseCommerceEntityPlaneObservation } from "@purin-labs/commerce-contracts/entity-plane-observations";
import { parseCommerceObservationResult as parseContractObservationResult } from "@purin-labs/commerce-contracts/entity-plane-results";
import { decodeRecord } from "./record-decoding.ts";

export type { CommerceEntityPlaneObservationV1 } from "@purin-labs/commerce-contracts";

export function parseEntityPlaneObservation(
  value: unknown,
): CommerceEntityPlaneObservationV1 {
  return decodeRecord(parseCommerceEntityPlaneObservation, value);
}

export function parseCommerceObservationResult(
  value: unknown,
): CommerceObservationResult {
  return decodeRecord(parseContractObservationResult, value);
}
