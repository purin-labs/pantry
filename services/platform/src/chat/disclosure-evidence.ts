import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type {
  ProjectId,
  UserId,
  ProjectAccessCommand,
} from "@purin-labs/control-api";
import {
  canonicalJson,
  sha256Hex,
  hasExactKeys,
  isRecord,
  isNonNegativeInteger,
} from "@purin-labs/std";
import { isConversationId, isUserId } from "@purin-labs/control-api";
import type { ConversationScope } from "./store";
import { authorizeProject, listProjectMembers } from "../projects/access";
import { listOrganisationMembers } from "@purin-labs/tenancy/data/control-plane";
import { readProject } from "../projects/records";
import { listAccessGrants } from "../data/access-grants";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import { authorizeConversation } from "./conversation-access";
import type { ConversationId } from "@purin-labs/control-api";
import type { ConversationSharingCommand } from "./conversation-sharing";

export class ProjectAudienceProposal {
  readonly #acceptedCommand = true;
  private constructor(
    readonly projectId: ProjectId,
    readonly scope: ConversationScope,
    readonly accessRevision: number,
    readonly contentRevision: number,
    readonly recipients: readonly UserId[],
    readonly commandDigest: string,
  ) {
    Object.freeze(scope);
    Object.freeze(recipients);
    Object.freeze(this);
  }

  static async prepare(
    db: OrganisationDatabase,
    scope: ConversationScope,
    projectId: ProjectId,
    command: ProjectAccessCommand,
  ): Promise<ProjectAudienceProposal | null> {
    const authorized = await authorizeProject(
      db,
      scope,
      projectId,
      "manage_members",
    );
    const project = await readProject(db, scope, projectId);
    if (
      authorized === null ||
      project === null ||
      authorized.access.accessRevision !== command.expectedAccessRevision
    )
      return null;
    const current = await listProjectMembers(db, scope, projectId);
    if (current === null) return null;
    const recipients = new Set<UserId>(current.map(memberUserId));
    switch (command.kind) {
      case "share_project":
        if (authorized.access.kind !== "personal") return null;
        recipients.add(scope.userId);
        for (const member of command.members) recipients.add(member.userId);
        break;
      case "set_project_member":
        recipients.add(command.userId);
        break;
      case "remove_project_member":
        recipients.delete(command.userId);
        break;
    }
    const active = await listOrganisationMembers({
      db,
      organisationId: scope.organisationId,
    });
    for (const userId of recipients)
      if (!active.some(memberForUser.bind(null, userId))) return null;
    return new ProjectAudienceProposal(
      projectId,
      { organisationId: scope.organisationId, userId: scope.userId },
      authorized.access.accessRevision,
      project.contentRevision,
      [...recipients].sort(),
      await sha256Hex(canonicalJson({ projectId, command })),
    );
  }
  static is(value: unknown): value is ProjectAudienceProposal {
    return (
      typeof value === "object" && value !== null && #acceptedCommand in value
    );
  }
}
function memberUserId(member: { userId: UserId }): UserId {
  return member.userId;
}
function memberForUser(userId: UserId, member: { userId: UserId }): boolean {
  return member.userId === userId;
}

