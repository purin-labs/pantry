// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { DatabaseSync } from "node:sqlite";

import type { RequestAuthority } from "@purin-labs/contracts";
import type {
  CommerceCommandAuthorityContext,
  CommerceAuthorityScope,
  CommerceEntityAuthority,
} from "@purin-labs/commerce-contracts";
import {
  parseCommerceEntityPlaneCommand,
  parseCommerceGraphQuery,
  parseEntityPlaneCommand,
} from "@purin-labs/commerce-client";
import { describe, expect, it } from "vitest";

import {
  compileCommerceReadAuthorities,
  commerceCommandGrantMatches,
} from "@purin-labs/area-commerce/server/entity-plane/grant-authorities";
import {
  compileEffectiveGrantSet,
  encodeProviderCapabilityKey,
  parseCapabilityKey,
  type AccessGrant,
  type ImmutableCapabilityDefinition,
} from "@purin-labs/authority/authorization/access-grants/index";
import {
  createAccessGrant,
  parseAccessGrantRow,
  revokeAccessGrant,
  readAccessGrant,
  listAccessGrants,
} from "@purin-labs/authority/data/access-grants";
import { d1Database } from "./sqlite-d1";
import type { Variant } from "@purin-labs/type-utils";
import { requireOrganisationId } from "./test-ids";

const baselineSql = singleDatabaseSchema();
const TEST_GRANT_PROVENANCE = {
  kind: "operator",
  userId: "user_47369a65-b51a-5eec-987f-ed5bd2d84e05",
  mutationReceiptId: "receipt_test",
} as const;

