import {
  d1TransitionApplied,
  prepareD1Transition,
} from "../data/d1-transition";
/**
 * The one writer of `paid_receipt` (Refactor 15, refactor 12). The shop's
 * feed records the Slack receipt of each paid online order here and moves on
 * to the next event; a receipt that cannot reach Slack never holds the order
 * queue or the stock. The feed tries each new receipt once at once. The
 * `paid_receipts` pass of the every-minute schedule tries each due receipt
 * again. The Connector delivery has the receipt's idempotency key, so Slack
 * gets one message for each paid order, also when two passes try it.
 */
import {
  machineTransition,
  type MachineEvent,
  type MachineState,
} from "@purin-labs/std/state-machine";
import type { ConnectorDelivery } from "@purin-labs/contracts";
import type { CanonicalCommerceDelivery } from "@purin-labs/commerce-contracts";
import { assertNever } from "@purin-labs/std";

import { resolveActiveConnectorActorAtPlacement } from "../actors/actor-router";
import { parseDelivery } from "../actors/connector/ingress-parsers";
import type { OrganisationDatabase } from "../database-handles";
import type { Env, ConnectorActorStub } from "../env";
import {
  newRequestId,
  parseChannelId,
  parseConnectorId,
  parseIntegrationAccountId,
  parseOrganisationId,
  parseWorkspaceId,
  type ChannelId,
  type ConnectorId,
  type IntegrationAccountId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import { traceWarn } from "../observability";
import {
  configuredOrganisationDatabases,
  OrganisationExecutionScope,
} from "../organisation-execution-scope";
import type { Result } from "../result";
import { PAID_RECEIPT_MACHINE } from "./paid-receipt.machine";
import {
  paidPlacementConnectorDelivery,
  paidPlacements,
} from "./paid-placements";

type PaidReceiptState = MachineState<typeof PAID_RECEIPT_MACHINE>;
type PaidReceiptEvent = MachineEvent<typeof PAID_RECEIPT_MACHINE>;

/** The schedule's retry pass, named as the machine's `due` exits name it. */
const PAID_RECEIPT_PASS = {
  name: "paid_receipts",
  /** How long one attempt holds a receipt before another pass may try it. */
  leaseMs: 60_000,
  firstRetryMs: 60_000,
  maxRetryMs: 15 * 60_000,
  /** A receipt that Slack did not get within a day is no longer news. */
  lifetimeMs: 24 * 60 * 60_000,
  page: 20,
} as const;

type PaidReceiptRow = Readonly<{
  organisationId: OrganisationId;
  receiptId: string;
  connectorId: ConnectorId;
  delivery: ConnectorDelivery;
  state: Extract<PaidReceiptState, "pending" | "failed">;
  attempts: number;
  revision: number;
  createdAt: number;
}>;

type CommunicationDestination = Readonly<{
  integrationAccountId: IntegrationAccountId;
  workspaceId: WorkspaceId;
  channelId: ChannelId;
}>;

/**
 * Records the receipt of each paid placement in one feed delivery, and tries
 * each new receipt once. Only a failed write is an error: the feed must not
 * acknowledge an event whose receipt it lost. No outcome of the attempt
 * stops the feed.
 */
export async function recordPaidReceipts(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    delivery: CanonicalCommerceDelivery;
    addressedAt: number;
    now: number;
  }>,
): Promise<Result<{ recorded: number }, { code: string }>> {
  const placements = paidPlacements(input.delivery);
  if (placements.length === 0) return { ok: true, value: { recorded: 0 } };
  const destination = await readCommunicationDestination(
    input.scope.database,
    input.scope.organisationId,
  );
  if (!destination.ok) {
    if (
      destination.error === "underclerk_slack_receipt_destination_unavailable"
    )
      return { ok: false, error: { code: destination.error } };
    // A shop with no Slack channel has no one to tell here; its staff see
    // the order in the queue. A damaged channel row is reported here.
    if (destination.error === "underclerk_slack_receipt_destination_invalid")
      traceWarn("underclerk.paid_receipt_destination_invalid", {
        requestId: newRequestId(),
        organisation_id: input.scope.organisationId,
      });
    return { ok: true, value: { recorded: 0 } };
  }
  const connectorId = parseConnectorId(
    `connector_slack_${destination.value.integrationAccountId}`,
  );
  if (!connectorId.ok) return { ok: true, value: { recorded: 0 } };
  const rows = placements.map((placement) => {
    const delivery = paidPlacementConnectorDelivery({
      destination: destination.value,
      placement,
      providerDeliveryId: input.delivery.providerDeliveryId,
      addressedAt: input.addressedAt,
    });
    return {
      orderId: placement.order.provenance.resourceId,
      row: {
        organisationId: input.scope.organisationId,
        receiptId: delivery.deliveryId,
        connectorId: connectorId.value,
        delivery,
        state: "pending",
        attempts: 0,
        revision: 1,
        createdAt: input.now,
      } satisfies PaidReceiptRow,
    };
  });
  let inserted: readonly D1Result[];
  try {
    inserted = await input.scope.database.batch(
      rows.map(({ orderId, row }) =>
        input.scope.database
          .prepare(
            `INSERT INTO paid_receipt (
               organisation_id, receipt_id, order_id, connector_id, delivery_json,
               state, failure_reason, attempts, next_attempt_at, revision,
               created_at, updated_at, sent_at
             ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, 0, ?, 1, ?, ?, NULL)
             ON CONFLICT (organisation_id, receipt_id) DO NOTHING`,
          )
          .bind(
            row.organisationId,
            row.receiptId,
            orderId,
            row.connectorId,
            JSON.stringify(row.delivery),
            // The feed holds the new receipt while it tries it. If the run
            // stops, the retry pass takes it when this lease ends.
            input.now + PAID_RECEIPT_PASS.leaseMs,
            input.now,
            input.now,
          ),
      ),
    );
  } catch {
    return {
      ok: false,
      error: { code: "underclerk_paid_receipt_record_failed" },
    };
  }
  const connectors = new ConnectorStubs(input.env, input.scope, input.now);
  for (const [index, { row }] of rows.entries()) {
    // A replayed feed event finds its receipt stored; the retry pass owns it.
    if (inserted[index]?.meta.changes !== 1) continue;
    await attemptPaidReceipt(input.scope, connectors, row, input.now);
  }
  return { ok: true, value: { recorded: rows.length } };
}

