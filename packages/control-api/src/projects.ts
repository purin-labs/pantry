import { parseProjectAccess, type ProjectAccess } from "./project-access";
import type { ProjectId } from "./ids";
import { isConversationId, isProjectId } from "./ids";
import type { ConversationId } from "./ids";
import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
} from "@seams/std";
import type { Variant } from "@seams/type-utils";

// A chat's Project is its Case's Project. The revision is that association's.
export type ChatPlacement = Readonly<{
  projectId: ProjectId;
  membershipRevision: number;
  position: number;
}>;

export type ChatDestination = Readonly<{ projectId: ProjectId }>;

export type ChatInsertion =
  | Readonly<{ kind: "end"; conversationId?: never }>
  | Readonly<{ kind: "before"; conversationId: ConversationId }>;

export type ProjectReference =
  | Readonly<{ kind: "bakery_run"; id: string; label: string }>
  | Readonly<{
      kind: "commerce_record";
      type:
        "product" | "order" | "menu" | "recipe_revision" | "production_batch";
      id: string;
      label: string;
    }>
  | Readonly<{
      kind: "case_entry";
      caseId: string;
      entryId: string;
      label: string;
    }>
  | Readonly<{
      kind: "file";
      integrationAccountId: string;
      provider: "google_drive" | "dropbox";
      providerFileId: string;
      label: string;
    }>;

export type ProjectContent = Readonly<{
  name: string;
  brief: string;
  references: readonly ProjectReference[];
}>;

export type Project = ProjectContent &
  Readonly<{
    id: ProjectId;
    access: ProjectAccess;
    revision: number;
    contentRevision: number;
    createdAt: number;
    updatedAt: number;
  }>;

export type ProjectDirectory = Readonly<{
  revision: number;
  // Where a member's work goes when they name no Project. They may not be
  // able to open it: `projects` lists only the Projects they can.
  defaultProjectId: ProjectId;
  projects: readonly Project[];
  placements: readonly Readonly<{
    projectId: ProjectId;
    position: number;
    collapsed: boolean;
  }>[];
}>;

// General Project commands. They are fenced by the Project's own revisions and
// answered from a receipt, so they need no chat directory.
export type ProjectCommand =
  | Readonly<{
      kind: "create_project";
      operationId: string;
      projectId: ProjectId;
      content: ProjectContent;
    }>
  | Readonly<{
      kind: "edit_project";
      operationId: string;
      projectId: ProjectId;
      expectedProjectRevision: number;
      content: ProjectContent;
    }>
  | Readonly<{
      kind: "delete_project";
      operationId: string;
      projectId: ProjectId;
      expectedProjectRevision: number;
      expectedAccessRevision: number;
    }>
  // Later work with no named Project goes to this one. Cases already filed stay where they are.
  | Readonly<{
      kind: "set_default_project";
      operationId: string;
      projectId: ProjectId;
      expectedDefaultRevision: number;
    }>;

export type ProjectCommandResult =
  | Readonly<{ kind: "accepted"; projectId: ProjectId; revision: number }>
  | Readonly<{
      kind: "rejected";
      code:
        | "project_unavailable"
        | "project_conflict"
        | "project_contains_shared_chats"
        | "project_contains_cases"
        | "project_is_default"
        | "default_project_ineligible"
        | "project_operation_conflict";
    }>;

// What a member may see of the Organisation's Projects.
export type ProjectCatalogue = Readonly<{
  defaultProject: Readonly<{ projectId: ProjectId; revision: number }>;
  projects: readonly Project[];
}>;

// A member's own sidebar: Project order and the position of their chats.
export type ChatDirectoryCommand =
  | Readonly<{
      kind: "set_project_placement";
      operationId: string;
      expectedDirectoryRevision: number;
      projectId: ProjectId;
      position: number;
      collapsed: boolean;
    }>
  | Readonly<{
      kind: "move_chat";
      operationId: string;
      expectedDirectoryRevision: number;
      conversationId: ConversationId;
      expectedMembershipRevision: number;
      destination: ChatDestination;
      insertion: ChatInsertion;
    }>;

