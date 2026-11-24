import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  terminalAssignmentPaymentBinding,
  terminalTargetDeviceId,
  terminalTargetHealthIsObservable,
  type TerminalAssignment,
} from "@purin-labs/commerce-contracts";

import type { OrganisationId } from "@purin-labs/kernel/ids";
import { listActiveTerminalAssignments } from "./terminal-assignment-store";
import type { TerminalCounterReadback } from "@purin-labs/control-api";
import type {
  TerminalOperationsReadback,
  TerminalOperationsRequest,
} from "../contract/cafe-services";
/**
 * Read every card-present counter for one organisation.
 *
 * Locations with no active assignment do not appear: an unpaired counter is not
 * a terminal in a bad state, it is a location that does not sell this way.
 */
export async function readTerminalOperations(
  input: TerminalOperationsRequest,
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
    schemaVersion: "pantry.terminal-operations.v2",
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
    pantryLocationId: assignment.pantryLocationId,
    // A retired assignment has no binding.
    blockedReason: binding.ok ? null : "assignment_retired",
    assignment: described,
    credentialHealth: authority.credentialHealth,
    paymentsLinked:
      binding.ok && linkedLocationIds.has(assignment.providerLocationId),
  };
}

type TerminalAuthorityRow = Readonly<{
  accountLifecycle: unknown;
  accountCapabilityRevision: unknown;
  connectionLifecycle: unknown;
}>;

type TerminalAuthorityReadback = Pick<
  TerminalCounterReadback,
  "credentialHealth"
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
            provider_connection.lifecycle AS connectionLifecycle
     FROM integration_account
     JOIN provider_connection
       ON provider_connection.provider_connection_id = integration_account.provider_connection_id
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

function requireNonnegativeInteger(raw: unknown, field: string): number {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
    return raw;
  throw new Error(`Terminal ${field} is corrupt`);
}