describe("Plan 25 access grants", () => {
  it("round-trips canonical provider capability keys", () => {
    const definition = providerDefinition();
    const key = encodeProviderCapabilityKey(definition);
    expect(key).toBe(
      "provider:stripe.refund.create:1:account_alpha:stripe:charge:ch_1",
    );
    expect(parseCapabilityKey(key)).toEqual({ ok: true, value: definition });
    const scoped = {
      ...definition,
      resourceScope: "commerce:publish_catalog_listing:offer_1",
    };
    expect(parseCapabilityKey(encodeProviderCapabilityKey(scoped))).toEqual({
      ok: true,
      value: scoped,
    });
    expect(
      parseCapabilityKey(
        "provider:stripe.refund.create:nope:account_alpha:stripe:charge:ch_1",
      ).ok,
    ).toBe(false);
  });

  it("persists lifecycle revisions with organisation fencing", async () => {
    const fixture = createFixture();
    const grant = activeGrant("organisation_alpha", "grant_catalog");

    expect(
      (
        await createAccessGrant({
          db: fixture.db,
          organisationId: requireOrganisationId("organisation_alpha"),
          grantId: grant.grantId,
          subject: grant.subject,
          target: grant.target,
          provenance: TEST_GRANT_PROVENANCE,
          now: 100,
        })
      ).ok,
    ).toBe(true);
    const listed = await listAccessGrants({
      db: fixture.db,
      organisationId: requireOrganisationId("organisation_alpha"),
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("list fixture failed");
    expect(
      listed.value.filter(
        (listedGrant) => listedGrant.grantId === grant.grantId,
      ),
    ).toHaveLength(1);
    const revoked = await revokeAccessGrant({
      db: fixture.db,
      organisationId: requireOrganisationId("organisation_alpha"),
      grantId: grant.grantId,
      expectedRevision: 1,
      reason: "access removed",
      now: 300,
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error("revocation fixture failed");
    expect(revoked.value.lifecycle).toEqual({
      kind: "revoked",
      revision: 2,
      revokedAt: 300,
      reason: "access removed",
    });
    expect(
      await readAccessGrant({
        db: fixture.db,
        organisationId: requireOrganisationId("organisation_other"),
        grantId: grant.grantId,
      }),
    ).toEqual({ ok: false, error: { code: "access_grant_not_found" } });
    expect(
      await revokeAccessGrant({
        db: fixture.db,
        organisationId: requireOrganisationId("organisation_alpha"),
        grantId: grant.grantId,
        expectedRevision: 1,
        reason: "stale",
        now: 400,
      }),
    ).toEqual({
      ok: false,
      error: { code: "access_grant_revision_conflict", expected: 1, actual: 2 },
    });
    fixture.sqlite.close();
  });

  it("selects direct and shared grants while preserving the organisation ceiling", () => {
    const authority = directAuthority();
    const direct = compileEffectiveGrantSet({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority,
      grants: [
        activeGrant("organisation_alpha", "role_catalog"),
        activePersonGrant("organisation_alpha", "person_catalog"),
        activeConversationGrant("organisation_alpha", "conversation_balance"),
      ],
      organisationAllowedTools: [
        "commerce.entity_plane.context",
        "stripe.refund.create",
      ],
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("direct fixture failed");
    expect(direct.value.capabilities.map(capabilityId)).toEqual([
      "commerce.entity_plane.context",
    ]);

    const shared = compileEffectiveGrantSet({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority: sharedAuthority(),
      grants: [
        activePersonGrant("organisation_alpha", "person_catalog"),
        activeConversationGrant("organisation_alpha", "conversation_balance"),
      ],
      organisationAllowedTools: [
        "commerce.entity_plane.context",
        "stripe.refund.create",
      ],
    });
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw new Error("shared fixture failed");
    expect(shared.value.capabilities.map(capabilityId)).toEqual([
      "stripe.refund.create",
    ]);
  });

  it("denies a revoked provider grant before credential resolution", () => {
    const authority = directAuthority();
    const provider = providerDefinition();
    const revoked: AccessGrant = {
      ...activeProviderGrant("organisation_alpha", "provider_grant"),
      lifecycle: {
        kind: "revoked",
        revision: 2,
        revokedAt: 20,
        reason: "removed",
      },
    };
    const compiled = compileEffectiveGrantSet({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority,
      grants: [revoked],
      organisationAllowedTools: [provider.capabilityId],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error("provider fixture failed");
    expect(compiled.value.capabilities).toHaveLength(0);
  });

  it("requires the exact workflow revision for workflow grants", () => {
    const authority: RequestAuthority = {
      kind: "workflow",
      organisationId: requireOrganisationId("organisation_alpha"),
      workflowId: "cue_low_stock",
      workflowRevision: 7,
    };
    const grant: AccessGrant = {
      ...activeGrant("organisation_alpha", "workflow_catalog"),
      subject: {
        kind: "workflow",
        workflowKind: "cue_subscription",
        workflowId: "cue_low_stock",
        workflowRevision: 6,
      },
    };
    const denied = compileEffectiveGrantSet({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority,
      grants: [grant],
      organisationAllowedTools: ["commerce.entity_plane.context"],
    });
    expect(denied.ok).toBe(true);
    if (!denied.ok) throw new Error("workflow fixture failed");
    expect(denied.value.capabilities).toHaveLength(0);
  });

  it("round-trips mailbox and WhatsApp support subjects from D1", () => {
    const subjects = [
      {
        kind: "agent_mailbox",
        integrationAccountId: "ia_gmail",
        mailboxBindingId: "mailbox_support",
        bindingRevision: 2,
      },
      {
        kind: "whatsapp_support",
        integrationAccountId: "ia_whatsapp",
        supportBindingId: "support_primary",
        bindingRevision: 3,
      },
    ] as const;
    for (const [index, subject] of subjects.entries()) {
      const parsed = parseAccessGrantRow(
        requireOrganisationId("organisation_alpha"),
        {
          grantId: `subject_grant_${index}`,
          organisationId: "organisation_alpha",
          subjectJson: JSON.stringify(subject),
          targetJson: JSON.stringify(
            activeGrant("organisation_alpha", "target").target,
          ),
          provenanceJson: JSON.stringify(TEST_GRANT_PROVENANCE),
          lifecycle: "active",
          revision: 1,
          reason: null,
          changedAt: 100,
        },
      );
      expect(parsed).toEqual({
        ok: true,
        value: expect.objectContaining({ subject }),
      });
    }

    const missingRevision = parseAccessGrantRow(
      requireOrganisationId("organisation_alpha"),
      {
        grantId: "subject_grant_missing_revision",
        organisationId: "organisation_alpha",
        subjectJson: JSON.stringify({
          kind: "agent_mailbox",
          integrationAccountId: "ia_gmail",
          mailboxBindingId: "mailbox_support",
        }),
        targetJson: JSON.stringify(
          activeGrant("organisation_alpha", "target").target,
        ),
        provenanceJson: JSON.stringify(TEST_GRANT_PROVENANCE),
        lifecycle: "active",
        revision: 1,
        reason: null,
        changedAt: 100,
      },
    );
    expect(missingRevision).toEqual({
      ok: false,
      error: { code: "invalid_grant_subject", field: "subject.kind" },
    });
  });

  it("parses only strict entity-plane grant scope branches", () => {
    const base = {
      grantId: "commerce_read_grant",
      organisationId: "organisation_alpha",
      subjectJson: JSON.stringify({
        kind: "organisation_role",
        role: "operator",
      }),
      provenanceJson: JSON.stringify(TEST_GRANT_PROVENANCE),
      lifecycle: "active",
      revision: 1,
      reason: null,
      changedAt: 100,
    };
    const read = parseAccessGrantRow(
      requireOrganisationId("organisation_alpha"),
      {
        ...base,
        targetJson: JSON.stringify({
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: { kind: "commerce_list", listId: "list_products" },
        }),
      },
    );
    expect(read).toEqual({
      ok: true,
      value: expect.objectContaining({
        target: {
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: { kind: "commerce_list", listId: "list_products" },
        },
      }),
    });

    const command = parseAccessGrantRow(
      requireOrganisationId("organisation_alpha"),
      {
        ...base,
        grantId: "commerce_command_grant",
        targetJson: JSON.stringify({
          kind: "commerce_command",
          capabilityId: "commerce.entity.patch",
          capabilityVersion: 1,
          scope: {
            kind: "entity_type",
            entityTypeId: { origin: "system", typeId: "product" },
          },
          target: {
            kind: "custom_entity_type",
            typeId: "custom_product",
            revision: 3,
          },
        }),
      },
    );
    expect(command.ok).toBe(true);
    if (!command.ok) throw new Error("command grant fixture failed");
    expect(command.value.target).toEqual(
      expect.objectContaining({
        kind: "commerce_command",
        target: {
          kind: "custom_entity_type",
          typeId: "custom_product",
          revision: 3,
        },
      }),
    );

    const malformed = parseAccessGrantRow(
      requireOrganisationId("organisation_alpha"),
      {
        ...base,
        targetJson: JSON.stringify({
          kind: "commerce_read",
          capabilityId: "commerce.entity.read",
          capabilityVersion: 1,
          scope: { kind: "entity_type" },
        }),
      },
    );
    expect(malformed).toEqual({
      ok: false,
      error: { code: "invalid_grant_target", field: "target.scope" },
    });
  });

  it("compiles explicit commerce reads and leaves responsibility scopes inert", () => {
    const context = commerceContext();
    const entityTypeQuery = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId: { origin: "system", typeId: "product" },
      filter: { kind: "all" },
      sorts: [],
      pagination: { limit: 1, cursor: null },
      traversal: { maxDepth: 0, resultLimit: 1 },
    });
    if (entityTypeQuery.kind !== "entity_type_page")
      throw new Error("entity type fixture failed");
    const scope: Variant<
      CommerceAuthorityScope,
      "entity_type" | "commerce_list" | "saved_selector"
    > = {
      kind: "entity_type",
      entityTypeId: entityTypeQuery.entityTypeId,
    };
    const grant = commerceReadGrant("commerce_read_grant", scope);
    const compiled = compileCommerceReadAuthorities({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority: directAuthority(),
      selectedGrants: [grant],
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      context,
    });
    expect(compiled).toEqual({
      ok: true,
      value: [
        {
          grantId: "commerce_read_grant",
          grantRevision: 1,
          authority: { kind: "entity_read", context, scope },
        },
      ],
    });

    const noImplicitAuthority = compileCommerceReadAuthorities({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority: directAuthority(),
      selectedGrants: [],
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      context,
    });
    expect(noImplicitAuthority).toEqual({ ok: true, value: [] });
    const generic = compileEffectiveGrantSet({
      organisationId: requireOrganisationId("organisation_alpha"),
      authority: directAuthority(),
      grants: [grant],
      organisationAllowedTools: ["commerce.entity.read"],
    });
    expect(generic).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ capabilities: [] }),
      }),
    );
  });

  it("matches commerce commands by exact scope, resource class, and revision", () => {
    const context = commerceContext();
    const entityQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "custom_product",
        entityId: "product_1",
      },
      filter: null,
      traversal: { maxDepth: 0, resultLimit: 1 },
    });
    if (
      entityQuery.kind !== "entity_by_ref" ||
      entityQuery.reference.origin !== "custom"
    ) {
      throw new Error("entity fixture failed");
    }
    const entityRef = entityQuery.reference;
    const command = parseCommerceEntityPlaneCommand({
      kind: "patch_custom_entity",
      command: {
        entityRef,
        typeRevision: 1,
        expectedRevision: 3,
        attributes: [],
        displayName: null,
      },
    });
    if (command.kind !== "patch_custom_entity")
      throw new Error("command authority fixture failed");
    const scope = {
      kind: "entity",
      entityRef,
    } satisfies CommerceAuthorityScope;
    const authority: CommerceEntityAuthority = {
      kind: "entity_command",
      context,
      scope,
      target: { entityRef, expectedRevision: command.command.expectedRevision },
    };
    const grant: AccessGrant = {
      grantId: "commerce_command_grant",
      organisationId: requireOrganisationId("organisation_alpha"),
      subject: { kind: "organisation_role", role: "operator" },
      target: {
        kind: "commerce_command",
        capabilityId: "commerce.entity.patch",
        capabilityVersion: 1,
        scope,
        target: {
          kind: "custom_entity",
          entityRef,
          revision: command.command.expectedRevision,
        },
      },
      provenance: TEST_GRANT_PROVENANCE,
      lifecycle: { kind: "active", revision: 1, activatedAt: 100 },
    };
    expect(
      commerceCommandGrantMatches({
        grant,
        capabilityId: "commerce.entity.patch",
        capabilityVersion: 1,
        authority,
      }),
    ).toBe(true);
    const changedCommand = parseCommerceEntityPlaneCommand({
      kind: "patch_custom_entity",
      command: {
        entityRef,
        typeRevision: 1,
        expectedRevision: 4,
        attributes: [],
        displayName: null,
      },
    });
    if (changedCommand.kind !== "patch_custom_entity")
      throw new Error("changed command fixture failed");
    expect(
      commerceCommandGrantMatches({
        grant: {
          ...grant,
          target: {
            kind: "commerce_command",
            capabilityId: "commerce.entity.patch",
            capabilityVersion: 1,
            scope,
            target: {
              kind: "custom_entity",
              entityRef,
              revision: changedCommand.command.expectedRevision,
            },
          },
        },
        capabilityId: "commerce.entity.patch",
        capabilityVersion: 1,
        authority,
      }),
    ).toBe(false);
    const differentResourceCommand = parseCommerceEntityPlaneCommand({
      kind: "publish_custom_entity_type",
      command: { target: { typeId: "custom_product", revision: 3 } },
    });
    if (differentResourceCommand.kind !== "publish_custom_entity_type")
      throw new Error("different resource fixture failed");
    expect(
      commerceCommandGrantMatches({
        grant: {
          ...grant,
          target: {
            kind: "commerce_command",
            capabilityId: "commerce.entity.patch",
            capabilityVersion: 1,
            scope,
            target: {
              kind: "custom_entity_type",
              typeId: differentResourceCommand.command.target.typeId,
              revision: differentResourceCommand.command.target.revision,
            },
          },
        },
        capabilityId: "commerce.entity.patch",
        capabilityVersion: 1,
        authority,
      }),
    ).toBe(false);
  });
});

