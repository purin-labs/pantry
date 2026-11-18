import type { OrganisationDatabase } from "../database-handles";
import {
  terminalAssignmentPaymentBinding,
  terminalTargetDeviceId,
  terminalTargetHealthIsObservable,
  type TerminalAssignment,
} from "@seams/contracts";

import type { OrganisationId } from "../ids";
import { listActiveTerminalAssignments } from "./terminal-assignment-store";
import type { Variant } from "@seams/type-utils";
import type { TerminalCounterReadback } from "@seams/control-api";
/**
 * What an operator needs in order to answer "can this counter take a payment
 * right now, and if not, why".
 *
 * Every field is a fact Pantry already holds. Nothing is inferred from elapsed
 * time, and device health is reported beside collection eligibility rather than
 * folded into it: a device Square has not heard from is a provider-time
 * collection failure, not a loss of authority.
 */
type TerminalOperationsReadback = Readonly<{
  schemaVersion: "satyr.terminal-operations.v2";
  organisationId: OrganisationId;
  generatedAt: string;
  counters: readonly TerminalCounterReadback[];
  /**
   * Rows that could not be parsed. Surfaced as a count rather than dropped,
   * because a counter Pantry cannot describe is still a counter that exists.
   */
  unreadableAssignments: number;
}>;

/**
 * Read every card-present counter for one organisation.
 *
 * Locations with no active assignment do not appear: an unpaired counter is not
 * a terminal in a bad state, it is a location that does not sell this way.
 */
export async function readTerminalOperations(
  input: Readonly<{
    db: OrganisationDatabase;
    organisationId: OrganisationId;
    now: number;
    /** The Square locations whose payments Commerce takes (Plan 80). */
    linkedLocationIds: ReadonlySet<string>;
  }>,
): Promise<TerminalOperationsReadback> {
  const assignments = await listActiveTerminalAssignments(
    input.db,
    input.organisationId,
  );
  const counters: TerminalCounterReadback[] = [];
  let unreadableAssignments = 0;
  for (const assignment of assignments) {
    if (!assignment.ok) {
      unreadableAssignments += 1;
      continue;
    }
    counters.push(
      await readCounter(
        input.db,
        input.organisationId,
        assignment.value,
        input.linkedLocationIds,
      ),
    );
  }
  return {
    schemaVersion: "satyr.terminal-operations.v2",
    organisationId: input.organisationId,
    generatedAt: new Date(input.now).toISOString(),
    counters,
    unreadableAssignments,
  };
}

async function readCounter(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  assignment: TerminalAssignment,
  linkedLocationIds: ReadonlySet<string>,
): Promise<TerminalCounterReadback> {
  const binding = terminalAssignmentPaymentBinding(assignment);
  const authority = await readTerminalAuthority(db, organisationId, assignment);
  const described = {
    assignmentId: assignment.assignmentId,
    revision: assignment.revision,
    merchantId: assignment.merchantId as string,
    integrationAccountId: assignment.account.integrationAccountId as string,
    capabilityRevision: assignment.account.capabilityRevision,
    capabilityCurrent: authority.capabilityCurrent,
    providerLocationId: assignment.providerLocationId,
    targetKind: assignment.target.kind,
    deviceId: terminalTargetDeviceId(assignment.target),
    adapterVersion: assignment.adapterVersion,
    environment: assignment.account.environment,
    healthIsObservable: terminalTargetHealthIsObservable(assignment.target),
  } as const;

  return {
    satyrLocationId: assignment.satyrLocationId,
    // A retired assignment has no binding.
    blockedReason: binding.ok ? null : "assignment_retired",
    assignment: described,
    credentialHealth: authority.credentialHealth,
    webhook: authority.webhook,
    paymentsLinked:
      binding.ok && linkedLocationIds.has(assignment.providerLocationId),
  };
}

type TerminalAuthorityRow = Readonly<{
  accountLifecycle: unknown;
  accountCapabilityRevision: unknown;
  connectionLifecycle: unknown;
  connectionCredentialGeneration: unknown;
  webhookLifecycle: unknown;
  webhookCredentialGeneration: unknown;
  lastVerifiedAt: unknown;
  webhookUpdatedAt: unknown;
}>;

type TerminalAuthorityReadback = Pick<
  TerminalCounterReadback,
  "credentialHealth" | "webhook"
> &
  Readonly<{ capabilityCurrent: boolean }>;

