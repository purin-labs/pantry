/**
 * The lifecycle port of an Organisation (Refactor 17). Tenancy owns the
 * lifecycle batches: the creation, a membership change, the archive, the
 * restore and the purge of an Organisation. Each batch also writes rows of
 * tables that other modules own: the agent workspace, the Projects, the
 * access defaults, the connections and the Slack records.
 *
 * Only the owner of a table writes it. So the owner gives a part: a function
 * that returns the prepared statements of its tables for one place in one
 * batch. Tenancy puts them into the batch at that place, so the batch keeps
 * the same statements in the same order, with the same SQL text and the same
 * bind values. One D1 batch stays one D1 batch.
 *
 * The Worker gives the parts (`organisation-lifecycle-parts.ts`) before it
 * serves a request or starts an Actor. A read before that is a programmer
 * error.
 */
import type {
  OnboardingControlRole,
  SurfaceKind,
} from "@purin-labs/contracts";
import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import type { ProjectId } from "@purin-labs/control-api";
import type { OrganisationId, UserId } from "../ids";
import type { InitialOrganisationPlacement } from "../placement";
import type { RowGuard } from "./shared-rows/organisation-row";

/** The session of the batch. */
type Session = OrganisationDatabaseSession;

export type OrganisationLifecycleParts = Readonly<{
  creation: OrganisationCreationParts;
  membership: OrganisationMembershipParts;
  archive: OrganisationArchiveParts;
}>;

/** The parts of the creation batch and of the install batch of a surface. */
export type OrganisationCreationParts = Readonly<{
  /** The id of the base Project of an Organisation (conversation). */
  baseProjectId(organisationId: OrganisationId): Promise<ProjectId>;
  /** The base Project, its pointer and its first owner (conversation). */
  baseProject(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      projectId: ProjectId;
      ownerUserId: UserId | null;
      now: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** The read-and-propose access defaults of a new Organisation (authority). */
  accessDefaults(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      placement: InitialOrganisationPlacement;
      materializationReceiptId: string;
      now: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** The first workspace and the default workspace pointer (agent). */
  workspace(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      workspaceId: string;
      workspaceHandle: string;
      name: string;
      createdAt: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** The connection, credential and account rows of a new install (connections). */
  surfaceInstall(
    session: Session,
    input: Readonly<{
      surfaceKind: SurfaceKind;
      providerConnectionId: string;
      integrationAccountId: string;
      organisationId: OrganisationId;
      botTokenRef: string;
      scopesJson: string;
      userId: string;
      workspaceId: string;
      name: string;
      capabilitySetJson: string;
      audiencePolicyJson: string;
      retentionPolicyJson: string;
      createdAt: number;
      installedAt: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** The rows that a repeat install reactivates (connections). */
  surfaceReinstall(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      integrationAccountId: string;
      botTokenRef: string;
      name: string;
      capabilitySetJson: string;
      audiencePolicyJson: string;
      retentionPolicyJson: string;
      installedAt: number;
      live: RowGuard;
    }>,
  ): readonly D1PreparedStatement[];
  /** The revocation of the bot token that a repeat install replaces (authority). */
  replacedSurfaceTokenRevocation(
    session: Session,
    input: Readonly<{
      installedAt: number;
      organisationId: OrganisationId;
      integrationAccountId: string;
      botTokenRef: string;
      guard: RowGuard;
    }>,
  ): D1PreparedStatement;
}>;

/** The parts of the batches that change a member of an Organisation. */
type OrganisationMembershipParts = Readonly<{
  /** The member's role in the base Project follows a role change (conversation). */
  baseProjectRoleChange(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      userId: UserId;
      role: OnboardingControlRole;
      now: number;
    }>,
  ): readonly D1PreparedStatement[];
  /**
   * A removed member's private chats go back to the default Project, the
   * member leaves each Project, and the chat directory moves on
   * (conversation).
   */
  memberRemoval(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      userId: UserId;
      now: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** A membership change ends the readiness assessment (organisation). */
  readinessInvalidation(
    session: Session,
    organisationId: OrganisationId,
  ): D1PreparedStatement;
  /** The member of an accepted invitation joins the base Project (conversation). */
  baseProjectMembership(
    db: OrganisationDatabase,
    input: Readonly<{
      organisationId: OrganisationId;
      userId: UserId;
      role: OnboardingControlRole;
      now: number;
    }>,
  ): readonly D1PreparedStatement[];
  /** The invitation of an accepted membership is accepted (organisation). */
  invitationAcceptance(
    db: OrganisationDatabase,
    input: Readonly<{
      organisationId: OrganisationId;
      invitationId: string;
      userId: UserId;
      membershipId: string;
      acceptanceReceiptId: string;
      now: number;
    }>,
  ): D1PreparedStatement;
}>;

/** The parts of the archive batch and of the delete of an archived Organisation. */
type OrganisationArchiveParts = Readonly<{
  /** The archive disables the accounts, the connections and the webhooks (connections). */
  connectionsDisable(
    session: Session,
    input: Readonly<{
      organisationId: OrganisationId;
      actorUserId: UserId;
      now: number;
      guard: RowGuard;
    }>,
  ): readonly D1PreparedStatement[];
  /** The delete removes the members of each Project (conversation). */
  projectMembersDeletion(
    session: Session,
    input: Readonly<{ organisationId: OrganisationId; guard: RowGuard }>,
  ): D1PreparedStatement;
}>;

let provided: OrganisationLifecycleParts | null = null;

/** Gives the parts to tenancy. The Worker calls it when it loads. */
export function provideOrganisationLifecycleParts(
  parts: OrganisationLifecycleParts,
): void {
  provided = parts;
}

/** The parts that the Worker gave. */
export function organisationLifecycleParts(): OrganisationLifecycleParts {
  if (provided === null)
    throw new Error(
      "The Organisation lifecycle parts are read before the Worker gave them.",
    );
  return provided;
}