function createFixture(): { sqlite: DatabaseSync; db: SingleDatabase } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(baselineSql);
  sqlite
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, ?, ?)",
    )
    .run("organisation_alpha", "Alpha", 1);
  return { sqlite, db: d1Database(sqlite) };
}

function activeGrant(organisation: string, grantId: string): AccessGrant {
  return {
    grantId,
    organisationId: requireOrganisationId(organisation),
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "platform_capability",
      capabilityId: "commerce.entity_plane.context",
      capabilityVersion: 1,
    },
    provenance: TEST_GRANT_PROVENANCE,
    lifecycle: { kind: "active", revision: 1, activatedAt: 100 },
  };
}

function activePersonGrant(organisation: string, grantId: string): AccessGrant {
  return {
    ...activeGrant(organisation, grantId),
    subject: { kind: "person", personId: "person_alice" },
  };
}

function activeConversationGrant(
  organisation: string,
  grantId: string,
): AccessGrant {
  return {
    ...activeGrant(organisation, grantId),
    target: {
      kind: "provider_resource",
      capabilityId: "stripe.refund.create",
      capabilityVersion: 1,
      integrationAccountId: "account_alpha",
      resourceScope: "stripe:charge:ch_1",
    },
    subject: {
      kind: "conversation",
      integrationAccountId: "account_alpha",
      conversationId: "conversation_alpha",
    },
  };
}

