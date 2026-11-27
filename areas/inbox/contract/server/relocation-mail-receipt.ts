import type { ConnectorId, IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { ActorRelocationId } from "@purin-labs/actor-runtime/actors/actor-relocation";
import type { ActorFenceToken } from "@purin-labs/actor-runtime/actors/actor-registry";
import type { RelocationReceiptError } from "@purin-labs/actor-runtime/actors/actor-relocation-state";

/**
 * A mail send that an operator saw while the Connector of the mailbox was
 * frozen for a relocation. The relocation admin route parses it, and the
 * Inbox records it in the frozen Connector.
 */
export type RelocationMailReceipt = {
  readonly kind: "reply" | "operational";
  readonly connectorId: ConnectorId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly proposalId: string;
  readonly version: number;
  readonly snapshotDigest: string;
  readonly rfcMessageId: string;
  readonly providerMessageId: string;
  readonly providerThreadId: string;
};

/** The request that the frozen Connector gets for one receipt. */
export type RelocationMailReceiptRequest = {
  readonly relocationId: ActorRelocationId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly receipt: RelocationMailReceipt;
  readonly now: number;
};

export function rejectedRelocationMailReceipt(): Result<
  never,
  RelocationReceiptError
> {
  return { ok: false, error: { code: "relocation_receipt_rejected" } };
}