/**
 * The retry pass of every Organisation that has a due receipt. The
 * every-minute schedule runs it; each Organisation fails alone.
 */
export async function runScheduledPaidReceiptDelivery(
  env: Env,
  now: number,
): Promise<void> {
  for (const database of configuredOrganisationDatabases(env)) {
    let organisations: readonly OrganisationId[];
    try {
      organisations = await dueOrganisations(database, now);
    } catch {
      traceWarn("underclerk.paid_receipt_pass_read_failed", {
        requestId: newRequestId(),
        reconciler: PAID_RECEIPT_PASS.name,
      });
      continue;
    }
    for (const organisationId of organisations) {
      try {
        const scope = await OrganisationExecutionScope.resolve(
          env,
          organisationId,
        );
        // Another database owns this Organisation and runs its pass itself.
        if (!scope.ok || scope.value.database !== database) continue;
        await deliverDuePaidReceipts({ env, scope: scope.value, now });
      } catch {
        traceWarn("underclerk.paid_receipt_pass_failed", {
          requestId: newRequestId(),
          reconciler: PAID_RECEIPT_PASS.name,
          organisation_id: organisationId,
        });
      }
    }
  }
}

/** Tries the oldest due receipts of one Organisation again, up to one page. */
async function deliverDuePaidReceipts(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    now: number;
  }>,
): Promise<void> {
  const connectors = new ConnectorStubs(input.env, input.scope, input.now);
  const due = await dueReceipts(input.scope, input.now);
  for (const row of due) {
    if (lifetimeEnded(row, input.now)) {
      await movePaidReceipt(input.scope.database, row, "expire", {
        reason: "paid_receipt_lifetime_ended",
        now: input.now,
      });
      continue;
    }
    // The claim moves the next attempt past the lease: a second pass that
    // reads the same row finds it taken and leaves it.
    const claimed = await input.scope.database
      .prepare(
        `UPDATE paid_receipt
         SET next_attempt_at = ?, revision = revision + 1, updated_at = ?
         WHERE organisation_id = ? AND receipt_id = ?
           AND state = ? AND revision = ?`,
      )
      .bind(
        input.now + PAID_RECEIPT_PASS.leaseMs,
        input.now,
        row.organisationId,
        row.receiptId,
        row.state,
        row.revision,
      )
      .run();
    if (claimed.meta.changes !== 1) continue;
    await attemptPaidReceipt(
      input.scope,
      connectors,
      { ...row, revision: row.revision + 1 },
      input.now,
    );
  }
}