function activeProviderGrant(
  organisation: string,
  grantId: string,
): AccessGrant {
  return {
    grantId,
    organisationId: requireOrganisationId(organisation),
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "provider_resource",
      capabilityId: "stripe.refund.create",
      capabilityVersion: 1,
      integrationAccountId: "account_alpha",
      resourceScope: "stripe:charge:ch_1",
    },
    provenance: TEST_GRANT_PROVENANCE,
    lifecycle: { kind: "active", revision: 1, activatedAt: 100 },
  };
}

function providerDefinition(): ImmutableCapabilityDefinition & {
  readonly kind: "provider_resource";
} {
  return {
    kind: "provider_resource",
    capabilityId: "stripe.refund.create",
    capabilityVersion: 1,
    integrationAccountId: "account_alpha",
    resourceScope: "stripe:charge:ch_1",
  };
}

function directAuthority(): RequestAuthority {
  return {
    kind: "direct_conversation",
    organisationId: requireOrganisationId("organisation_alpha"),
    requesterPersonId: "person_alice",
    membershipRevision: 4,
    role: "operator",
    connectorId: "slack",
    integrationAccountId: "account_alpha",
    conversationId: "conversation_alpha",
  };
}

function sharedAuthority(): RequestAuthority {
  return {
    kind: "shared_conversation",
    organisationId: requireOrganisationId("organisation_alpha"),
    requesterPersonId: "person_bob",
    membershipRevision: 4,
    role: "operator",
    connectorId: "slack",
    integrationAccountId: "account_alpha",
    conversationId: "conversation_alpha",
  };
}

