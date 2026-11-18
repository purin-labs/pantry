import type { WorkflowChangeCommand } from "../commerce/bakery/workflow-proposals";
import type {
  AgentOperationInput,
  AgentOperationsSnapshot,
} from "../data/agent-operations";
import type {
  OperatorConfigurationDraft,
  DeviceDraftCommand,
  OperatorDraftCommand,
} from "../data/operator-configuration-draft";
import type { OfferPriceAllowanceCommand } from "../data/offer-price-allowance";
import { presentJevDraftCommand } from "../jev-features/agent-draft";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

/**
 * How one configuration command is presented to an operator.
 *
 * Every field is required, which is the parity guarantee: a command that the
 * Portal can submit but that nobody wrote a Slack action label for will not
 * compile, so the two surfaces cannot drift apart silently.
 */
export type ConfigurationCommandPresentation = Readonly<{
  /** What this change is, in the operator's terms. */
  summary: string;
  /** The button or reply that accepts it. Names the change, never "Confirm". */
  actionLabel: string;
  /** What actually changes as a result, including what does not. */
  consequence: string;
  /** The Portal section holding the same control. */
  portalSection:
    "overview" | "instructions" | "tools" | "triggers" | "limits" | "pricing";
}>;

/** Presents staged changes; agent-operation coverage is checked exhaustively. */
export function presentConfigurationCommand(
  draft: OperatorDraftCommand,
): ConfigurationCommandPresentation {
  if (draft.family === "device_command")
    return presentDeviceCommand(draft.command);
  if (draft.family === "jev_feature")
    return {
      ...presentJevDraftCommand(draft.command),
      portalSection: "overview",
    };
  if (draft.family === "workflow_change")
    return presentWorkflowChange(draft.change);
  return draft.family === "offer_price_allowance"
    ? presentOfferPriceAllowance(draft.allowance)
    : presentAgentOperation(draft.operation);
}

/** The words about the change come from the diff. Only the reason is the agent's. */
function presentWorkflowChange(
  command: WorkflowChangeCommand,
): ConfigurationCommandPresentation {
  const parts = [];
  const { added, changed, removed, arrows } = command.change;
  if (added.length > 0) parts.push(`add ${added.join(", ")}`);
  if (changed.length > 0) parts.push(`change ${changed.join(", ")}`);
  if (removed.length > 0) parts.push(`remove ${removed.join(", ")}`);
  if (arrows > 0) parts.push(`${arrows} changed arrows`);
  return {
    summary: `${command.title}: ${parts.join("; ")}. Reason: ${command.reason}.`,
    actionLabel: "Approve workflow change",
    consequence:
      "Seams Pantry writes a new revision of this recipe, and new runs use it. Every member can then read its step names. A run that started keeps its revision.",
    portalSection: "overview",
  };
}

/** A device change names the device that a person confirmed. */
function presentDeviceCommand(
  command: DeviceDraftCommand,
): ConfigurationCommandPresentation {
  return command.kind === "device_restrict"
    ? {
        summary: `Restrict ${command.deviceName}. Reason: ${command.reason}.`,
        actionLabel: "Restrict device",
        consequence:
          "Seams Pantry sends it no new task until an admin lifts this. A task that runs now continues.",
        portalSection: "overview",
      }
    : {
        summary: `Resume ${command.deviceName}.`,
        actionLabel: "Resume device",
        consequence:
          "Check that the area around it is clear. Seams Pantry can send it new tasks after this.",
        portalSection: "overview",
      };
}

/** An allowance names the offer and the band, because both bear the risk. */
function presentOfferPriceAllowance(
  command: OfferPriceAllowanceCommand,
): ConfigurationCommandPresentation {
  if (command.kind === "withdraw_offer_price_allowance") {
    return {
      summary: `Withdraw the price allowance on ${command.offerId}.`,
      actionLabel: "Withdraw price allowance",
      consequence:
        "The price stops changing without a fresh decision. Prices already " +
        "committed stay as they are.",
      portalSection: "pricing",
    };
  }
  let consequence: string;
  if (command.expectedOfferRevision === undefined) {
    consequence =
      "The band is measured from the price at the moment this is confirmed, " +
      "so repeated small changes cannot walk the price away from it.";
  } else {
    consequence =
      "The band is measured from that price. If the price changes before " +
      "you confirm, this is refused rather than measured from a price you " +
      "did not see.";
  }
  return {
    summary: `Allow the price of ${command.offerId} to move up to ${(
      command.maxMovementBps / 100
    ).toFixed(2)}% from ${allowanceReference(command)}.`,
    actionLabel: "Save price allowance",
    consequence,
    portalSection: "pricing",
  };
}