export class ConversationAudienceProposal {
  readonly #acceptedCommand = true;
  private constructor(
    readonly scope: ConversationScope,
    readonly conversationId: ConversationId,
    readonly projectId: ProjectId,
    readonly sourceRevision: number,
    readonly sourceAccessRevision: number,
    readonly destinationAccessRevision: number,
    readonly contentRevision: number,
    readonly recipients: readonly UserId[],
    readonly commandDigest: string,
  ) {
    Object.freeze(scope);
    Object.freeze(recipients);
    Object.freeze(this);
  }
  static async prepare(
    db: OrganisationDatabase,
    scope: ConversationScope,
    conversationId: ConversationId,
    command: ConversationSharingCommand,
  ): Promise<ConversationAudienceProposal | null> {
    const source = await authorizeConversation(db, scope, conversationId);
    const destination = await authorizeProject(
      db,
      scope,
      command.projectId,
      command.kind === "share_conversation" ? "contribute" : "move_shared_chat",
    );
    const project = await readProject(db, scope, command.projectId);
    const row = await db
      .prepare(
        "SELECT revision FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
      )
      .bind(scope.organisationId, conversationId)
      .first<{ revision: unknown }>();
    if (
      source === null ||
      source.role !== "owner" ||
      destination?.access.kind !== "shared" ||
      project === null ||
      row?.revision !== command.expectedRevision ||
      destination.access.accessRevision !==
        command.expectedProjectAccessRevision ||
      (command.kind === "share_conversation") !==
        (source.access.kind === "private")
    )
      return null;
    const members = await listProjectMembers(db, scope, command.projectId);
    if (members === null || members.length === 0) return null;
    return new ConversationAudienceProposal(
      { organisationId: scope.organisationId, userId: scope.userId },
      conversationId,
      command.projectId,
      command.expectedRevision,
      source.accessRevision,
      destination.access.accessRevision,
      project.contentRevision,
      members.map(memberUserId).sort(),
      await sha256Hex(canonicalJson({ conversationId, command })),
    );
  }
  static is(value: unknown): value is ConversationAudienceProposal {
    return (
      typeof value === "object" && value !== null && #acceptedCommand in value
    );
  }
}

export type DisclosureDestination =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "project_admission"; proposal: ProjectAudienceProposal }>
  | Readonly<{
      kind: "conversation_admission";
      proposal: ConversationAudienceProposal;
    }>;