function capabilityId(value: {
  readonly definition: ImmutableCapabilityDefinition;
}): string {
  return value.definition.capabilityId;
}

function commerceReadGrant(
  grantId: string,
  scope: Variant<
    CommerceAuthorityScope,
    "entity_type" | "commerce_list" | "saved_selector"
  >,
): AccessGrant {
  return {
    grantId,
    organisationId: requireOrganisationId("organisation_alpha"),
    subject: { kind: "organisation_role", role: "operator" },
    target: {
      kind: "commerce_read",
      capabilityId: "commerce.entity.read",
      capabilityVersion: 1,
      scope,
    },
    provenance: TEST_GRANT_PROVENANCE,
    lifecycle: { kind: "active", revision: 1, activatedAt: 100 },
  };
}

function commerceContext(): CommerceCommandAuthorityContext {
  const request = parseEntityPlaneCommand({
    organisationId: "organisation_alpha",
    merchantId: "merchant_alpha",
    commandId: "command_context",
    expectedMerchantRevision: 0,
    authority: {
      kind: "entity_create",
      context: {
        organisationId: "organisation_alpha",
        merchantId: "merchant_alpha",
        principalId: "principal_alpha",
        sensitivityCeiling: "restricted",
        expiresAt: "2026-12-31T00:00:00Z",
        causation: { kind: "command", commandId: "command_context" },
      },
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "custom_context" },
      },
      target: { entityId: "context_entity", typeId: "custom_context" },
    },
    command: {
      kind: "create_custom_entity",
      command: {
        entityId: "context_entity",
        typeId: "custom_context",
        typeRevision: 1,
        displayName: "Context Entity",
        attributes: [],
        sensitivity: "public",
      },
    },
  });
  if (request.authority.kind !== "entity_create")
    throw new Error("authority fixture failed");
  return request.authority.context;
}