export type ChatDirectoryResult =
  | Readonly<{ kind: "accepted"; directoryRevision: number }>
  | Readonly<{
      kind: "rejected";
      code:
        | "chat_directory_conflict"
        | "chat_destination_unavailable"
        | "chat_running"
        // A failed turn awaits its retry, or messages are queued.
        | "chat_work_unfinished"
        | "chat_not_found"
        | "chat_operation_conflict";
    }>;

export type CaseOriginKind =
  | "portal_chat"
  | "canvas_chat"
  | "direct"
  | "slack"
  | "email"
  | "whatsapp"
  | "inbox_assistant"
  | "commerce_approval";

// One Case's Project, as its reader may see it.
export type CaseProjectView = Readonly<{
  caseId: string;
  projectId: ProjectId;
  revision: number;
  origin: CaseOriginKind;
}>;

// A Case filed in a Project, as one reader may list it. It carries no title or
// preview: those belong to the Case's source and its own access rules.
export type ProjectCaseEntry = CaseProjectView &
  Readonly<{
    filedAt: number;
    // The chat that presents the Case, when the reader may open it.
    conversationId: ConversationId | null;
  }>;

export type CaseProjectCommand = Readonly<{
  kind: "move_case";
  operationId: string;
  expectedRevision: number;
  projectId: ProjectId;
}>;

export type CaseProjectResult =
  | Readonly<{
      kind: "accepted";
      placement: CaseProjectView;
      // A move grants the handling agent nothing. No agent holds Project
      // access yet, so the Case runs without the destination's context.
      agentProjectContext: "none";
    }>
  | Readonly<{
      kind: "rejected";
      code:
        | "case_not_found"
        | "case_project_conflict"
        | "case_running"
        // The chat that presents the Case has a failed turn awaiting its
        // retry, or queued messages.
        | "case_work_unfinished"
        | "case_destination_unavailable"
        | "case_move_requires_audience_review"
        | "case_operation_conflict";
    }>;

export function isProjectIdentifier(raw: unknown): raw is string {
  return (
    typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(raw)
  );
}

export function parseChatPlacement(raw: unknown): ChatPlacement | null {
  if (
    !isRecord(raw) ||
    !isProjectId(raw.projectId) ||
    !isNonNegativeInteger(raw.membershipRevision) ||
    raw.membershipRevision === 0 ||
    !isNonNegativeInteger(raw.position) ||
    !hasExactKeys(raw, ["projectId", "membershipRevision", "position"])
  )
    return null;
  return {
    projectId: raw.projectId,
    membershipRevision: raw.membershipRevision,
    position: raw.position,
  };
}

export function parseChatDestination(raw: unknown): ChatDestination | null {
  if (
    !isRecord(raw) ||
    !isProjectId(raw.projectId) ||
    !hasExactKeys(raw, ["projectId"])
  )
    return null;
  return { projectId: raw.projectId };
}

export function parseChatInsertion(raw: unknown): ChatInsertion | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "end" && hasExactKeys(raw, ["kind"])) return { kind: "end" };
  if (
    raw.kind === "before" &&
    isConversationId(raw.conversationId) &&
    hasExactKeys(raw, ["kind", "conversationId"])
  )
    return { kind: "before", conversationId: raw.conversationId };
  return null;
}

