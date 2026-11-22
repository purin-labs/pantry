import type { ContextVisibility as AuthorityVisibility } from "../../authorization/access-grants/types";
import { parseContextVisibility as parseAuthorityVisibility } from "../../authorization/access-grants/visibility";
import type { RequestAuthority } from "@purin-labs/contracts";

import { parseFlowReader as parseContextVisibility } from "./readers";
import type { FlowAudience as ContextVisibility } from "./types";
import type { Result } from "@purin-labs/kernel/result";
import { digestCanonical } from "./digest";
import type {
  CanonicalFlowPolicy,
  FlowAudience,
  FlowLabelError,
  FlowLevel,
  FlowPolicyInput,
  FlowPolicyOwner,
  FlowRecipient,
  FlowWriter,
  SerializedFlowLabel,
  SerializedFlowPolicy,
  SerializedFlowReader,
} from "./types";
import type { Variant } from "@purin-labs/type-utils";
import {
  assertNever,
  hasExactKeys,
  isNonBlankString,
  isPositiveInteger,
  isRecord,
  isSha256Hex,
} from "@purin-labs/std";

export class FlowLabel {
  readonly policies: readonly CanonicalFlowPolicy[];
  readonly digest: string;
  /**
   * `outside` when a source of this label holds free text that a person
   * outside the Organisation wrote (Plan 89). A join keeps it, as it keeps
   * each policy. The readers of the label do not depend on it.
   */
  readonly writer: FlowWriter | undefined;
  readonly #flowLabel = true;

  private constructor(
    policies: readonly CanonicalFlowPolicy[],
    digest: string,
    writer: FlowWriter | undefined,
  ) {
    this.policies = policies;
    this.digest = digest;
    this.writer = writer;
    Object.freeze(this.policies);
    Object.freeze(this);
  }

  static async create(
    policies: readonly FlowPolicyInput[],
    writer?: FlowWriter,
  ): Promise<Result<FlowLabel, FlowLabelError>> {
    const normalized = normalizePolicies(policies);
    if (!normalized.ok) return normalized;
    if (writer !== undefined && writer !== "outside")
      return invalidLabel("writer");
    const canonical = canonicalPolicies(normalized.value);
    // A label with no writer keeps the digest that it was stored with.
    const digest = await digestCanonical(
      writer === undefined ? canonical : { policies: canonical, writer },
    );
    return { ok: true, value: new FlowLabel(normalized.value, digest, writer) };
  }

  static async restore(
    raw: unknown,
  ): Promise<Result<FlowLabel, FlowLabelError>> {
    if (
      !isRecord(raw) ||
      !Array.isArray(raw.policies) ||
      !isSha256Hex(raw.digest)
    ) {
      return invalidLabel("shape");
    }
    if (raw.writer !== undefined && raw.writer !== "outside")
      return invalidLabel("writer");
    // A stored policy has exactly an owner, readers and maybe a level. A policy
    // stored with other fields, such as the tool rules that labels once copied,
    // is refused, and so is the record that holds it.
    for (const policy of raw.policies)
      if (
        !isRecord(policy) ||
        !hasExactKeys(
          policy,
          policy.level === undefined
            ? ["owner", "readers"]
            : ["owner", "readers", "level"],
        )
      )
        return invalidLabel("policies");
    // `create` checks every field, so the stored policies go to it as they are.
    const created = await FlowLabel.create(
      raw.policies as readonly FlowPolicyInput[],
      raw.writer,
    );
    if (!created.ok) return created;
    return created.value.digest === raw.digest
      ? created
      : { ok: false, error: { code: "flow_label_digest_mismatch" } };
  }

  toJSON(): SerializedFlowLabel {
    return canonicalFlowLabel(this);
  }

  static is(value: unknown): value is FlowLabel {
    return typeof value === "object" && value !== null && #flowLabel in value;
  }
}

export async function emptyFlowLabel(): Promise<FlowLabel> {
  const created = await FlowLabel.create([]);
  if (!created.ok) throw new Error("empty flow label must be valid");
  return created.value;
}

