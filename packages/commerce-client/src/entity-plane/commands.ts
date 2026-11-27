import type { CommerceEntityPlaneCommandRequest } from "@purin-labs/commerce-contracts/entity-plane-commands";
export type { CommerceEntityPlaneCommandRequest } from "@purin-labs/commerce-contracts/entity-plane-commands";
import type { CommerceEntityPlaneCommand } from "@purin-labs/commerce-contracts";
import { parseCommerceTimestamp } from "./primitives.ts";
import * as commandContracts from "@purin-labs/commerce-contracts/entity-plane-commands";
import { decodeRecord } from "./record-decoding.ts";

export function parseEntityPlaneCommand(
  value: unknown,
): CommerceEntityPlaneCommandRequest {
  const now = parseCommerceTimestamp(new Date().toISOString(), "authority.now");
  return decodeRecord(parseCommandAtTime.bind(null, now), value);
}

export function parseCommerceEntityPlaneCommand(
  value: unknown,
): CommerceEntityPlaneCommand {
  return decodeRecord(commandContracts.parseCommerceEntityPlaneCommand, value);
}
function parseCommandAtTime(now: string, value: unknown) {
  return commandContracts.parseEntityPlaneCommand(value, now);
}