export function parseProjectReference(raw: unknown): ProjectReference | null {
  if (!isRecord(raw) || !boundedProjectText(raw.label, 160)) return null;
  const label = raw.label.trim();
  if (
    raw.kind === "bakery_run" &&
    typeof raw.id === "string" &&
    /^[a-f0-9]{64}$/u.test(raw.id) &&
    hasExactKeys(raw, ["kind", "id", "label"])
  )
    return { kind: "bakery_run", id: raw.id, label };
  if (
    raw.kind === "commerce_record" &&
    isProjectIdentifier(raw.id) &&
    isProjectCommerceType(raw.type) &&
    hasExactKeys(raw, ["kind", "type", "id", "label"])
  )
    return { kind: "commerce_record", type: raw.type, id: raw.id, label };
  if (
    raw.kind === "case_entry" &&
    isProjectIdentifier(raw.caseId) &&
    isProjectIdentifier(raw.entryId) &&
    hasExactKeys(raw, ["kind", "caseId", "entryId", "label"])
  )
    return {
      kind: "case_entry",
      caseId: raw.caseId,
      entryId: raw.entryId,
      label,
    };
  if (
    raw.kind === "file" &&
    isProjectIdentifier(raw.integrationAccountId) &&
    (raw.provider === "google_drive" || raw.provider === "dropbox") &&
    boundedProjectText(raw.providerFileId, 512) &&
    hasExactKeys(raw, [
      "kind",
      "integrationAccountId",
      "provider",
      "providerFileId",
      "label",
    ])
  )
    return {
      kind: "file",
      integrationAccountId: raw.integrationAccountId,
      provider: raw.provider,
      providerFileId: raw.providerFileId,
      label,
    };
  return null;
}

function isProjectCommerceType(
  raw: unknown,
): raw is Variant<ProjectReference, "commerce_record">["type"] {
  return (
    raw === "product" ||
    raw === "order" ||
    raw === "menu" ||
    raw === "recipe_revision" ||
    raw === "production_batch"
  );
}

function boundedProjectText(raw: unknown, limit: number): raw is string {
  return (
    typeof raw === "string" && raw.trim().length > 0 && raw.length <= limit
  );
}

export function parseProjectContent(raw: unknown): ProjectContent | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["name", "brief", "references"]) ||
    !boundedProjectText(raw.name, 120) ||
    typeof raw.brief !== "string" ||
    raw.brief.length > 4000 ||
    !Array.isArray(raw.references) ||
    raw.references.length > 12
  )
    return null;
  const references: ProjectReference[] = [];
  const identities = new Set<string>();
  for (const value of raw.references) {
    const reference = parseProjectReference(value);
    if (reference === null) return null;
    const identity = projectReferenceIdentity(reference);
    if (identities.has(identity)) return null;
    identities.add(identity);
    references.push(reference);
  }
  return { name: raw.name.trim(), brief: raw.brief.trim(), references };
}

export function projectReferenceIdentity(reference: ProjectReference): string {
  switch (reference.kind) {
    case "bakery_run":
      return `bakery_run:${reference.id}`;
    case "commerce_record":
      return `commerce:${reference.type}:${reference.id}`;
    case "case_entry":
      return `case:${reference.caseId}:${reference.entryId}`;
    case "file":
      return `file:${reference.integrationAccountId}:${reference.provider}:${reference.providerFileId}`;
    default:
      return assertNever(reference);
  }
}

export function parseProject(raw: unknown): Project | null {
  if (
    !isRecord(raw) ||
    !isProjectId(raw.id) ||
    !isNonNegativeInteger(raw.revision) ||
    raw.revision === 0 ||
    !isNonNegativeInteger(raw.contentRevision) ||
    raw.contentRevision === 0 ||
    !isNonNegativeInteger(raw.createdAt) ||
    !isNonNegativeInteger(raw.updatedAt)
  )
    return null;
  const content = parseProjectContent({
    name: raw.name,
    brief: raw.brief,
    references: raw.references,
  });
  const access = parseProjectAccess(raw.access);
  if (content === null || access === null) return null;
  return {
    id: raw.id,
    access,
    revision: raw.revision,
    contentRevision: raw.contentRevision,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    name: content.name,
    brief: content.brief,
    references: content.references,
  };
}

