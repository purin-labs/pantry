import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTerminalAssignment } from "@seams/contracts";
import { REGISTER_VIEW_COMMANDS } from "@seams/control-api";
import { parseEnvelope as parseCounterSaleEnvelope } from "@seams/control-api/portal/counter-sale";

import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
import type { SingleDatabase } from "../src/database-handles";
import { parseOrganisationId } from "../src/ids";
import {
  activateTerminalAssignment,
  readActiveTerminalAssignment,
} from "../src/data/terminal-assignment-store";
import { runDeviceFleetSchemaMigrations } from "../src/actors/device-fleet-schema";
import {
  clearTerminalResultUnknown,
  markGatewayCollectionsUnknown,
  openUnknownTerminalCollections,
  readTerminalCollection,
  recordTerminalResult,
  reserveTerminalCollection,
} from "../src/actors/device-fleet-terminal";
import { matchCounterSaleControlRoute } from "../src/control/routes/counter-sale";
import { TOOLS } from "../src/agent-tools/registry";
import { authorizedBakerySurfaceCommands } from "../src/actors/session/transient-turns";

const ORG_ID = "org_11111111-1111-4111-8111-111111111111";

describe("Plan 90 counter register & GMO stera LAN gateway integration", () => {
  it("stores payment_terminal device enrollments and lan_gateway_device assignments in D1 schema and patch", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(singleDatabaseSchema());
    const db = sqliteAsD1(sqlite);
    const now = Date.now();
    const parsedOrg = parseOrganisationId(ORG_ID);
    if (!parsedOrg.ok) throw new Error("Invalid org id");

    // Seed org + gateway + payment_terminal enrollment directly against real CHECK constraints.
    sqlite.exec(`
      INSERT INTO organisation (organisation_id, name, created_at)
      VALUES ('${ORG_ID}', 'Tokyo Cafe', ${now});
      INSERT INTO device_gateway (
        gateway_id, organisation_id, location_id, name, state,
        credential_sha256, created_by_user_id, created_at, enrolled_at, service_version
      ) VALUES (
        'gw_tokyo_1', '${ORG_ID}', 'loc_tokyo', 'Counter Gateway', 'active',
        'hash_gw_1', 'user_owner', ${now}, ${now}, '0.1.0'
      );
      INSERT INTO device_enrollment (
        device_id, organisation_id, gateway_id, source_key, name,
        device_kind, model, capabilities_json, revision, state,
        verified_at, health, work_state, created_at
      ) VALUES (
        'dev_stera_1', '${ORG_ID}', 'gw_tokyo_1', 'stera_lan_1', 'Counter stera',
        'payment_terminal', 'stera terminal', '[]', 1, 'active',
        ${now}, 'ok', 'idle', ${now}
      );
    `);

    const assignment = parseTerminalAssignment({
      assignmentId: "assign_stera_1",
      organisationId: ORG_ID,
      merchantId: "merchant_tokyo",
      satyrLocationId: "loc_tokyo",
      providerLocationId: "GMO_STERA_LOC_TOKYO",
      account: {
        integrationAccountId: "gmo_account_1",
        providerAccountId: "gmo_merchant_1",
        environment: "development",
        capabilityRevision: 1,
        country: "JP",
        currency: "JPY",
      },
      target: {
        kind: "lan_gateway_device",
        gatewayId: "gw_tokyo_1",
        deviceSourceKey: "stera_lan_1",
      },
      transport: "lan_gateway",
      adapterVersion: "gmo_stera_lan_v1",
      revision: 1,
      state: { kind: "active" },
    });
    if (!assignment.ok) throw new Error(JSON.stringify(assignment.error));

    const scope = await createOrganisationExecutionFixture(db, parsedOrg.value);
    const recorded = await activateTerminalAssignment({
      db: scope.database,
      organisationId: parsedOrg.value,
      assignment: assignment.value,
      now,
    });
    expect(recorded.ok).toBe(true);

    const loaded = await readActiveTerminalAssignment(
      scope.database,
      parsedOrg.value,
      "loc_tokyo",
    );
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.target).toEqual({
        kind: "lan_gateway_device",
        gatewayId: "gw_tokyo_1",
        deviceSourceKey: "stera_lan_1",
      });
      expect(loaded.value.transport).toBe("lan_gateway");
    }

    // Verify the D1 patch script executes cleanly on an existing database containing rows.
    const patchSql = readFileSync(
      resolve(__dirname, "../scripts/plan90-payment-terminal-d1-patch.sql"),
      "utf8",
    );
    sqlite.exec(patchSql);
    const reloaded = await readActiveTerminalAssignment(
      scope.database,
      parsedOrg.value,
      "loc_tokyo",
    );
    expect(reloaded.ok).toBe(true);
  });

  it("enforces DeviceFleetActor LAN terminal exclusivity, result_unknown lock on drop, reconnect inquiry, and recovery", () => {
    const sqlite = new DatabaseSync(":memory:");
    const sql = sqliteAsDoSql(sqlite);
    runDeviceFleetSchemaMigrations({
      sql,
      transactionSync: <T>(fn: () => T): T => fn(),
    } as unknown as DurableObjectStorage);

    const baseInput = {
      gatewayId: "gw_tokyo_1",
      sourceKey: "stera_lan_1",
      requestId: "req_1",
      paymentAttemptId: "att_1",
      checkoutId: "chk_1",
      amountMinor: 1180,
      currency: "JPY",
      paymentMethod: "felica" as const,
      expiresAt: "2026-11-19T12:00:00.000Z",
    };

    // 1. Reserve terminal for Sale #1.
    const first = reserveTerminalCollection(sql, baseInput, 1_000);
    expect(first.ok).toBe(true);

    // 2. Concurrent Sale #2 on same terminal is refused with terminal_busy.
    const concurrent = reserveTerminalCollection(
      sql,
      {
        ...baseInput,
        requestId: "req_2",
        paymentAttemptId: "att_2",
        checkoutId: "chk_2",
      },
      1_500,
    );
    expect(concurrent).toMatchObject({ ok: false, reason: "terminal_busy" });

    // 3. Gateway socket drops -> collection moves to result_unknown and stays locked!
    markGatewayCollectionsUnknown(sql, "gw_tokyo_1", 2_000);
    expect(readTerminalCollection(sql, "gw_tokyo_1", "stera_lan_1")?.state).toBe(
      "result_unknown",
    );
    const blockedByUnknown = reserveTerminalCollection(
      sql,
      {
        ...baseInput,
        requestId: "req_3",
        paymentAttemptId: "att_3",
        checkoutId: "chk_3",
      },
      2_500,
    );
    expect(blockedByUnknown).toMatchObject({
      ok: false,
      reason: "result_unknown",
    });

    // 4. Reconnect lists open unknown collections so DeviceFleetActor sends terminal_inquire.
    const pendingInquiry = openUnknownTerminalCollections(sql, "gw_tokyo_1");
    expect(pendingInquiry).toHaveLength(1);
    expect(pendingInquiry[0]?.paymentAttemptId).toBe("att_1");

    // 5. Gateway answers with captured FeliCa SUICA (non-refundable via provider).
    const settled = recordTerminalResult(
      sql,
      "gw_tokyo_1",
      {
        type: "terminal_result",
        requestId: "req_1",
        sourceKey: "stera_lan_1",
        paymentAttemptId: "att_1",
        outcome: "captured",
        providerPaymentReference: "stera_tx_99",
        paymentMethod: "felica",
        tenderBrand: "SUICA",
        providerRefundable: false,
        reasonCode: null,
      },
      3_000,
    );
    expect(settled).toMatchObject({
      state: "captured",
      providerPaymentReference: "stera_tx_99",
      paymentMethod: "felica",
      tenderBrand: "SUICA",
      providerRefundable: false,
    });

    // 6. Terminal is now free for the next customer; explicit unknown clear also works.
    const nextSale = reserveTerminalCollection(
      sql,
      {
        ...baseInput,
        requestId: "req_4",
        paymentAttemptId: "att_4",
        checkoutId: "chk_4",
        paymentMethod: "qr_code",
      },
      4_000,
    );
    expect(nextSale.ok).toBe(true);
    markGatewayCollectionsUnknown(sql, "gw_tokyo_1", 4_500);
    expect(
      clearTerminalResultUnknown(sql, "gw_tokyo_1", "stera_lan_1", "att_4", 5_000),
    ).toBe(true);
    expect(readTerminalCollection(sql, "gw_tokyo_1", "stera_lan_1")?.state).toBe(
      "declined",
    );
  });

  it("matches all Plan 90 counter-register routes, parses extended counter-sale readbacks, and enforces Sous Chef read/staging-only boundaries", () => {
    expect(
      matchCounterSaleControlRoute(
        `/v1/control/organisations/${ORG_ID}/commerce/counter-register`,
      ),
    ).toEqual({ kind: "counterRegister", organisationIdRaw: ORG_ID });
    expect(
      matchCounterSaleControlRoute(
        `/v1/control/organisations/${ORG_ID}/commerce/counter-sales/chk_1/cash`,
      ),
    ).toEqual({
      kind: "counterSaleCash",
      organisationIdRaw: ORG_ID,
      checkoutIdRaw: "chk_1",
    });
    expect(
      matchCounterSaleControlRoute(
        `/v1/control/organisations/${ORG_ID}/commerce/counter-sales/chk_1/cancel`,
      ),
    ).toEqual({
      kind: "counterSaleCancel",
      organisationIdRaw: ORG_ID,
      checkoutIdRaw: "chk_1",
    });
    expect(
      matchCounterSaleControlRoute(
        `/v1/control/organisations/${ORG_ID}/commerce/counter-sales/chk_1/manual-cash-refund`,
      ),
    ).toEqual({
      kind: "counterSaleManualCashRefund",
      organisationIdRaw: ORG_ID,
      checkoutIdRaw: "chk_1",
    });

    // Portal parser accepts Plan 90 fields while still rejecting unmodeled keys.
    const parsed = parseCounterSaleEnvelope({
      ok: true,
      counterSale: {
        schemaVersion: "satyr.counter-sale.v1",
        checkoutId: "chk_1",
        satyrLocationId: "loc_tokyo",
        revision: 3,
        state: "complete",
        collectable: false,
        recoverable: null,
        quote: {
          quoteDigest: `quote_${"a".repeat(64)}`,
          checkoutRevision: 2,
          lineCount: 2,
          amount: { amountMinor: 1180, currency: "JPY" },
        },
        orderId: "ord_1",
        capturedPaymentReference: null,
        pickupCode: "C-125",
        manualTender: {
          cashReceivedMinor: 2000,
          changeDueMinor: 820,
          currency: "JPY",
        },
        afterSale: null,
      },
    });
    expect(parsed.pickupCode).toBe("C-125");
    expect(parsed.manualTender?.changeDueMinor).toBe(820);

    // Sous Chef catalog exposes read + basket staging only, ZERO money movement tools.
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("counter_sale_read");
    for (const cmd of REGISTER_VIEW_COMMANDS) {
      expect(names).toContain(cmd);
    }
    expect(
      TOOLS.find((t) =>
        /counter_sale_(collect|cash|charge|drawer|refund)|terminal_collect|cash_drawer/u.test(
          t.name,
        ),
      ),
    ).toBeUndefined();

    // Operator gets ONLY Register basket staging commands; viewer gets none.
    expect(
      authorizedBakerySurfaceCommands({
        kind: "control",
        organisationId: ORG_ID,
        requesterPersonId: "person_operator",
        userId: "user_operator",
        membershipRevision: 1,
        role: "operator",
      }),
    ).toEqual([...REGISTER_VIEW_COMMANDS]);
    expect(
      authorizedBakerySurfaceCommands({
        kind: "control",
        organisationId: ORG_ID,
        requesterPersonId: "person_viewer",
        userId: "user_viewer",
        membershipRevision: 1,
        role: "viewer",
      }),
    ).toEqual([]);
  });
});

