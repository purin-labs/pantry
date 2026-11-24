import type {
  CommerceCommandResult,
  Quantity,
} from "@purin-labs/commerce-contracts";
import {
  parseInventoryProductionPlanAcceptance,
  parseInventoryQuantityText,
  type InventoryProductionPlanAcceptance,
  type InventoryProductionPlanLine,
  type InventoryProductionPlanOutcome,
} from "@purin-labs/kitchen-control-api";
import {
  parseEntityPlaneCommand,
  parseListEntryReadRequest,
  parseProductionRequestFields,
  productionRequestAttributes,
  type ProductionRequestFields,
  type CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { controlError, readJsonRecord } from "@purin-labs/control/worker/http";
import {
  finishInventoryOperation,
  resolveInventoryAccess,
  resolveInventoryMutation,
  type InventoryControlMutation,
} from "@purin-labs/area-kitchen-contract/server/inventory-control";
import { productionClient } from "./inventory-production";
import {
  type ProductionPlanRoute,
  authorizeProductionPlanSocket,
} from "../admission/production-plan";
import type { Variant } from "@purin-labs/type-utils";

export async function handleProductionPlanRoute(
  request: Request,
  env: Env,
  route: ProductionPlanRoute,
): Promise<Response> {
  if (route.transport === "accept")
    return acceptProductionPlan(request, env, route);
  const authorized = await authorizeProductionPlanSocket(request, env, route);
  if (!authorized.ok) return authorized.response;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    return organisation.fetch(request);
  } catch {
    return controlError("production_plan_unavailable", 503);
  }
}

type LineOutcome = InventoryProductionPlanOutcome;

type ReadEntry =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{
      kind: "found";
      merchantRevision: number;
      listRevision: number;
      revision: number;
      fields: ProductionRequestFields | null;
    }>;

type StepResult =
  | Readonly<{ kind: "applied"; requestRevision: number }>
  | Readonly<{ kind: "refused"; reason: "request_missing" | "request_changed" }>
  | Readonly<{ kind: "unavailable" }>;

/** An unrelated merchant write between the read and the command is retried. */
const STEP_ATTEMPTS = 3;

async function acceptProductionPlan(
  request: Request,
  env: Env,
  route: ProductionPlanRoute,
): Promise<Response> {
  if (request.method !== "POST") return controlError("method_not_allowed", 405);
  const access = await resolveInventoryAccess(
    request,
    env,
    route.organisationId,
    "operator",
  );
  if (!access.ok) return access.response;
  const plane = productionClient(
    env,
    String(access.value.authorized.organisationId),
  );
  if (plane === null) return controlError("commerce_unavailable", 503);
  const body = await readJsonRecord(request);
  if (!body.ok) return controlError("production_plan_invalid", 422);
  let acceptance: InventoryProductionPlanAcceptance;
  try {
    acceptance = parseInventoryProductionPlanAcceptance(body.value);
  } catch {
    return controlError("production_plan_invalid", 422);
  }
  const mutation = await resolveInventoryMutation(
    request,
    env,
    access.value,
    body.value,
    "inventory.production.accept_plan",
  );
  if (!mutation.ok) return mutation.response;
  const lines: LineOutcome[] = [];
  let reachable = true;
  for (const line of acceptance.lines) {
    const outcome = reachable
      ? await acceptPlanLine(plane, mutation.value, route.locationId, line)
      : ({
          requestId: line.requestId,
          revised: false,
          outcome: "unavailable",
        } as const);
    if (outcome.outcome === "unavailable") reachable = false;
    lines.push(outcome);
  }
  await clearSettledLines(env, mutation.value, route.locationId, lines);
  return finishInventoryOperation(request, env, mutation.value, {
    ok: true,
    lines,
  });
}

/**
 * Revises the request's quantity when the plan changed it, then accepts the
 * request. Each command carries an id from the accept's idempotency key, so a
 * repeated command replays its receipt.
 */
