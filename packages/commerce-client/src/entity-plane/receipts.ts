import type {
  CommerceCommandResult,
  CommerceEntityPlaneError,
  CommerceMutationReceiptV1,
} from "@seams/commerce-contracts";
import { parseCommerceMutationReceipt } from "@seams/commerce-contracts/entity-plane-receipts";
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

export function parseReceipt(value: unknown): CommerceMutationReceiptV1 {
  return decodeRecord(parseCommerceMutationReceipt, value);
}

function parseError(value: unknown): CommerceEntityPlaneError {
  return decodeRecord(parseContractError, value);
}
