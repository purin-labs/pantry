import type {
  MailboxSetupAgent,
  MailboxSetupAgentChoice,
  MailboxSetupChange,
  MailboxSetupPlan,
  MailboxSetupRequirement,
  MailboxSetupRequirementId,
} from "@purin-labs/control-api";
import { MAILBOX_SETUP_REQUIREMENTS } from "@purin-labs/control-api";
import type { CapabilityMode } from "@purin-labs/contracts";

import { readAccessControlView } from "@purin-labs/authority/access-control/read-model";
import { opaqueSubjectReference } from "@purin-labs/authority/access-control/references";
import type { AccessGrant } from "@purin-labs/authority/authorization/access-grants/types";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import {
  readAgentOperations,
  type AgentDefinition,
  type AgentInstallation,
  type AgentOperationInput,
  type AgentOperationsSnapshot,
} from "@purin-labs/agent/data/agent-operations";
import type { ControlRole } from "@purin-labs/tenancy/data/control-plane";
import {
  readAgentMailboxBinding,
  readEmailMailboxAccount,
} from "../data/email-mailbox";
import { readGmailModelState } from "./gmail-model-consent";
import type { Env } from "@purin-labs/kernel/env";
import type { IntegrationAccountId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";

/**
 * The mail agent that Pantry creates for a workspace that has no agent. The
 * role names it, so that a second read of the plan finds the agent that the
 * first one asked for.
 */
const MAIL_AGENT = {
  displayName: "Mail assistant",
  role: "mail_assistant",
  purpose: "Reads the mail of a connected mailbox and prepares replies.",
  instructions:
    "You answer the email of this workspace. Read the thread and what the " +
    "workspace knows about its sender. Write a short, plain reply that " +
    "answers what was asked. When you are not sure, or the reply commits " +
    "the business to something, leave the reply for a person to approve.",
} as const;

/** The area a workspace gets when it has none. An agent is active in one. */
const MAIL_AREA = {
  name: "Mail",
  purpose: "Mail that agents read and answer.",
} as const;

/** The roles that turn a mailbox on. They also review its drafts. */
const REVIEWER_ROLES = ["owner", "admin"] as const;

type MailboxSetupError = Readonly<{
  code:
    | "agent_mailbox_not_connected"
    | "mailbox_setup_agent_unavailable"
    | "mailbox_setup_unavailable";
}>;

/**
 * Reads what one connected mailbox still needs, and the next change.
 *
 * Each requirement is read from the record that a mail turn or a draft
 * review reads. The read changes nothing.
 */
export async function readMailboxSetupPlan(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    integrationAccountId: IntegrationAccountId;
    choice: MailboxSetupAgentChoice;
    requesterRole: ControlRole;
    now: number;
  }>,
): Promise<Result<MailboxSetupPlan, MailboxSetupError>> {
  const { scope, integrationAccountId } = input;
  const target = {
    db: scope.database,
    organisationId: scope.organisationId,
    integrationAccountId,
  };
  const [mailbox, binding, operations, access, grants, model] =
    await Promise.all([
      readEmailMailboxAccount(target),
      readAgentMailboxBinding(target),
      readAgentOperations(scope.database, scope.organisationId),
      readAccessControlView({
        db: scope.database,
        organisationId: scope.organisationId,
        requesterRole: input.requesterRole,
        grantOffset: 0,
        sourcePolicyOffset: 0,
      }),
      listAccessGrants({
        db: scope.database,
        organisationId: scope.organisationId,
        lifecycle: "active",
      }),
      readGmailModelState(input),
    ]);
  if (!mailbox.ok) return failure("agent_mailbox_not_connected");
  if (!access.ok || !grants.ok) return failure("mailbox_setup_unavailable");

  const assigned = binding.ok
    ? {
        mailboxBindingId: binding.value.binding.mailboxBindingId,
        revision: binding.value.binding.currentRevision,
        installationId: binding.value.currentRevision.installationId,
      }
    : null;
  const agent = resolveAgent(
    operations,
    input.choice,
    assigned?.installationId ?? null,
  );
  if (agent === null) return failure("mailbox_setup_agent_unavailable");

  const met = new Set<MailboxSetupRequirementId>();
  let next: MailboxSetupChange | null = null;
  const propose = (change: MailboxSetupChange | null): void => {
    next ??= change;
  };

  // 1. The agent.
  if (agent.view.state === "assigned") met.add("agent");
  else propose(agent.change);

  const modes = new Map<
    string,
    Readonly<{ mode: CapabilityMode; revision: number }>
  >();
  for (const capability of access.value.capabilities)
    modes.set(capability.definition.capabilityId, {
      mode: capability.mode,
      revision: capability.revision,
    });
  const enabled = (capabilityId: string): boolean =>
    modes.get(capabilityId)?.mode === "enabled";
  const enable = (capabilityId: string): MailboxSetupChange | null => {
    const current = modes.get(capabilityId);
    return current === undefined
      ? null
      : {
          kind: "enable_action",
          capabilityId,
          body: {
            expectedRevision: access.value.revision,
            capabilityRevision: current.revision,
            capabilityVersion: 1,
            mode: "enabled",
          },
        };
  };

  // 2. Reply drafts. A turn's reply is refused when this action is off.
  if (enabled(CAPABILITY_KEYS.emailReplyPropose)) met.add("reply_drafts");
  else propose(enable(CAPABILITY_KEYS.emailReplyPropose));

  // 3. The agent reads the Case of a thread. The grant names the assignment
  //    and its revision, so a change of agent needs the grant again.
  if (assigned !== null && agent.view.state === "assigned") {
    const contextEnabled = enabled(CAPABILITY_KEYS.contextCaseRead);
    const granted = grants.value.some(
      (grant) =>
        grant.subject.kind === "agent_mailbox" &&
        grant.subject.integrationAccountId === integrationAccountId &&
        grant.subject.mailboxBindingId === assigned.mailboxBindingId &&
        grant.subject.bindingRevision === assigned.revision &&
        grant.target.kind === "platform_capability" &&
        grant.target.capabilityId === CAPABILITY_KEYS.contextCaseRead &&
        grant.target.capabilityVersion === 1,
    );
    if (contextEnabled && granted) met.add("agent_context");
    else if (!contextEnabled) propose(enable(CAPABILITY_KEYS.contextCaseRead));
    else
      propose({
        kind: "grant_access",
        body: {
          expectedRevision: access.value.revision,
          subjectRef: {
            subjectRefId: await opaqueSubjectReference(scope.organisationId, {
              kind: "agent_mailbox",
              firstId: integrationAccountId,
              secondId: assigned.mailboxBindingId,
              revision: assigned.revision,
            }),
            revision: assigned.revision,
          },
          target: {
            kind: "platform",
            capabilityRef: {
              capabilityId: CAPABILITY_KEYS.contextCaseRead,
              capabilityVersion: 1,
            },
          },
        },
      });
  }

  // 4. Owners and admins read the mailbox and its drafts in Pantry.
  const readEnabled = enabled(CAPABILITY_KEYS.emailMailboxRead);
  const withoutRead = REVIEWER_ROLES.filter(
    (role) =>
      !grants.value.some(readsMailbox.bind(null, role, integrationAccountId)),
  );
  if (readEnabled && withoutRead.length === 0) met.add("review");
  else if (!readEnabled) propose(enable(CAPABILITY_KEYS.emailMailboxRead));
  else {
    const role = withoutRead[0];
    if (role !== undefined)
      propose({
        kind: "grant_access",
        body: {
          expectedRevision: access.value.revision,
          subjectRef: {
            subjectRefId: await opaqueSubjectReference(scope.organisationId, {
              kind: "organisation_role",
              firstId: role,
              secondId: null,
              revision: 1,
            }),
            revision: 1,
          },
          target: {
            kind: "provider_resource",
            capabilityRef: {
              capabilityId: CAPABILITY_KEYS.emailMailboxRead,
              capabilityVersion: 1,
            },
            integrationRef: `integration:${integrationAccountId}`,
            resourceRef: `provider_resource:${EMAIL_MAILBOX_RESOURCE_SCOPE}`,
          },
        },
      });
  }

  // 5. The model. Purin reviewed it, and an owner or admin accepted its
  //    terms. Only the person's own checkbox gives the acceptance, so the
  //    plan has no change for it.
  if (model.kind === "approved") met.add("model");

  const requirements: MailboxSetupRequirement[] =
    MAILBOX_SETUP_REQUIREMENTS.map((id) => ({
      id,
      state: met.has(id) ? "met" : "missing",
    }));
  return {
    ok: true,
    value: { agent: agent.view, requirements, next, model },
  };
}

