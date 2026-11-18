import type {
  MailOrganizationCommand,
  MailRule,
  MailRuleSet,
} from "./mail-organization.ts";

const category = {
  kind: "categorize",
  ruleId: "suppliers",
  instruction: "Supplier email",
  category: "Suppliers",
} as const;
// @ts-expect-error A priority rule cannot carry category state from a spread.
const mixed: MailRule = { ...category, kind: "prioritize" };
const action: MailRule = {
  kind: "prioritize",
  ruleId: "priority",
  instruction: "Delivery delay",
  // @ts-expect-error Organization-only rules cannot carry an execution target.
  agentId: "purchasing",
};
// @ts-expect-error Published rules require the activation boundary.
const missingActivation: MailRuleSet = {
  kind: "published",
  revision: 1,
  rules: [category],
};
void mixed;
void action;
void missingActivation;
const investigation: MailRule = {
  kind: "investigate_supplier_delay",
  ruleId: "delivery",
  instruction: "Supplier delivery delays",
  // @ts-expect-error The supported action uses the bound installation.
  agentId: "other_agent",
};
void investigation;

const publication = {
  kind: "publish",
  expectedRevision: 2,
  rules: [category],
  consent: true,
} as const;
// @ts-expect-error Resume uses saved rules; it cannot replace them through a spread.
const replacedResume: MailOrganizationCommand = {
  ...publication,
  kind: "resume",
};
const historicalResume: MailOrganizationCommand = {
  kind: "resume",
  expectedRevision: 2,
  // @ts-expect-error Resume cannot request historical mailbox processing.
  messageIds: ["message_1"],
};
void replacedResume;
void historicalResume;
