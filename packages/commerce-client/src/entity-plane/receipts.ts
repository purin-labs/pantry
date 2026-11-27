import type { CommerceCommandResult } from "@purin-labs/commerce-contracts";
import { parseCommerceCommandResult } from "@purin-labs/commerce-contracts/entity-plane-results";
import { decodeRecord } from "./record-decoding.ts";

export function parseEntityPlaneCommandResult(
  value: unknown,
): CommerceCommandResult {
  return decodeRecord(parseCommerceCommandResult, value);
}
