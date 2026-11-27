import {
  assertNever,
  hasExactKeys,
  isNonNegativeInteger,
  isRecord,
} from "@purin-labs/std";
import { isUserId, type ProjectId, type UserId } from "./ids.ts";

export type ProjectRole = "owner" | "editor" | "viewer";

export type ProjectAccess =
  | Readonly<{
      kind: "personal";
      ownerUserId: UserId;
      role?: never;
      accessRevision: number;
    }>
  | Readonly<{
      kind: "shared";
      role: ProjectRole;
      ownerUserId?: never;
      accessRevision: number;
    }>;

export type ChatConversationAccess =
  | Readonly<{
      kind: "workspace_canvas";
      documentId: string;
      ownerUserId?: never;
      sharedProjectId?: never;
    }>
  | Readonly<{
      kind: "private";
      ownerUserId: UserId;
      sharedProjectId?: never;
      documentId?: never;
    }>
  | Readonly<{
      kind: "shared";
      sharedProjectId: ProjectId;
      documentId?: never;
      ownerUserId?: never;
    }>;

export type ProjectPermission =
  | "read"
  | "contribute"
  | "edit_content"
  | "manage_members"
  | "move_shared_chat"
  | "delete_shared_chat"
  | "delete_project";

export type ProjectMember = Readonly<{
  userId: UserId;
  displayName: string;
  role: ProjectRole;
}>;

export function isProjectRole(raw: unknown): raw is ProjectRole {
  return raw === "owner" || raw === "editor" || raw === "viewer";
}

export function parseProjectAccess(raw: unknown): ProjectAccess | null {
  if (!isRecord(raw) || !isNonNegativeInteger(raw.accessRevision)) return null;
  if (
    raw.kind === "personal" &&
    isUserId(raw.ownerUserId) &&
    hasExactKeys(raw, ["kind", "ownerUserId", "accessRevision"])
  ) {
    return {
      kind: "personal",
      ownerUserId: raw.ownerUserId,
      accessRevision: raw.accessRevision,
    };
  }
  if (
    raw.kind === "shared" &&
    isProjectRole(raw.role) &&
    hasExactKeys(raw, ["kind", "role", "accessRevision"])
  ) {
    return {
      kind: "shared",
      role: raw.role,
      accessRevision: raw.accessRevision,
    };
  }
  return null;
}

// This role check follows authenticated organisation and project membership resolution.
export function projectRoleAllows(
  role: ProjectRole,
  permission: ProjectPermission,
): boolean {
  switch (permission) {
    case "read":
      return true;
    case "contribute":
    case "edit_content":
      return role === "owner" || role === "editor";
    case "manage_members":
    case "move_shared_chat":
    case "delete_shared_chat":
    case "delete_project":
      return role === "owner";
    default:
      return assertNever(permission);
  }
}

export type ProjectAccessCommand =
  | Readonly<{
      kind: "share_project";
      operationId: string;
      expectedAccessRevision: number;
      members: readonly Readonly<{ userId: UserId; role: ProjectRole }>[];
    }>
  | Readonly<{
      kind: "set_project_member";
      operationId: string;
      expectedAccessRevision: number;
      userId: UserId;
      role: ProjectRole;
    }>
  | Readonly<{
      kind: "remove_project_member";
      operationId: string;
      expectedAccessRevision: number;
      userId: UserId;
    }>;

export function parseProjectAccessCommand(
  raw: unknown,
): ProjectAccessCommand | null {
  if (
    !isRecord(raw) ||
    typeof raw.operationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(raw.operationId) ||
    !isNonNegativeInteger(raw.expectedAccessRevision)
  )
    return null;
  switch (raw.kind) {
    case "share_project": {
      if (
        !hasExactKeys(raw, [
          "kind",
          "operationId",
          "expectedAccessRevision",
          "members",
        ]) ||
        !Array.isArray(raw.members) ||
        raw.members.length > 100
      )
        return null;
      const members: { userId: UserId; role: ProjectRole }[] = [];
      const seen = new Set<UserId>();
      for (const member of raw.members) {
        if (
          !isRecord(member) ||
          !hasExactKeys(member, ["userId", "role"]) ||
          !isUserId(member.userId) ||
          !isProjectRole(member.role) ||
          seen.has(member.userId)
        )
          return null;
        seen.add(member.userId);
        members.push({ userId: member.userId, role: member.role });
      }
      return {
        kind: "share_project",
        operationId: raw.operationId,
        expectedAccessRevision: raw.expectedAccessRevision,
        members,
      };
    }
    case "set_project_member":
      if (
        !hasExactKeys(raw, [
          "kind",
          "operationId",
          "expectedAccessRevision",
          "userId",
          "role",
        ]) ||
        !isUserId(raw.userId) ||
        !isProjectRole(raw.role)
      )
        return null;
      return {
        kind: "set_project_member",
        operationId: raw.operationId,
        expectedAccessRevision: raw.expectedAccessRevision,
        userId: raw.userId,
        role: raw.role,
      };
    case "remove_project_member":
      if (
        !hasExactKeys(raw, [
          "kind",
          "operationId",
          "expectedAccessRevision",
          "userId",
        ]) ||
        !isUserId(raw.userId)
      )
        return null;
      return {
        kind: "remove_project_member",
        operationId: raw.operationId,
        expectedAccessRevision: raw.expectedAccessRevision,
        userId: raw.userId,
      };
    default:
      return null;
  }
}

export type ProjectCandidate = Readonly<{
  userId: UserId;
  displayName: string;
}>;
export type ProjectAccessDetails = Readonly<{
  access: ProjectAccess;
  members: readonly ProjectMember[];
  candidates: readonly ProjectCandidate[];
}>;

export function parseProjectAccessDetails(
  raw: unknown,
): ProjectAccessDetails | null {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.members) ||
    !Array.isArray(raw.candidates)
  )
    return null;
  const access = parseProjectAccess(raw.access);
  if (access === null) return null;
  const members: ProjectMember[] = [];
  const candidates: ProjectCandidate[] = [];
  for (const member of raw.members) {
    if (
      !isRecord(member) ||
      !isUserId(member.userId) ||
      typeof member.displayName !== "string" ||
      !isProjectRole(member.role)
    )
      return null;
    members.push({
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
    });
  }
  for (const candidate of raw.candidates) {
    if (
      !isRecord(candidate) ||
      !isUserId(candidate.userId) ||
      typeof candidate.displayName !== "string"
    )
      return null;
    candidates.push({
      userId: candidate.userId,
      displayName: candidate.displayName,
    });
  }
  return { access, members, candidates };
}