export async function joinFlowLabels(
  left: FlowLabel,
  right: FlowLabel,
): Promise<Result<FlowLabel, FlowLabelError>> {
  return FlowLabel.create(
    [...left.policies, ...right.policies],
    left.writer ?? right.writer,
  );
}

/**
 * The same label for content that holds free text of a person outside the
 * Organisation (Plan 89). A read adapter calls it for such a result, before it
 * records the observation.
 *
 * @public The IFC integration guide (`README.md` beside this file) tells a
 * new read adapter to call it.
 */
export async function outsideWrittenFlowLabel(
  label: FlowLabel,
): Promise<FlowLabel> {
  if (label.writer === "outside") return label;
  const marked = await FlowLabel.create(label.policies, "outside");
  if (!marked.ok) throw new Error("a valid flow label must stay valid");
  return marked.value;
}

/**
 * The label of a record that a person read and accepted, such as an accepted
 * Memory (Plan 89). The person's decision made the text a record of the
 * Organisation, so the label keeps its readers and loses its writer. Only the
 * read of an accepted record calls this. A summary by a model never does.
 */
export async function acceptedByPersonFlowLabel(
  label: FlowLabel,
): Promise<FlowLabel> {
  if (label.writer === undefined) return label;
  const accepted = await FlowLabel.create(label.policies);
  if (!accepted.ok) throw new Error("a valid flow label must stay valid");
  return accepted.value;
}

export function audiencesForAdmission(
  authority: RequestAuthority,
  caseId: string,
): readonly AuthorityVisibility[] {
  if (!isRecord(authority) || !isNonBlankString(caseId)) return [];
  const caseVisibility = parseAuthorityVisibility({ kind: "case", caseId });
  if (!caseVisibility.ok) return [];
  const audiences = [...audiencesForAuthority(authority), caseVisibility.value];
  return normalizeReaders(audiences);
}

export function audiencesForDestination(
  authority: RequestAuthority,
): readonly AuthorityVisibility[] {
  return isRecord(authority) ? audiencesForAuthority(authority) : [];
}

/**
 * The level of one policy. A policy that states no level was stored before
 * levels, or its source does not need to state one. It is private only when
 * every reader is a person, a Portal chat or a Slack conversation, because
 * Pantry cannot tell from such a reader that the whole Organisation may read.
 * Any other reader belongs to the whole Organisation.
 */
export function policyLevel(policy: CanonicalFlowPolicy): FlowLevel {
  if (policy.level !== undefined) return policy.level;
  return policy.readers.every(
    (reader) =>
      reader.kind === "person" ||
      reader.kind === "chat_conversation" ||
      reader.kind === "conversation",
  )
    ? "private"
    : "internal";
}

export function labelAllowsAudiences(
  label: FlowLabel,
  audiences: readonly FlowAudience[],
): boolean {
  if (!FlowLabel.is(label) || !Array.isArray(audiences)) return false;
  return label.policies.every((policy) =>
    policyAllowsAudiences(policy, audiences),
  );
}

/** Whether one of these audiences is a reader of the policy. */
export function policyAllowsAudiences(
  policy: CanonicalFlowPolicy,
  audiences: readonly FlowAudience[],
): boolean {
  const keys = new Set(audiences.map(readerKey));
  return policy.readers.some((reader) => keys.has(readerKey(reader)));
}

/**
 * The serialized form of each label that was serialized before. A label does
 * not change, so its serialized form does not change. The form is frozen,
 * because every caller that serializes the label gets the same object.
 */
const SERIALIZED_LABELS = new WeakMap<FlowLabel, SerializedFlowLabel>();

export function canonicalFlowLabel(label: FlowLabel): SerializedFlowLabel {
  const known = SERIALIZED_LABELS.get(label);
  if (known !== undefined) return known;
  const serialized: SerializedFlowLabel = {
    policies: canonicalPolicies(label.policies),
    digest: label.digest,
    ...(label.writer === undefined ? {} : { writer: label.writer }),
  };
  freezeJsonValue(serialized);
  SERIALIZED_LABELS.set(label, serialized);
  return serialized;
}