async function readTerminalAuthority(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  assignment: TerminalAssignment,
): Promise<TerminalAuthorityReadback> {
  const row = await db
    .prepare(
      `SELECT integration_account.lifecycle AS accountLifecycle,
            integration_account.updated_at AS accountCapabilityRevision,
            provider_connection.lifecycle AS connectionLifecycle,
            provider_connection.credential_generation AS connectionCredentialGeneration,
            provider_webhook.lifecycle AS webhookLifecycle,
            provider_webhook.credential_generation AS webhookCredentialGeneration,
            provider_webhook.last_verified_at AS lastVerifiedAt,
            provider_webhook.updated_at AS webhookUpdatedAt
     FROM integration_account
     JOIN provider_connection
       ON provider_connection.provider_connection_id = integration_account.provider_connection_id
     LEFT JOIN provider_webhook
       ON provider_webhook.integration_account_id = integration_account.integration_account_id
      AND provider_webhook.provider = 'square'
      AND provider_webhook.environment = integration_account.environment
      AND provider_webhook.provider_native_id = integration_account.provider_account_id
      AND provider_webhook.event_type = 'terminal_events'
     WHERE integration_account.organisation_id = ?
       AND integration_account.integration_account_id = ?
       AND integration_account.provider = 'square'
       AND integration_account.provider_account_id = ?
       AND integration_account.environment = ?`,
    )
    .bind(
      organisationId,
      assignment.account.integrationAccountId,
      assignment.account.providerAccountId,
      assignment.account.environment,
    )
    .first<TerminalAuthorityRow>();
  if (row === null) {
    return {
      capabilityCurrent: false,
      credentialHealth: "unavailable",
      webhook: { kind: "unconfigured" },
    };
  }
  return {
    capabilityCurrent:
      assignment.account.capabilityRevision ===
      Math.max(
        1,
        requireNonnegativeInteger(
          row.accountCapabilityRevision,
          "account capability revision",
        ),
      ),
    credentialHealth: terminalCredentialHealth(row),
    webhook: terminalWebhookReadback(row),
  };
}

function terminalCredentialHealth(
  row: TerminalAuthorityRow,
): TerminalCounterReadback["credentialHealth"] {
  const accountLifecycle = requireAccountLifecycle(row.accountLifecycle);
  const connectionLifecycle = requireConnectionLifecycle(
    row.connectionLifecycle,
  );
  if (accountLifecycle === "revoked" || connectionLifecycle === "revoked")
    return "revoked";
  if (accountLifecycle === "disabled" || connectionLifecycle === "disabled")
    return "disabled";
  if (
    accountLifecycle === "reauth_required" ||
    connectionLifecycle === "reauth_required"
  ) {
    return "reauth_required";
  }
  if (accountLifecycle === "degraded") return "degraded";
  return accountLifecycle === "active" && connectionLifecycle === "active"
    ? "active"
    : "unavailable";
}

function terminalWebhookReadback(
  row: TerminalAuthorityRow,
): TerminalCounterReadback["webhook"] {
  if (row.webhookLifecycle === null) return { kind: "unconfigured" };
  const lifecycle = requireWebhookLifecycle(row.webhookLifecycle);
  const connectionGeneration = requirePositiveInteger(
    row.connectionCredentialGeneration,
    "connection credential generation",
  );
  const webhookGeneration = requirePositiveInteger(
    row.webhookCredentialGeneration,
    "webhook credential generation",
  );
  const updatedAt = requireNonnegativeInteger(
    row.webhookUpdatedAt,
    "webhook update time",
  );
  const lastVerifiedAt =
    row.lastVerifiedAt === null
      ? null
      : requireNonnegativeInteger(
          row.lastVerifiedAt,
          "webhook verification time",
        );
  return {
    kind: "configured",
    lifecycle,
    credentialCurrent: connectionGeneration === webhookGeneration,
    lastVerifiedAt,
    updatedAt,
  };
}

type TerminalAccountLifecycle =
  | "connecting"
  | "pending_activation"
  | "active"
  | "degraded"
  | "reauth_required"
  | "disabled"
  | "revoked";

function requireAccountLifecycle(raw: unknown): TerminalAccountLifecycle {
  switch (raw) {
    case "connecting":
    case "pending_activation":
    case "active":
    case "degraded":
    case "reauth_required":
    case "disabled":
    case "revoked":
      return raw;
    default:
      throw new Error("Terminal account lifecycle is corrupt");
  }
}

type TerminalConnectionLifecycle =
  "connecting" | "active" | "reauth_required" | "disabled" | "revoked";

function requireConnectionLifecycle(raw: unknown): TerminalConnectionLifecycle {
  switch (raw) {
    case "connecting":
    case "active":
    case "reauth_required":
    case "disabled":
    case "revoked":
      return raw;
    default:
      throw new Error("Terminal connection lifecycle is corrupt");
  }
}

function requireWebhookLifecycle(
  raw: unknown,
): Variant<TerminalCounterReadback["webhook"], "configured">["lifecycle"] {
  switch (raw) {
    case "pending":
    case "live":
    case "degraded":
    case "disabled":
    case "revoked":
      return raw;
    default:
      throw new Error("Terminal webhook lifecycle is corrupt");
  }
}

function requirePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0)
    return raw;
  throw new Error(`Terminal ${field} is corrupt`);
}

function requireNonnegativeInteger(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
    return raw;
  throw new Error(`Terminal ${field} is corrupt`);
}
