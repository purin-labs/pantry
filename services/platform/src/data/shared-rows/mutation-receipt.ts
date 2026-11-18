/**
 * The control mutation receipts (Refactor 12). The table is in both baselines,
 * but a receipt is never copied between the databases: each receipt lives in
 * the database of the effect that it records, and it is written in the same
 * batch as that effect. Its replay reads the same database. A receipt moves
 * and is restored with its Organisation's rows (organisation-row.ts holds the
 * rules of the regional copy). See docs/refactor-12.md.
 */
import { assertNever } from "@seams/std";
import type { OrganisationExecutionScope } from "../../organisation-execution-scope";
import type {
  ControlMutationBoundary,
  ControlMutationIdentity,
  ControlMutationReceiptScope,
  ControlMutationReplay,
} from "../control-mutation";
import type {
  GlobalQuerySource,
  OrganisationQuerySource,
  QuerySource,
} from "../query-source";
import type { OrganisationId } from "../../ids";

type MutationReceiptRow = {
  readonly requestHash: unknown;
  readonly responseStatus: unknown;
  readonly responseBody: unknown;
};

const MUTATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

export async function readControlMutationReplay(input: {
  readonly db: QuerySource;
  readonly scope: ControlMutationReceiptScope;
  readonly boundary: ControlMutationBoundary;
}): Promise<ControlMutationReplay> {
  const row = await input.db
    .prepare(
      `SELECT request_hash AS requestHash, response_status AS responseStatus,
            response_body AS responseBody
     FROM control_mutation_receipt
     WHERE user_id = ? AND organisation_scope = ? AND route = ?
       AND operation = ? AND idempotency_key = ?`,
    )
    .bind(
      input.scope.userId,
      input.scope.organisationScope,
      input.scope.route,
      input.scope.operation,
      input.boundary.idempotencyKey,
    )
    .first<MutationReceiptRow>();
  if (row === null) {
    return { kind: "absent" };
  }
  if (row.requestHash !== input.boundary.requestHash) {
    return { kind: "conflict" };
  }
  if (
    typeof row.responseStatus !== "number" ||
    typeof row.responseBody !== "string"
  ) {
    throw new Error("control mutation receipt is corrupt");
  }
  return {
    kind: "replay",
    receipt: {
      responseStatus: row.responseStatus,
      responseBody: JSON.parse(row.responseBody),
    },
  };
}

type ControlMutationReceiptInput = {
  readonly scope: ControlMutationReceiptScope;
  readonly boundary: ControlMutationBoundary;
  readonly identity: ControlMutationIdentity;
  readonly responseStatus: number;
  readonly responseBody: unknown;
};

export function prepareControlMutationReceipt(
  db: QuerySource,
  input: ControlMutationReceiptInput,
): D1PreparedStatement {
  return controlMutationReceiptStatement(db, input, { kind: "unconditional" });
}

export function prepareControlMutationReceiptAfterWrite(
  db: QuerySource,
  input: ControlMutationReceiptInput,
): D1PreparedStatement {
  return controlMutationReceiptStatement(db, input, {
    kind: "preceding_write",
  });
}

/**
 * Finishes a receipt that was stored as accepted (202) with its final body,
 * when the request hash still matches.
 */
export function prepareControlMutationReceiptCompletion(
  db: QuerySource,
  input: Readonly<{
    receiptId: string;
    requestHash: string;
    responseBody: unknown;
  }>,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE control_mutation_receipt SET response_status = 200, response_body = ?
       WHERE receipt_id = ? AND request_hash = ? AND response_status = 202`,
    )
    .bind(
      JSON.stringify(input.responseBody),
      input.receiptId,
      input.requestHash,
    );
}

export function prepareOrganisationControlMutationReceipt(
  db: QuerySource,
  input: ControlMutationReceiptInput & {
    readonly executionScope: OrganisationExecutionScope;
  },
): D1PreparedStatement {
  return controlMutationReceiptStatement(db, input, {
    kind: "organisation_placement",
    executionScope: input.executionScope,
  });
}

function controlMutationReceiptStatement(
  db: QuerySource,
  input: ControlMutationReceiptInput,
  admission:
    | { readonly kind: "unconditional"; readonly executionScope?: never }
    | { readonly kind: "preceding_write"; readonly executionScope?: never }
    | {
        readonly kind: "organisation_placement";
        readonly executionScope: OrganisationExecutionScope;
      },
): D1PreparedStatement {
  let condition: string;
  let bindings: readonly (string | number)[];
  switch (admission.kind) {
    case "unconditional":
      condition = "";
      bindings = [];
      break;
    case "preceding_write":
      condition = " WHERE changes() = 1";
      bindings = [];
      break;
    case "organisation_placement": {
      const scope = admission.executionScope;
      condition = ` WHERE ? = ? AND EXISTS (
        SELECT 1 FROM organisation_placement WHERE organisation_id = ?
        AND placement_epoch = ? AND placement_cell_id = ?
        AND fence_token = ? AND status = 'active')`;
      bindings = [
        input.scope.organisationScope,
        scope.organisationId,
        scope.organisationId,
        scope.placement.placementEpoch,
        scope.placement.placementCellId,
        scope.fenceToken,
      ];
      break;
    }
    default:
      return assertNever(admission);
  }
  return db
    .prepare(
      `INSERT INTO control_mutation_receipt (
       receipt_id, user_id, organisation_scope, route, operation,
       idempotency_key, request_hash, response_status, response_body,
       created_at, expires_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${condition}`,
    )
    .bind(
      input.identity.receiptId,
      input.scope.userId,
      input.scope.organisationScope,
      input.scope.route,
      input.scope.operation,
      input.boundary.idempotencyKey,
      input.boundary.requestHash,
      input.responseStatus,
      JSON.stringify(input.responseBody),
      input.identity.createdAt,
      input.identity.createdAt + MUTATION_RECEIPT_TTL_MS,
      ...bindings,
    );
}

/**
 * Onboarding answers 201 once the global placement is active. The receipt is
 * in the global database, beside the reservation that it records.
 */
export function prepareBootstrapReceiptPublication(
  directory: GlobalQuerySource,
  input: Readonly<{
    receiptId: string;
    requestHash: string;
    responseBody: unknown;
    organisationId: OrganisationId;
    fenceToken: string;
  }>,
): D1PreparedStatement {
  return directory
    .prepare(
      `UPDATE control_mutation_receipt SET response_status = 201, response_body = ?
       WHERE receipt_id = ? AND request_hash = ? AND response_status = 202
       AND EXISTS (SELECT 1 FROM organisation_placement WHERE organisation_id = ? AND placement_epoch = 1 AND fence_token = ? AND status = 'active')`,
    )
    .bind(
      JSON.stringify(input.responseBody),
      input.receiptId,
      input.requestHash,
      input.organisationId,
      input.fenceToken,
    );
}

/** A purge drops the Organisation's expired receipts with its other rows. */
export function prepareExpiredOrganisationReceiptsDeletion(
  db: OrganisationQuerySource,
  organisationId: OrganisationId,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM control_mutation_receipt
       WHERE organisation_scope = ? AND expires_at <= ?`,
    )
    .bind(organisationId, now);
}
