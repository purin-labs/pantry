import type { UnitTestEnv } from "./worker-fakes";
import { isRecord } from "@seams/std";
import type { ActorRecoveryAdmission } from "../src/actors/actor-activation";
import { createAgentOperationsDatabase } from "./agent-operations-database";
import { requireOrganisationId } from "./test-ids";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";

// Existing Case state-machine tests isolate authorization. Native Case journeys
// exercise real origin, membership, placement and Actor recovery boundaries.
export async function admitCaseMutationFixture(
  _env: Pick<UnitTestEnv, "DB" | "SATYR_ORGANISATION_PLACEMENT_PROFILE">,
  storage: Pick<DurableObjectStorage, "sql">,
): Promise<ActorRecoveryAdmission> {
  const meta = storage.sql
    .exec<{ organisation_id: string }>(
      "SELECT organisation_id FROM case_meta WHERE singleton = 1",
    )
    .toArray()[0];
  if (meta === undefined) return { kind: "inactive" };
  const organisationId = requireOrganisationId(meta.organisation_id);
  const scope = await requireOrganisationExecutionScope(
    {
      DB: createAgentOperationsDatabase(organisationId),
      SATYR_ORGANISATION_PLACEMENT_PROFILE: JSON.stringify({
 databaseBinding: "DB",
        kind: "affinity",
        placementCellId: "test",
        locationHint: "wnam",
      }),
    },
    organisationId,
  );
  return { kind: "admitted", scope };
}

export async function allowCaseMutationFixture(): Promise<boolean> {
  return true;
}

export function withCaseMutationExecution(
  organisationId: string,
  input: unknown,
): unknown {
  if (!isRecord(input)) return input;
  const proposal = isRecord(input.proposal) ? input.proposal : null;
  const origin =
    proposal !== null && isRecord(proposal.origin) ? proposal.origin : null;
  const placement = {
    kind: "affinity",
    placementEpoch: 1,
    placementCellId: "test",
    locationHint: "wnam",
  };
  const deadlineAt = Date.now() + 600_000;
  if (origin?.kind === "agent_session") {
    const binding = isRecord(input.flowBinding) ? input.flowBinding : null;
    return {
      ...input,
      execution: {
        kind: "session_turn",
        organisationId,
        placement,
        fenceToken: "fixture-fence",
        deadlineAt,
        execution: {
          sessionId: origin.sessionId,
          turnId: binding?.turnId ?? "turn_fixture",
          requestAuthority: proposal?.requestAuthority,
        },
      },
    };
  }
  return {
    ...input,
    execution: {
      kind: "control_session",
      organisationId,
      placement,
      fenceToken: "fixture-fence",
      deadlineAt,
      controlSessionId:
        origin?.controlSessionId ?? "control_session_case_fixture",
      userId: origin?.userId ?? "user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab",
    },
  };
}