async function acceptPlanLine(
  plane: CommerceEntityPlaneClient,
  mutation: InventoryControlMutation,
  locationId: string,
  line: InventoryProductionPlanLine,
): Promise<LineOutcome> {
  const unavailable = {
    requestId: line.requestId,
    outcome: "unavailable",
  } as const;
  const current = await readEntry(plane, mutation, line.requestId);
  if (current.kind === "unavailable") return { ...unavailable, revised: false };
  if (current.kind === "missing")
    return refused(line, "request_missing", false);
  const fields = current.fields;
  if (
    fields === null ||
    fields.status !== "requested" ||
    fields.locationId !== locationId ||
    current.revision !== line.requestRevision
  )
    return refused(line, "request_changed", false);
  let planned: Quantity;
  try {
    planned = parseInventoryQuantityText(line.quantity, fields.quantity.unit);
    if (
      BigInt(planned.amount) * 10n ** BigInt(6 - planned.scale) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Quantity is too large.");
  } catch {
    return refused(line, "quantity_invalid", false);
  }
  let requestRevision = line.requestRevision;
  let revised = false;
  if (!sameQuantity(planned, fields.quantity)) {
    const revision = await commandStep(plane, mutation, {
      requestId: line.requestId,
      requestRevision,
      step: "revise",
      fields: { ...fields, quantity: planned },
      first: current,
    });
    if (revision.kind === "unavailable") return { ...unavailable, revised };
    if (revision.kind === "refused")
      return refused(line, revision.reason, revised);
    requestRevision = revision.requestRevision;
    revised = true;
  }
  const accepted = await commandStep(plane, mutation, {
    requestId: line.requestId,
    requestRevision,
    step: "accept",
    fields: { ...fields, quantity: planned, status: "accepted" },
    first: revised ? null : current,
  });
  if (accepted.kind === "unavailable") return { ...unavailable, revised };
  if (accepted.kind === "refused")
    return refused(line, accepted.reason, revised);
  return {
    requestId: line.requestId,
    revised,
    outcome: "accepted",
    quantity: planned,
  };
}

async function commandStep(
  plane: CommerceEntityPlaneClient,
  mutation: InventoryControlMutation,
  input: Readonly<{
    requestId: string;
    requestRevision: number;
    step: "revise" | "accept";
    fields: ProductionRequestFields;
    first: Variant<ReadEntry, "found"> | null;
  }>,
): Promise<StepResult> {
  let read: ReadEntry =
    input.first ?? (await readEntry(plane, mutation, input.requestId));
  for (let attempt = 0; attempt < STEP_ATTEMPTS; attempt++) {
    if (read.kind === "unavailable") return read;
    if (read.kind === "missing")
      return { kind: "refused", reason: "request_missing" };
    if (
      read.revision !== input.requestRevision ||
      read.fields?.status !== "requested"
    )
      return { kind: "refused", reason: "request_changed" };
    const result = await plane.command(
      patchCommand(mutation, input, read.merchantRevision, read.listRevision),
    );
    if (!result.ok) return { kind: "unavailable" };
    const settled = stepReceipt(result.value);
    if (settled !== null) return settled;
    read = await readEntry(plane, mutation, input.requestId);
  }
  return { kind: "refused", reason: "request_changed" };
}

/** The step's result, or null when another write moved a revision first. */
function stepReceipt(result: CommerceCommandResult): StepResult | null {
  if (result.status === "rejected")
    return result.error.code === "revision_conflict"
      ? null
      : { kind: "refused", reason: "request_changed" };
  const target = result.receipt.target;
  return target.kind === "commerce_list_entry"
    ? { kind: "applied", requestRevision: Number(target.revision) }
    : { kind: "refused", reason: "request_changed" };
}

function patchCommand(
  mutation: InventoryControlMutation,
  input: Readonly<{
    requestId: string;
    requestRevision: number;
    step: "revise" | "accept";
    fields: ProductionRequestFields;
  }>,
  merchantRevision: number,
  listRevision: number,
) {
  const commandId = `production_plan:${mutation.boundary.idempotencyKey}:${input.requestId}:${input.step}`;
  const target = {
    entry: {
      entryId: input.requestId,
      listId: "production_requests",
      revision: input.requestRevision,
    },
    expectedRevision: input.requestRevision,
  };
  return parseEntityPlaneCommand({
    organisationId: mutation.authorized.organisationId,
    merchantId: mutation.binding.merchantId,
    expectedMerchantRevision: merchantRevision,
    commandId,
    authority: {
      kind: "commerce_list_entry_command",
      context: {
        organisationId: mutation.authorized.organisationId,
        merchantId: mutation.binding.merchantId,
        principalId: mutation.identity.userId,
        sensitivityCeiling: "restricted",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        causation: { kind: "command", commandId },
      },
      scope: { kind: "commerce_list_entry", entry: target.entry },
      target,
    },
    command: {
      kind: "patch_commerce_list_entry",
      command: {
        target,
        expectedListRevision: listRevision,
        attributeValues: productionRequestAttributes(input.fields),
      },
    },
  });
}

async function readEntry(
  plane: CommerceEntityPlaneClient,
  mutation: InventoryControlMutation,
  requestId: string,
): Promise<ReadEntry> {
  const result = await plane.readListEntry(
    parseListEntryReadRequest({
      merchantId: mutation.binding.merchantId,
      listId: "production_requests",
      entryId: requestId,
    }),
  );
  if (!result.ok) return { kind: "unavailable" };
  if (result.value.kind === "missing") return { kind: "missing" };
  let fields: ProductionRequestFields | null;
  try {
    fields = parseProductionRequestFields(result.value.entry.attributeValues);
  } catch {
    fields = null;
  }
  return {
    kind: "found",
    merchantRevision: Number(result.value.merchantRevision),
    listRevision: Number(result.value.listRevision),
    revision: Number(result.value.entry.revision),
    fields,
  };
}

/**
 * Accepted lines and lines of requests that no longer exist leave the plan,
 * so open pages stop showing them. A failure leaves them; the page shows only
 * requests that wait for acceptance.
 */
async function clearSettledLines(
  env: Env,
  mutation: InventoryControlMutation,
  locationId: string,
  lines: readonly LineOutcome[],
): Promise<void> {
  const settled: string[] = [];
  for (const line of lines)
    if (
      line.outcome === "accepted" ||
      (line.outcome === "refused" && line.reason === "request_missing")
    )
      settled.push(line.requestId);
  if (settled.length === 0) return;
  try {
    const organisation = await requireActiveOrganisationActor({
      env,
      organisationId: mutation.authorized.organisationId,
      now: Date.now(),
    });
    const cleared = await organisation.clearProductionPlanLines({
      organisationId: mutation.authorized.organisationId,
      locationId,
      requestIds: settled,
      userId: mutation.authorized.authenticated.session.userId,
      controlSessionId:
        mutation.authorized.authenticated.session.controlSessionId,
    });
    if (cleared.ok) return;
  } catch {
    // Reported below.
  }
  traceWarn("inventory.production_plan_clear_deferred", {
    requestId: newRequestId(),
    organisation_id: mutation.authorized.organisationId,
  });
}

function refused(
  line: InventoryProductionPlanLine,
  reason: "request_missing" | "request_changed" | "quantity_invalid",
  revised: boolean,
): LineOutcome {
  return { requestId: line.requestId, revised, outcome: "refused", reason };
}

function sameQuantity(left: Quantity, right: Quantity): boolean {
  return (
    left.unit === right.unit &&
    BigInt(left.amount) * 10n ** BigInt(6 - left.scale) ===
      BigInt(right.amount) * 10n ** BigInt(6 - right.scale)
  );
}
