import {
  hasExactKeys,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
} from "@purin-labs/std";

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
  /** The mail agent that Pantry creates for a workspace. */
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
  /** Owners and admins may read the mailbox and its drafts in Pantry. */
  | "review"
  /**
   * Purin reviewed the workspace's model for mailbox content, and an owner
   * or admin accepted its data terms.
   */
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

/**
 * A model route that Purin reviewed for mailbox content (Gmail's Limited
 * Use rules): the provider trains on no mail and keeps no mail after the
 * answer. A person accepts it before new mail goes to it.
 */
export type MailboxModelReview = Readonly<{
  keySource: string;
  provider: string;
  model: string;
  /** The model's name, as a person reads it. */
  name: string;
  /** Who receives the content of new mail. */
  recipients: string;
  /** The data terms that Purin's review read. The consent names them. */
  termsUrl: string;
  /** When Purin's review ends. Each consent ends with it. */
  reviewExpiresAt: number;
}>;

/** Whether the workspace's model may receive mailbox content. */
export type MailboxSetupModel =
  /** An owner or admin accepted the reviewed model's data terms. */
  | Readonly<{ kind: "approved"; review: MailboxModelReview }>
  /**
   * Purin reviewed the model. Nobody accepted its terms yet, or the
   * acceptance ended: the model changed, the review ended, or the last
   * mailbox turned off.
   */
  | Readonly<{ kind: "consent_needed"; review: MailboxModelReview }>
  /** Purin has not reviewed this model for mailbox content. */
  | Readonly<{ kind: "not_reviewed"; name: string }>
  /** The workspace has no model connection that resolves. */
  | Readonly<{ kind: "unavailable" }>;

/**
 * The body of `POST …/agent-mailboxes/{account}/model-consent`: the route
 * and the terms that the person read. The server refuses it when the
 * workspace's model or Purin's review changed in between.
 */
export type MailboxModelConsentRequest = Readonly<{
  keySource: string;
  provider: string;
  model: string;
  termsUrl: string;
}>;

export function mailboxModelConsentRequest(
  review: MailboxModelReview,
): MailboxModelConsentRequest {
  return {
    keySource: review.keySource,
    provider: review.provider,
    model: review.model,
    termsUrl: review.termsUrl,
  };
}

export function parseMailboxModelConsentRequest(
  raw: unknown,
): MailboxModelConsentRequest | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["keySource", "provider", "model", "termsUrl"]) ||
    !isNonBlankString(raw.keySource) ||
    !isNonBlankString(raw.provider) ||
    !isNonBlankString(raw.model) ||
    !isNonBlankString(raw.termsUrl)
  )
    return null;
  return {
    keySource: raw.keySource,
    provider: raw.provider,
    model: raw.model,
    termsUrl: raw.termsUrl,
  };
}

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
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "approved":
    case "consent_needed": {
      if (!hasExactKeys(raw, ["kind", "review"])) return null;
      const review = parseModelReview(raw.review);
      return review === null ? null : { kind: raw.kind, review };
    }
    case "not_reviewed":
      return hasExactKeys(raw, ["kind", "name"]) && isNonBlankString(raw.name)
        ? { kind: "not_reviewed", name: raw.name }
        : null;
    case "unavailable":
      return hasExactKeys(raw, ["kind"]) ? { kind: "unavailable" } : null;
    default:
      return null;
  }
}

function parseModelReview(raw: unknown): MailboxModelReview | null {
  const route = parseMailboxModelConsentRequest(
    isRecord(raw)
      ? {
          keySource: raw.keySource,
          provider: raw.provider,
          model: raw.model,
          termsUrl: raw.termsUrl,
        }
      : null,
  );
  if (
    route === null ||
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "keySource",
      "provider",
      "model",
      "name",
      "recipients",
      "termsUrl",
      "reviewExpiresAt",
    ]) ||
    !isNonBlankString(raw.name) ||
    !isNonBlankString(raw.recipients) ||
    !isNonNegativeInteger(raw.reviewExpiresAt)
  )
    return null;
  return {
    ...route,
    name: raw.name,
    recipients: raw.recipients,
    reviewExpiresAt: raw.reviewExpiresAt,
  };
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
