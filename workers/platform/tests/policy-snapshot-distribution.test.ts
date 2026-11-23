/// <reference types="@cloudflare/workers-types" />

import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import {
  defaultDenyPolicy,
  loadOrganisationPolicy,
  parseOrganisationPolicySnapshot,
  reconcileOrganisationPolicyPublication,
  type OrganisationPolicySnapshot,
} from "@purin-labs/authority/policy-snapshot";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";

describe("organisation policy snapshot distribution", function policySnapshotDistributionSuite() {
  it("blocks new admissions while budget activation is incomplete", async function pendingBudget() {
    const organisationId = requiredOrganisationId();
    const snapshot = policySnapshot(8);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: snapshot.version, body: JSON.stringify(snapshot) },
    });
    db.budgetAppliedRevision = 0;
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: JSON.stringify(snapshot),
    });
    expect(
      await loadOrganisationPolicy({
        bindings: bindings(db, kv),
        organisationId,
        now: 9000,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "workspace_ai_budget_unavailable" },
    });
  });
  it("uses KV only after it matches the authoritative D1 head", async function readsMatchingKv() {
    const organisationId = requiredOrganisationId();
    const snapshot = policySnapshot(8);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: snapshot.version, body: JSON.stringify(snapshot) },
    });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: JSON.stringify(snapshot),
    });
    const loaded = await loadOrganisationPolicy({
      bindings: bindings(db, kv),
      organisationId,
      now: 9_000,
    });

    expect(loaded).toEqual({ ok: true, value: { snapshot, source: "kv" } });
    expect(db.queries.some(queryContainsPolicySnapshot)).toBe(true);
  });

  it("fails closed while KV is stale behind D1", async function rejectsStaleKv() {
    const organisationId = requiredOrganisationId();
    const stale = policySnapshot(8);
    const current = policySnapshot(9);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: current.version, body: JSON.stringify(current) },
    });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: JSON.stringify(stale),
    });
    const loaded = await loadOrganisationPolicy({
      bindings: bindings(db, kv),
      organisationId,
      now: 10_000,
    });

    expect(loaded).toEqual({
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1 and KV policy heads differ",
      },
    });
    expect(kv.puts).toEqual([]);
  });

  it("fails closed when the distributed body is corrupt", async function rejectsCorruptKv() {
    const organisationId = requiredOrganisationId();
    const snapshot = policySnapshot(9);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: snapshot.version, body: JSON.stringify(snapshot) },
    });
    const kv = new PolicyKvMock({ [`policy:${organisationId}:latest`]: "{" });
    const loaded = await loadOrganisationPolicy({
      bindings: bindings(db, kv),
      organisationId,
      now: 10_000,
    });

    expect(loaded).toEqual({
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1 and KV policy heads differ",
      },
    });
    expect(db.queries.some(queryContainsPolicySnapshot)).toBe(true);
    expect(kv.puts).toEqual([]);
  });

  it("rejects a KV-only snapshot without an authoritative D1 head", async function rejectsKvOnly() {
    const organisationId = requiredOrganisationId();
    const snapshot = policySnapshot(10);
    const db = new PolicyD1Mock({ kind: "stored_snapshot", row: null });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: JSON.stringify(snapshot),
    });
    const loaded = await loadOrganisationPolicy({
      bindings: bindings(db, kv),
      organisationId,
      now: 11_000,
    });
    expect(loaded).toEqual({
      ok: false,
      error: {
        code: "policy_store_failed",
        detail: "authoritative policy snapshot missing",
      },
    });
  });

  it("reconciles the authoritative D1 head into versioned and latest KV", async function reconcilesPublication() {
    const organisationId = requiredOrganisationId();
    const stale = policySnapshot(27);
    const current = policySnapshot(29);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: current.version, body: JSON.stringify(current) },
    });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: JSON.stringify(stale),
    });
    const organisation = new MatchingOrganisationPolicyActivator();

    const reconciled = await reconcileOrganisationPolicyPublication({
      bindings: bindings(db, kv),
      organisationId,
      organisation,
      now: 30_000,
    });

    expect(reconciled).toEqual({
      ok: true,
      value: { snapshot: current, source: "d1" },
    });
    expect(organisation.snapshots).toEqual([current]);
    expect(kv.puts).toEqual([
      {
        key: `policy:${organisationId}:v${current.version}`,
        value: JSON.stringify(current),
      },
      {
        key: `policy:${organisationId}:latest`,
        value: JSON.stringify(current),
      },
    ]);
    await expect(
      loadOrganisationPolicy({
        bindings: bindings(db, kv),
        organisationId,
        now: 31_000,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { snapshot: current, source: "kv" },
    });
  });

  it("leaves stale KV untouched when policy activation fails", async function rejectsActivationFailure() {
    const organisationId = requiredOrganisationId();
    const stale = policySnapshot(27);
    const current = policySnapshot(29);
    const staleBody = JSON.stringify(stale);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: current.version, body: JSON.stringify(current) },
    });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: staleBody,
    });

    const reconciled = await reconcileOrganisationPolicyPublication({
      bindings: bindings(db, kv),
      organisationId,
      organisation: new FailingOrganisationPolicyActivator(),
      now: 30_000,
    });

    expect(reconciled).toEqual({
      ok: false,
      error: {
        code: "policy_activation_failed",
        detail: "activation_rejected",
      },
    });
    expect(kv.puts).toEqual([]);
    await expect(kv.get(`policy:${organisationId}:latest`)).resolves.toBe(
      staleBody,
    );
    await expect(
      kv.get(`policy:${organisationId}:v${current.version}`),
    ).resolves.toBeNull();
  });

  it("does not distribute an older snapshot after the D1 head advances", async function rejectsAdvancedHead() {
    const organisationId = requiredOrganisationId();
    const stale = policySnapshot(27);
    const current = policySnapshot(29);
    const advanced = policySnapshot(30);
    const staleBody = JSON.stringify(stale);
    const db = new PolicyD1Mock({
      kind: "stored_snapshot",
      row: { version: current.version, body: JSON.stringify(current) },
      rows: [
        { version: current.version, body: JSON.stringify(current) },
        { version: current.version, body: JSON.stringify(current) },
        { version: advanced.version, body: JSON.stringify(advanced) },
      ],
    });
    const kv = new PolicyKvMock({
      [`policy:${organisationId}:latest`]: staleBody,
    });

    const reconciled = await reconcileOrganisationPolicyPublication({
      bindings: bindings(db, kv),
      organisationId,
      organisation: new MatchingOrganisationPolicyActivator(),
      now: 30_000,
    });

    expect(reconciled).toEqual({
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1, KV, and Organisation Actor policy heads differ",
      },
    });
    expect(kv.puts).toEqual([]);
    await expect(kv.get(`policy:${organisationId}:latest`)).resolves.toBe(
      staleBody,
    );
    await expect(
      kv.get(`policy:${organisationId}:v${current.version}`),
    ).resolves.toBeNull();
  });

  it("uses hold-mode default deny and rejects snapshots without conversation risk", function failsClosed() {
    const denied = defaultDenyPolicy({ now: 13_000 });
    const missingConversationRisk = policySnapshotWithoutConversationRisk(13);
    const parsed = parseOrganisationPolicySnapshot(missingConversationRisk);

    expect(denied.conversationRisk.outputScreeningMode).toBe("hold");
    expect(denied.egress.allowedHosts).toEqual([]);
    expect(denied.authz.allowedTools).toEqual([]);
    expect(parsed).toEqual({
      ok: false,
      error: {
        code: "policy_snapshot_invalid",
        detail: "conversationRisk object required",
      },
    });
  });
});