function audiencesForAuthority(
  authority: RequestAuthority,
): readonly AuthorityVisibility[] {
  switch (authority.kind) {
    case "direct_conversation":
      if (!validDirectOrSharedAuthority(authority, true)) return [];
      return normalizeReaders([
        { kind: "person", personId: authority.requesterPersonId },
        { kind: "organisation_role", role: authority.role },
      ]);
    case "shared_conversation":
      if (!validDirectOrSharedAuthority(authority, false)) return [];
      return [
        {
          kind: "conversation",
          integrationAccountId: authority.integrationAccountId,
          conversationId: authority.conversationId,
        },
      ];
    case "workflow":
      if (
        !isNonBlankString(authority.organisationId) ||
        !isNonBlankString(authority.workflowId) ||
        !isPositiveInteger(authority.workflowRevision)
      )
        return [];
      return [
        {
          kind: "workflow",
          workflowKind: "cue_subscription",
          workflowId: authority.workflowId,
          workflowRevision: authority.workflowRevision,
        },
      ];
    case "agent_mailbox":
      if (
        !isNonBlankString(authority.organisationId) ||
        !isNonBlankString(authority.integrationAccountId) ||
        !isNonBlankString(authority.mailboxBindingId) ||
        !isPositiveInteger(authority.bindingRevision) ||
        !isPositiveInteger(authority.mailboxPolicyVersion)
      )
        return [];
      return [
        {
          kind: "agent_mailbox",
          integrationAccountId: authority.integrationAccountId,
          mailboxBindingId: authority.mailboxBindingId,
          bindingRevision: authority.bindingRevision,
        },
      ];
    case "whatsapp_support":
      if (
        !isNonBlankString(authority.organisationId) ||
        !isNonBlankString(authority.integrationAccountId) ||
        !isNonBlankString(authority.supportBindingId) ||
        !isPositiveInteger(authority.bindingRevision) ||
        !isPositiveInteger(authority.ingressPolicyVersion)
      )
        return [];
      return [
        {
          kind: "whatsapp_support",
          integrationAccountId: authority.integrationAccountId,
          supportBindingId: authority.supportBindingId,
          bindingRevision: authority.bindingRevision,
        },
      ];
    case "control":
      if (
        !isNonBlankString(authority.role) ||
        !isNonBlankString(authority.requesterPersonId) ||
        !isNonBlankString(authority.userId) ||
        !isPositiveInteger(authority.membershipRevision)
      )
        return [];
      return normalizeReaders([
        { kind: "person", personId: authority.requesterPersonId },
        { kind: "organisation_role", role: authority.role },
      ]);
    default:
      return [];
  }
}

function validDirectOrSharedAuthority(
  authority: Variant<
    RequestAuthority,
    "direct_conversation" | "shared_conversation"
  >,
  requiresPerson: boolean,
): boolean {
  return (
    isNonBlankString(authority.organisationId) &&
    isPositiveInteger(authority.membershipRevision) &&
    isNonBlankString(authority.role) &&
    isNonBlankString(authority.connectorId) &&
    isNonBlankString(authority.integrationAccountId) &&
    isNonBlankString(authority.conversationId) &&
    (!requiresPerson || isNonBlankString(authority.requesterPersonId))
  );
}

function normalizePolicies(
  policies: readonly FlowPolicyInput[],
): Result<readonly CanonicalFlowPolicy[], FlowLabelError> {
  if (!Array.isArray(policies)) return invalidLabel("policies");
  const byKey = new Map<string, CanonicalFlowPolicy>();
  for (const policy of policies) {
    const normalized = normalizePolicy(policy);
    if (!normalized.ok) return normalized;
    byKey.set(
      JSON.stringify(canonicalPolicy(normalized.value)),
      normalized.value,
    );
  }
  const sorted = [...byKey.entries()]
    .sort(compareEntries)
    .map((entry) => entry[1]);
  return { ok: true, value: sorted };
}