export function parseProjectDirectory(raw: unknown): ProjectDirectory | null {
  if (
    !isRecord(raw) ||
    !isNonNegativeInteger(raw.revision) ||
    !isProjectId(raw.defaultProjectId) ||
    !Array.isArray(raw.projects)
  )
    return null;
  const projects: Project[] = [];
  const ids = new Set<string>();
  for (const value of raw.projects) {
    const project = parseProject(value);
    if (project === null || ids.has(project.id)) return null;
    ids.add(project.id);
    projects.push(project);
  }
  if (!Array.isArray(raw.placements)) return null;
  const placements: ProjectDirectory["placements"][number][] = [];
  for (const value of raw.placements) {
    if (
      !isRecord(value) ||
      !isProjectId(value.projectId) ||
      !isNonNegativeInteger(value.position) ||
      typeof value.collapsed !== "boolean"
    )
      return null;
    placements.push({
      projectId: value.projectId,
      position: value.position,
      collapsed: value.collapsed,
    });
  }
  return {
    revision: raw.revision,
    defaultProjectId: raw.defaultProjectId,
    projects,
    placements,
  };
}

export function parseProjectCommand(raw: unknown): ProjectCommand | null {
  if (!isRecord(raw) || !isProjectIdentifier(raw.operationId)) return null;
  if (
    raw.kind === "delete_project" &&
    isProjectId(raw.projectId) &&
    isNonNegativeInteger(raw.expectedProjectRevision) &&
    isNonNegativeInteger(raw.expectedAccessRevision) &&
    hasExactKeys(raw, [
      "kind",
      "operationId",
      "projectId",
      "expectedProjectRevision",
      "expectedAccessRevision",
    ])
  )
    return {
      kind: "delete_project",
      operationId: raw.operationId,
      projectId: raw.projectId,
      expectedProjectRevision: raw.expectedProjectRevision,
      expectedAccessRevision: raw.expectedAccessRevision,
    };
  if (
    raw.kind === "set_default_project" &&
    isProjectId(raw.projectId) &&
    isNonNegativeInteger(raw.expectedDefaultRevision) &&
    raw.expectedDefaultRevision > 0 &&
    hasExactKeys(raw, [
      "kind",
      "operationId",
      "projectId",
      "expectedDefaultRevision",
    ])
  )
    return {
      kind: "set_default_project",
      operationId: raw.operationId,
      projectId: raw.projectId,
      expectedDefaultRevision: raw.expectedDefaultRevision,
    };
  if (
    raw.kind === "create_project" &&
    isProjectId(raw.projectId) &&
    hasExactKeys(raw, ["kind", "operationId", "projectId", "content"])
  ) {
    const content = parseProjectContent(raw.content);
    return content === null
      ? null
      : {
          kind: "create_project",
          operationId: raw.operationId,
          projectId: raw.projectId,
          content,
        };
  }
  if (
    raw.kind === "edit_project" &&
    isProjectId(raw.projectId) &&
    isNonNegativeInteger(raw.expectedProjectRevision) &&
    raw.expectedProjectRevision > 0 &&
    hasExactKeys(raw, [
      "kind",
      "operationId",
      "projectId",
      "expectedProjectRevision",
      "content",
    ])
  ) {
    const content = parseProjectContent(raw.content);
    return content === null
      ? null
      : {
          kind: "edit_project",
          operationId: raw.operationId,
          projectId: raw.projectId,
          expectedProjectRevision: raw.expectedProjectRevision,
          content,
        };
  }
  return null;
}