async function attemptPaidReceipt(
  scope: OrganisationExecutionScope,
  connectors: ConnectorStubs,
  row: PaidReceiptRow,
  now: number,
): Promise<void> {
  const outcome = await sendToConnector(connectors, row, now);
  const attempted = { ...row, attempts: row.attempts + 1 };
  // A lost write leaves the receipt held until its lease ends; the next pass
  // then tries it again, and the Connector answers a repeat as delivered.
  try {
    switch (outcome.kind) {
      case "sent":
        await movePaidReceipt(scope.database, attempted, "send", { now });
        return;
      case "failed":
        await movePaidReceipt(scope.database, attempted, "fail", {
          reason: outcome.reason,
          now,
        });
        return;
      case "refused":
        await movePaidReceipt(scope.database, attempted, "refuse", {
          reason: outcome.reason,
          now,
        });
        return;
      default:
        assertNever(outcome, "Unexpected paid receipt outcome");
    }
  } catch {
    traceWarn("underclerk.paid_receipt_write_failed", {
      requestId: newRequestId(),
      reconciler: PAID_RECEIPT_PASS.name,
      organisation_id: scope.organisationId,
    });
  }
}

type ConnectorOutcome =
  | Readonly<{ kind: "sent" }>
  | Readonly<{ kind: "failed" | "refused"; reason: string }>;

async function sendToConnector(
  connectors: ConnectorStubs,
  row: PaidReceiptRow,
  now: number,
): Promise<ConnectorOutcome> {
  const connector = await connectors.resolve(row.connectorId);
  if (!connector.ok) return { kind: "failed", reason: connector.error };
  let result: Awaited<ReturnType<ConnectorActorStub["deliver"]>>;
  try {
    result = await connector.value.deliver({
      identity: {
        organisationId: row.organisationId,
        connectorId: row.connectorId,
      },
      delivery: row.delivery,
      requestedAt: now,
    });
  } catch {
    return {
      kind: "failed",
      reason: "underclerk_slack_receipt_connector_unavailable",
    };
  }
  if (!result.ok)
    return {
      kind: "failed",
      reason: `underclerk_slack_receipt_connector_${result.error.code}`,
    };
  switch (result.value.kind) {
    case "delivered":
    case "already_delivered":
      return { kind: "sent" };
    case "retry":
      return {
        kind: "failed",
        reason: `underclerk_slack_receipt_retry_${result.value.reason}`,
      };
    // The Connector keeps a refusal for the receipt's key: a later attempt
    // gets the same answer.
    case "rejected":
      return {
        kind: "refused",
        reason: `underclerk_slack_receipt_rejected_${result.value.reason}`,
      };
    default:
      return assertNever(result.value, "Unexpected Connector delivery result");
  }
}

