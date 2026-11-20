import type { OrganisationDatabase } from "../../database-handles";
import { nativeChatAudienceMatchesAuthority } from "./native-audience";
import { digestCanonical } from "./digest";
import {
  audiencesForDestination,
  labelAllowsAudiences,
  policyAllowsAudiences,
  labelAllowsRecipient,
  parseFlowRecipient,
  policyLevel,
  type FlowLabel,
} from "./labels";
import { digestFlowBinding, type FlowBinding } from "./oac";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import type {
  CanonicalFlowPolicy,
  ConversationDeliverySink,
  FlowAudience,
  FlowDecision,
  FlowDecisionReason,
  FlowLabelDecision,
  FlowRecipient,
  FlowSink,
  ToolEffectSink,
} from "./types";
import type { Variant } from "@purin-labs/type-utils";
import {
  decideOrganisationToolEffect,
  readCurrentOrganisationAuthz,
  type CurrentOrganisationAuthz,
} from "./organisation-authz";
import { parseOrganisationId } from "../../ids";
import type { Result } from "../../result";

/** The audience of an effect that every member of the Organisation reads. */
const EVERY_ROLE: readonly FlowAudience[] = [
  { kind: "organisation_role", role: "owner" },
  { kind: "organisation_role", role: "admin" },
  { kind: "organisation_role", role: "operator" },
  { kind: "organisation_role", role: "viewer" },
];

/** A sink that can never be a tool effect, so no capability rule meets it. */
type SinkWithoutToolEffect =
  | Exclude<FlowSink, { kind: "native_chat" | "tool_effect" }>
  | Readonly<{
      kind: "native_chat";
      audience: Variant<FlowSink, "native_chat">["audience"];
      sink: Exclude<
        Variant<FlowSink, "native_chat">["sink"],
        { kind: "tool_effect" }
      >;
    }>;

/**
 * A sink check. A sink that can be a tool effect carries the organisation's
 * current capability rules, and every tool effect meets them whatever the
 * label holds. See `organisation-authz.ts`.
 */
export type FlowSinkCheck =
  | Readonly<{
      readonly flowLabel: FlowLabel;
      readonly sink: FlowSink;
      readonly organisationAuthz: CurrentOrganisationAuthz;
    }>
  | Readonly<{
      readonly flowLabel: FlowLabel;
      readonly sink: SinkWithoutToolEffect;
      readonly organisationAuthz: null;
    }>;

/**
 * Builds a sink check from the current policy of the organisation that the
 * effect's authority belongs to. It reads the policy only for a sink that can
 * be a tool effect.
 */
export async function currentFlowSinkCheck(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly flowLabel: FlowLabel;
    readonly sink: FlowSink;
  }>,
): Promise<Result<FlowSinkCheck, string>> {
  if (isSinkWithoutToolEffect(input.sink))
    return {
      ok: true,
      value: {
        flowLabel: input.flowLabel,
        sink: input.sink,
        organisationAuthz: null,
      },
    };
  const effect =
    input.sink.kind === "native_chat" ? input.sink.sink : input.sink;
  const organisationId = parseOrganisationId(
    effect.destinationAuthority.organisationId,
  );
  if (!organisationId.ok)
    return { ok: false, error: "organisation_id_invalid" };
  const organisationAuthz = await readCurrentOrganisationAuthz(
    input.db,
    organisationId.value,
  );
  if (!organisationAuthz.ok) return organisationAuthz;
  return {
    ok: true,
    value: {
      flowLabel: input.flowLabel,
      sink: input.sink,
      organisationAuthz: organisationAuthz.value,
    },
  };
}

function isSinkWithoutToolEffect(
  sink: FlowSink,
): sink is SinkWithoutToolEffect {
  return (
    sink.kind !== "tool_effect" &&
    (sink.kind !== "native_chat" || sink.sink.kind !== "tool_effect")
  );
}

