// The purge of an Organisation deletes its Kitchen files in R2: the saved
// runs, the staged runs, the run artifacts and the recipe workflow revisions,
// proposals and findings. Each R2 prefix of the purge catalogue is empty for
// the purged Organisation, and the files of another Organisation stay.
import { env } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";

import {
  importScenario,
  type BakeryWorkflowDocument,
} from "@purin-labs/bakery-workflow";
import type { WorkflowChange } from "@purin-labs/bakery-workflow/changes";
import { parseRunSnapshot } from "@purin-labs/bakery-model/bakery-run-snapshot";
import { prepareWorkflowProposal } from "@purin-labs/area-kitchen/server/bakery/workflow-proposals";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { isRecord, sha256Hex } from "@purin-labs/std";
import {
  PURGE_R2_PREFIXES,
  purgeR2Prefix,
} from "@purin-labs/tenancy/data/purge-catalogue";
import { compileLatte } from "../../../../packages/production-simulation/src/recipes/bakery/latte";
import failed from "../fixtures/bakery-persistent-failure.json";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { controlRequest } from "./organisation-fixture";
import {
  erasedTableResidue,
  purgeOrganisation,
  purgeOwner,
} from "./purge-support";

declare module "vitest" {
  interface TaskMeta {
    kitchenFilesErasure?: Record<string, unknown>;
  }
}

const WORKFLOW = "latte-erasure";
const KITCHEN_ROOTS = [
  "bakery-runs",
  "bakery-run-prepared",
  "bakery-run-artifacts",
  "bakery-workflows",
] as const;

it(
  "deletes the saved, staged and published Kitchen files and the workflow documents of a purged Organisation, and keeps those of another",
  kitchenFilesErasureJourney,
  180_000,
);

async function kitchenFilesErasureJourney({ task }: TestContext) {
  const purged = await purgeOwner("kitchen-erasure-owner", "Kitchen erasure");
  const kept = await purgeOwner("kitchen-kept-owner", "Kitchen kept");

  // Input: the owner stages a run, stores its artifacts and saves it, and
  // applies a recipe workflow with findings and an agent's proposal.
  await stageAndSaveRun(purged);
  const digest = await applyWorkflow(purged);
  const findings = await controlRequest(
    purged.client,
    `${workflowPath(purged.organisationId)}/findings`,
    { digest, findings: [] },
  );
  expect(findings.status, await findings.clone().text()).toBe(200);
  const proposal = await prepareWorkflowProposal(
    env,
    await requireOrganisationExecutionScope(env, purged.organisationId),
    {
      workflowId: WORKFLOW,
      baseDigest: digest,
      changes: warmCup(),
      reason: "The cup is cold when the drink is poured.",
      findingIds: [],
      sessionId: "session-kitchen-erasure",
      turnId: "turn-kitchen-erasure",
      operationId: "operation-kitchen-erasure",
    },
  );
  expect(proposal.kind).toBe("ready");
  // The other Organisation stages a run and applies a workflow.
  await stageRun(kept);
  await applyWorkflow(kept);

  const before = await kitchenObjectCounts(purged.organisationId);
  expect(before["bakery-runs"]).toBe(1);
  expect(before["bakery-run-prepared"]).toBe(1);
  expect(before["bakery-run-artifacts"]).toBe(failed.artifacts.length);
  // The revision, the proposal document and the findings.
  expect(before["bakery-workflows"]).toBe(3);
  const keptBefore = await kitchenObjectCounts(kept.organisationId);
  expect(keptBefore["bakery-run-prepared"]).toBe(1);
  expect(keptBefore["bakery-workflows"]).toBe(1);

  await purgeOrganisation(purged);

  // Each R2 prefix of the purged Organisation is empty.
  const after: Record<string, number> = {};
  for (const entry of PURGE_R2_PREFIXES)
    after[entry.root] = await objectCount(
      purgeR2Prefix(entry, purged.organisationId),
    );
  expect(
    Object.values(after).every((count) => count === 0),
    JSON.stringify(after),
  ).toBe(true);
  expect(await erasedTableResidue(purged.organisationId)).toEqual({});
  // The files of the other Organisation stay.
  expect(await kitchenObjectCounts(kept.organisationId)).toEqual(keptBefore);

  task.meta.kitchenFilesErasure = {
    purged: purged.organisationId,
    kept: kept.organisationId,
    before,
    after,
    keptAfter: keptBefore,
  };
}

