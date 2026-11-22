import type { RequestAuthority } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import { sourceReaderForAuthority } from "@purin-labs/authority/policy/information-flow/source-readers";
import type { Variant } from "@purin-labs/type-utils";

describe("information-flow source readers", function sourceReaderSuite() {
  it("binds direct and control ingress to the exact requester", function exactPersonReaders() {
    expect(sourceReaderForAuthority(directAuthority())).toEqual({
      kind: "person",
      personId: "person_reader",
    });
    expect(sourceReaderForAuthority(controlAuthority())).toEqual({
      kind: "person",
      personId: "person_reader",
    });
  });

  it("preserves exact non-person ingress identities", function exactSurfaceReaders() {
    expect(sourceReaderForAuthority(sharedAuthority())).toEqual({
      kind: "conversation",
      integrationAccountId: "account_slack",
      conversationId: "channel_cafe",
    });
    expect(sourceReaderForAuthority(workflowAuthority())).toEqual({
      kind: "workflow",
      workflowKind: "cue_subscription",
      workflowId: "cue_low_stock",
      workflowRevision: 3,
    });
    expect(sourceReaderForAuthority(mailboxAuthority())).toEqual({
      kind: "agent_mailbox",
      integrationAccountId: "account_gmail",
      mailboxBindingId: "mailbox_support",
      bindingRevision: 4,
    });
    expect(sourceReaderForAuthority(whatsAppAuthority())).toEqual({
      kind: "whatsapp_support",
      integrationAccountId: "account_whatsapp",
      supportBindingId: "support_cafe",
      bindingRevision: 5,
    });
  });
});

function directAuthority(): Variant<RequestAuthority, "direct_conversation"> {
  return {
    kind: "direct_conversation",
    organisationId: "organisation_reader",
    requesterPersonId: "person_reader",
    membershipRevision: 1,
    role: "admin",
    connectorId: "connector_slack",
    integrationAccountId: "account_slack",
    conversationId: "dm_reader",
  };
}

function controlAuthority(): Variant<RequestAuthority, "control"> {
  return {
    kind: "control",
    organisationId: "organisation_reader",
    requesterPersonId: "person_reader",
    userId: "user_eb314326-52f0-55f4-bd0f-5d645e60c690",
    membershipRevision: 1,
    role: "admin",
  };
}

function sharedAuthority(): Variant<RequestAuthority, "shared_conversation"> {
  return {
    kind: "shared_conversation",
    organisationId: "organisation_reader",
    requesterPersonId: "person_reader",
    membershipRevision: 1,
    role: "operator",
    connectorId: "connector_slack",
    integrationAccountId: "account_slack",
    conversationId: "channel_cafe",
  };
}

function workflowAuthority(): Variant<RequestAuthority, "workflow"> {
  return {
    kind: "workflow",
    organisationId: "organisation_reader",
    workflowId: "cue_low_stock",
    workflowRevision: 3,
  };
}

function mailboxAuthority(): Variant<RequestAuthority, "agent_mailbox"> {
  return {
    kind: "agent_mailbox",
    organisationId: "organisation_reader",
    integrationAccountId: "account_gmail",
    mailboxBindingId: "mailbox_support",
    bindingRevision: 4,
    mailboxPolicyVersion: 2,
  };
}

function whatsAppAuthority(): Variant<RequestAuthority, "whatsapp_support"> {
  return {
    kind: "whatsapp_support",
    organisationId: "organisation_reader",
    integrationAccountId: "account_whatsapp",
    supportBindingId: "support_cafe",
    bindingRevision: 5,
    ingressPolicyVersion: 2,
  };
}