export function evaluateFlowLabelSink(input: FlowSinkCheck): FlowLabelDecision {
  const sink: Exclude<FlowSink, { kind: "native_chat" }> =
    input.sink.kind === "native_chat" ? input.sink.sink : input.sink;
  if (
    input.sink.kind === "native_chat" &&
    !nativeChatAudienceMatchesAuthority(
      input.sink.audience,
      input.sink.sink.destinationAuthority,
    )
  ) {
    return {
      kind: "deny",
      reason: audienceNotPermittedReason(),
      violationAction: "deny",
    };
  }
  const audiences =
    sink.kind === "tool_effect" && sink.readByEveryMember !== undefined
      ? [...EVERY_ROLE, ...sink.readByEveryMember.sharedWith]
      : input.sink.kind === "native_chat"
        ? input.sink.audience.readers
        : sink.kind === "typesafe_system_one"
          ? sink.processing.kind === "public_fixture"
            ? []
            : audiencesForDestination(sink.processing.authority)
          : audiencesForDestination(sink.destinationAuthority);
  if (
    sink.kind === "typesafe_system_one" &&
    !validTypeSafeSink(input.flowLabel, sink)
  ) {
    return {
      kind: "deny",
      reason: audienceNotPermittedReason(),
      violationAction: "deny",
    };
  }
  // A model call keeps its own reader rule. Each other sink is an exit, and
  // meets the levels (Plan 27C).
  if (sink.kind === "typesafe_system_one") {
    if (
      !labelAllowsAudiences(input.flowLabel, audiences) ||
      !labelAllowsRecipient(input.flowLabel, null)
    )
      return {
        kind: "deny",
        reason: audienceNotPermittedReason(),
        violationAction: "deny",
      };
    return { kind: "allow" };
  }
  const exit = decideExit(input.flowLabel, audiences, sink);
  if (exit.kind !== "allow") return exit;
  if (sink.kind !== "tool_effect") return { kind: "allow" };
  // The check type gives every tool effect the current rules.
  if (input.organisationAuthz === null)
    return {
      kind: "deny",
      reason: audienceNotPermittedReason(),
      violationAction: "deny",
    };
  const rules = decideOrganisationToolEffect(input.organisationAuthz, sink);
  if (rules.kind !== "allow") return rules;
  return decideWriter(input.flowLabel, sink);
}

/**
 * The writer rule of a tool effect (Plan 89). A Session that read free text of
 * a person outside the Organisation may hold an instruction that no member
 * gave. So an effect with a consequence asks a person, who sees the action.
 * It runs after the reader rule and the Organisation's rules, so a block of
 * those wins.
 */
function decideWriter(
  label: FlowLabel,
  sink: ToolEffectSink,
): FlowLabelDecision {
  if (!toolEffectAsksAfterOutsideText(label, sink)) return { kind: "allow" };
  return {
    kind: "approval_required",
    reason: {
      code: "outside_written",
      ruleId: null,
      reasonCode: "aifc.outside_written",
    },
  };
}

export async function decideFlowSink(
  input: DistributiveOmit<FlowSinkCheck, "flowLabel"> &
    Readonly<{ readonly binding: FlowBinding }>,
): Promise<FlowDecision> {
  const flowBindingDigest = await digestFlowBinding(input.binding);
  const evaluated = evaluateFlowLabelSink(
    input.organisationAuthz === null
      ? {
          flowLabel: input.binding.flowLabel,
          sink: input.sink,
          organisationAuthz: null,
        }
      : {
          flowLabel: input.binding.flowLabel,
          sink: input.sink,
          organisationAuthz: input.organisationAuthz,
        },
  );
  const decisionDigest = await computeDecisionDigest(
    evaluated.kind,
    flowBindingDigest,
    input.sink,
    evaluated.kind === "allow" ? null : evaluated.reason,
  );
  switch (evaluated.kind) {
    case "allow":
      return { kind: "allow", flowBindingDigest, decisionDigest };
    case "approval_required":
      return {
        kind: "approval_required",
        flowBindingDigest,
        decisionDigest,
        reason: evaluated.reason,
      };
    case "deny":
      return {
        kind: "deny",
        flowBindingDigest,
        decisionDigest,
        reason: evaluated.reason,
        violationAction: evaluated.violationAction,
      };
  }
}

/**
 * The digests of a delivery that a person approved after the exit check
 * stopped it. The receipt names the request, so that it can be traced to the
 * person's decision.
 */
export async function approvedOutputDecision(
  binding: FlowBinding,
  requestId: string,
): Promise<Readonly<{ flowBindingDigest: string; decisionDigest: string }>> {
  const flowBindingDigest = await digestFlowBinding(binding);
  return {
    flowBindingDigest,
    decisionDigest: await digestCanonical({
      effect: "approved",
      flowBindingDigest,
      requestId,
    }),
  };
}

/**
 * The level rule of an exit. Content that names the destination as a reader
 * goes there, so an answer may always return to its own conversation, mailbox
 * or WhatsApp line. Other private content goes nowhere. Other internal content
 * goes everywhere inside the Organisation, and needs approval to go outside.
 */
