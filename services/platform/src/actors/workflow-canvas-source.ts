import { CanvasLayout } from "@purin-labs/workflow-canvas-crdt";
import type { Env } from "@purin-labs/kernel/env";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { isOrganisationExecutionActive } from "./actor-execution-quiescence";
import type { WorkflowCanvasSource } from "@purin-labs/bakery-model/bakery-canvas-source";
import {
  parseRunSnapshot,
  MAX_RUN_SNAPSHOT_BYTES,
} from "@purin-labs/bakery-model/bakery-run-snapshot";
import {
  parseApplianceWorkflow,
  applianceCanvasObjects,
} from "@purin-labs/bakery-model/bakery-appliance-workflow";
import { bakeryRunSnapshotPrefix } from "../commerce/bakery/saved-runs";
import { sha256Hex } from "@purin-labs/std";

type CanvasSource = Readonly<{
  layout: CanvasLayout;
  labels: ReadonlyMap<string, string>;
}>;

/** Load object membership from the saved run's content-addressed snapshot. */
export async function readWorkflowCanvasSource(
  sql: SqlStorage,
  env: Env,
  scope: OrganisationExecutionScope,
  source: WorkflowCanvasSource,
): Promise<Result<CanvasSource, Readonly<{ code: "source_unavailable" }>>> {
  if (!(await isOrganisationExecutionActive(sql, scope))) return unavailable();
  try {
    const object = await env.ARCHIVE.get(
      bakeryRunSnapshotPrefix(scope.organisationId) + source.snapshotId,
    );
    if (object === null) return unavailable();
    if (object.size > MAX_RUN_SNAPSHOT_BYTES) {
      await object.body.cancel();
      return unavailable();
    }
    const content = await object.text();
    if ((await sha256Hex(content)) !== source.snapshotId) return unavailable();
    const snapshot = parseRunSnapshot(JSON.parse(content));
    if (
      snapshot?.kind !== "appliance" ||
      !(await isOrganisationExecutionActive(sql, scope))
    )
      return unavailable();
    const plan = parseApplianceWorkflow(snapshot.file);
    const layout = CanvasLayout.parse(applianceCanvasObjects(plan));
    if (!layout.ok) return unavailable();
    const labels = new Map<string, string>();
    for (const state of plan.operations)
      labels.set(state.operation.id, state.operation.label);
    return { ok: true, value: { layout: layout.value, labels } };
  } catch {
    return unavailable();
  }
}

function unavailable(): Result<
  never,
  Readonly<{ code: "source_unavailable" }>
> {
  return { ok: false, error: { code: "source_unavailable" } };
}
