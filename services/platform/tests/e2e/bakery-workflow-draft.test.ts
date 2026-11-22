// Plan 84 Journey J3: people edit one recipe's draft at one time over the real
// room, and apply it. The engine's admission judges each apply.
import { fixtureDatabase } from "./organisation-database";
import {
  importScenario,
  type BakeryWorkflowDocument,
} from "@purin-labs/bakery-workflow";
import {
  compileDraft,
  draftSeed,
  newStepNode,
} from "@purin-labs/bakery-workflow/draft";
import { compileLatte } from "../../../../packages/production-simulation/src/recipes/bakery/latte";
import { sha256Hex } from "@purin-labs/std";
import {
  DraftEncoding,
  type DraftSnapshot,
} from "@purin-labs/workflow-canvas-crdt/draft";
import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { bakeryWorkflowPrefix } from "../../src/commerce/bakery/workflow-revisions";
import { ensureCreatedOrganisationActor } from "@purin-labs/agent/control/organisation-runtime";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { WorkflowDraftPeer } from "./workflow-draft-peer";
import {
  commerceClient,
  commerceHeaders,
  commerceWorkspace,
} from "./commerce-support";

type Client = Awaited<ReturnType<typeof commerceClient>>;
const WORKFLOW = "latte-j3";

function value<T>(
  result: Readonly<{ ok: boolean; value?: T; error?: unknown }>,
): T {
  if (!result.ok || result.value === undefined)
    throw new Error(JSON.stringify(result.error));
  return result.value;
}

function requireOrganisationId(raw: string): OrganisationId {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error("Invalid organisation");
  return parsed.value;
}

function keys(snapshot: DraftSnapshot): readonly string[] {
  return snapshot.nodes.map((node) => node.key).sort();
}

function edges(snapshot: DraftSnapshot): readonly string[] {
  return snapshot.edges.map((edge) => `${edge.from}>${edge.to}`).sort();
}

async function member(
  organisation: string,
  client: Client,
  role: "operator" | "viewer",
): Promise<void> {
  const person = `person_workflow_${role}`;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(organisation, person, role),
    fixtureDatabase()
      .prepare(
        `INSERT INTO service_role_grant
       (organisation_id, user_id, person_id, role, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .bind(organisation, client.identity.userId, person, role, Date.now()),
  ]);
}

async function apply(
  session: Client["session"],
  organisation: string,
  document: unknown,
  baseDigest: string | null,
): Promise<Response> {
  return exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisation}/bakery/workflows/${WORKFLOW}/apply`,
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({ document, baseDigest }),
    },
  );
}

