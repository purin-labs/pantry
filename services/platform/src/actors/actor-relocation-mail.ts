import {
  assertNever,
  hasExactKeys,
  isNonEmptyString,
  isPositiveInteger,
  isRecord,
} from "@purin-labs/std";
import {
  parseConnectorId,
  parseIntegrationAccountId,
  type ConnectorId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import { readPlacementByEpoch } from "@purin-labs/tenancy/data/organisation-placement";
import { selectOrganisationPlacementDatabase } from "@purin-labs/tenancy/organisation-execution-scope";
import { dispatchRfcMessageId } from "@purin-labs/connections/mail/reply-target";
import {
  resolveFrozenReceiptActors,
  type ActorRelocationError,
  type ActorRelocationId,
  type RelocationBindings,
} from "@purin-labs/actor-runtime/actors/actor-relocation";
import { actorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import type { ActorFenceToken } from "@purin-labs/actor-runtime/actors/actor-registry";
import { readActivationExportSource } from "@purin-labs/actor-runtime/actors/actor-export";
import {
  frozenRelocationReceiptGate,
  type RelocationReceiptError,
} from "@purin-labs/actor-runtime/actors/actor-relocation-state";
import {
  latestEmailDraftOperation,
  readEmailRuntime,
  updateEmailDraftState,
} from "./connector-email";
import {
  latestOperationalEmailProposal,
  readOperationalEmailDispatchId,
} from "./connector-email-operational";

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

export type RelocationMailReceiptRequest = {
  readonly relocationId: ActorRelocationId;
  readonly expectedFenceToken: ActorFenceToken;
  readonly receipt: RelocationMailReceipt;
  readonly now: number;
};

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

/** Record an operator-observed send. Never send mail or delete a provider draft here. */
export async function reconcileFrozenMailReceipt(
  env: Env,
  storage: DurableObjectStorage,
  request: RelocationMailReceiptRequest,
): Promise<Result<null, RelocationReceiptError>> {
  const activation = readActivationExportSource(storage.sql);
  if (
    !activation.ok ||
    activation.value.identity.objectKind !== "connector" ||
    activation.value.identity.logicalObjectId !== request.receipt.connectorId ||
    activation.value.fenceToken !== request.expectedFenceToken
  )
    return rejectedReceipt();
  const gate = frozenRelocationReceiptGate(
    env.DB,
    activation.value,
    request.relocationId,
  );
  if ((await gate.first()) === null) return rejectedReceipt();
  if (request.receipt.kind === "reply") {
    const runtime = readEmailRuntime(storage.sql);
    if (
      runtime === null ||
      runtime.organisationId !== activation.value.identity.organisationId ||
      runtime.integrationAccountId !== request.receipt.integrationAccountId
    )
      return rejectedReceipt();

    const placement = await readPlacementByEpoch(
      env.DB,
      activation.value.identity.organisationId,
      activation.value.placementEpoch,
    );
    if (!placement.ok) return rejectedReceipt();
    const database = selectOrganisationPlacementDatabase(
      env,
      activation.value.identity.organisationId,
      placement.value.placement,
    );
    if (!database.ok) return rejectedReceipt();
    const address = await database.value
      .prepare(
        "SELECT observed_address FROM email_mailbox_account WHERE organisation_id = ? AND integration_account_id = ?",
      )
      .bind(runtime.organisationId, runtime.integrationAccountId)
      .first<unknown>("observed_address");
    if (
      !isNonEmptyString(address) ||
      dispatchRfcMessageId(
        request.receipt.proposalId,
        request.receipt.version,
        address,
      ) !== request.receipt.rfcMessageId
    )
      return rejectedReceipt();
  }
  if ((await gate.first()) === null) return rejectedReceipt();
  return storage.transactionSync(
    settleMailReceipt.bind(null, storage.sql, request),
  );
}

function settleMailReceipt(
  sql: SqlStorage,
  request: RelocationMailReceiptRequest,
): Result<null, RelocationReceiptError> {
  const receipt = request.receipt;
  switch (receipt.kind) {
    case "reply": {
      const row = latestEmailDraftOperation(sql, receipt.proposalId);
      if (
        row === null ||
        row.version !== receipt.version ||
        row.snapshotDigest !== receipt.snapshotDigest ||
        row.approvedSnapshotDigest !== receipt.snapshotDigest ||
        row.threadId !== receipt.providerThreadId
      )
        return rejectedReceipt();
      if (row.state === "cleanup_pending" || row.state === "sent") {
        return row.sentMessageId === receipt.providerMessageId
          ? { ok: true, value: null }
          : rejectedReceipt();
      }
      if (row.state !== "send_indeterminate" || row.sentMessageId !== null)
        return rejectedReceipt();
      updateEmailDraftState(sql, {
        proposalId: receipt.proposalId,
        version: receipt.version,
        state: "cleanup_pending",
        sentMessageId: receipt.providerMessageId,
        now: request.now,
      });
      return { ok: true, value: null };
    }
    case "operational": {
      const row = latestOperationalEmailProposal(sql, receipt.proposalId);
      if (
        row === null ||
        row.version !== receipt.version ||
        row.integrationAccountId !== receipt.integrationAccountId ||
        row.snapshotDigest !== receipt.snapshotDigest ||
        row.approvedSnapshotDigest !== receipt.snapshotDigest ||
        readOperationalEmailDispatchId(sql, row) !== receipt.rfcMessageId
      )
        return rejectedReceipt();
      if (row.state === "sent") {
        return row.sentMessageId === receipt.providerMessageId &&
          row.sentThreadId === receipt.providerThreadId
          ? { ok: true, value: null }
          : rejectedReceipt();
      }
      if (
        row.state !== "send_indeterminate" ||
        row.sentMessageId !== null ||
        row.sentThreadId !== null
      )
        return rejectedReceipt();
      sql.exec(
        `UPDATE connector_email_operational_proposal SET state = 'sent', sent_message_id = ?,
        sent_thread_id = ?, updated_at = ? WHERE proposal_id = ? AND version = ?`,
        receipt.providerMessageId,
        receipt.providerThreadId,
        request.now,
        receipt.proposalId,
        receipt.version,
      );
      return { ok: true, value: null };
    }
    default:
      return assertNever(receipt.kind);
  }
}

function rejectedReceipt(): Result<never, RelocationReceiptError> {
  return { ok: false, error: { code: "relocation_receipt_rejected" } };
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
