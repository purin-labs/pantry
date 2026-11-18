import { describe, expect, it } from "vitest";

import {
  parseControlAuthority,
  parseCueSubscriptionAuthority,
  parseDirectSlackAuthority,
  grantSubjectsForAuthority,
  parseSharedSlackAuthority,
} from "../src/request-authority";
import {
  authorityPartitionKey,
  parseStoredAuthorityPartition,
} from "../src/authorization/access-grants";

function validSlackAuthority(
  conversationKind: string,
): Record<string, unknown> {
  return {
    organisationId: "organisation_1",
    requester: { organisationId: "organisation_1", personId: "person_1" },
    membershipRevision: 2,
    role: "operator",
    connector: { organisationId: "organisation_1", id: "connector_slack" },
    workspace: { organisationId: "organisation_1", id: "workspace_1" },
    integrationAccount: {
      organisationId: "organisation_1",
      workspaceId: "workspace_1",
      id: "account_slack",
    },
    conversation: {
      organisationId: "organisation_1",
      workspaceId: "workspace_1",
      id: "conversation_1",
      kind: conversationKind,
    },
  };
}

function validWorkflowAuthority(): Record<string, unknown> {
  return {
    organisationId: "organisation_1",
    workflow: { organisationId: "organisation_1", id: "cue_subscription_1", revision: 3 },
  };
}

describe("request authority boundary", () => {
  it("builds direct Slack authority and derives person scope from the exact authority", () => {
    const result = parseDirectSlackAuthority(validSlackAuthority("im"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.requestAuthority).toEqual({
      kind: "direct_conversation",
      organisationId: "organisation_1",
      requesterPersonId: "person_1",
      membershipRevision: 2,
      role: "operator",
      connectorId: "connector_slack",
      integrationAccountId: "account_slack",
      conversationId: "conversation_1",
    });
    expect(grantSubjectsForAuthority(result.value.requestAuthority)).toEqual([
      { kind: "organisation_role", role: "operator" },
      { kind: "person", personId: "person_1" },
    ]);
  });

  it("builds shared Slack authority without requester-private grants", () => {
    const result = parseSharedSlackAuthority(validSlackAuthority("channel"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(grantSubjectsForAuthority(result.value.requestAuthority)).toEqual([
      { kind: "organisation_role", role: "operator" },
      {
        kind: "conversation",
        integrationAccountId: "account_slack",
        conversationId: "conversation_1",
      },
    ]);
  });

  it("rejects an unknown Slack conversation kind", () => {
    const result = parseSharedSlackAuthority(validSlackAuthority("unknown"));

    expect(result).toEqual({
      ok: false,
      error: { code: "unknown_slack_conversation_kind", value: "unknown" },
    });
  });

  it("rejects cross-organisation Slack scope", () => {
    const raw = validSlackAuthority("im");
    raw.conversation = {
      organisationId: "organisation_2",
      workspaceId: "workspace_1",
      id: "conversation_1",
      kind: "im",
    };

    const result = parseDirectSlackAuthority(raw);

    expect(result).toEqual({
      ok: false,
      error: { code: "cross_organisation_scope", field: "conversation.organisationId" },
    });
  });

  it("rejects missing Slack role at the boundary", () => {
    const raw = validSlackAuthority("im");
    delete raw.role;

    const result = parseDirectSlackAuthority(raw);

    expect(result).toEqual({
      ok: false,
      error: { code: "missing_field", field: "role" },
    });
  });

  it("rejects a workspace mismatch between account and conversation", () => {
    const raw = validSlackAuthority("channel");
    raw.conversation = {
      organisationId: "organisation_1",
      workspaceId: "workspace_2",
      id: "conversation_1",
      kind: "channel",
    };

    const result = parseSharedSlackAuthority(raw);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "cross_workspace_scope",
        field: "conversation.workspaceId",
      },
    });
  });

  it("builds cue subscription workflow authority with an exact revision", () => {
    const result = parseCueSubscriptionAuthority(validWorkflowAuthority());

    expect(result).toEqual({
      ok: true,
      value: {
        requestAuthority: {
          kind: "workflow",
          organisationId: "organisation_1",
          workflowId: "cue_subscription_1",
          workflowRevision: 3,
        },
      },
    });
    if (!result.ok) return;
    expect(grantSubjectsForAuthority(result.value.requestAuthority)).toEqual([
      {
        kind: "workflow",
        workflowKind: "cue_subscription",
        workflowId: "cue_subscription_1",
        workflowRevision: 3,
      },
    ]);
  });

  it("builds control authority from the authenticated role", () => {
    const result = parseControlAuthority({
      organisationId: "organisation_1",
      requester: { organisationId: "organisation_1", personId: "person_operator" },
      user: { organisationId: "organisation_1", id: "user_ac60d4c0-0104-5a11-95f6-f2c3f46948f9" },
      membershipRevision: 4,
      role: "approve",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(grantSubjectsForAuthority(result.value.requestAuthority)).toEqual([
      { kind: "organisation_role", role: "approve" },
    ]);
  });

  it("parses the frozen authority partition at the persistence boundary", () => {
    const authority = parseDirectSlackAuthority(validSlackAuthority("im"));
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    const key = authorityPartitionKey(authority.value.requestAuthority);
    const result = parseStoredAuthorityPartition({
      digest: "a".repeat(64),
      key,
      selectedGrantSetDigest: "b".repeat(64),
      capabilityKeys: ["platform:commerce_entity_context:1"],
      policyVersion: "policy_1",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        digest: "a".repeat(64),
        key,
        selectedGrantSetDigest: "b".repeat(64),
        capabilityKeys: ["platform:commerce_entity_context:1"],
        policyVersion: "policy_1",
      },
    });
    expect(parseStoredAuthorityPartition({ key })).toEqual({
      ok: false,
      error: { code: "invalid_authority_partition", field: "digest" },
    });
  });

  it("parses a WhatsApp support authority partition", () => {
    const key = {
      kind: "whatsapp_support" as const,
      organisationId: "organisation_1",
      integrationAccountId: "integration_whatsapp_1",
      supportBindingId: "binding_whatsapp_1",
      bindingRevision: 2,
      ingressPolicyVersion: 4,
    };
    expect(
      parseStoredAuthorityPartition({
        digest: "a".repeat(64),
        key,
        selectedGrantSetDigest: "b".repeat(64),
        capabilityKeys: ["platform:commerce_entity_context:1"],
        policyVersion: "policy_1",
      }),
    ).toEqual({
      ok: true,
      value: {
        digest: "a".repeat(64),
        key,
        selectedGrantSetDigest: "b".repeat(64),
        capabilityKeys: ["platform:commerce_entity_context:1"],
        policyVersion: "policy_1",
      },
    });
  });
});