function normalizePolicy(
  policy: FlowPolicyInput,
): Result<CanonicalFlowPolicy, FlowLabelError> {
  if (
    !isRecord(policy) ||
    !isRecord(policy.owner) ||
    !Array.isArray(policy.readers)
  )
    return invalidPolicy("shape");
  const owner = normalizeOwner(policy.owner);
  if (!owner.ok) return owner;
  if (policy.readers.length === 0) return invalidPolicy("readers");
  const readers: ContextVisibility[] = [];
  for (const reader of policy.readers) {
    const parsed = parseContextVisibility(reader);
    if (!parsed.ok) return invalidPolicy(`readers.${parsed.error.field}`);
    readers.push(parsed.value);
  }
  if (
    policy.level !== undefined &&
    policy.level !== "private" &&
    policy.level !== "internal"
  )
    return invalidPolicy("level");
  return {
    ok: true,
    value: Object.freeze({
      owner: owner.value,
      readers: Object.freeze(normalizeReaders(readers)),
      ...(policy.level === undefined ? {} : { level: policy.level }),
    }),
  };
}

function normalizeOwner(
  owner: FlowPolicyOwner,
): Result<FlowPolicyOwner, FlowLabelError> {
  if (!isRecord(owner) || typeof owner.kind !== "string")
    return invalidPolicy("owner.kind");
  switch (owner.kind) {
    case "recipient_constraint": {
      const recipient = parseFlowRecipient(owner.recipient);
      return recipient !== null &&
        owner.organisationId === recipient.organisationId
        ? {
            ok: true,
            value: Object.freeze({
              kind: "recipient_constraint",
              organisationId: recipient.organisationId,
              recipient,
            }),
          }
        : invalidPolicy("owner.recipient");
    }
    case "platform":
      return { ok: true, value: Object.freeze({ kind: "platform" }) };
    case "organisation":
      return isNonBlankString(owner.organisationId)
        ? {
            ok: true,
            value: Object.freeze({
              kind: "organisation",
              organisationId: owner.organisationId,
            }),
          }
        : invalidPolicy("owner.organisationId");
    case "integration_resource":
      return isNonBlankString(owner.organisationId) &&
        isNonBlankString(owner.integrationAccountId) &&
        isNonBlankString(owner.resourceScope)
        ? {
            ok: true,
            value: Object.freeze({
              kind: "integration_resource",
              organisationId: owner.organisationId,
              integrationAccountId: owner.integrationAccountId,
              resourceScope: owner.resourceScope,
            }),
          }
        : invalidPolicy("owner.integration_resource");
    default:
      return invalidPolicy("owner.kind");
  }
}

function normalizeReaders<Reader extends ContextVisibility>(
  readers: readonly Reader[],
): readonly Reader[] {
  const byKey = new Map<string, Reader>();
  for (const reader of readers) byKey.set(readerKey(reader), reader);
  return [...byKey.entries()]
    .sort(compareEntries)
    .map((entry) => Object.freeze(entry[1]));
}

function canonicalPolicies(
  policies: readonly CanonicalFlowPolicy[],
): readonly SerializedFlowPolicy[] {
  return policies.map(canonicalPolicy);
}

function canonicalPolicy(policy: CanonicalFlowPolicy): SerializedFlowPolicy {
  return {
    owner: canonicalOwner(policy.owner),
    readers: policy.readers.map(canonicalReader),
    // A policy with no level keeps the digest that it was stored with.
    ...(policy.level === undefined ? {} : { level: policy.level }),
  };
}

function canonicalOwner(owner: FlowPolicyOwner): FlowPolicyOwner {
  switch (owner.kind) {
    case "recipient_constraint":
      return {
        kind: owner.kind,
        organisationId: owner.organisationId,
        recipient: owner.recipient,
      };
    case "platform":
      return { kind: owner.kind };
    case "organisation":
      return { kind: owner.kind, organisationId: owner.organisationId };
    case "integration_resource":
      return {
        kind: owner.kind,
        organisationId: owner.organisationId,
        integrationAccountId: owner.integrationAccountId,
        resourceScope: owner.resourceScope,
      };
  }
}

