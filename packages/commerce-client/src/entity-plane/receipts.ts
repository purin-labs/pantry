import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
} from "@seams/commerce-contracts";
import {
  parseCommerceCommandResult,
  parseCommerceEntityPlaneError as parseContractError,
} from "@seams/commerce-contracts/entity-plane-results";
import { decodeRecord } from "./record-decoding.ts";

export function parseEntityPlaneCommandResult(
  value: unknown,
): CommerceCommandResult {
  return decodeRecord(parseCommerceCommandResult, value);
}

export function parseCommerceEntityPlaneError(
  value: unknown,
): CommerceEntityPlaneError {
  return parseError(value);
}

function parseError(value: unknown): CommerceEntityPlaneError {
  return decodeRecord(parseContractError, value);
}
