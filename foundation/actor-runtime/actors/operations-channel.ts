import type { ConnectorDelivery } from "@purin-labs/contracts";
import type { OperationsDestination } from "@purin-labs/tenancy/data/operations-destination";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { resolveActiveConnectorActorAtPlacement } from "./actor-router";

/**
 * One card in the Organisation's operations channel, through its Slack
 * Connector. The Connector keeps one receipt for each delivery id, so a
 * repeated card answers with the first message. Device alerts and bake
 * proposals post this way; no agent turn takes part.
 */
export type OperationsCard = Readonly<{
  deliveryId: string;
  bindingId: string;
  caseId: string;
  caseRevision: number;
  text: string;
  idempotencyKey: string;
  /** The trace name of a card that did not go out, for example `devices.alert`. */
  trace: string;
  /** A reply in this message's thread, in place of a channel message. */
  threadTs?: string;
}>;

/** The Slack message ts of the card, or null when it did not go out. */
export async function deliverOperationsCard(
  env: Env,
  scope: OrganisationExecutionScope,
  destination: OperationsDestination,
  card: OperationsCard,
  now: number,
): Promise<string | null> {
  const delivery = {
    deliveryId: card.deliveryId,
    bindingId: card.bindingId,
    address:
      card.threadTs === undefined
        ? {
            kind: "slack_channel",
            workspaceId: destination.workspaceId,
            channelId: destination.channelId,
          }
        : {
            kind: "slack",
            workspaceId: destination.workspaceId,
            channelId: destination.channelId,
            threadTs: card.threadTs,
          },
    caseId: card.caseId,
    caseRevision: card.caseRevision,
    content: { kind: "text", text: card.text },
    idempotencyKey: card.idempotencyKey,
    addressedAt: now,
  } as ConnectorDelivery;
  try {
    const connector = await resolveActiveConnectorActorAtPlacement({
      env,
      namespace: env.CONNECTOR,
      organisationId: scope.organisationId,
      connectorId: destination.connectorId,
      placement: scope.placement,
      now,
    });
    if (!connector.ok) return null;
    const result = await connector.value.deliver({
      identity: {
        organisationId: scope.organisationId,
        connectorId: destination.connectorId,
      },
      delivery,
      requestedAt: now,
    });
    if (
      result.ok &&
      (result.value.kind === "delivered" ||
        result.value.kind === "already_delivered")
    )
      return result.value.receipt.nativeReceiptId;
    traceWarn(`${card.trace}_delivery_held`, {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      deliveryId: card.deliveryId,
      outcome: result.ok ? result.value.kind : result.error.code,
    });
    return null;
  } catch {
    traceWarn(`${card.trace}_delivery_failed`, {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      deliveryId: card.deliveryId,
    });
    return null;
  }
}
