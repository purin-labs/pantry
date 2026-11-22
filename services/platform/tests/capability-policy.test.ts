import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
} from "../src/authorization/capability-catalogue";
import {
  prepareReadAndProposeAccessDefaults,
  prepareCapabilityPolicyWrite,
  prepareReadAndProposeCapabilityPolicies,
  readOrganisationCapabilityPolicies,
  writeOrganisationCapabilityPolicy,
} from "../src/data/capability-policy";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import {
  compilePublishAndActivateOrganisationPolicy,
  type OrganisationPolicySnapshot,
} from "../src/policy-snapshot";
import { d1Database } from "./sqlite-d1";
import { requireChannelId, requireIntegrationAccountId } from "./test-ids";

const baselineSql = singleDatabaseSchema();

describe("organisation capability policy", function capabilityPolicySuite() {
  it("materializes every catalogue capability and preserves explicit changes", async function materializesBaseline() {
    const fixture = createFixture();
    const session = fixture.db.withSession("first-primary");
    const first = prepareReadAndProposeAccessDefaults({
      source: session,
      admission: {
        kind: "organisation_execution",
        scope: await requireOrganisationExecutionScope(
          {
            DB: fixture.db,
            PANTRY_ORGANISATION_PLACEMENT_PROFILE:
              TEST_ORGANISATION_PLACEMENT_PROFILE,
          },
          fixture.organisationId,
        ),
      },
      materializationReceiptId: "receipt_baseline_first",
      now: 100,
      destination: { kind: "organisation" },
    });
    await session.batch([...first]);
    await fixture.db
      .prepare(
        `UPDATE access_grant
          SET lifecycle = 'revoked', revision = 2,
              reason = 'operator revoked', changed_at = 150
        WHERE organisation_id = ? AND grant_id IN (
          'grant_baseline_owner_context_case_read',
          'grant_baseline_owner_integration_discovery_read'
        )`,
      )
      .bind(fixture.organisationId)
      .run();
    const changed = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(
        {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        fixture.organisationId,
      ),
      write: {
        kind: "change",

        capabilityId: CAPABILITY_KEYS.fileRead,
        expectedRevision: 1,
        mode: "disabled",
        provenance: {
          kind: "operator",
          userId: "user_c6e653f6-18d7-5a1c-94fd-8c16cf911e9c",
          mutationReceiptId: "receipt_policy_change",
        },
        now: 200,
      },
    });
    expect(changed.ok).toBe(true);
    const second = prepareReadAndProposeAccessDefaults({
      source: session,
      admission: {
        kind: "organisation_execution",
        scope: await requireOrganisationExecutionScope(
          {
            DB: fixture.db,
            PANTRY_ORGANISATION_PLACEMENT_PROFILE:
              TEST_ORGANISATION_PLACEMENT_PROFILE,
          },
          fixture.organisationId,
        ),
      },
      materializationReceiptId: "receipt_baseline_second",
      now: 300,
      destination: { kind: "organisation" },
    });
    await session.batch([...second]);
    const policies = await readOrganisationCapabilityPolicies({
      db: fixture.db,
      organisationId: fixture.organisationId,
    });
    expect(policies.ok).toBe(true);
    if (!policies.ok) throw new Error(policies.error.code);
    expect(policies.value).toHaveLength(CAPABILITY_CATALOGUE.length);
    expect(
      policies.value.filter(isEnabledPolicy).map(readCapabilityId),
    ).toEqual([
      CAPABILITY_KEYS.contextCaseRead,
      CAPABILITY_KEYS.customConnectorDraft,
      CAPABILITY_KEYS.integrationDiscoveryRead,
      CAPABILITY_KEYS.messageAttachmentInspect,
      CAPABILITY_KEYS.messageLinkRead,
      CAPABILITY_KEYS.voiceTranscription,
      CAPABILITY_KEYS.whatsappSupportReplySend,
    ]);
    expect(policies.value.find(isFilePolicy)).toMatchObject({
      mode: "disabled",
      revision: 2,
      provenance: {
        kind: "operator",
        mutationReceiptId: "receipt_policy_change",
      },
    });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT lifecycle, revision FROM access_grant WHERE organisation_id = ? AND grant_id = ?",
        )
        .get(fixture.organisationId, "grant_baseline_owner_context_case_read"),
    ).toEqual({
      lifecycle: "revoked",
      revision: 2,
    });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT lifecycle, revision FROM access_grant WHERE organisation_id = ? AND grant_id = ?",
        )
        .get(
          fixture.organisationId,
          "grant_baseline_owner_integration_discovery_read",
        ),
    ).toEqual({
      lifecycle: "revoked",
      revision: 2,
    });
    fixture.sqlite.close();
  });

  it("scopes message read grants to each Slack conversation and preserves restrictions", async function scopesMessageReads() {
    const fixture = createFixture();
    const session = fixture.db.withSession("first-primary");
    const integrationAccountId = requireIntegrationAccountId("ia_slack");
    const firstConversation = requireChannelId("C_alpha");
    const firstGrantId = "grant_baseline_conversation_context_alpha";
    await session.batch([
      ...prepareReadAndProposeAccessDefaults({
        source: session,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: fixture.db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            fixture.organisationId,
          ),
        },
        materializationReceiptId: "receipt_conversation_first",
        now: 100,
        destination: {
          kind: "slack_conversation",
          grantId: firstGrantId,
          integrationAccountId,
          conversationId: firstConversation,
        },
      }),
    ]);

    await fixture.db
      .prepare(
        `UPDATE access_grant
          SET lifecycle = 'revoked', revision = 2,
              reason = 'operator revoked', changed_at = 150
        WHERE organisation_id = ? AND grant_id = ?`,
      )
      .bind(
        fixture.organisationId,
        `${firstGrantId}_message_attachment_inspect`,
      )
      .run();
    const disabled = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(
        {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        fixture.organisationId,
      ),
      write: {
        kind: "change",

        capabilityId: CAPABILITY_KEYS.messageLinkRead,
        expectedRevision: 1,
        mode: "disabled",
        provenance: {
          kind: "operator",
          userId: "user_c6e653f6-18d7-5a1c-94fd-8c16cf911e9c",
          mutationReceiptId: "receipt_message_link_disable",
        },
        now: 160,
      },
    });
    expect(disabled.ok).toBe(true);

    await session.batch([
      ...prepareReadAndProposeAccessDefaults({
        source: session,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: fixture.db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            fixture.organisationId,
          ),
        },
        materializationReceiptId: "receipt_conversation_rehydrate",
        now: 200,
        destination: {
          kind: "slack_conversation",
          grantId: firstGrantId,
          integrationAccountId,
          conversationId: firstConversation,
        },
      }),
    ]);
    const secondConversation = requireChannelId("C_beta");
    const secondGrantId = "grant_baseline_conversation_context_beta";
    await session.batch([
      ...prepareReadAndProposeAccessDefaults({
        source: session,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: fixture.db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            fixture.organisationId,
          ),
        },
        materializationReceiptId: "receipt_conversation_second",
        now: 300,
        destination: {
          kind: "slack_conversation",
          grantId: secondGrantId,
          integrationAccountId,
          conversationId: secondConversation,
        },
      }),
    ]);

    expect(
      fixture.sqlite
        .prepare(
          `SELECT grant_id AS grantId, lifecycle, revision,
              json_extract(subject_json, '$.kind') AS subjectKind,
              json_extract(subject_json, '$.conversationId') AS conversationId,
              json_extract(target_json, '$.capabilityId') AS capabilityId
         FROM access_grant
        WHERE organisation_id = ? AND grant_id LIKE 'grant_baseline_conversation_context_%'
        ORDER BY grant_id`,
        )
        .all(fixture.organisationId),
    ).toEqual([
      {
        grantId: firstGrantId,
        lifecycle: "active",
        revision: 1,
        subjectKind: "conversation",
        conversationId: "C_alpha",
        capabilityId: CAPABILITY_KEYS.contextCaseRead,
      },
      {
        grantId: `${firstGrantId}_message_attachment_inspect`,
        lifecycle: "revoked",
        revision: 2,
        subjectKind: "conversation",
        conversationId: "C_alpha",
        capabilityId: CAPABILITY_KEYS.messageAttachmentInspect,
      },
      {
        grantId: `${firstGrantId}_message_link_read`,
        lifecycle: "active",
        revision: 1,
        subjectKind: "conversation",
        conversationId: "C_alpha",
        capabilityId: CAPABILITY_KEYS.messageLinkRead,
      },
      {
        grantId: secondGrantId,
        lifecycle: "active",
        revision: 1,
        subjectKind: "conversation",
        conversationId: "C_beta",
        capabilityId: CAPABILITY_KEYS.contextCaseRead,
      },
      {
        grantId: `${secondGrantId}_message_attachment_inspect`,
        lifecycle: "active",
        revision: 1,
        subjectKind: "conversation",
        conversationId: "C_beta",
        capabilityId: CAPABILITY_KEYS.messageAttachmentInspect,
      },
      {
        grantId: `${secondGrantId}_message_link_read`,
        lifecycle: "active",
        revision: 1,
        subjectKind: "conversation",
        conversationId: "C_beta",
        capabilityId: CAPABILITY_KEYS.messageLinkRead,
      },
    ]);
    const policies = await readOrganisationCapabilityPolicies({
      db: fixture.db,
      organisationId: fixture.organisationId,
    });
    expect(policies.ok).toBe(true);
    if (policies.ok) {
      expect(policies.value.find(isMessageLinkPolicy)).toMatchObject({
        mode: "disabled",
        revision: 2,
        provenance: {
          kind: "operator",
          mutationReceiptId: "receipt_message_link_disable",
        },
      });
    }
    fixture.sqlite.close();
  });

  it("compiles enabled, approval-required, and disabled modes", async function compilesModes() {
    const fixture = createFixture();
    const session = fixture.db.withSession("first-primary");
    await session.batch([
      ...prepareReadAndProposeCapabilityPolicies({
        source: session,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: fixture.db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            fixture.organisationId,
          ),
        },
        materializationReceiptId: "receipt_compile_baseline",
        now: 100,
      }),
    ]);
    const changed = await writeOrganisationCapabilityPolicy({
      scope: await requireOrganisationExecutionScope(
        {
          DB: fixture.db,
          PANTRY_ORGANISATION_PLACEMENT_PROFILE:
            TEST_ORGANISATION_PLACEMENT_PROFILE,
        },
        fixture.organisationId,
      ),
      write: {
        kind: "change",

        capabilityId: CAPABILITY_KEYS.commerceListEntryPatch,
        expectedRevision: 1,
        mode: "approval_required",
        provenance: {
          kind: "operator",
          userId: "user_c6e653f6-18d7-5a1c-94fd-8c16cf911e9c",
          mutationReceiptId: "receipt_policy_approval",
        },
        now: 200,
      },
    });
    expect(changed.ok).toBe(true);
    const kv = new MemoryKv();
    const compiled = await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: fixture.db, kv: kv as unknown as KVNamespace },
      organisationId: fixture.organisationId,
      organisation: new MatchingOrganisationPolicyActivator(),
      now: 300,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.error.code);
    expect(compiled.value.snapshot.authz.allowedTools).toContain(
      CAPABILITY_KEYS.contextCaseRead,
    );
    expect(compiled.value.snapshot.authz.allowedTools).toContain(
      CAPABILITY_KEYS.commerceListEntryPatch,
    );
    expect(compiled.value.snapshot.authz.approvalRequired).toEqual([
      CAPABILITY_KEYS.commerceListEntryPatch,
    ]);
    expect(compiled.value.snapshot.authz.deniedTools).toContain(
      CAPABILITY_KEYS.stripeChargeCreate,
    );
    expect(kv.puts).toEqual([
      `policy:${fixture.organisationId}:v1`,
      `policy:${fixture.organisationId}:latest`,
    ]);
    fixture.sqlite.close();
  });

  it("rejects publication while the Organisation Actor head is held", async function rejectsHeldActor() {
    const fixture = createFixture();
    const session = fixture.db.withSession("first-primary");
    await session.batch([
      ...prepareReadAndProposeCapabilityPolicies({
        source: session,
        admission: {
          kind: "organisation_execution",
          scope: await requireOrganisationExecutionScope(
            {
              DB: fixture.db,
              PANTRY_ORGANISATION_PLACEMENT_PROFILE:
                TEST_ORGANISATION_PLACEMENT_PROFILE,
            },
            fixture.organisationId,
          ),
        },
        materializationReceiptId: "receipt_held_actor_baseline",
        now: 100,
      }),
    ]);
    const kv = new MemoryKv();
    const published = await compilePublishAndActivateOrganisationPolicy({
      bindings: { db: fixture.db, kv: kv as unknown as KVNamespace },
      organisationId: fixture.organisationId,
      organisation: new HeldOrganisationPolicyActivator(),
      now: 200,
    });
    expect(published).toEqual({
      ok: false,
      error: {
        code: "policy_settlement_failed",
        detail: "D1, KV, and Organisation Actor policy heads differ",
      },
    });
    expect(kv.puts).toEqual([]);
    fixture.sqlite.close();
  });

  it("rejects modes unsupported by the capability definition", async function rejectsUnsupportedMode() {
    const fixture = createFixture();
    const scope = await requireOrganisationExecutionScope(
      {
        DB: fixture.db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      },
      fixture.organisationId,
    );
    expect(function prepareUnsupportedMode() {
      prepareCapabilityPolicyWrite(
        fixture.db,
        { kind: "organisation_execution", scope },
        {
          kind: "materialize",

          capabilityId: CAPABILITY_KEYS.contextCaseRead,
          mode: "approval_required",
          provenance: {
            kind: "baseline",
            profile: "read_and_propose",
            profileVersion: 1,
            materializationReceiptId: "receipt_invalid_mode",
          },
          now: 100,
        },
      );
    }).toThrow("Invalid capability policy write: mode");
    fixture.sqlite.close();
  });
});