async function journey(): Promise<void> {
  const owner = await commerceClient("workflow-draft-owner");
  const operator = await commerceClient("workflow-draft-operator");
  const viewer = await commerceClient("workflow-draft-viewer");
  const organisation = await commerceWorkspace(owner, "Workflow draft");
  await member(organisation, operator, "operator");
  await member(organisation, viewer, "viewer");
  await ensureCreatedOrganisationActor({
    env,
    organisationId: requireOrganisationId(organisation),
    now: Date.now(),
  });
  const document: BakeryWorkflowDocument = importScenario(
    await compileLatte({ revision: 1, milkG: 180 }),
    { title: "Latte", recipe: "latte" },
  );

  // A draft starts from an applied revision, so nothing opens before the first.
  const headers = new Headers(commerceHeaders(owner.session));
  headers.set("Upgrade", "websocket");
  const early = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisation}/bakery/workflows/${WORKFLOW}/socket`,
    { headers },
  );
  expect(early.status).toBe(404);

  // A viewer cannot apply. The owner applies, and a repeat returns one receipt.
  expect(
    (await apply(viewer.session, organisation, document, null)).status,
  ).toBeGreaterThanOrEqual(400);
  const first = await apply(owner.session, organisation, document, null);
  expect(first.status).toBe(200);
  const firstReceipt = (
    (await first.json()) as { receipt: { digest: string; revision: number } }
  ).receipt;
  expect(firstReceipt.revision).toBe(1);
  const repeat = await apply(owner.session, organisation, document, null);
  expect(((await repeat.json()) as { receipt: unknown }).receipt).toEqual(
    firstReceipt,
  );

  // Two people on one draft: each edit reaches the other, and they merge.
  const a = new WorkflowDraftPeer(owner.session, organisation, WORKFLOW);
  const b = new WorkflowDraftPeer(operator.session, organisation, WORKFLOW);
  const reader = new WorkflowDraftPeer(viewer.session, organisation, WORKFLOW);
  await a.connect();
  await b.connect();
  await reader.connect();
  expect(a.access).toBe("edit");
  expect(b.access).toBe("edit");
  expect(reader.access).toBe("read");
  expect(keys(a.snapshot())).toEqual(keys(draftSeed(document)));

  const added = newStepNode(document, a.snapshot(), {
    workflow: "latte-order",
    kind: "work",
    label: "Warm the cup",
    seconds: 5,
  });
  if (added === null) throw new Error("No new step");
  const addUpdate = value(a.doc.putNode(added));
  const edgeUpdate = value(
    b.doc.putEdge({
      workflow: "latte-order",
      from: "espresso-shot",
      to: "grasp-pitcher",
      order: 90,
      branch: null,
    }),
  );
  // Both edits leave before either page saw the other's.
  const [addReceipt, edgeReceipt] = await Promise.all([
    a.submit(addUpdate),
    b.submit(edgeUpdate),
  ]);
  expect(addReceipt.kind).toBe("update_accepted");
  expect(edgeReceipt.kind).toBe("update_accepted");
  await a.until((event) => event.kind === "update_broadcast");
  await b.until((event) => event.kind === "update_broadcast");
  expect(keys(a.snapshot())).toEqual(keys(b.snapshot()));
  expect(edges(a.snapshot())).toEqual(edges(b.snapshot()));
  expect(keys(b.snapshot())).toContain("warm-the-cup");
  expect(edges(a.snapshot())).toContain("espresso-shot>grasp-pitcher");

  // A page that loses its connection keeps editing, and its edits arrive.
  b.disconnect();
  const offlineNode = newStepNode(document, b.snapshot(), {
    workflow: "latte-order",
    kind: "wait",
    label: "Rest the milk",
    seconds: 4,
  });
  if (offlineNode === null) throw new Error("No offline step");
  value(b.doc.putNode(offlineNode));
  const whileAway = newStepNode(document, a.snapshot(), {
    workflow: "latte-order",
    kind: "wait",
    label: "Wipe the wand",
    seconds: 3,
  });
  if (whileAway === null) throw new Error("No online step");
  expect((await a.submit(value(a.doc.putNode(whileAway)))).kind).toBe(
    "update_accepted",
  );
  await b.connect();
  expect(keys(b.snapshot())).toContain("wipe-the-wand");
  expect((await b.submitMissing()).kind).toBe("update_accepted");
  await a.until(() =>
    a.snapshot().nodes.some((node) => node.key === "rest-the-milk"),
  );
  expect(keys(a.snapshot())).toEqual(keys(b.snapshot()));

  // A viewer's update does not reach the draft.
  const viewerUpdate = value(
    reader.doc.movePosition("latte-order/place-cup", { x: 900, y: 900 }),
  );
  expect((await reader.submit(viewerUpdate)).kind).toBe("failure");

  // A shape that is not a draft is refused, and the draft stays.
  const raw = new Y.Doc();
  raw.getMap("nodes").set("broken", { nonsense: true });
  const rawUpdate = value(
    DraftEncoding.parse("update", Y.encodeStateAsUpdate(raw)),
  );
  const refused = await a.submit(rawUpdate);
  expect(refused).toMatchObject({ kind: "failure", code: "invalid_draft" });
  await a.connect();

  // A person who loses access stops editing.
  await fixtureDatabase()
    .prepare(
      `UPDATE service_role_grant SET status = 'revoked', revoked_at = ?
     WHERE organisation_id = ? AND user_id = ?`,
    )
    .bind(Date.now(), organisation, operator.identity.userId)
    .run();
  const afterRevoke = await b.submit(
    value(b.doc.movePosition("latte-order/place-cup", { x: 40, y: 40 })),
  );
  expect(afterRevoke).toMatchObject({
    kind: "failure",
    code: "access_revoked",
  });

  // A reopened page reads the same draft from the Actor's storage.
  a.disconnect();
  reader.disconnect();
  const reopened = new WorkflowDraftPeer(owner.session, organisation, WORKFLOW);
  await reopened.connect();
  expect(keys(reopened.snapshot())).toContain("rest-the-milk");
  expect(keys(reopened.snapshot())).toContain("wipe-the-wand");
  expect(edges(reopened.snapshot())).toContain("espresso-shot>grasp-pitcher");

  // A cycle cannot become a revision.
  const cycleDoc = {
    ...document,
    workflows: document.workflows.map((graph) => ({
      ...graph,
      edges: [
        ...graph.edges,
        { from: "return-pitcher", to: "place-cup", branch: null },
      ],
    })),
  };
  const cycle = await apply(
    owner.session,
    organisation,
    cycleDoc,
    firstReceipt.digest,
  );
  expect(cycle.status).toBe(422);
  expect(await cycle.json()).toMatchObject({
    error: "bakery_workflow_refused",
    problems: [{ code: "cyclic_tasks" }],
  });

  // The merged draft becomes revision 2, with one receipt and one R2 object.
  const compiled = await compileDraft(document, reopened.snapshot());
  if (compiled.kind !== "ready")
    throw new Error(JSON.stringify(compiled.problems));
  const watcher = new WorkflowDraftPeer(owner.session, organisation, WORKFLOW);
  await watcher.connect();
  const applied = await apply(
    owner.session,
    organisation,
    compiled.document,
    firstReceipt.digest,
  );
  expect(applied.status).toBe(200);
  const receipt = (
    (await applied.json()) as {
      receipt: {
        digest: string;
        revision: number;
        scenarioDigest: string;
        baseDigest: string;
      };
    }
  ).receipt;
  expect(receipt).toMatchObject({
    revision: 2,
    baseDigest: firstReceipt.digest,
    scenarioDigest: compiled.digest,
  });
  await watcher.until((event) => event.kind === "revision_changed");

  // An apply from the old base cannot overwrite it.
  const stale = await apply(
    owner.session,
    organisation,
    document,
    firstReceipt.digest,
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    error: "bakery_workflow_stale",
    currentDigest: receipt.digest,
  });

  // The read route returns what was applied, and R2 holds it under its digest.
  const current = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisation}/bakery/workflows/${WORKFLOW}`,
    { headers: commerceHeaders(viewer.session) },
  );
  expect(current.status).toBe(200);
  const body = (await current.json()) as {
    current: {
      document: BakeryWorkflowDocument;
      receipt: { revision: number };
    };
  };
  expect(body.current.receipt.revision).toBe(2);
  const nodes = body.current.document.workflows[0]?.nodes ?? [];
  expect(nodes.map((node) => node.label)).toContain("Warm the cup");
  const parsedId = parseOrganisationId(organisation);
  if (!parsedId.ok) throw new Error("Invalid organisation");
  const object = await env.ARCHIVE.get(
    bakeryWorkflowPrefix(parsedId.value) + receipt.digest,
  );
  expect(await sha256Hex((await object?.text()) ?? "")).toBe(receipt.digest);
  const scope = await requireOrganisationExecutionScope(env, parsedId.value);
  const rows = await scope.database
    .prepare(
      "SELECT revision FROM bakery_workflow_revision WHERE organisation_id = ? AND workflow_id = ? ORDER BY revision",
    )
    .bind(organisation, WORKFLOW)
    .all<{ revision: number }>();
  expect(rows.results.map((row) => row.revision)).toEqual([1, 2]);
  watcher.disconnect();
  reopened.disconnect();
}

it(
  "merges two people's draft edits, keeps offline edits, and applies one revision with one receipt",
  { timeout: 120_000 },
  journey,
);