function decideExit(
  label: FlowLabel,
  audiences: readonly FlowAudience[],
  sink: ConversationDeliverySink | ToolEffectSink,
): FlowLabelDecision {
  const recipientBound = sinkSendsToRecipient(sink);
  const outside = sinkReachesOutside(sink);
  const otherService =
    outside &&
    sink.kind === "tool_effect" &&
    OTHER_SERVICE_CAPABILITIES.has(sink.capabilityId);
  let needsApproval = false;
  for (const policy of label.policies) {
    if (policy.owner.kind === "recipient_constraint") {
      if (recipientBound && !isBoundRecipient(policy.owner.recipient, sink))
        return {
          kind: "deny",
          reason: {
            code: "audience_not_permitted",
            ruleId: null,
            reasonCode: "aifc.other_recipient",
          },
          violationAction: "deny",
        };
      continue;
    }
    const level = policyLevel(policy);
    if (otherService && level === "internal") {
      if (cameFromDestination(policy, sink)) continue;
    } else if (policyAllowsAudiences(policy, audiences)) continue;
    if (level === "private") return denied();
    if (outside) needsApproval = true;
  }
  return needsApproval
    ? {
        kind: "approval_required",
        reason: {
          code: "audience_not_permitted",
          ruleId: null,
          reasonCode: "aifc.outside_organisation",
        },
      }
    : { kind: "allow" };
}

/**
 * The capabilities whose effect stays inside the Organisation or its connected
 * tools. `pnpm lint:ifc-boundaries` refuses a tool effect whose capability is in
 * no class set here.
 */
export const INSIDE_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_KEYS.commerceProductDescriptionDraftEdit,
  CAPABILITY_KEYS.commerceMenuDraftEdit,
  CAPABILITY_KEYS.commerceProductionPlanEdit,
  CAPABILITY_KEYS.commerceWorkflowCanvasMove,
  CAPABILITY_KEYS.commerceOrderQueueAdvance,
  CAPABILITY_KEYS.commerceSoldOutMark,
  CAPABILITY_KEYS.commerceRecipeSave,
  CAPABILITY_KEYS.commerceSupplyCostSave,
  CAPABILITY_KEYS.commerceSupplierCreate,
  CAPABILITY_KEYS.devicePause,
  CAPABILITY_KEYS.customConnectorDraft,
  CAPABILITY_KEYS.marketingEmailDraftEdit,
  CAPABILITY_KEYS.messageLinkRead,
  "commerce.action.propose",
  "custom_connector.read",
]);

/**
 * Whether the writer rule asks for this effect. A caller that let an effect
 * pass a reader block with a person's approval uses it, because that approval
 * did not show the action.
 */
export function toolEffectAsksAfterOutsideText(
  label: FlowLabel,
  sink: ToolEffectSink,
): boolean {
  return (
    label.writer === "outside" &&
    !sink.approvalSatisfied &&
    !PASSES_AFTER_OUTSIDE_TEXT.has(sink.capabilityId)
  );
}

/**
 * The capabilities whose effect passes in a Session that read outside-written
 * text (Plan 89): a read, or a step that waits for a person's own review of
 * the exact content before anything changes. Each other capability asks, so a
 * new capability asks until a person adds it here.
 */
const PASSES_AFTER_OUTSIDE_TEXT: ReadonlySet<string> = new Set([
  // A person reads each email and each Slack message before it leaves.
  CAPABILITY_KEYS.emailReplyPropose,
  CAPABILITY_KEYS.emailOperationalPropose,
  CAPABILITY_KEYS.slackMessagePropose,
  CAPABILITY_KEYS.marketingEmailDraftEdit,
  // A person confirms a proposal on its card, and reviews a connector write.
  "commerce.action.propose",
  CAPABILITY_KEYS.customConnectorDraft,
  "custom_connector.write",
  // Reads. A link read fetches only a link that the person's message holds.
  "custom_connector.read",
  CAPABILITY_KEYS.messageLinkRead,
]);

/**
 * A capability that sends to one verified recipient, as a person approved. A
 * person reads each email before it leaves, so a label bound to a recipient
 * is the only rule that it meets here.
 */
const RECIPIENT_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_KEYS.emailReplyPropose,
  CAPABILITY_KEYS.emailOperationalPropose,
  CAPABILITY_KEYS.whatsappSupportReplySend,
]);