export function parseFlowRecipient(raw: unknown): FlowRecipient | null {
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 11 ||
    !isNonBlankString(raw.organisationId) ||
    !isNonBlankString(raw.merchantId) ||
    !isNonBlankString(raw.integrationAccountId) ||
    !isNonBlankString(raw.partyId) ||
    !isNonBlankString(raw.contactId) ||
    !isPositiveInteger(raw.contactRevision) ||
    !isNonBlankString(raw.verificationId) ||
    !isPositiveInteger(raw.verificationRevision) ||
    !isSha256Hex(raw.endpointDigest) ||
    !(
      (raw.partyKind === "supplier" && raw.purpose === "supplier_reply") ||
      (raw.partyKind === "customer" && raw.purpose === "customer_reply")
    )
  )
    return null;
  const fields = {
    organisationId: raw.organisationId,
    merchantId: raw.merchantId,
    integrationAccountId: raw.integrationAccountId,
    partyId: raw.partyId,
    contactId: raw.contactId,
    contactRevision: raw.contactRevision,
    verificationId: raw.verificationId,
    verificationRevision: raw.verificationRevision,
    endpointDigest: raw.endpointDigest,
  };
  return raw.partyKind === "supplier"
    ? Object.freeze({
        ...fields,
        partyKind: "supplier",
        purpose: "supplier_reply",
      })
    : Object.freeze({
        ...fields,
        partyKind: "customer",
        purpose: "customer_reply",
      });
}

export function labelAllowsRecipient(
  label: FlowLabel,
  recipient: FlowRecipient | null,
): boolean {
  for (const policy of label.policies) {
    if (policy.owner.kind !== "recipient_constraint") continue;
    const parsed = parseFlowRecipient(recipient);
    if (
      parsed === null ||
      JSON.stringify(policy.owner.recipient) !== JSON.stringify(parsed)
    )
      return false;
  }
  return true;
}

function canonicalReader(reader: ContextVisibility): SerializedFlowReader {
  switch (reader.kind) {
    case "project":
      return {
        kind: reader.kind,
        organisationId: reader.organisationId,
        projectId: reader.projectId,
      };
    case "chat_conversation":
      return {
        kind: reader.kind,
        organisationId: reader.organisationId,
        conversationId: reader.conversationId,
      };
    case "organisation_role":
      return { kind: reader.kind, role: reader.role };
    case "person":
      return { kind: reader.kind, personId: reader.personId };
    case "conversation":
      return {
        kind: reader.kind,
        integrationAccountId: reader.integrationAccountId,
        conversationId: reader.conversationId,
      };
    case "case":
      return { kind: reader.kind, caseId: reader.caseId };
    case "workflow":
      return {
        kind: reader.kind,
        workflowKind: reader.workflowKind,
        workflowId: reader.workflowId,
        workflowRevision: reader.workflowRevision,
      };
    case "agent_mailbox":
      return {
        kind: reader.kind,
        integrationAccountId: reader.integrationAccountId,
        mailboxBindingId: reader.mailboxBindingId,
        bindingRevision: reader.bindingRevision,
      };
    case "whatsapp_support":
      return {
        kind: reader.kind,
        integrationAccountId: reader.integrationAccountId,
        supportBindingId: reader.supportBindingId,
        bindingRevision: reader.bindingRevision,
      };
    default:
      return assertNever(reader, "unhandled flow reader");
  }
}

function readerKey(reader: ContextVisibility): string {
  return JSON.stringify(canonicalReader(reader));
}

function freezeJsonValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) freezeJsonValue(item);
    Object.freeze(value);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) freezeJsonValue(item);
    Object.freeze(value);
  }
}

function compareEntries<T>(
  left: readonly [string, T],
  right: readonly [string, T],
): number {
  return compareStrings(left[0], right[0]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidPolicy(field: string): Result<never, FlowLabelError> {
  return { ok: false, error: { code: "invalid_flow_policy", field } };
}

function invalidLabel(field: string): Result<never, FlowLabelError> {
  return { ok: false, error: { code: "invalid_flow_label", field } };
}
