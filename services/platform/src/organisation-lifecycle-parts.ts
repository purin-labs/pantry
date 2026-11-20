import { prepareReplacedSurfaceTokenRevocation } from "./credential-vault";
import { prepareReadAndProposeAccessDefaults } from "./data/capability-policy";
import {
  prepareSurfaceInstallConnectionRows,
  prepareSurfaceReinstallConnectionRows,
} from "./data/integration-account";
import type { OrganisationLifecycleParts } from "./data/organisation-lifecycle-port";
import { prepareInitialOrganisationWorkspace } from "./data/organisation-workspace";
import { prepareReadinessAssessmentDeletion } from "./data/onboarding";
import { prepareServiceInvitationAcceptance } from "./data/service-invitation-role";
import {
  prepareChatDirectoryRevisionBump,
  prepareReturnPrivateChatsToDefault,
} from "./projects/case-project";
import {
  baseProjectId,
  prepareBaseProject,
  prepareBaseProjectMembership,
  prepareBaseProjectRoleChange,
  prepareProjectMembershipRevocation,
} from "./projects/default-project";

/**
 * The Worker gives the lifecycle batches of tenancy the statements of the
 * tables that other modules own. Each part comes from the owner of its
 * tables. Each part names its function when it runs, so a test that mocks
 * an owner module still loads the parts.
 */
export const ORGANISATION_LIFECYCLE_PARTS: OrganisationLifecycleParts = {
  creation: {
    baseProjectId: (organisationId) => baseProjectId(organisationId),
    baseProject: (session, input) => prepareBaseProject(session, input),
    accessDefaults: (session, input) =>
      prepareReadAndProposeAccessDefaults({
        source: session,
        admission: {
          kind: "organisation_creation",
          organisationId: input.organisationId,
          placement: input.placement,
        },
        materializationReceiptId: input.materializationReceiptId,
        now: input.now,
        destination: { kind: "organisation" },
      }),
    workspace: (session, input) =>
      prepareInitialOrganisationWorkspace(session, input),
    surfaceInstall: (session, input) =>
      prepareSurfaceInstallConnectionRows(session, input),
    surfaceReinstall: (session, input) =>
      prepareSurfaceReinstallConnectionRows(session, input),
    replacedSurfaceTokenRevocation: (session, input) =>
      prepareReplacedSurfaceTokenRevocation(session, input),
  },
  membership: {
    baseProjectRoleChange: (session, input) =>
      prepareBaseProjectRoleChange(session, input),
    memberRemoval: (session, input) => [
      ...prepareReturnPrivateChatsToDefault(session, {
        organisationId: input.organisationId,
        sourceProjectId: null,
        ownerUserId: input.userId,
        now: input.now,
        guard: null,
      }),
      ...prepareProjectMembershipRevocation(session, {
        organisationId: input.organisationId,
        userId: input.userId,
        now: input.now,
        guard: null,
      }),
      prepareChatDirectoryRevisionBump(session, input.organisationId),
    ],
    readinessInvalidation: (session, organisationId) =>
      prepareReadinessAssessmentDeletion(session, organisationId),
    baseProjectMembership: (db, input) =>
      prepareBaseProjectMembership(db, input),
    invitationAcceptance: (db, input) =>
      prepareServiceInvitationAcceptance(db, input),
  },
};
