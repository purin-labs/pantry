import type { SingleDatabase } from "../src/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import type { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  ensureOrganisationDefaultWorkspace,
  readOrganisationDefaultWorkspacePortalAddress,
} from "../src/data/organisation-workspace";
import { parseOrganisationId } from "../src/ids";
import {
  commitWorkspaceRevision,
  prepareWorkspaceRevisionMutation,
  readCurrentWorkspaceRevisionReceipt,
  readWorkspaceRevision,
  verifyWorkspaceRevisionReceipt,
  type PreparedWorkspaceRevisionMutation,
  type WorkspaceRevisionProposal,
} from "../src/workspace-revision-store";
import { d1Database } from "./sqlite-d1";
import { sha256Hex } from "@seams/std";

describe("workspace revision store", () => {
  test("provisions one stable default workspace per organisation", async function provisionsOrganisationWorkspace() {
    const fixture = await revisionStoreFixture();
    const organisationId = parseOrganisationId("organisation_1");
    if (!organisationId.ok) throw new Error(organisationId.error.code);
    const first = await ensureOrganisationDefaultWorkspace({
      scope: fixture.scope,
      archive: fixture.bucket.binding(),
      now: 10,
    });
    if (!first.ok) throw new Error(first.error.code);
    const second = await ensureOrganisationDefaultWorkspace({
      scope: fixture.scope,
      archive: fixture.bucket.binding(),
      now: 20,
    });
    expect(second).toEqual({ ok: true, value: first.value });
    expect(first.value.workspaceId).toMatch(/^workspace_[0-9a-f-]{36}$/);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM organisation_default_workspace")
        .get(),
    ).toMatchObject({ count: 1 });
    await expect(
      readOrganisationDefaultWorkspacePortalAddress({
        db: fixture.db,
        organisationId: organisationId.value,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        organisationHandle: "test-organisation",
        workspaceHandle: "cafe-operations",
      },
    });
    await expect(
      readWorkspaceRevision(fixture.db, fixture.bucket.binding(), {
        organisationId: organisationId.value,
        workspaceId: first.value.workspaceId,
        revision: first.value.revision,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        manifest: {
          files: [
            {
              path: "workspace.yaml",
              content: expect.stringContaining(
                `workspaceId: ${first.value.workspaceId}`,
              ),
            },
          ],
        },
      },
    });
  });

  test("serializes one workspace head and returns verifiable idempotent receipts", async function serializesWorkspaceHead() {
    const fixture = await revisionStoreFixture();
    const genesis = await prepareProposal(
      fixture,
      null,
      "workspace-genesis",
      "a",
      10,
    );
    const first = await commitWorkspaceRevision(
      fixture.bucket.binding(),
      genesis,
    );
    expect(first).toMatchObject({
      ok: true,
      value: { kind: "committed", receipt: { outcome: "accepted" } },
    });
    if (!first.ok) throw new Error(first.error.code);

    await expect(
      readWorkspaceRevision(fixture.db, fixture.bucket.binding(), {
        organisationId: "organisation_1",
        workspaceId: "workspace_catalog_1",
        revision: first.value.receipt.revision,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        manifest: {
          schemaVersion: "workspace_revision_manifest.v1",
          files: [
            {
              path: "products/product_1/product.json",
              content: JSON.stringify({ title: "a" }),
            },
          ],
        },
      },
    });

    const duplicate = await commitWorkspaceRevision(
      fixture.bucket.binding(),
      genesis,
    );
    expect(duplicate).toEqual({
      ok: true,
      value: {
        kind: "duplicate",
        receipt: { ...first.value.receipt, outcome: "already_applied" },
      },
    });
    if (!duplicate.ok) throw new Error(duplicate.error.code);
    await expect(
      verifyWorkspaceRevisionReceipt(
        fixture.scope,
        "organisation_1",
        duplicate.value.receipt,
      ),
    ).resolves.toEqual({ ok: true, value: duplicate.value.receipt });

    const next = await prepareProposal(
      fixture,
      first.value.receipt.revision,
      "workspace-next",
      "b",
      20,
    );
    const committed = await commitWorkspaceRevision(
      fixture.bucket.binding(),
      next,
    );
    expect(committed).toMatchObject({
      ok: true,
      value: { kind: "committed", receipt: { canonicalHead: digest("b") } },
    });
    if (!committed.ok) throw new Error(committed.error.code);
    await expect(
      readCurrentWorkspaceRevisionReceipt(
        fixture.db,
        "organisation_1",
        "workspace_catalog_1",
      ),
    ).resolves.toEqual({ ok: true, value: committed.value.receipt });

    const stale = await prepareProposal(
      fixture,
      first.value.receipt.revision,
      "workspace-stale",
      "c",
      30,
    );
    await expect(
      commitWorkspaceRevision(fixture.bucket.binding(), stale),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "workspace_revision_base_conflict",
        currentHead: digest("b"),
      },
    });
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM workspace_revision")
        .get(),
    ).toMatchObject({ count: 2 });

    await expect(
      verifyWorkspaceRevisionReceipt(fixture.scope, "organisation_1", {
        ...first.value.receipt,
        canonicalHead: digest("f"),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "workspace_revision_receipt_conflict" },
    });
  });

  test("refuses to advance the head when immutable revision objects are missing or corrupt", async function rejectsInvalidRevisionObjects() {
    const fixture = await revisionStoreFixture();
    const missing = await prepareProposal(
      fixture,
      null,
      "workspace-missing",
      "a",
      10,
    );
    await fixture.bucket.deleteKind("manifests");
    await expect(
      commitWorkspaceRevision(fixture.bucket.binding(), missing),
    ).resolves.toEqual({
      ok: false,
      error: { code: "workspace_revision_object_missing" },
    });
    expect(revisionCount(fixture)).toBe(0);

    const corrupt = await prepareProposal(
      fixture,
      null,
      "workspace-corrupt",
      "b",
      20,
    );
    await fixture.bucket.corruptKind("changesets");
    await expect(
      commitWorkspaceRevision(fixture.bucket.binding(), corrupt),
    ).resolves.toEqual({
      ok: false,
      error: { code: "workspace_revision_object_corrupt" },
    });
    expect(revisionCount(fixture)).toBe(0);
  });

  test("rejects an aggregate manifest that exceeds the Worker materialization bound", async function rejectsOversizedManifest() {
    const fixture = await revisionStoreFixture();
    const content = "a".repeat(3 * 1024 * 1024);
    const prepared = await prepareWorkspaceRevisionMutation(
      fixture.scope,
      { kind: "placement" },
      fixture.bucket.binding(),
      {
        kind: "genesis",
        organisationId: "organisation_1",
        workspaceId: "workspace_catalog_1",
        idempotencyKey: "workspace-oversized",
        files: [
          {
            path: "products/product_1/a.md",
            mediaType: "text/markdown",
            content,
          },
          {
            path: "products/product_1/b.md",
            mediaType: "text/markdown",
            content,
          },
          {
            path: "products/product_1/c.md",
            mediaType: "text/markdown",
            content,
          },
        ],
        correlationId: "correlation_1",
        causation: { kind: "command", commandId: "command_oversized" },
        committedAt: 10,
      },
    );

    expect(prepared).toEqual({
      ok: false,
      error: { code: "workspace_revision_input_invalid" },
    });
    expect(revisionCount(fixture)).toBe(0);
  });
});