type DisclosureState = Readonly<{
  organisationConfiguration:
    | Readonly<{ kind: "unconfigured" }>
    | Readonly<{ kind: "configured"; revision: number }>;
  policy:
    | Readonly<{ kind: "unpublished" }>
    | Readonly<{ kind: "published"; version: number }>;
  grants: readonly Readonly<{ id: string; revision: number }>[];
  accounts: readonly Readonly<{
    id: string;
    lifecycle: string;
    updatedAt: number;
    policyJson: string;
  }>[];
  projects: readonly Readonly<{
    id: string;
    accessRevision: number;
    contentRevision: number;
  }>[];
}>;
export async function readDisclosureState(
  db: OrganisationDatabase,
  scope: ConversationScope,
): Promise<DisclosureState | null> {
  // Read each component independently. Keep the before/after disclosure
  // checks and publication fences in the callers.
  const [organisation, policy, grants, accounts, projects] = await Promise.all([
    db
      .prepare(
        "SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?",
      )
      .bind(scope.organisationId)
      .first<{ configuration_version: number }>(),
    readCurrentOrganisationPolicySnapshot(db, scope.organisationId),
    listAccessGrants({
      db,
      organisationId: scope.organisationId,
      lifecycle: "active",
    }),
    db
      .prepare(
        "SELECT integration_account_id, lifecycle, updated_at, audience_policy FROM integration_account WHERE organisation_id = ? ORDER BY integration_account_id",
      )
      .bind(scope.organisationId)
      .all<{
        integration_account_id: unknown;
        lifecycle: unknown;
        updated_at: unknown;
        audience_policy: unknown;
      }>(),
    db
      .prepare(
        "SELECT project_id, access_revision, content_revision FROM project WHERE organisation_id = ? ORDER BY project_id",
      )
      .bind(scope.organisationId)
      .all<{
        project_id: unknown;
        access_revision: unknown;
        content_revision: unknown;
      }>(),
  ]);
  const organisationMembershipRevision =
    organisation?.configuration_version ?? null;
  if (
    !grants.ok ||
    (!policy.ok && policy.error.code !== "policy_snapshot_missing")
  )
    return null;
  const checkedProjects: DisclosureState["projects"][number][] = [];
  const checkedAccounts: DisclosureState["accounts"][number][] = [];
  for (const row of accounts.results) {
    if (
      typeof row.integration_account_id !== "string" ||
      typeof row.lifecycle !== "string" ||
      typeof row.updated_at !== "number" ||
      typeof row.audience_policy !== "string"
    )
      return null;
    checkedAccounts.push({
      id: row.integration_account_id,
      lifecycle: row.lifecycle,
      updatedAt: row.updated_at,
      policyJson: row.audience_policy,
    });
  }
  for (const row of projects.results) {
    if (
      typeof row.project_id !== "string" ||
      typeof row.access_revision !== "number" ||
      typeof row.content_revision !== "number"
    )
      return null;
    checkedProjects.push({
      id: row.project_id,
      accessRevision: row.access_revision,
      contentRevision: row.content_revision,
    });
  }
  return {
    organisationConfiguration:
      organisationMembershipRevision === null
        ? { kind: "unconfigured" }
        : { kind: "configured", revision: organisationMembershipRevision },
    policy: policy.ok
      ? { kind: "published", version: policy.value.version }
      : { kind: "unpublished" },
    grants: grants.value.map(grantRevision).sort(compareGrantIds),
    projects: checkedProjects,
    accounts: checkedAccounts,
  };
}
function grantRevision(
  grant: import("../authorization/access-grants/types").AccessGrant,
): DisclosureState["grants"][number] {
  if (grant.lifecycle.kind !== "active")
    throw new Error("disclosure_grant_inactive");
  return { id: grant.grantId, revision: grant.lifecycle.revision };
}
function compareGrantIds(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

class DisclosureProof {
  readonly #checked = true;
  private constructor(
    readonly state: DisclosureState,
    readonly conversationId: string,
    readonly historyDigest: string,
    readonly audience: readonly UserId[],
    readonly decisionDigests: readonly string[],
    readonly digest: string,
  ) {
    Object.freeze(audience);
    Object.freeze(decisionDigests);
    Object.freeze(this);
  }
  static async create(
    state: DisclosureState,
    conversationId: string,
    historyDigest: string,
    audience: readonly UserId[],
    decisionDigests: readonly string[],
  ): Promise<DisclosureProof> {
    const recipients = [...audience].sort();
    const decisions = [...decisionDigests];
    const digest = await sha256Hex(
      canonicalJson({
        state,
        conversationId,
        historyDigest,
        audience: recipients,
        decisionDigests: decisions,
      }),
    );
    return new DisclosureProof(
      state,
      conversationId,
      historyDigest,
      recipients,
      decisions,
      digest,
    );
  }
  static is(value: unknown): value is DisclosureProof {
    return typeof value === "object" && value !== null && #checked in value;
  }
}
export type { DisclosureProof };
export async function createDisclosureProof(
  state: DisclosureState,
  conversationId: string,
  historyDigest: string,
  audience: readonly UserId[],
  decisionDigests: readonly string[],
): Promise<DisclosureProof> {
  return DisclosureProof.create(
    state,
    conversationId,
    historyDigest,
    audience,
    decisionDigests,
  );
}

// Acceptance uses the same snapshot checked before asynchronous source/history reads.
export const DISCLOSURE_STATE_FENCE_SQL = `(SELECT configuration_version FROM organisation_onboarding WHERE organisation_id = ?) IS ?
  AND (SELECT MAX(version) FROM policy_snapshot WHERE organisation_id = ?) IS ?
  AND NOT EXISTS (
  SELECT 1 FROM json_each(json_extract(?, '$.grants')) checked WHERE NOT EXISTS (
    SELECT 1 FROM access_grant g WHERE g.organisation_id = ? AND g.grant_id = json_extract(checked.value, '$.id')
      AND g.lifecycle = 'active' AND g.revision = json_extract(checked.value, '$.revision')))
  AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(?, '$.accounts')) checked WHERE NOT EXISTS (
    SELECT 1 FROM integration_account a WHERE a.organisation_id = ? AND a.integration_account_id = json_extract(checked.value, '$.id')
      AND a.lifecycle = json_extract(checked.value, '$.lifecycle') AND a.updated_at = json_extract(checked.value, '$.updatedAt')
      AND a.audience_policy = json_extract(checked.value, '$.policyJson')))
  AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(?, '$.projects')) checked WHERE NOT EXISTS (
    SELECT 1 FROM project p WHERE p.organisation_id = ? AND p.project_id = json_extract(checked.value, '$.id')
      AND p.access_revision = json_extract(checked.value, '$.accessRevision') AND p.content_revision = json_extract(checked.value, '$.contentRevision')))`;
export function disclosureStateFenceBindings(
  state: DisclosureState,
  scope: ConversationScope,
): readonly (string | number | null)[] {
  const serialized = canonicalJson(state);
  return [
    scope.organisationId,
    state.organisationConfiguration.kind === "configured"
      ? state.organisationConfiguration.revision
      : null,
    scope.organisationId,
    state.policy.kind === "published" ? state.policy.version : null,
    serialized,
    scope.organisationId,
    serialized,
    scope.organisationId,
    serialized,
    scope.organisationId,
  ];
}
export function sameDisclosureState(
  before: DisclosureState,
  after: DisclosureState | null,
): boolean {
  return after !== null && canonicalJson(before) === canonicalJson(after);
}

export async function verifyStoredDisclosureProof(
  raw: unknown,
): Promise<boolean> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "state",
      "conversationId",
      "historyDigest",
      "audience",
      "decisionDigests",
      "digest",
    ]) ||
    !validStoredDisclosureState(raw.state) ||
    !isConversationId(raw.conversationId) ||
    !isDigest(raw.historyDigest) ||
    !isDigest(raw.digest) ||
    !Array.isArray(raw.audience) ||
    !raw.audience.every(isUserId) ||
    !Array.isArray(raw.decisionDigests) ||
    !raw.decisionDigests.every(isDigest)
  )
    return false;
  return (
    raw.digest ===
    (await sha256Hex(
      canonicalJson({
        state: raw.state,
        conversationId: raw.conversationId,
        historyDigest: raw.historyDigest,
        audience: raw.audience,
        decisionDigests: raw.decisionDigests,
      }),
    ))
  );
}