/** One Connector stub for each connector of one pass. */
class ConnectorStubs {
  readonly #stubs = new Map<
    ConnectorId,
    Promise<Result<ConnectorActorStub, string>>
  >();

  constructor(
    private readonly env: Env,
    private readonly scope: OrganisationExecutionScope,
    private readonly now: number,
  ) {}

  resolve(
    connectorId: ConnectorId,
  ): Promise<Result<ConnectorActorStub, string>> {
    let stub = this.#stubs.get(connectorId);
    if (stub === undefined) {
      stub = this.load(connectorId);
      this.#stubs.set(connectorId, stub);
    }
    return stub;
  }

  private async load(
    connectorId: ConnectorId,
  ): Promise<Result<ConnectorActorStub, string>> {
    try {
      const connector = await resolveActiveConnectorActorAtPlacement({
        env: this.env,
        namespace: this.env.CONNECTOR,
        organisationId: this.scope.organisationId,
        connectorId,
        placement: this.scope.placement,
        now: this.now,
      });
      return connector.ok
        ? connector
        : {
            ok: false,
            error: `underclerk_slack_receipt_actor_${connector.error.code}`,
          };
    } catch {
      return { ok: false, error: "underclerk_slack_receipt_actor_unavailable" };
    }
  }
}

/**
 * The one write of a move. It changes the row only while the row still has
 * the state and the revision that the caller read, so a second pass that
 * tried the same receipt cannot write over the first.
 */
async function movePaidReceipt(
  database: OrganisationDatabase,
  row: PaidReceiptRow,
  event: PaidReceiptEvent,
  fields: Readonly<{ now: number; reason?: string }>,
): Promise<boolean> {
  const move =
    event === "expire"
      ? machineTransition(PAID_RECEIPT_MACHINE, row.state, event, {
          lifetime_ended: () => lifetimeEnded(row, fields.now),
        })
      : machineTransition(PAID_RECEIPT_MACHINE, row.state, event);
  if (!move.allowed) return false;
  const next = move.to;
  const failed = next === "failed";
  const nextAttemptAt = failed ? fields.now + retryDelay(row.attempts) : null;
  const written = await prepareD1Transition(
    database,
    PAID_RECEIPT_MACHINE.store,
    {
      where: {
        organisation_id: row.organisationId,
        receipt_id: row.receiptId,
      },
      from: { state: row.state, revision: row.revision },
      to: next,
      set: {
        failure_reason: next === "sent" ? null : (fields.reason ?? null),
        attempts: row.attempts,
        next_attempt_at: nextAttemptAt,
        sent_at: next === "sent" ? fields.now : null,
      },
      updatedAt: fields.now,
    },
  ).run();
  return d1TransitionApplied(written);
}

function lifetimeEnded(row: PaidReceiptRow, now: number): boolean {
  return now - row.createdAt >= PAID_RECEIPT_PASS.lifetimeMs;
}

/** One minute after the first failure, doubled to 15 minutes. */
function retryDelay(attempts: number): number {
  return Math.min(
    PAID_RECEIPT_PASS.maxRetryMs,
    PAID_RECEIPT_PASS.firstRetryMs * 2 ** Math.max(0, attempts - 1),
  );
}

async function dueOrganisations(
  database: OrganisationDatabase,
  now: number,
): Promise<readonly OrganisationId[]> {
  const rows = await database
    .prepare(
      `SELECT DISTINCT organisation_id AS organisationId
       FROM paid_receipt
       WHERE state IN ('pending', 'failed') AND next_attempt_at <= ?
       LIMIT 100`,
    )
    .bind(now)
    .all<Record<string, unknown>>();
  const organisations: OrganisationId[] = [];
  for (const row of rows.results) {
    if (typeof row.organisationId !== "string") continue;
    const organisationId = parseOrganisationId(row.organisationId);
    if (organisationId.ok) organisations.push(organisationId.value);
  }
  return organisations;
}