function sqliteAsD1(sqlite: DatabaseSync): SingleDatabase {
  const prepare = (query: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        params = values;
        return stmt;
      },
      first: async <T = Record<string, unknown>>() => {
        const row = sqlite
          .prepare(query)
          .get(...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["get"]>));
        return (row ?? null) as T | null;
      },
      all: async <T = Record<string, unknown>>() => {
        const rows = sqlite
          .prepare(query)
          .all(...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["all"]>));
        return { results: rows as T[], success: true, meta: {} };
      },
      run: async () => {
        const info = sqlite
          .prepare(query)
          .run(...(params as Parameters<ReturnType<DatabaseSync["prepare"]>["run"]>));
        return {
          success: true,
          meta: { changes: Number(info.changes) },
          results: [],
        };
      },
    };
    return stmt;
  };
  const db: Record<string, unknown> = {
    prepare,
    batch: async (stmts: readonly { run: () => Promise<unknown> }[]) =>
      Promise.all(stmts.map((s) => s.run())),
    exec: async (sqlText: string) => {
      sqlite.exec(sqlText);
      return { count: 1, duration: 0 };
    },
  };
  db.withSession = () => db;
  return db as unknown as SingleDatabase;
}

function sqliteAsDoSql(sqlite: DatabaseSync): SqlStorage {
  return {
    exec: <T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: unknown[]
    ) => {
      const prepared = sqlite.prepare(query);
      const upper = query.trimStart().toUpperCase();
      if (upper.startsWith("SELECT") || upper.startsWith("PRAGMA")) {
        const rows = prepared.all(
          ...(bindings as Parameters<typeof prepared.all>),
        ) as T[];
        return {
          toArray: () => rows,
          one: () => rows[0],
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          rowsRead: rows.length,
          rowsWritten: 0,
        };
      }
      const info = prepared.run(
        ...(bindings as Parameters<typeof prepared.run>),
      );
      return {
        toArray: () => [] as T[],
        one: () => undefined,
        [Symbol.iterator]: () => [][Symbol.iterator](),
        rowsRead: 0,
        rowsWritten: Number(info.changes),
      };
    },
  } as unknown as SqlStorage;
}
