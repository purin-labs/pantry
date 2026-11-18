import { hasExactKeys, isNonBlankString, isRecord } from "@seams/std";

/**
 * What a connected mailbox still needs before its agent writes a reply, and
 * the next change that supplies it.
 *
 * The plan changes nothing. Each change it names is a request to a control
 * route that exists apart from it, so the person who presses "Set up" makes
 * each change with their own authority, and each one keeps its own receipt.
 */

/** Which agent answers the mailbox. */
export type MailboxSetupAgentChoice =
  /** The assigned agent, else the workspace's first agent, else a new one. */
  | Readonly<{ kind: "automatic" }>
  | Readonly<{ kind: "installation"; installationId: string }>
  | Readonly<{ kind: "definition"; agentDefinitionId: string }>
  /** The mail agent that Satyr creates for a workspace. */
  | Readonly<{ kind: "new" }>;

/** The agent the plan settled on. It is never `automatic`. */
export type MailboxSetupAgent = Readonly<{
  choice: Exclude<MailboxSetupAgentChoice, { kind: "automatic" }>;
  name: string;
  /**
   * `assigned` answers this mailbox now. `ready` can be assigned as it is.
   * `inactive` exists and is not active in the workspace. `absent` is the
   * mail agent that does not exist yet.
   */
  state: "assigned" | "ready" | "inactive" | "absent";
}>;

export type MailboxSetupRequirementId =
  /** An active agent is assigned to the mailbox. */
  | "agent"
  /** The agent may write a reply draft. */
  | "reply_drafts"
  /** The agent may read the Case of an email thread. */
  | "agent_context"
  /** Owners and admins may read the mailbox and its drafts in Satyr. */
  | "review"
  /** Satyr has approved the workspace's model for mailbox content. */
  | "model";

export const MAILBOX_SETUP_REQUIREMENTS: readonly MailboxSetupRequirementId[] =
  ["agent", "reply_drafts", "agent_context", "review", "model"];

export type MailboxSetupRequirement = Readonly<{
  id: MailboxSetupRequirementId;
  state: "met" | "missing";
}>;

/**
 * One change, as the body of the control route that makes it. `body` is sent
 * as it is.
 */
export type MailboxSetupChange =
  | Readonly<{
      /** `POST …/operations`: an area, the agent or its activation. */
      kind: "agent_operation";
      body: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      /** `POST …/agent-mailboxes/{account}/bind`. */
      kind: "assign_agent";
      body: Readonly<{ installationId: string }>;
    }>
  | Readonly<{
      /** `POST …/access-control/capabilities/{capabilityId}`. */
      kind: "enable_action";
      capabilityId: string;
      body: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      /** `POST …/access-control/grants`. */
      kind: "grant_access";
      body: Readonly<Record<string, unknown>>;
    }>;

/** Whether the workspace's model may receive mailbox content. */
export type MailboxSetupModel =
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "not_approved" }>
  /** The workspace has no model connection that resolves. */
  | Readonly<{ kind: "unavailable" }>;

export type MailboxSetupPlan = Readonly<{
  agent: MailboxSetupAgent;
  requirements: readonly MailboxSetupRequirement[];
  /**
   * The next change of the setup. Null when no change is left for the person:
   * each requirement is met, or only `model` is missing.
   */
  next: MailboxSetupChange | null;
  model: MailboxSetupModel;
}>;

/** The choice as the `agent` query value of the plan read. */
export function encodeMailboxSetupAgentChoice(
  choice: MailboxSetupAgentChoice,
): string {
  switch (choice.kind) {
    case "automatic":
    case "new":
      return choice.kind;
    case "installation":
      return `installation:${choice.installationId}`;
    case "definition":
      return `definition:${choice.agentDefinitionId}`;
  }
}

export function parseMailboxSetupAgentChoice(
  raw: string | null,
): MailboxSetupAgentChoice | null {
  if (raw === null || raw === "automatic") return { kind: "automatic" };
  if (raw === "new") return { kind: "new" };
  const separator = raw.indexOf(":");
  const id = separator < 0 ? "" : raw.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(id)) return null;
  switch (raw.slice(0, separator)) {
    case "installation":
      return { kind: "installation", installationId: id };
    case "definition":
      return { kind: "definition", agentDefinitionId: id };
    default:
      return null;
  }
}

export function parseMailboxSetupPlan(raw: unknown): MailboxSetupPlan | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["agent", "requirements", "next", "model"]) ||
    !Array.isArray(raw.requirements)
  )
    return null;
  const agent = parseAgent(raw.agent);
  const model = parseModel(raw.model);
  const next = raw.next === null ? null : parseChange(raw.next);
  if (agent === null || model === null || (raw.next !== null && next === null))
    return null;
  const requirements: MailboxSetupRequirement[] = [];
  for (const entry of raw.requirements) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["id", "state"]) ||
      !isRequirementId(entry.id) ||
      (entry.state !== "met" && entry.state !== "missing")
    )
      return null;
    requirements.push({ id: entry.id, state: entry.state });
  }
  return { agent, requirements, next, model };
}

function isRequirementId(raw: unknown): raw is MailboxSetupRequirementId {
  return MAILBOX_SETUP_REQUIREMENTS.some((id) => id === raw);
}

function parseAgent(raw: unknown): MailboxSetupAgent | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["choice", "name", "state"]) ||
    !isNonBlankString(raw.name) ||
    !isRecord(raw.choice)
  )
    return null;
  const { state, choice } = raw;
  if (
    state !== "assigned" &&
    state !== "ready" &&
    state !== "inactive" &&
    state !== "absent"
  )
    return null;
  if (choice.kind === "new" && hasExactKeys(choice, ["kind"]))
    return { choice: { kind: "new" }, name: raw.name, state };
  if (
    choice.kind === "installation" &&
    hasExactKeys(choice, ["kind", "installationId"]) &&
    isNonBlankString(choice.installationId)
  )
    return {
      choice: { kind: "installation", installationId: choice.installationId },
      name: raw.name,
      state,
    };
  if (
    choice.kind === "definition" &&
    hasExactKeys(choice, ["kind", "agentDefinitionId"]) &&
    isNonBlankString(choice.agentDefinitionId)
  )
    return {
      choice: {
        kind: "definition",
        agentDefinitionId: choice.agentDefinitionId,
      },
      name: raw.name,
      state,
    };
  return null;
}

function parseModel(raw: unknown): MailboxSetupModel | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["kind"])) return null;
  switch (raw.kind) {
    case "approved":
    case "not_approved":
    case "unavailable":
      return { kind: raw.kind };
    default:
      return null;
  }
}

function parseChange(raw: unknown): MailboxSetupChange | null {
  if (!isRecord(raw) || !isRecord(raw.body)) return null;
  switch (raw.kind) {
    case "agent_operation":
    case "grant_access":
      return hasExactKeys(raw, ["kind", "body"])
        ? { kind: raw.kind, body: raw.body }
        : null;
    case "assign_agent":
      return hasExactKeys(raw, ["kind", "body"]) &&
        hasExactKeys(raw.body, ["installationId"]) &&
        isNonBlankString(raw.body.installationId)
        ? {
            kind: "assign_agent",
            body: { installationId: raw.body.installationId },
          }
        : null;
    case "enable_action":
      return hasExactKeys(raw, ["kind", "capabilityId", "body"]) &&
        isNonBlankString(raw.capabilityId)
        ? {
            kind: "enable_action",
            capabilityId: raw.capabilityId,
            body: raw.body,
          }
        : null;
    default:
      return null;
  }
}
