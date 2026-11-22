import type { BakeRunRecord } from "@purin-labs/kitchen-control-api";
import { deliverOperationsCard } from "../actors/operations-channel";
import { readOperationsDestination } from "@purin-labs/tenancy/data/operations-destination";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId } from "@purin-labs/kernel/ids";
import {
  readBakeProposal,
  readBakeProposalCardTs,
} from "../kitchen/bakes/records";
import { traceWarn } from "@purin-labs/kernel/observability";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  bakeRunCardNotice,
  bakeRunCardText,
  bakeRunCardUpdate,
  bakeRunOverBakeText,
} from "./bake-run-card";

/**
 * A bake run's posts in its proposal's Slack thread (Plan 24 S6): one card
 * that each change of the run's state or hold updates, and one message when
 * the unload is late after the bake. A shop with no Slack channel, or a
 * proposal whose card did not go out, gets the Bakes page only. A post that
 * fails never fails the run.
 */

type RunRecord = Omit<BakeRunRecord, "check" | "problem">;

async function threadOf(scope: OrganisationExecutionScope, record: RunRecord) {
  const [destination, proposal, cardTs] = await Promise.all([
    readOperationsDestination(scope.database, scope.organisationId),
    readBakeProposal(scope.database, scope.organisationId, record.proposalId),
    readBakeProposalCardTs(
      scope.database,
      scope.organisationId,
      record.proposalId,
    ),
  ]);
  if (!destination.ok || proposal === null || cardTs === null) return null;
  return { destination: destination.value, caseId: proposal.caseId, cardTs };
}

async function post(
  env: Env,
  scope: OrganisationExecutionScope,
  record: RunRecord,
  deliveryId: string,
  text: string,
  now: number,
): Promise<void> {
  try {
    const thread = await threadOf(scope, record);
    if (thread === null) return;
    await deliverOperationsCard(
      env,
      scope,
      thread.destination,
      {
        deliveryId,
        bindingId: `binding_${thread.caseId}`,
        caseId: thread.caseId,
        caseRevision: 2,
        text,
        idempotencyKey: `bake_run:${deliveryId}`,
        trace: "kitchen.bake_run",
        threadTs: thread.cardTs,
      },
      now,
    );
  } catch {
    traceWarn("kitchen.bake_run_announce_failed", {
      requestId: newRequestId(),
      organisationId: scope.organisationId,
      runId: record.runId,
      deliveryId,
    });
  }
}

/** Posts the run's card, at its first revision, or updates it. */
export function announceBakeRun(
  env: Env,
  scope: OrganisationExecutionScope,
  record: RunRecord,
  revision: number,
  now: number,
): Promise<void> {
  return post(
    env,
    scope,
    record,
    revision <= 1
      ? bakeRunCardNotice(record)
      : bakeRunCardUpdate(record, revision),
    bakeRunCardText(record),
    now,
  );
}

/** The one message of the over-bake risk; its delivery id makes it one. */
export function tellBakeRunOverBake(
  env: Env,
  scope: OrganisationExecutionScope,
  record: RunRecord,
  risk: NonNullable<RunRecord["unloadRisk"]>,
  now: number,
): Promise<void> {
  return post(
    env,
    scope,
    record,
    `bake_run_overbake_${record.runId}`,
    bakeRunOverBakeText(record, risk),
    now,
  );
}