type StoredSnapshotRow = {
  version: number;
  body: string;
};

type PolicyD1Mode = {
  kind: "stored_snapshot";
  row: StoredSnapshotRow | null;
  rows?: readonly (StoredSnapshotRow | null)[];
};

class PolicyD1Mock {
  budgetAppliedRevision = 1;
  readonly queries: string[] = [];
  private readonly snapshotRows: Array<StoredSnapshotRow | null>;

  constructor(readonly mode: PolicyD1Mode) {
    this.snapshotRows = [...(mode.rows ?? [])];
  }

  withSession(): PolicyD1Mock {
    return this;
  }

  prepare(query: string): PolicyD1StatementMock {
    this.queries.push(query);

    return new PolicyD1StatementMock(this, query);
  }

  nextSnapshotRow(): StoredSnapshotRow | null {
    return this.snapshotRows.length > 0
      ? this.snapshotRows.shift()!
      : this.mode.row;
  }
}

class PolicyD1StatementMock {
  private bindings: unknown[] = [];

  constructor(
    private readonly database: PolicyD1Mock,
    private readonly query: string,
  ) {}

  bind(...bindings: unknown[]): PolicyD1StatementMock {
    this.bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.query.includes("FROM organisation_placement")) {
      return {
        placementKind: "affinity",
        placementEpoch: 1,
        placementCellId: "test",
        locationHint: "wnam",
        residencyJurisdiction: null,
        fenceToken: "test_fence",
        status: "active",
        createdAt: 1,
        activatedAt: 1,
        frozenAt: null,
        abandonedAt: null,
        retiredAt: null,
      } as T;
    }
    if (this.query.includes("FROM workspace_ai_budget"))
      return {
        max_tokens: 64000,
        max_wall_ms: 180000,
        max_tool_calls: 20,
        revision: 1,
        applied_revision: this.database.budgetAppliedRevision,
        mutation_receipt_id: "initial",
        previous_limits_json:
          '{"maxTokens":64000,"maxWallMs":180000,"maxToolCalls":20}',
      } as T;
    if (queryContainsPolicySnapshot(this.query)) {
      return this.database.nextSnapshotRow() as T | null;
    }

    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    throw new Error(`unexpected_d1_all:${this.query}:${this.bindings.length}`);
  }

  async run(): Promise<D1Result<unknown>> {
    throw new Error(`unexpected_d1_run:${this.query}:${this.bindings.length}`);
  }
}

