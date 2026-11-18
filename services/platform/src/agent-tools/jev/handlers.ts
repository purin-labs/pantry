import type { JevFeaturesView } from "@seams/control-api/portal/jev-features";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import { requireSessionExecution } from "../../actors/session-execution-admission";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  digestCanonical,
  ObservationEvidence,
} from "../../policy";
import { JevFeatureRequestError } from "../catalog/types";
import type { SessionToolContext } from "../context";
import { liveDeviceMember } from "../session-support";

/**
 * The Jev settings for the agent (Plan 88 section 6): the view that Settings ›
 * Jev reads, so fields that a later phase adds reach the agent too. Every
 * member may read it. A mailbox name enters the turn only after the
 * information-flow boundary admits it.
 */
export async function readJevFeaturesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<JevFeaturesView> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null)
    throw new JevFeatureRequestError(
      "Only a member of this workspace can read its Jev settings. Nothing was read. Tell the person.",
    );
  const label = await createCurrentSourceFlowLabel({
    kind: "jev_settings",
    db: scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) throw new Error("Jev settings source policy unavailable");
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit")
    throw new Error("Jev settings context admission denied");
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  const read = await organisation.readJevFeatures({
    organisationId: scope.organisationId,
  });
  if (!read.ok) throw new Error(`Jev settings read failed: ${read.error.code}`);
  await requireSessionExecution(execution, lease);
  const now = Date.now();
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: scope.organisationId,
      recordId: "jev-features",
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(read.value),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) throw new Error("Jev settings observation is invalid");
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
    throw new Error("Jev settings observation admission failed");
  await requireSessionExecution(execution, lease);
  return read.value;
}
