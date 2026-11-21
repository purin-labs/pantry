import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import type {
  CaseAssignmentLifecycle,
  CaseLifecycle,
} from "@purin-labs/contracts";
import {
  listRecentActiveCaseRegistryEntries,
  type ActiveActorRegistryEntry,
} from "./actor-registry";
import { resolveActiveCaseActor } from "./actor-router";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";

type ActiveCaseOperationsView = {
  readonly caseId: string;
  readonly pinnedOrganisationId: OrganisationId;
  readonly purpose: string;
  readonly revision: number;
  readonly lifecycle: CaseLifecycle["kind"];
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly sessionId: string;
    readonly lifecycle: "assigned" | "running" | "settled";
  }[];
  readonly outputs: {
    readonly pending: number;
    readonly settled: number;
  };
};

/** The fields of a Case snapshot that the operations view reads. */
type CaseOperationsSnapshot = Readonly<{
  identity: Readonly<{ caseId: string }>;
  purpose: string;
  revision: number;
  lifecycle: CaseLifecycle;
  assignmentLifecycles: readonly CaseAssignmentLifecycle[];
  outputs: readonly Readonly<{ kind: string }>[];
}>;

type CaseOperationsError = { readonly code: "case_operations_unavailable" };

const RECENT_CASE_LIMIT = 20;

export async function readActiveCaseOperations(input: {
  readonly env: OrganisationPlacementBindings & Pick<Env, "CASE">;
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<Result<readonly ActiveCaseOperationsView[], CaseOperationsError>> {
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok)
    return { ok: false, error: { code: "case_operations_unavailable" } };
  const entries = await listRecentActiveCaseRegistryEntries({
    db: scope.value.database,
    organisationId: input.organisationId,
    limit: RECENT_CASE_LIMIT,
  });
  if (!entries.ok) {
    return { ok: false, error: { code: "case_operations_unavailable" } };
  }

  const inspected = await Promise.all(
    entries.value.map((entry) =>
      readActiveCaseOperation({
        env: input.env,
        organisationId: input.organisationId,
        now: input.now,
        entry,
      }),
    ),
  );
  const cases: ActiveCaseOperationsView[] = [];
  for (const result of inspected) {
    if (result.ok) cases.push(result.value);
  }
  return { ok: true, value: cases };
}

async function readActiveCaseOperation(input: {
  readonly env: OrganisationPlacementBindings & Pick<Env, "CASE">;
  readonly organisationId: OrganisationId;
  readonly now: number;
  readonly entry: ActiveActorRegistryEntry;
}): Promise<Result<ActiveCaseOperationsView, CaseOperationsError>> {
  if (input.entry.identity.objectKind !== "case") {
    return { ok: false, error: { code: "case_operations_unavailable" } };
  }
  const actor = await resolveActiveCaseActor({
    env: input.env,
    namespace: input.env.CASE,
    organisationId: input.organisationId,
    caseId: input.entry.identity.logicalObjectId,
    now: input.now,
  });
  if (!actor.ok)
    return { ok: false, error: { code: "case_operations_unavailable" } };
  const snapshot = await actor.value.inspect();
  if (snapshot.ok !== true)
    return { ok: false, error: { code: "case_operations_unavailable" } };
  return {
    ok: true,
    value: mapActiveCase(snapshot.value, input.organisationId),
  };
}

function mapActiveCase(
  snapshot: CaseOperationsSnapshot,
  pinnedOrganisationId: OrganisationId,
): ActiveCaseOperationsView {
  let pending = 0;
  let settled = 0;
  for (const output of snapshot.outputs) {
    if (output.kind === "pending" || output.kind === "held") {
      pending += 1;
    } else if (output.kind === "settled") {
      settled += 1;
    }
  }
  return {
    caseId: snapshot.identity.caseId,
    pinnedOrganisationId,
    purpose: snapshot.purpose,
    revision: snapshot.revision,
    lifecycle: snapshot.lifecycle.kind,
    assignments: snapshot.assignmentLifecycles.map((lifecycle) => ({
      assignmentId: lifecycle.assignment.assignmentId,
      sessionId: lifecycle.assignment.sessionId,
      lifecycle: lifecycle.kind,
    })),
    outputs: { pending, settled },
  };
}