async function revisionStoreFixture(): Promise<{
  readonly database: DatabaseSync;
  readonly db: SingleDatabase;
  readonly bucket: TestR2Bucket;
  readonly scope: OrganisationExecutionScope;
}> {
  const organisationIdRaw = "organisation_1";
  const database = new DatabaseSync(":memory:");
  database.exec(singleDatabaseSchema());
  database.exec(
    `INSERT INTO organisation (organisation_id, organisation_handle, name, created_at) VALUES ('${organisationIdRaw}', 'test-organisation', 'Test organisation', 0)`,
  );
  const db = d1Database(database);
  const organisationId = parseOrganisationId(organisationIdRaw);
  if (!organisationId.ok) throw new Error(organisationId.error.code);
  await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisationId.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 0,
  });
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisationId.value,
  );
  return {
    scope,
    database,
    db,
    bucket: new TestR2Bucket(),
  };
}

async function prepareProposal(
  fixture: Awaited<ReturnType<typeof revisionStoreFixture>>,
  baseRevision: string | null,
  idempotencyKey: string,
  fill: string,
  committedAt: number,
): Promise<PreparedWorkspaceRevisionMutation> {
  const proposal = await revisionProposal(
    baseRevision,
    idempotencyKey,
    fill,
    committedAt,
  );
  const prepared = await prepareWorkspaceRevisionMutation(
    fixture.scope,
    {
      kind: "execution",
      authorizeCommit: fixture.scope.isActive.bind(fixture.scope),
    },
    fixture.bucket.binding(),
    proposal,
  );
  if (!prepared.ok) throw new Error(prepared.error.code);
  return prepared.value;
}

