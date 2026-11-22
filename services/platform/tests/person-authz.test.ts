import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { describe, expect, it } from "vitest";

import {
  configurePersonRole,
  parseApprovalRole,
  parsePersonId,
  parsePersonRoleOperation,
  parsePersonRoleRecords,
} from "../src/data/person-authz";
import { parseRequestId } from "@purin-labs/kernel/ids";
import { requireOrganisationId } from "./test-ids";

describe("person role administration boundary", function personRoleAdminSuite() {
  it("assembles organisation people from normalized persistence rows", function parsesPeople() {
    const parsed = parsePersonRoleRecords(
      organisationId(),
      [
        {
          personId: "person_alice",
          displayName: "Alice",
        },
        {
          personId: "person_bob",
          displayName: "Bob",
        },
      ],
      [{ personId: "person_alice", role: "approve" }],
    );

    expect(parsed).toEqual({
      ok: true,
      value: [
        {
          organisationId: organisationId(),
          personId: "person_alice",
          displayName: "Alice",
          roles: ["approve"],
        },
        {
          organisationId: organisationId(),
          personId: "person_bob",
          displayName: "Bob",
          roles: [],
        },
      ],
    });
  });

  it("rejects approval roles without a person in the selected organisation", function rejectsOrphans() {
    const parsed = parsePersonRoleRecords(
      organisationId(),
      [],
      [{ personId: "person_other", role: "approve" }],
    );

    expect(parsed).toEqual({
      ok: false,
      error: { code: "invalid_person_record" },
    });
  });

  it("parses only closed role administration values", function parsesClosedValues() {
    expect(parsePersonId("person_alice")).toBe("person_alice");
    expect(parsePersonId("alice")).toBeNull();
    expect(parseApprovalRole("approve")).toBe("approve");
    expect(parseApprovalRole("command")).toBeNull();
    expect(parsePersonRoleOperation("revoke")).toBe("revoke");
    expect(parsePersonRoleOperation("delete")).toBeNull();
  });

  it("configures and audits an organisation-scoped role mutation", async function configuresRole() {
    const db = new RoleAdminDatabase(organisationId(), "person_alice");
    const result = await configurePersonRole(db as unknown as SingleDatabase, {
      organisationId: organisationId(),
      personId: requiredPersonId("person_alice"),
      operation: "grant",
      role: "approve",
      requestId: requiredRequestId(),
      now: 1_234,
    });

    expect(result.ok).toBe(true);
    expect(db.session.batches).toHaveLength(1);
    expect(db.session.batches[0]?.map(readQueryKind)).toEqual([
      "grant",
      "audit",
    ]);
    expect(db.session.batches[0]?.[0]?.bindings).toEqual([
      organisationId(),
      "person_alice",
      "approve",
      1_234,
    ]);
  });

  it("does not mutate a person from another organisation", async function deniesCrossOrganisationMutation() {
    const db = new RoleAdminDatabase(
      requireOrganisationId("organisation_OTHER"),
      "person_alice",
    );
    const result = await configurePersonRole(db as unknown as SingleDatabase, {
      organisationId: organisationId(),
      personId: requiredPersonId("person_alice"),
      operation: "revoke",
      role: "approve",
      requestId: requiredRequestId(),
      now: 1_234,
    });

    expect(result).toEqual({ ok: false, error: { code: "person_not_found" } });
    expect(db.session.batches).toEqual([]);
  });
});

class RoleAdminDatabase {
  readonly session: RoleAdminSession;

  constructor(organisationIdValue: string, personIdValue: string) {
    this.session = new RoleAdminSession(organisationIdValue, personIdValue);
  }

  withSession(): RoleAdminSession {
    return this.session;
  }
}

class RoleAdminSession {
  readonly batches: RoleAdminStatement[][] = [];

  constructor(
    private readonly existingOrganisationId: string,
    private readonly existingPersonId: string,
  ) {}

  prepare(query: string): RoleAdminStatement {
    return new RoleAdminStatement(this, query);
  }

  async batch(
    statements: RoleAdminStatement[],
  ): Promise<readonly D1Result<unknown>[]> {
    this.batches.push(statements);
    return statements.map(emptyD1Result);
  }

  personExists(bindings: readonly unknown[]): boolean {
    return (
      bindings[0] === this.existingOrganisationId &&
      bindings[1] === this.existingPersonId
    );
  }
}

class RoleAdminStatement {
  bindings: unknown[] = [];

  constructor(
    private readonly session: RoleAdminSession,
    readonly query: string,
  ) {}

  bind(...bindings: unknown[]): RoleAdminStatement {
    this.bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.session.personExists(this.bindings)
      ? ({ personId: this.bindings[1] } as T)
      : null;
  }
}

function readQueryKind(
  statement: RoleAdminStatement,
): "grant" | "audit" | "revoke" {
  if (statement.query.includes("INSERT OR IGNORE INTO person_authz_role")) {
    return "grant";
  }

  if (statement.query.includes("INSERT INTO person_authz_audit")) {
    return "audit";
  }

  return "revoke";
}

function emptyD1Result(): D1Result<unknown> {
  return {
    success: true,
    results: [],
    meta: {
      served_by: "test",
      duration: 0,
      changes: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };
}

function requiredPersonId(value: string) {
  const parsed = parsePersonId(value);

  if (parsed === null) {
    throw new Error("test person id is invalid");
  }

  return parsed;
}

function requiredRequestId() {
  const parsed = parseRequestId("req_person_role_test");

  if (!parsed.ok) {
    throw new Error("test request id is invalid");
  }

  return parsed.value;
}

function organisationId() {
  return requireOrganisationId("organisation_T0BGQSSG45N");
}
