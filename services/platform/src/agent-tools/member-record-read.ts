import { admitSessionInformationFlowObservation } from "../actors/agent-session-information-flow";
import { requireSessionExecution } from "../actors/session-execution-admission";
import type { OrganisationMember } from "../data/control-plane";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  digestCanonical,
  ObservationEvidence,
} from "../policy";
import type { SessionToolContext } from "./context";
import { liveDeviceMember } from "./session-support";

/**
 * One agent read of an Organisation record that every member may read, such
 * as the Jev settings or the Bakes page. The person who asked must be a
 * member now. The value enters the turn only after the information-flow
 * boundary admits it, under the record's source label.
 */
export async function readMemberRecord<Value>(
  context: SessionToolContext,
  input: Readonly<{
    source: "device_fleet" | "recipe_workflow" | "jev_settings" | "bake_board";
    recordId: string;
    /**
     * Whether the member may read the record. A read that every member may
     * do leaves it out.
     */
    mayRead?: (member: OrganisationMember) => boolean;
    /** The refusal when the person who asked is not a member who may read. */
    refusal: () => Error;
    read: (member: OrganisationMember) => Promise<Value>;
  }>,
): Promise<Value> {
  const { storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null || input.mayRead?.(member) === false)
    throw input.refusal();
  const label = await createCurrentSourceFlowLabel({
    kind: input.source,
    db: scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) throw new Error(`${input.recordId} source policy unavailable`);
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit")
    throw new Error(`${input.recordId} context admission denied`);
  const value = await input.read(member);
  await requireSessionExecution(execution, lease);
  const now = Date.now();
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: scope.organisationId,
      recordId: input.recordId,
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(value),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) throw new Error(`${input.recordId} observation is invalid`);
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: label.value,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok)
    throw new Error(`${input.recordId} observation admission failed`);
  await requireSessionExecution(execution, lease);
  return value;
}