class PolicyKvMock {
  readonly puts: { key: string; value: string }[] = [];
  private readonly values: Map<string, string>;

  constructor(values: Record<string, string>) {
    this.values = new Map(Object.entries(values));
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push({ key, value });
    this.values.set(key, value);
  }
}

class MatchingOrganisationPolicyActivator {
  readonly snapshots: OrganisationPolicySnapshot[] = [];

  async activatePolicy(input: {
    snapshot: OrganisationPolicySnapshot;
  }): Promise<{
    ok: true;
    value: {
      head: {
        activeVersion: number;
        restrictionVersion: number;
        digest: string;
      };
      consumers: number;
      delivered: number;
      pending: number;
    };
  }> {
    this.snapshots.push(input.snapshot);
    return {
      ok: true,
      value: {
        head: {
          activeVersion: input.snapshot.version,
          restrictionVersion: input.snapshot.version,
          digest: await snapshotDigest(input.snapshot),
        },
        consumers: 0,
        delivered: 0,
        pending: 0,
      },
    };
  }
}

class FailingOrganisationPolicyActivator {
  async activatePolicy(): Promise<{ ok: false; error: { code: string } }> {
    return { ok: false, error: { code: "activation_rejected" } };
  }
}

function bindings(db: PolicyD1Mock, kv: PolicyKvMock) {
  return {
    db: db as unknown as SingleDatabase,
    kv: kv as unknown as KVNamespace,
  };
}

function requiredOrganisationId(): OrganisationId {
  const organisationId = parseOrganisationId("organisation_policy_snapshot");

  if (!organisationId.ok) {
    throw new Error("organisation_policy_snapshot_identity_invalid");
  }

  return organisationId.value;
}

function policySnapshot(version: number): OrganisationPolicySnapshot {
  return {
    version,
    egress: {
      allowedHosts: ["api.example.com"],
      injections: [],
      modelRoute: { baseUrl: "https://model-gateway.internal" },
    },
    authz: {
      allowedTools: [],
      deniedTools: [],
      approvalRequired: [],
      maxBudget: null,
    },
    conversationRisk: { outputScreeningMode: "stream" },
    createdAt: version * 1_000,
  };
}

function policySnapshotWithoutConversationRisk(
  version: number,
): Record<string, unknown> {
  const snapshot = policySnapshot(version);
  return {
    version: snapshot.version,
    egress: snapshot.egress,
    authz: snapshot.authz,
    createdAt: snapshot.createdAt,
  };
}

async function snapshotDigest(
  snapshot: OrganisationPolicySnapshot,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const value of digest) hex += value.toString(16).padStart(2, "0");
  return hex;
}

function queryContainsPolicySnapshot(query: string): boolean {
  return query.includes("FROM policy_snapshot");
}