function failure(
  code: MailboxSetupError["code"],
): Result<never, MailboxSetupError> {
  return { ok: false, error: { code } };
}

function readsMailbox(
  role: string,
  integrationAccountId: IntegrationAccountId,
  grant: AccessGrant,
): boolean {
  return (
    grant.subject.kind === "organisation_role" &&
    grant.subject.role === role &&
    grant.target.kind === "provider_resource" &&
    grant.target.capabilityId === CAPABILITY_KEYS.emailMailboxRead &&
    grant.target.capabilityVersion === 1 &&
    grant.target.integrationAccountId === integrationAccountId &&
    grant.target.resourceScope === EMAIL_MAILBOX_RESOURCE_SCOPE
  );
}

type ResolvedAgent = Readonly<{
  view: MailboxSetupAgent;
  /** The change that brings the agent one step nearer to the mailbox. */
  change: MailboxSetupChange | null;
}>;

/**
 * Settles the choice on one agent and names its next change: create it, give
 * the workspace an area, make it active there, then assign it.
 */
function resolveAgent(
  operations: AgentOperationsSnapshot,
  choice: MailboxSetupAgentChoice,
  assignedInstallationId: string | null,
): ResolvedAgent | null {
  const definitions = operations.definitions.filter(isActiveDefinition);
  const installations = operations.installations.filter(isActiveInstallation);
  const nameOf = (agentDefinitionId: string): string | null =>
    operations.definitions.find(
      (definition) => definition.agentDefinitionId === agentDefinitionId,
    )?.displayName ?? null;

  const installed = (installation: AgentInstallation): ResolvedAgent | null => {
    const name = nameOf(installation.agentDefinitionId);
    if (name === null) return null;
    const assigned = installation.installationId === assignedInstallationId;
    return {
      view: {
        choice: {
          kind: "installation",
          installationId: installation.installationId,
        },
        name,
        state: assigned ? "assigned" : "ready",
      },
      change: assigned
        ? null
        : {
            kind: "assign_agent",
            body: { installationId: installation.installationId },
          },
    };
  };
  const defined = (definition: AgentDefinition): ResolvedAgent | null => {
    const installation = installations.find(
      (candidate) =>
        candidate.agentDefinitionId === definition.agentDefinitionId,
    );
    if (installation !== undefined) return installed(installation);
    const area = operations.areas.find((entry) => entry.lifecycle === "active");
    const operation: AgentOperationInput =
      area === undefined
        ? { kind: "create_area", ...MAIL_AREA }
        : {
            kind: "install_agent",
            agentDefinitionId: definition.agentDefinitionId,
            definitionRevision: definition.currentRevision.revision,
            areaId: area.areaId,
            responsibility: definition.purpose,
            scopeIds: [],
            policyRevision: 1,
            // A mailbox turn reads none of an installation's capabilities.
            grantedCapabilities: [],
          };
    return {
      view: {
        choice: {
          kind: "definition",
          agentDefinitionId: definition.agentDefinitionId,
        },
        name: definition.displayName,
        state: "inactive",
      },
      change: { kind: "agent_operation", body: operation },
    };
  };
  const created = (): ResolvedAgent | null => {
    const existing = definitions.find(
      (definition) => definition.role === MAIL_AGENT.role,
    );
    if (existing !== undefined) return defined(existing);
    const operation: AgentOperationInput = {
      kind: "create_agent_definition",
      ...MAIL_AGENT,
      requestedCapabilities: [],
      skillRefs: [],
    };
    return {
      view: {
        choice: { kind: "new" },
        name: MAIL_AGENT.displayName,
        state: "absent",
      },
      change: { kind: "agent_operation", body: operation },
    };
  };

  switch (choice.kind) {
    case "installation": {
      const installation = installations.find(
        (candidate) => candidate.installationId === choice.installationId,
      );
      return installation === undefined ? null : installed(installation);
    }
    case "definition": {
      const definition = definitions.find(
        (candidate) => candidate.agentDefinitionId === choice.agentDefinitionId,
      );
      return definition === undefined ? null : defined(definition);
    }
    case "new":
      return created();
    case "automatic": {
      const current = installations.find(
        (candidate) => candidate.installationId === assignedInstallationId,
      );
      if (current !== undefined) return installed(current);
      const [installation] = installations;
      if (installation !== undefined) return installed(installation);
      const [definition] = definitions;
      return definition === undefined ? created() : defined(definition);
    }
  }
}

function isActiveDefinition(definition: AgentDefinition): boolean {
  return definition.lifecycle === "active";
}

function isActiveInstallation(installation: AgentInstallation): boolean {
  return installation.lifecycle === "active";
}