class MemoryKv {
  readonly puts: string[] = [];
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push(key);
    this.values.set(key, value);
  }
}

class MatchingOrganisationPolicyActivator {
  async activatePolicy(
    input: Readonly<{
      readonly snapshot: OrganisationPolicySnapshot;
    }>,
  ): Promise<{
    readonly ok: true;
    readonly value: {
      readonly head: {
        readonly activeVersion: number;
        readonly restrictionVersion: number;
        readonly digest: string;
      };
      readonly consumers: number;
      readonly delivered: number;
      readonly pending: number;
    };
  }> {
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

class HeldOrganisationPolicyActivator {
  async activatePolicy(): Promise<{
    readonly ok: true;
    readonly value: {
      readonly head: {
        readonly activeVersion: number;
        readonly restrictionVersion: number;
        readonly digest: string;
      };
      readonly consumers: number;
      readonly delivered: number;
      readonly pending: number;
    };
  }> {
    return {
      ok: true,
      value: {
        head: { activeVersion: 0, restrictionVersion: 0, digest: "held" },
        consumers: 0,
        delivered: 0,
        pending: 0,
      },
    };
  }
}

function createFixture(): {
  readonly sqlite: DatabaseSync;
  readonly db: SingleDatabase;
  readonly organisationId: OrganisationId;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(baselineSql);
  sqlite
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, ?, ?)",
    )
    .run("organisation_capability_policy", "Capability Policy", 1);
  sqlite.exec(`INSERT INTO organisation_placement (organisation_id, placement_epoch, placement_kind, placement_cell_id, location_hint, status, fence_token, created_at, activated_at)
    VALUES ('organisation_capability_policy', 1, 'affinity', 'multi-region-preview', 'wnam', 'active', 'test_fence', 1, 1)`);
  const organisationId = parseOrganisationId("organisation_capability_policy");
  if (!organisationId.ok) throw new Error("organisation fixture invalid");
  return {
    sqlite,
    db: d1Database(sqlite),
    organisationId: organisationId.value,
  };
}

function isEnabledPolicy(policy: { readonly mode: string }): boolean {
  return policy.mode === "enabled";
}

function readCapabilityId(policy: { readonly capabilityId: string }): string {
  return policy.capabilityId;
}

function isFilePolicy(policy: { readonly capabilityId: string }): boolean {
  return policy.capabilityId === CAPABILITY_KEYS.fileRead;
}

function isMessageLinkPolicy(policy: {
  readonly capabilityId: string;
}): boolean {
  return policy.capabilityId === CAPABILITY_KEYS.messageLinkRead;
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
