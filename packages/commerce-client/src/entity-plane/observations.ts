import type { CommerceEntityPlaneObservationV1 } from "@purin-labs/commerce-contracts";
import { parseCommerceEntityPlaneObservation } from "@purin-labs/commerce-contracts/entity-plane-observations";
import { decodeRecord } from "./record-decoding.ts";

export type { CommerceEntityPlaneObservationV1 } from "@purin-labs/commerce-contracts";

export function parseEntityPlaneObservation(
  value: unknown,
): CommerceEntityPlaneObservationV1 {
  return decodeRecord(parseCommerceEntityPlaneObservation, value);
}