export function parseChatDirectoryCommand(
  raw: unknown,
): ChatDirectoryCommand | null {
  if (
    !isRecord(raw) ||
    !isProjectIdentifier(raw.operationId) ||
    !isNonNegativeInteger(raw.expectedDirectoryRevision)
  )
    return null;
  if (
    raw.kind === "set_project_placement" &&
    isProjectId(raw.projectId) &&
    isNonNegativeInteger(raw.position) &&
    typeof raw.collapsed === "boolean" &&
    hasExactKeys(raw, [
      "kind",
      "operationId",
      "expectedDirectoryRevision",
      "projectId",
      "position",
      "collapsed",
    ])
  )
    return {
      kind: "set_project_placement",
      operationId: raw.operationId,
      expectedDirectoryRevision: raw.expectedDirectoryRevision,
      projectId: raw.projectId,
      position: raw.position,
      collapsed: raw.collapsed,
    };
  if (
    raw.kind === "move_chat" &&
    isConversationId(raw.conversationId) &&
    isNonNegativeInteger(raw.expectedMembershipRevision) &&
    hasExactKeys(raw, [
      "kind",
      "operationId",
      "expectedDirectoryRevision",
      "conversationId",
      "expectedMembershipRevision",
      "destination",
      "insertion",
    ])
  ) {
    const destination = parseChatDestination(raw.destination);
    const insertion = parseChatInsertion(raw.insertion);
    if (
      destination === null ||
      insertion === null ||
      (insertion.kind === "before" &&
        insertion.conversationId === raw.conversationId)
    )
      return null;
    return {
      kind: "move_chat",
      operationId: raw.operationId,
      expectedDirectoryRevision: raw.expectedDirectoryRevision,
      conversationId: raw.conversationId,
      expectedMembershipRevision: raw.expectedMembershipRevision,
      destination,
      insertion,
    };
  }
  return null;
}

export function parseCaseProjectCommand(
  raw: unknown,
): CaseProjectCommand | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "move_case" ||
    !isProjectIdentifier(raw.operationId) ||
    !isNonNegativeInteger(raw.expectedRevision) ||
    raw.expectedRevision === 0 ||
    !isProjectId(raw.projectId) ||
    !hasExactKeys(raw, ["kind", "operationId", "expectedRevision", "projectId"])
  )
    return null;
  return {
    kind: "move_case",
    operationId: raw.operationId,
    expectedRevision: raw.expectedRevision,
    projectId: raw.projectId,
  };
}

export function isCaseOriginKind(raw: unknown): raw is CaseOriginKind {
  return (
    raw === "portal_chat" ||
    raw === "canvas_chat" ||
    raw === "direct" ||
    raw === "slack" ||
    raw === "email" ||
    raw === "whatsapp" ||
    raw === "inbox_assistant" ||
    raw === "commerce_approval"
  );
}

export function parseProjectCatalogue(raw: unknown): ProjectCatalogue | null {
  if (
    !isRecord(raw) ||
    !isRecord(raw.defaultProject) ||
    !isProjectId(raw.defaultProject.projectId) ||
    !isNonNegativeInteger(raw.defaultProject.revision) ||
    raw.defaultProject.revision === 0 ||
    !Array.isArray(raw.projects)
  )
    return null;
  const projects: Project[] = [];
  const ids = new Set<string>();
  for (const value of raw.projects) {
    const project = parseProject(value);
    if (project === null || ids.has(project.id)) return null;
    ids.add(project.id);
    projects.push(project);
  }
  return {
    defaultProject: {
      projectId: raw.defaultProject.projectId,
      revision: raw.defaultProject.revision,
    },
    projects,
  };
}

export function parseProjectCaseEntries(
  raw: unknown,
): readonly ProjectCaseEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: ProjectCaseEntry[] = [];
  for (const value of raw) {
    if (
      !isRecord(value) ||
      !isProjectIdentifier(value.caseId) ||
      !isProjectId(value.projectId) ||
      !isNonNegativeInteger(value.revision) ||
      value.revision === 0 ||
      !isCaseOriginKind(value.origin) ||
      !isNonNegativeInteger(value.filedAt) ||
      (value.conversationId !== null && !isConversationId(value.conversationId))
    )
      return null;
    entries.push({
      caseId: value.caseId,
      projectId: value.projectId,
      revision: value.revision,
      origin: value.origin,
      filedAt: value.filedAt,
      conversationId: value.conversationId,
    });
  }
  return entries;
}
