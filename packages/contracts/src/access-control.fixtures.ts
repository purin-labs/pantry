import type {
  AccessGrantLifecycle,
  AccessGrantTarget,
  CapabilityDefinition,
  CapabilityPolicyModes,
  CapabilityProviderDependency,
  GrantSubject,
} from "./index.ts";

export const mailboxGrantSubject = {
  kind: "agent_mailbox",
  integrationAccountId: "account_gmail",
  mailboxBindingId: "mailbox_support",
  bindingRevision: 1,
} satisfies GrantSubject;

export const whatsAppGrantSubject = {
  kind: "whatsapp_support",
  integrationAccountId: "account_whatsapp",
  supportBindingId: "support_cafe",
  bindingRevision: 1,
} satisfies GrantSubject;

export const invalidMailboxSubject = {
  kind: "agent_mailbox",
  integrationAccountId: "account_gmail",
  bindingRevision: 1,
  // @ts-expect-error Mailbox subjects require their exact binding identity.
} satisfies GrantSubject;

export const invalidMixedSubject = {
  kind: "person",
  personId: "person_1",
  // @ts-expect-error Conversation identity cannot enter a person subject.
  conversationId: "channel_1",
} satisfies GrantSubject;

declare const broadSubject: Record<string, unknown>;

// @ts-expect-error Broad records cannot become grant subjects through a spread.
export const invalidBroadSubject = { ...broadSubject } satisfies GrantSubject;

export const invalidMixedTarget = {
  kind: "platform_capability",
  capabilityId: "context.case.read",
  capabilityVersion: 1,
  // @ts-expect-error Provider identity cannot enter a platform target.
  integrationAccountId: "account_1",
} satisfies AccessGrantTarget;

export const customConnectorReadTarget = {
  kind: "custom_connector_operation",
  capabilityId: "custom_connector.read",
  capabilityVersion: 1,
  integrationAccountId: "integration_custom_inventory",
  connectorId: "custom_connector_inventory",
  definitionRevision: 2,
  definitionDigest: "a".repeat(64),
  operationId: "list_products",
} satisfies AccessGrantTarget;

export const invalidCustomConnectorReadTarget = {
  kind: "custom_connector_operation",
  capabilityId: "custom_connector.read",
  capabilityVersion: 1,
  integrationAccountId: "integration_custom_inventory",
  connectorId: "custom_connector_inventory",
  definitionRevision: 2,
  definitionDigest: "a".repeat(64),
  // @ts-expect-error Custom connector grants require an exact operation ID.
} satisfies AccessGrantTarget;

export const invalidRevokedLifecycle = {
  kind: "revoked",
  revision: 2,
  revokedAt: 2,
  // @ts-expect-error Revoked grants require a revocation reason.
} satisfies AccessGrantLifecycle;

// @ts-expect-error Unsupported policy-mode combinations are absent from the union.
export const invalidPolicyModes: CapabilityPolicyModes =
  "enabled_approval_required";

export const invalidProviderDependency = {
  kind: "provider",
  providers: [
    // @ts-expect-error Unknown providers cannot enter capability metadata.
    "salesforce",
  ],
} satisfies CapabilityProviderDependency;

export const commerceSystemDependency = {
  kind: "commerce_system",
  systems: ["satyr_commerce", "shopify"],
} satisfies CapabilityProviderDependency;

export const invalidCommerceSystemDependency = {
  kind: "commerce_system",
  systems: [
    // @ts-expect-error Commerce is an implementation authority, not a commerce-system identity.
    "underclerk",
  ],
} satisfies CapabilityProviderDependency;

export const contextCapabilityDefinition = {
  capabilityId: "context.case.read",
  capabilityVersion: 1,
  label: "Read Case context",
  description: "View accepted Case context available to the current authority.",
  category: "context",
  risk: "read",
  target: "platform",
  providerDependency: { kind: "none" },
  policyModes: "enabled_disabled",
} satisfies CapabilityDefinition;

export const invalidMissingPresentation = {
  capabilityId: "context.case.read",
  capabilityVersion: 1,
  description: "View accepted Case context available to the current authority.",
  category: "context",
  risk: "read",
  target: "platform",
  providerDependency: { kind: "none" },
  policyModes: "enabled_disabled",
  // @ts-expect-error Capability definitions require their display label.
} satisfies CapabilityDefinition;
