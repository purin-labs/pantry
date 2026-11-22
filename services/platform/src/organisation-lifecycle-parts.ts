import { prepareReplacedSurfaceTokenRevocation } from "@purin-labs/authority/credential-vault/index";
import { prepareReadAndProposeAccessDefaults } from "@purin-labs/authority/data/capability-policy";
import {
  prepareSurfaceInstallConnectionRows,
  prepareSurfaceReinstallConnectionRows,
} from "@purin-labs/connections/data/integration-account";
import {
  prepareArchivedOrganisationAccountsDisable,
  prepareArchivedOrganisationWebhooksDisable,
  prepareOrganisationPurgeAccounts,
} from "@purin-labs/connections/data/integration-account-writes";
import type { OrganisationLifecycleParts } from "@purin-labs/tenancy/data/organisation-lifecycle-port";
import { prepareInitialOrganisationWorkspace } from "./data/organisation-workspace";
import { prepareReadinessAssessmentDeletion } from "./data/onboarding";
import {
  prepareArchivedOrganisationConnectionsDisable,
  prepareOrganisationPurgeConnections,
} from "@purin-labs/connections/data/provider-connection-writes";
import { prepareOrganisationPurgeCredentialGenerations } from "@purin-labs/connections/data/provider-credential-generation";
import {
  prepareSlackInstallationCredentialMove,
  prepareSlackInstallationRevocation,
} from "@purin-labs/authority/data/slack-installation-records";
import {
  directorySlackRecordDeletions,
} from "./slack/organisation-routing";
import {
  prepareChatDirectoryRevisionBump,
  prepareReturnPrivateChatsToDefault,
} from "./projects/case-project";
import {
  baseProjectId,
  prepareBaseProject,
  prepareBaseProjectMembership,
  prepareBaseProjectRoleChange,
  prepareOrganisationProjectMembersDeletion,
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
  },
  archive: {
    connectionsDisable: (session, input) => [
      prepareArchivedOrganisationAccountsDisable(session, input),
      prepareArchivedOrganisationConnectionsDisable(session, input),
      prepareArchivedOrganisationWebhooksDisable(session, input),
    ],
    projectMembersDeletion: (session, input) =>
      prepareOrganisationProjectMembersDeletion(session, input),
  },
  purge: {
    pseudonymize: {
      integration_account: (context) =>
        prepareOrganisationPurgeAccounts(context),
      provider_credential_generation: (context) =>
        prepareOrganisationPurgeCredentialGenerations(context),
      provider_connection: (context) =>
        prepareOrganisationPurgeConnections(context),
    },
    directoryRecordDeletions: (directory, organisationId) =>
      directorySlackRecordDeletions(directory, organisationId),
    slackInstallationRevocation: (directory, input) =>
      prepareSlackInstallationRevocation(directory, input),
    slackInstallationCredentialMove: (directory, input) =>
      prepareSlackInstallationCredentialMove(directory, input),
  },
};