export function validStoredDisclosureState(raw: unknown): boolean {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "organisationConfiguration",
      "policy",
      "grants",
      "accounts",
      "projects",
    ]) ||
    !isRecord(raw.organisationConfiguration) ||
    !isRecord(raw.policy) ||
    !Array.isArray(raw.grants) ||
    !Array.isArray(raw.accounts) ||
    !Array.isArray(raw.projects)
  )
    return false;
  const configuration = raw.organisationConfiguration;
  const policy = raw.policy;
  if (
    !(
      configuration.kind === "unconfigured" &&
      hasExactKeys(configuration, ["kind"])
    ) &&
    !(
      configuration.kind === "configured" &&
      hasExactKeys(configuration, ["kind", "revision"]) &&
      isNonNegativeInteger(configuration.revision)
    )
  )
    return false;
  if (
    !(policy.kind === "unpublished" && hasExactKeys(policy, ["kind"])) &&
    !(
      policy.kind === "published" &&
      hasExactKeys(policy, ["kind", "version"]) &&
      isNonNegativeInteger(policy.version)
    )
  )
    return false;
  for (const grant of raw.grants) {
    if (
      !isRecord(grant) ||
      !hasExactKeys(grant, ["id", "revision"]) ||
      typeof grant.id !== "string" ||
      !isNonNegativeInteger(grant.revision)
    )
      return false;
  }
  for (const account of raw.accounts) {
    if (
      !isRecord(account) ||
      !hasExactKeys(account, ["id", "lifecycle", "updatedAt", "policyJson"]) ||
      typeof account.id !== "string" ||
      typeof account.lifecycle !== "string" ||
      !isNonNegativeInteger(account.updatedAt) ||
      typeof account.policyJson !== "string"
    )
      return false;
  }
  for (const project of raw.projects) {
    if (
      !isRecord(project) ||
      !hasExactKeys(project, ["id", "accessRevision", "contentRevision"]) ||
      typeof project.id !== "string" ||
      !isNonNegativeInteger(project.accessRevision) ||
      !isNonNegativeInteger(project.contentRevision)
    )
      return false;
  }
  return true;
}

function isDigest(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw);
}