async function dueReceipts(
  scope: OrganisationExecutionScope,
  now: number,
): Promise<readonly PaidReceiptRow[]> {
  const rows = await scope.database
    .prepare(
      `SELECT receipt_id AS receiptId, connector_id AS connectorId,
              delivery_json AS deliveryJson, state, attempts, revision,
              created_at AS createdAt
       FROM paid_receipt
       WHERE organisation_id = ? AND state IN ('pending', 'failed')
         AND next_attempt_at <= ?
       ORDER BY next_attempt_at, receipt_id
       LIMIT ?`,
    )
    .bind(scope.organisationId, now, PAID_RECEIPT_PASS.page)
    .all<Record<string, unknown>>();
  const due: PaidReceiptRow[] = [];
  for (const row of rows.results) {
    const parsed = parseReceiptRow(scope.organisationId, row);
    if (parsed !== null) due.push(parsed);
    else
      traceWarn("underclerk.paid_receipt_unreadable", {
        requestId: newRequestId(),
        reconciler: PAID_RECEIPT_PASS.name,
        organisation_id: scope.organisationId,
      });
  }
  return due;
}

function parseReceiptRow(
  organisationId: OrganisationId,
  row: Record<string, unknown>,
): PaidReceiptRow | null {
  if (
    typeof row.receiptId !== "string" ||
    typeof row.connectorId !== "string" ||
    typeof row.deliveryJson !== "string" ||
    (row.state !== "pending" && row.state !== "failed") ||
    typeof row.attempts !== "number" ||
    typeof row.revision !== "number" ||
    typeof row.createdAt !== "number"
  )
    return null;
  const connectorId = parseConnectorId(row.connectorId);
  let delivery: ConnectorDelivery | null;
  try {
    delivery = parseDelivery(JSON.parse(row.deliveryJson));
  } catch {
    delivery = null;
  }
  if (!connectorId.ok || delivery === null) return null;
  return {
    organisationId,
    receiptId: row.receiptId,
    connectorId: connectorId.value,
    delivery,
    state: row.state,
    attempts: row.attempts,
    revision: row.revision,
    createdAt: row.createdAt,
  };
}

async function readCommunicationDestination(
  database: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<
  Result<
    CommunicationDestination,
    | "underclerk_slack_receipt_destination_missing"
    | "underclerk_slack_receipt_destination_invalid"
    | "underclerk_slack_receipt_destination_unavailable"
  >
> {
  let row: Record<string, unknown> | null;
  try {
    row = await database
      .prepare(
        `SELECT integration_account_id AS integrationAccountId,
                workspace_id AS workspaceId,
                channel_id AS channelId
         FROM organisation_communication_destination
         WHERE organisation_id = ?`,
      )
      .bind(organisationId)
      .first<Record<string, unknown>>();
  } catch {
    return {
      ok: false,
      error: "underclerk_slack_receipt_destination_unavailable",
    };
  }
  if (row === null)
    return { ok: false, error: "underclerk_slack_receipt_destination_missing" };
  if (
    typeof row.integrationAccountId !== "string" ||
    typeof row.workspaceId !== "string" ||
    typeof row.channelId !== "string"
  )
    return { ok: false, error: "underclerk_slack_receipt_destination_invalid" };
  const integrationAccountId = parseIntegrationAccountId(
    row.integrationAccountId,
  );
  const workspaceId = parseWorkspaceId(row.workspaceId);
  const channelId = parseChannelId(row.channelId);
  return integrationAccountId.ok && workspaceId.ok && channelId.ok
    ? {
        ok: true,
        value: {
          integrationAccountId: integrationAccountId.value,
          workspaceId: workspaceId.value,
          channelId: channelId.value,
        },
      }
    : { ok: false, error: "underclerk_slack_receipt_destination_invalid" };
}