/** The price a preview names, formatted at the currency's own exponent. */
function allowanceReference(
  command: Variant<OfferPriceAllowanceCommand, "set_offer_price_allowance">,
): string {
  if (
    command.referencePriceMinor === undefined ||
    command.currency === undefined
  ) {
    return "the price it is at now";
  }
  try {
    const format = new Intl.NumberFormat("en", {
      style: "currency",
      currency: command.currency,
      currencyDisplay: "code",
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(command.referencePriceMinor / 10 ** digits);
  } catch {
    return `${command.referencePriceMinor} ${command.currency}`;
  }
}

function presentAgentOperation(
  command: AgentOperationInput,
): ConfigurationCommandPresentation {
  switch (command.kind) {
    case "create_area":
      return {
        summary: `Create the area "${command.name}".`,
        actionLabel: "Create area",
        consequence: "An area groups related work. Creating one runs no agent.",
        portalSection: "overview",
      };
    case "publish_responsibility_scope":
      return {
        summary: "Publish a responsibility scope for this area.",
        actionLabel: "Publish scope",
        consequence:
          "Scopes decide which records an agent may be pointed at. This grants no access on its own.",
        portalSection: "tools",
      };
    case "create_skill":
      return {
        summary: `Create the skill "${command.title}".\n\n${excerpt(command.markdownBody)}`,
        actionLabel: "Create skill",
        consequence:
          "The skill exists but no agent follows it until a version attaching it is published and activated.",
        portalSection: "instructions",
      };
    case "publish_skill_revision":
      return {
        summary: `Publish version ${command.expectedRevision + 1} of this skill.\n\n${excerpt(command.markdownBody)}`,
        actionLabel: "Publish skill",
        consequence:
          "Agents keep running the version they were activated with until you activate the new one.",
        portalSection: "instructions",
      };
    case "create_agent_definition":
      return {
        summary:
          `Create the agent "${command.displayName}".\n\n` +
          `Instructions: ${excerpt(command.instructions)}\n` +
          `Requests access to: ${command.requestedCapabilities.length === 0 ? "nothing" : command.requestedCapabilities.join(", ")}`,
        actionLabel: "Create agent",
        consequence:
          "The agent exists but does no work until it is assigned and given access.",
        portalSection: "overview",
      };
    case "publish_agent_definition_revision":
      return {
        summary:
          `Publish version ${command.expectedRevision + 1} of this agent's instructions and skills.\n\n` +
          `Instructions: ${excerpt(command.instructions)}\n` +
          `Skills: ${command.skillRefs.length === 0 ? "none" : command.skillRefs.map((ref) => ref.skillId).join(", ")}`,
        actionLabel: "Publish instructions",
        consequence:
          "Publishing records a version. Running work is unchanged until you activate it.",
        portalSection: "instructions",
      };
    case "activate_agent_definition_revision":
      return {
        summary: `Put version ${command.definitionRevision} into use for this assignment.`,
        actionLabel: "Activate update",
        consequence:
          "New work uses this version. Conversations already under way keep the version they started with.",
        portalSection: "instructions",
      };
    case "install_agent":
      return {
        summary:
          "Assign this agent to an area with the access listed.\n\n" +
          `Access: ${command.grantedCapabilities.length === 0 ? "none" : command.grantedCapabilities.join(", ")}`,
        actionLabel: "Assign agent",
        consequence:
          "The agent can read what you grant here, and nothing else.",
        portalSection: "tools",
      };
    case "bind_skill":
      return {
        summary: "Attach this skill to the area.",
        actionLabel: "Attach area skill",
        consequence:
          "Agents working in this area follow the skill alongside their own instructions.",
        portalSection: "instructions",
      };
    case "configure_cue_binding":
      return {
        summary: `Have the agent respond to ${command.cueEventType} from ${command.cueSource}.`,
        actionLabel: command.enabled
          ? "Turn on signal trigger"
          : "Save signal trigger",
        consequence:
          "Each matching signal starts one run against this assignment's budget.",
        portalSection: "triggers",
      };
    case "configure_schedule_binding":
      return {
        summary: `Run the agent ${describeSchedule(command.spec)}.`,
        actionLabel: command.enabled ? "Turn on schedule" : "Save schedule",
        consequence:
          "Each occurrence starts one run against this assignment's budget. Missed windows are not backfilled.",
        portalSection: "triggers",
      };
    case "update_cue_binding":
      return {
        summary: command.enabled
          ? "Turn this signal trigger on."
          : "Turn this signal trigger off.",
        actionLabel: command.enabled
          ? "Turn on signal trigger"
          : "Turn off signal trigger",
        consequence: command.enabled
          ? "Matching signals start runs again from the next one."
          : "Matching signals stop starting runs. Work already under way finishes.",
        portalSection: "triggers",
      };
    case "update_schedule_binding":
      return {
        summary: command.enabled
          ? "Turn this schedule on."
          : "Turn this schedule off.",
        actionLabel: command.enabled ? "Turn on schedule" : "Turn off schedule",
        consequence: command.enabled
          ? "Runs resume from the next occurrence. Windows missed while off are not backfilled."
          : "No further runs start. Work already under way finishes.",
        portalSection: "triggers",
      };
    case "configure_installation_governance":
      return {
        summary: `Allow at most ${formatCount(command.maxSessionBudgetTokens)} tokens per run.`,
        actionLabel: "Save limits",
        consequence:
          "A run that reaches the limit stops and reports what it had done.",
        portalSection: "limits",
      };
    case "configure_escalation_policy":
      return {
        summary:
          "Change when approvals are chased and escalated.\n\n" +
          `Remind after ${formatDuration(command.approvalReminderAfterMs)}, ` +
          `escalate after ${formatDuration(command.escalateAfterMs)}.`,
        // Distinct from the budget limit, which also reads as "Save limits".
        actionLabel: "Save escalation timing",
        consequence:
          "Only reminder timing changes. Who may approve is unchanged.",
        portalSection: "limits",
      };
    case "accept_configuration_proposal":
      return {
        summary:
          "Accept the change the agent suggested to its own instructions.",
        actionLabel: "Accept change",
        consequence:
          "This publishes a version. Running work is unchanged until you activate it.",
        portalSection: "instructions",
      };
    case "dismiss_configuration_proposal":
      return {
        summary: "Dismiss the change the agent suggested.",
        actionLabel: "Dismiss",
        consequence: "The suggestion is closed. Nothing else changes.",
        portalSection: "instructions",
      };
    case "dispatch_manual_run":
      return {
        summary: `Run the agent once now with this instruction.\n\n${excerpt(command.instructionBody)}`,
        actionLabel: "Run now",
        consequence: "One run starts against this assignment's budget.",
        portalSection: "overview",
      };
    default:
      return assertNever(command);
  }
}

/**
 * The three stable Slack message shapes.
 *
 * Text only: Slack delivery in this runtime posts one message per turn with no
 * interactive components, so a preview names its action in words and the
 * operator confirms by replying with it.
 */
export type SlackConfigurationMessage =
  | Readonly<{ kind: "summary"; text: string }>
  | Readonly<{
      kind: "preview";
      text: string;
      actionLabel: string;
      draftId: string;
    }>
  | Readonly<{ kind: "receipt"; text: string }>;

/** The current setup, with the Portal link for anything not shown here. */
export function renderConfigurationSummary(
  input: Readonly<{
    snapshot: AgentOperationsSnapshot;
    agentDefinitionId: string;
    portalUrl: string;
  }>,
): SlackConfigurationMessage {
  const definition = input.snapshot.definitions.find(
    (entry) => entry.agentDefinitionId === input.agentDefinitionId,
  );
  if (definition === undefined) {
    return {
      kind: "summary",
      text: `That agent is not set up yet. ${input.portalUrl}`,
    };
  }
  const installations = input.snapshot.installations.filter(
    (entry) =>
      entry.agentDefinitionId === input.agentDefinitionId &&
      entry.lifecycle === "active",
  );
  const behind = installations.filter(
    (entry) => entry.definitionRevision !== definition.currentRevision.revision,
  );
  const schedules = input.snapshot.scheduleBindings.filter((binding) =>
    installations.some(
      (entry) => entry.installationId === binding.installationId,
    ),
  );
  const lines = [
    `*${definition.displayName}* — ${definition.purpose}`,
    `Published version ${definition.currentRevision.revision}.` +
      (behind.length === 0
        ? " Every assignment is running it."
        : ` ${formatCount(behind.length)} assignment${behind.length === 1 ? "" : "s"} still on an earlier version.`),
    installations.length === 0
      ? "Not assigned anywhere yet."
      : `Assigned in ${formatCount(installations.length)} place${installations.length === 1 ? "" : "s"}.`,
    schedules.length === 0
      ? "No schedules."
      : `${formatCount(schedules.filter((binding) => binding.enabled).length)} schedule${schedules.length === 1 ? "" : "s"} on.`,
    input.portalUrl,
  ];
  return { kind: "summary", text: lines.join("\n") };
}

/**
 * A short code identifying the exact change a preview showed.
 *
 * The operator repeats it when accepting, which is what ties their reply to
 * the change they read. Without it a reply to an older preview would accept
 * whatever change happens to be pending when it arrives.
 */
export function previewCode(commandDigest: string): string {
  return commandDigest.slice(0, 6).toUpperCase();
}

/** What a change would do, and the exact words that accept it. */
export function renderConfigurationPreview(
  draft: OperatorConfigurationDraft,
): SlackConfigurationMessage {
  const presentation = presentConfigurationCommand(draft.command);
  const code = previewCode(draft.commandDigest);
  return {
    kind: "preview",
    draftId: draft.draftId,
    actionLabel: `${presentation.actionLabel} ${code}`,
    text: [
      presentation.summary,
      "",
      presentation.consequence,
      "",
      `Reply *${presentation.actionLabel} ${code}* to go ahead, or *Cancel* to drop it.`,
    ].join("\n"),
  };
}

/** What happened, with where to see it. */
export function renderConfigurationReceipt(
  input: Readonly<{
    draft: OperatorConfigurationDraft;
    portalUrl: string;
    at: number;
  }>,
): SlackConfigurationMessage {
  const presentation = presentConfigurationCommand(input.draft.command);
  return {
    kind: "receipt",
    text: [
      `Done. ${presentation.summary}`,
      presentation.consequence,
      `Changed by <@${input.draft.actorPersonId}> at ${new Date(input.at).toISOString()}.`,
      input.portalUrl,
    ].join("\n"),
  };
}

/**
 * Whether a bare reply accepts the pending draft.
 *
 * Matching the action's own words means an operator cannot accept a change by
 * saying "yes" to a message they did not read. Case and surrounding
 * punctuation are ignored; the words are not.
 */
export function replyAcceptsDraft(
  reply: string,
  draft: OperatorConfigurationDraft,
): boolean {
  const presentation = presentConfigurationCommand(draft.command);
  const expected = `${presentation.actionLabel} ${previewCode(draft.commandDigest)}`;
  return normalizeReply(reply) === normalizeReply(expected);
}

/**
 * The preview code an operator's reply carried, if any.
 *
 * Recovered from what they actually typed rather than read back from the
 * draft, so confirmation can be checked against the change they saw.
 */
export function replyPreviewCode(reply: string): string | null {
  const words = normalizeReply(reply).split(" ");
  const last = words[words.length - 1];
  return last !== undefined && /^[a-f0-9]{6}$/u.test(last)
    ? last.toUpperCase()
    : null;
}

/** Whether a bare reply withdraws the pending draft. */
export function replyCancelsDraft(reply: string): boolean {
  return normalizeReply(reply) === "cancel";
}

function normalizeReply(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
}

function describeSchedule(
  spec: Variant<AgentOperationInput, "configure_schedule_binding">["spec"],
): string {
  switch (spec.cadence) {
    case "hourly":
      return `every hour at ${spec.minuteOfHour} past`;
    case "daily":
      return `every day at ${spec.timeOfDay} ${spec.timezone}`;
    case "weekly":
      return `every ${spec.weekday} at ${spec.timeOfDay} ${spec.timezone}`;
    default:
      return assertNever(spec);
  }
}

/**
 * The opening of a long body, so the operator sees what they are approving.
 *
 * A change to instructions or a skill is a change to what the agent will do;
 * approving it from a one-line label alone is approving something unread.
 */
function excerpt(body: string): string {
  const collapsed = body.replace(/\s+/gu, " ").trim();
  return collapsed.length <= 280 ? collapsed : `${collapsed.slice(0, 277)}...`;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) {
    return `${minutes} minutes`;
  }
  const hours = minutes / 60;
  return Number.isInteger(hours)
    ? `${hours} hours`
    : `${hours.toFixed(1)} hours`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