/** A capability that shows its content outside the Organisation. */
const OUTSIDE_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_KEYS.whatsappSupportReplySend,
  CAPABILITY_KEYS.commerceCatalogPublish,
  CAPABILITY_KEYS.commerceCatalogUpdateDescription,
]);

/**
 * A capability that writes to another company's service. The person who acts
 * does not read it there, so their role passes no internal content to it. A
 * person's own words and their conversation's words still go with the request.
 */
const OTHER_SERVICE_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_KEYS.airtableApiWrite,
  "custom_connector.write",
]);

/** Content that the effect's own resource holds does not leave it. */
function cameFromDestination(
  policy: CanonicalFlowPolicy,
  sink: ConversationDeliverySink | ToolEffectSink,
): boolean {
  return (
    sink.kind === "tool_effect" &&
    policy.owner.kind === "integration_resource" &&
    policy.owner.integrationAccountId === sink.integrationAccountId &&
    policy.owner.resourceScope === sink.resourceScope
  );
}

function sinkSendsToRecipient(
  sink: ConversationDeliverySink | ToolEffectSink,
): boolean {
  return (
    sink.kind === "tool_effect" &&
    (sink.recipient !== undefined ||
      RECIPIENT_CAPABILITIES.has(sink.capabilityId))
  );
}

function sinkReachesOutside(
  sink: ConversationDeliverySink | ToolEffectSink,
): boolean {
  return sink.kind === "conversation_delivery"
    ? sink.reachesOutside === true
    : (OUTSIDE_CAPABILITIES.has(sink.capabilityId) ||
        OTHER_SERVICE_CAPABILITIES.has(sink.capabilityId)) &&
        !sink.approvalSatisfied;
}

function isBoundRecipient(
  bound: FlowRecipient,
  sink: ConversationDeliverySink | ToolEffectSink,
): boolean {
  if (sink.kind !== "tool_effect") return false;
  const named = parseFlowRecipient(sink.recipient ?? null);
  return named !== null && JSON.stringify(named) === JSON.stringify(bound);
}

function denied(): FlowLabelDecision {
  return {
    kind: "deny",
    reason: audienceNotPermittedReason(),
    violationAction: "deny",
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function validTypeSafeSink(
  label: FlowLabel,
  sink: Variant<FlowSink, "typesafe_system_one">,
): boolean {
  if (
    sink.organisationId.length === 0 ||
    (sink.funding.kind !== "satyr_platform" &&
      (sink.funding.kind !== "organisation_byo" ||
        !Number.isSafeInteger(sink.funding.connectionRevision) ||
        sink.funding.connectionRevision < 1))
  )
    return false;
  if (sink.processing.kind === "public_fixture") {
    if (
      !Number.isSafeInteger(sink.processing.fixtureRevision) ||
      sink.processing.fixtureRevision < 1 ||
      label.policies.length !== 0
    )
      return false;
  } else if (
    sink.processing.authority.organisationId !== sink.organisationId ||
    label.policies.length === 0
  )
    return false;
  for (const policy of label.policies) {
    if (
      policy.owner.kind !== "platform" &&
      policy.owner.organisationId !== sink.organisationId
    )
      return false;
  }
  return true;
}

function audienceNotPermittedReason(): FlowDecisionReason {
  return {
    code: "audience_not_permitted",
    ruleId: null,
    reasonCode: "aifc.audience_not_permitted",
  };
}

async function computeDecisionDigest(
  effect: FlowDecision["kind"],
  flowBindingDigest: string,
  sink: FlowSink,
  reason: FlowDecisionReason | null,
): Promise<string> {
  return digestCanonical({ effect, flowBindingDigest, sink, reason });
}

/**
 * Why a flow may not reach the conversation of a channel. The Connector, the
 * Session and the commerce delivery ask for this decision.
 */
export type CaseConversationSinkRefusal = {
  readonly code:
    | "case_flow_authority_partition_changed"
    | "case_flow_destination_invalid"
    | "case_flow_destination_mismatch"
    | `case_flow_sink_${Exclude<FlowDecision["kind"], "allow">}`;
};

/**
 * The refusals that a person can answer (Plan 27C). The level rule stopped
 * the output, so it waits for approval. Other refusals, such as a changed
 * authority, stay final.
 */
export function sinkRefusalAsksPerson(code: string): boolean {
  return (
    code === "case_flow_sink_deny" ||
    code === "case_flow_sink_approval_required"
  );
}
