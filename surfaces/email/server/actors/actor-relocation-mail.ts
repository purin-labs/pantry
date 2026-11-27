import {
  hasExactKeys,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import {
  parseConnectorId,
  parseIntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  resolveFrozenReceiptActors,
  type ActorRelocationError,
  type ActorRelocationId,
  type RelocationBindings,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { RelocationReceiptError } from "@purin-labs/actor-runtime/actors/actor-relocation-state";
import {
  rejectedRelocationMailReceipt as rejectedReceipt,
  type RelocationMailReceipt,
} from "@purin-labs/area-inbox-contract/server/relocation-mail-receipt";

export type { RelocationMailReceipt };

export function parseRelocationMailReceipt(
  raw: unknown,
): Result<RelocationMailReceipt, RelocationReceiptError> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "connectorId",
      "integrationAccountId",
      "proposalId",
      "version",
      "snapshotDigest",
      "rfcMessageId",
      "providerMessageId",
      "providerThreadId",
    ])
  )
    return rejectedReceipt();
  if (
    typeof raw.connectorId !== "string" ||
    typeof raw.integrationAccountId !== "string"
  )
    return rejectedReceipt();
  const connectorId = parseConnectorId(raw.connectorId);
  const integrationAccountId = parseIntegrationAccountId(
    raw.integrationAccountId,
  );
  if (
    !connectorId.ok ||
    !integrationAccountId.ok ||
    (raw.kind !== "reply" && raw.kind !== "operational") ||
    !isNonEmptyString(raw.proposalId) ||
    !isPositiveInteger(raw.version) ||
    typeof raw.snapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.snapshotDigest) ||
    !isNonEmptyString(raw.rfcMessageId) ||
    !isNonEmptyString(raw.providerMessageId) ||
    !isNonEmptyString(raw.providerThreadId)
  )
    return rejectedReceipt();
  return {
    ok: true,
    value: {
      kind: raw.kind,
      connectorId: connectorId.value,
      integrationAccountId: integrationAccountId.value,
      proposalId: raw.proposalId,
      version: raw.version,
      snapshotDigest: raw.snapshotDigest,
      rfcMessageId: raw.rfcMessageId,
      providerMessageId: raw.providerMessageId,
      providerThreadId: raw.providerThreadId,
    },
  };
}

export async function reconcileActorRelocationMailReceipt(input: {
  readonly env: RelocationBindings;
  readonly relocationId: ActorRelocationId;
  readonly receipt: RelocationMailReceipt;
  readonly now: number;
}): Promise<Result<null, ActorRelocationError>> {
  const source = await resolveFrozenReceiptActors(
    input.env,
    input.relocationId,
  );
  if (!source.ok) return source;
  for (const entry of source.value.entries) {
    if (
      entry.identity.objectKind !== "connector" ||
      entry.identity.logicalObjectId !== input.receipt.connectorId
    )
      continue;
    const connector = actorStub(
      input.env.CONNECTOR,
      entry.physicalObjectName,
      entry.placement,
    );
    return connector.reconcileRelocationMailReceipt({
      relocationId: source.value.relocationId,
      expectedFenceToken: entry.fenceToken,
      receipt: input.receipt,
      now: input.now,
    });
  }
  return { ok: false, error: { code: "relocation_receipt_rejected" } };
}