async function revisionProposal(
  baseRevision: string | null,
  idempotencyKey: string,
  fill: string,
  committedAt: number,
): Promise<WorkspaceRevisionProposal> {
  const common = {
    organisationId: "organisation_1",
    workspaceId: "workspace_catalog_1",
    idempotencyKey,
    files: [
      {
        path: "products/product_1/product.json",
        mediaType: "application/json",
        content: JSON.stringify({ title: fill }),
      },
    ],
    correlationId: "correlation_1",
    causation: {
      kind: "command" as const,
      commandId: `command_${idempotencyKey}`,
    },
    committedAt,
  };
  if (baseRevision === null) {
    return { ...common, kind: "genesis" };
  }
  const material = {
    schemaVersion: "satyr.product-folder-changeset.v1",
    organisationId: common.organisationId,
    workspaceId: common.workspaceId,
    baseRevision,
    resultingSemanticHash: digest(fill),
    diff: {
      productId: "product_1",
      fields: ["title" as const],
      variantIds: [],
    },
  };
  return {
    ...common,
    kind: "product_folder_changeset",
    changeset: {
      ...material,
      changesetDigest: await sha256Hex(JSON.stringify(material)),
    },
  };
}

function digest(fill: string): string {
  return fill.repeat(64);
}

function revisionCount(
  fixture: Awaited<ReturnType<typeof revisionStoreFixture>>,
): number {
  const row = fixture.database
    .prepare("SELECT COUNT(*) AS count FROM workspace_revision")
    .get() as { count: number };
  return row.count;
}

class TestR2Bucket {
  readonly #objects = new Map<string, Uint8Array>();

  binding(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
  ): Promise<R2Object> {
    const bytes = await r2InputBytes(value);
    this.#objects.set(key, bytes);
    return { key } as R2Object;
  }

  get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.#objects.get(key);
    return Promise.resolve(
      bytes === undefined ? null : r2ObjectBody(key, bytes),
    );
  }

  async deleteKind(kind: "manifests" | "changesets"): Promise<void> {
    for (const key of this.#keysForKind(kind)) this.#objects.delete(key);
  }

  async corruptKind(kind: "manifests" | "changesets"): Promise<void> {
    for (const key of this.#keysForKind(kind)) {
      this.#objects.set(key, new TextEncoder().encode("corrupt"));
    }
  }

  #keysForKind(kind: "manifests" | "changesets"): string[] {
    const keys = [...this.#objects.keys()].filter(
      matchesObjectKind.bind(null, kind),
    );
    if (keys.length === 0) throw new Error(`missing ${kind} object`);
    return keys;
  }
}

function matchesObjectKind(
  kind: "manifests" | "changesets",
  key: string,
): boolean {
  return key.includes(`/${kind}/`);
}

async function r2InputBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function r2ObjectBody(key: string, bytes: Uint8Array): R2ObjectBody {
  return {
    key,
    size: bytes.byteLength,
    arrayBuffer: arrayBufferCopy.bind(null, bytes),
  } as R2ObjectBody;
}

function arrayBufferCopy(bytes: Uint8Array): Promise<ArrayBuffer> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return Promise.resolve(copy);
}