function runsPath(organisationId: OrganisationId): string {
  return `/v1/control/organisations/${organisationId}/bakery/runs`;
}

function workflowPath(organisationId: OrganisationId): string {
  return `/v1/control/organisations/${organisationId}/bakery/workflows/${WORKFLOW}`;
}

type Owner = Awaited<ReturnType<typeof purgeOwner>>;

async function runBody(): Promise<
  Readonly<{ id: string; body: Record<string, unknown> }>
> {
  const snapshot = parseRunSnapshot({
    name: "Failed cell at 30 seconds",
    document: { kind: "saved", document: failed.document, artifacts: [] },
  });
  if (snapshot === null) throw new Error("Invalid native acceptance fixture");
  const id = await sha256Hex(snapshot.content);
  return {
    id,
    body: {
      expectedId: id,
      name: snapshot.name,
      document: JSON.parse(snapshot.file),
    },
  };
}

async function stageRun(owner: Owner): Promise<void> {
  const { id, body } = await runBody();
  const staged = await controlRequest(
    owner.client,
    `${runsPath(owner.organisationId)}/prepared/${id}`,
    body,
  );
  expect(staged.status, await staged.clone().text()).toBe(200);
}

async function stageAndSaveRun(owner: Owner): Promise<void> {
  const { id, body } = await runBody();
  const path = runsPath(owner.organisationId);
  await stageRun(owner);
  for (const artifact of failed.artifacts) {
    const stored = await controlRequest(
      owner.client,
      `${path}/prepared/${id}/artifacts/${artifact.digest}`,
      { content: artifact.content },
    );
    expect(stored.status, await stored.clone().text()).toBe(200);
  }
  const saved = await controlRequest(owner.client, path, body);
  expect(saved.status, await saved.clone().text()).toBe(201);
}

async function applyWorkflow(owner: Owner): Promise<string> {
  const document: BakeryWorkflowDocument = importScenario(
    await compileLatte({ revision: 1, milkG: 180 }),
    { title: "Latte", recipe: "latte" },
  );
  const applied = await controlRequest(
    owner.client,
    `${workflowPath(owner.organisationId)}/apply`,
    { document, baseDigest: null },
  );
  const body: unknown = await applied.json();
  expect(applied.status, JSON.stringify(body)).toBe(200);
  if (
    !isRecord(body) ||
    !isRecord(body.receipt) ||
    typeof body.receipt.digest !== "string"
  )
    throw new Error("The apply gave no receipt");
  return body.receipt.digest;
}

function warmCup(): readonly WorkflowChange[] {
  return [
    {
      kind: "add_step",
      workflow: "latte-order",
      step: "warm-cup",
      label: "Warm the cup",
      stepKind: "wait",
      seconds: 5,
    },
    {
      kind: "connect",
      workflow: "latte-order",
      from: "warm-cup",
      to: "pour-latte",
      outcome: null,
    },
  ];
}

async function kitchenObjectCounts(
  organisationId: OrganisationId,
): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const root of KITCHEN_ROOTS) {
    const entry = PURGE_R2_PREFIXES.find((prefix) => prefix.root === root);
    if (entry === undefined) throw new Error(`${root} is not in the catalogue`);
    counts[root] = await objectCount(purgeR2Prefix(entry, organisationId));
  }
  return counts;
}

async function objectCount(prefix: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  while (true) {
    const page = await env.ARCHIVE.list({ prefix, cursor, limit: 1_000 });
    count += page.objects.length;
    if (!page.truncated) return count;
    cursor = page.cursor;
  }
}
