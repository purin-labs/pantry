import { Select } from "../ui/select";
import React from "react";

import type { AgentConfigurationProposal, AgentDefinition, AgentInstallation, AgentOperationsSnapshot, CueBinding, OperationalArea, Skill, ScheduleBinding } from "@seams/control-api/portal/agent-operations";
import { StatusChip, TechnicalDetails } from "../page-components";
import { SideDrawer } from "../ui";
import {
  DiffView,
  DocumentEditor,
  type AgentRevisionLoader,
} from "./agent-documents";
import {
  AGENT_CAPABILITIES,
  activateAgentSteps,
  activeInstallationsForDefinition,
  agentCueBindings,
  agentScheduleBindings,
  areaById,
  attachedSkillRefs,
  buildCapabilityChoice,
  capabilityLabel,
  CapabilityChoices,
  CUE_CHOICES,
  cueEventLabel,
  humanizeIdentifier,
  installationsForDefinition,
  lifecycleChip,
  MutationFeedback,
  openProposalsForDefinition,
  skillById,
  readFormList,
  readFormText,
  setMillisecondField,
  type AgentOperationMutationState,
  type AgentOperationRunner,
  type AgentOperationStep,
  type AgentOperationSubmitter,
} from "./agent-console-shared";
import type { AgentSkillRef, ScheduleWeekday } from "@seams/control-api";

type AgentDetailProps = {
  readonly snapshot: AgentOperationsSnapshot;
  readonly definition: AgentDefinition;
  readonly submit: AgentOperationSubmitter;
  readonly run: AgentOperationRunner;
  readonly mutation: AgentOperationMutationState;
  readonly canConfigure: boolean;
  readonly loadRevisions: AgentRevisionLoader;
};

export function AgentDetail(props: AgentDetailProps): React.ReactNode {
  const busy = props.mutation.kind === "submitting";
  return (
    <div className="agent-detail">
      <OverviewSection {...props} busy={busy} />
      <InstructionsSection {...props} busy={busy} />
      <ToolsSection {...props} busy={busy} />
      <TriggersSection {...props} busy={busy} />
      <RunNowSection {...props} busy={busy} />
      <LimitsSection {...props} busy={busy} />
    </div>
  );
}

type SectionProps = AgentDetailProps & { readonly busy: boolean };

function activateDetailAgent(props: SectionProps): void {
  void props.run(
    `activate:${props.definition.agentDefinitionId}`,
    `${props.definition.displayName} is active.`,
    props.snapshot,
    activateAgentSteps(() => props.definition),
    null,
  );
}

function OverviewSection(props: SectionProps): React.ReactNode {
  const installations = installationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const proposals = openProposalsForDefinition(
    props.snapshot,
    props.definition,
  );
  return (
    <section className="agent-section" aria-labelledby="agent-overview-title">
      <h3 id="agent-overview-title">Overview</h3>
      <div className="agent-overview-facts">
        <p>{props.definition.purpose}</p>
        <div className="chip-list">
          {/* An agent with no activation is "Not active", whatever the
              lifecycle of its definition, so the two chips never disagree. */}
          {installations.length === 0 &&
          props.definition.lifecycle === "active" ? null : (
            <StatusChip status={lifecycleChip(props.definition.lifecycle)} />
          )}
          {installations.length === 0 ? (
            <StatusChip status={{ kind: "warning", label: "Not active" }} />
          ) : (
            installations.map(renderInstallationChip.bind(null, props.snapshot))
          )}
        </div>
        {installations.length === 0 ? (
          <div className="empty-state">
            <p>
              This agent is not active yet. Activate it to let it work. To
              choose its area and tools yourself, use Tools and access below.
            </p>
            {props.canConfigure ? (
              <>
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={activateDetailAgent.bind(null, props)}
                >
                  Activate {props.definition.displayName}
                </button>
                <MutationFeedback
                  mutation={props.mutation}
                  formKey={`activate:${props.definition.agentDefinitionId}`}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {proposals.length === 0 ? null : (
        <div className="agent-proposals">
          <h4>Suggested changes</h4>
          <p>
            This agent suggested better instructions. Nothing changes until you
            accept a suggestion.
          </p>
          <div className="commerce-list">
            {proposals.map((proposal) => renderProposal(proposal, props))}
          </div>
        </div>
      )}
    </section>
  );
}

function renderInstallationChip(
  snapshot: AgentOperationsSnapshot,
  installation: AgentInstallation,
): React.ReactNode {
  const areaNames = installationAreaNames(snapshot, installation);
  return (
    <StatusChip
      key={installation.installationId}
      status={
        installation.lifecycle === "active"
          ? { kind: "success", label: `Assigned: ${areaNames}` }
          : {
              kind: "neutral",
              label: `${humanizeIdentifier(installation.lifecycle)}: ${areaNames}`,
            }
      }
    />
  );
}

function installationAreaNames(
  snapshot: AgentOperationsSnapshot,
  installation: AgentInstallation,
): string {
  const names = installation.areaAssignments.map(
    (assignment) =>
      areaById(snapshot, assignment.areaId)?.name ??
      humanizeIdentifier(assignment.areaId),
  );
  return names.length === 0 ? "no area" : names.join(", ");
}

function renderProposal(
  proposal: AgentConfigurationProposal,
  props: SectionProps,
): React.ReactNode {
  const formKey = `proposal:${proposal.proposalId}`;
  const targetLabel =
    proposal.targetKind === "agent_instructions"
      ? "Instruction update"
      : `Skill update for ${skillById(props.snapshot, proposal.targetId)?.title ?? "a skill"}`;
  const currentBody =
    proposal.targetKind === "agent_instructions"
      ? props.definition.currentRevision.instructions
      : (skillById(props.snapshot, proposal.targetId)?.currentRevision
          .markdownBody ?? "");
  return (
    <article className="commerce-card" key={proposal.proposalId}>
      <h4>{targetLabel}</h4>
      <p>{proposal.rationale}</p>
      <DiffView
        before={currentBody}
        after={proposal.proposedBody}
        label="Suggested change compared with the current text"
      />
      {props.canConfigure ? (
        <div className="proposal-decision">
          <form
            className="inline-form"
            onSubmit={props.submit.bind(
              null,
              formKey,
              "accept_configuration_proposal",
            )}
          >
            <input
              type="hidden"
              name="proposalId"
              value={proposal.proposalId}
            />
            <button
              type="submit"
              className="connection-primary-action"
              disabled={props.busy}
            >
              Accept and publish
            </button>
          </form>
          <form
            className="inline-form"
            onSubmit={props.submit.bind(
              null,
              formKey,
              "dismiss_configuration_proposal",
            )}
          >
            <input
              type="hidden"
              name="proposalId"
              value={proposal.proposalId}
            />
            <button type="submit" className="secondary" disabled={props.busy}>
              Dismiss
            </button>
          </form>
        </div>
      ) : (
        <p role="status">Waiting for an owner or admin to decide.</p>
      )}
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </article>
  );
}

function InstructionsSection(props: SectionProps): React.ReactNode {
  const revision = props.definition.currentRevision;
  const formKey = `instructions:${props.definition.agentDefinitionId}`;
  return (
    <section
      className="agent-section"
      aria-labelledby="agent-instructions-title"
    >
      <h3 id="agent-instructions-title">Instructions</h3>
      <p>
        What this agent is told at the start of every session. Markdown is
        supported.
      </p>
      {props.canConfigure ? (
        <DocumentEditor
          formKey={formKey}
          operation="publish_agent_definition_revision"
          hidden={[
            {
              name: "agentDefinitionId",
              value: props.definition.agentDefinitionId,
            },
            { name: "expectedRevision", value: String(revision.revision) },
            ...revision.requestedCapabilities.map(hiddenCapabilityField),
            ...revision.skillRefs.map(hiddenSkillRefField),
          ]}
          fieldName="instructions"
          label="Instructions"
          submitLabel="Publish instructions"
          currentBody={revision.instructions}
          currentRevision={revision.revision}
          rows={10}
          submit={props.submit}
          mutation={props.mutation}
          busy={props.busy}
          history={{
            target: {
              kind: "agent_definition",
              id: props.definition.agentDefinitionId,
            },
            load: props.loadRevisions,
          }}
        />
      ) : (
        <pre className="agent-document-preview">{revision.instructions}</pre>
      )}
      <PendingActivations {...props} />
      <AttachedSkills {...props} />
    </section>
  );
}

/**
 * Publishing records a version; it does not change what a running agent uses.
 * Each assignment shows its own Active version against the Published one, so
 * an update that has not been adopted is visible rather than silent.
 */
function PendingActivations(props: SectionProps): React.ReactNode {
  const installations = activeInstallationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  if (installations.length === 0) return null;
  const published = props.definition.currentRevision.revision;
  return (
    <div className="agent-activation">
      <h4>Versions</h4>
      <p>
        Published version {published}. Publishing does not change a running
        agent.
      </p>
      {installations.map((installation) => (
        <ActivationRow
          key={installation.installationId}
          {...props}
          installation={installation}
        />
      ))}
    </div>
  );
}

function ActivationRow(
  props: SectionProps & {
    readonly installation: AgentInstallation;
  },
): React.ReactNode {
  const published = props.definition.currentRevision.revision;
  const active = props.installation.definitionRevision;
  const areas = installationAreaNames(props.snapshot, props.installation);
  const scope = areas === "no area" ? "This assignment" : areas;
  const updateAvailable = active !== published;
  return (
    <div className="agent-activation-row">
      <p>
        {scope}:{" "}
        <StatusChip
          status={
            updateAvailable
              ? {
                  kind: "warning",
                  label: `Update available · active ${active}`,
                }
              : { kind: "success", label: `Active ${active}` }
          }
        />
      </p>
      {updateAvailable ? <ActivateUpdateForm {...props} /> : null}
    </div>
  );
}

function ActivateUpdateForm(
  props: SectionProps & {
    readonly installation: AgentInstallation;
  },
): React.ReactNode {
  const revision = props.definition.currentRevision;
  const formKey = `activate:${props.installation.installationId}`;
  if (!props.canConfigure) {
    return (
      <p className="empty-state">
        An owner or admin can activate the published version.
      </p>
    );
  }
  return (
    <form
      className="inline-form"
      onSubmit={props.submit.bind(
        null,
        formKey,
        "activate_agent_definition_revision",
      )}
    >
      <input
        type="hidden"
        name="installationId"
        value={props.installation.installationId}
      />
      <input
        type="hidden"
        name="expectedDefinitionRevision"
        value={props.installation.definitionRevision}
      />
      <input
        type="hidden"
        name="definitionRevision"
        value={revision.revision}
      />
      {revision.skillRefs.map((ref) => (
        <input key={ref.skillId} type="hidden" {...hiddenSkillRefField(ref)} />
      ))}
      <button type="submit" disabled={props.busy}>
        Activate update
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

/**
 * The preferences this merchant has accepted, and where each one applies.
 *
 * A revoked preference stays listed with the date it was withdrawn, because a
 * bare list of active ones would hide what an agent used to be told.
 */
function hiddenCapabilityField(capability: string): {
  readonly name: string;
  readonly value: string;
} {
  return { name: "requestedCapabilities", value: capability };
}

function hiddenSkillRefField(ref: AgentSkillRef): {
  readonly name: string;
  readonly value: string;
} {
  return { name: "skillRefs", value: `${ref.skillId}@${ref.revision}` };
}

/**
 * Renders the hidden fields that carry a definition's complete skill set into
 * a publication. Attaching or detaching a skill publishes a new revision, so
 * every submission must restate the whole set.
 */
function skillRefFields(refs: readonly AgentSkillRef[]): React.ReactNode {
  return refs.map((ref) => (
    <input
      key={ref.skillId}
      type="hidden"
      name="skillRefs"
      value={`${ref.skillId}@${ref.revision}`}
    />
  ));
}

function AttachedSkills(props: SectionProps): React.ReactNode {
  const refs = attachedSkillRefs(props.definition);
  const attached = refs
    .map((ref) => skillById(props.snapshot, ref.skillId))
    .filter((skill): skill is Skill => skill !== null);
  const available = props.snapshot.skills.filter(
    (skill) =>
      skill.lifecycle === "published" &&
      !refs.some((ref) => ref.skillId === skill.skillId),
  );
  return (
    <div className="agent-skills">
      <h4>Skills</h4>
      <p>Reusable instructions this agent follows alongside its own.</p>
      {attached.length === 0 ? (
        <p className="empty-state">No skills attached yet.</p>
      ) : (
        <div className="commerce-list">
          {attached.map((skill) => (
            <article className="commerce-card" key={skill.skillId}>
              <h4>{skill.title}</h4>
              <TechnicalDetails summary="Skill contents">
                <pre className="agent-document-preview">
                  {skill.currentRevision.markdownBody}
                </pre>
              </TechnicalDetails>
              {props.canConfigure ? (
                <DetachSkillForm {...props} refs={refs} skill={skill} />
              ) : null}
            </article>
          ))}
        </div>
      )}
      {props.canConfigure && available.length > 0 ? (
        <AttachSkillForm {...props} refs={refs} available={available} />
      ) : null}
    </div>
  );
}

function AttachSkillForm(
  props: SectionProps & {
    readonly refs: readonly AgentSkillRef[];
    readonly available: readonly Skill[];
  },
): React.ReactNode {
  const [selectedId, setSelectedId] = React.useState(
    props.available[0]?.skillId ?? "",
  );
  const selected =
    props.available.find((skill) => skill.skillId === selectedId) ??
    props.available[0] ??
    null;
  const formKey = `skill-attach:${props.definition.agentDefinitionId}`;
  if (selected === null) return null;
  const revision = props.definition.currentRevision;
  return (
    <form
      className="inline-form"
      onSubmit={props.submit.bind(
        null,
        formKey,
        "publish_agent_definition_revision",
      )}
    >
      <input
        type="hidden"
        name="agentDefinitionId"
        value={props.definition.agentDefinitionId}
      />
      <input type="hidden" name="expectedRevision" value={revision.revision} />
      <input type="hidden" name="instructions" value={revision.instructions} />
      {revision.requestedCapabilities.map((capability) => (
        <input
          key={capability}
          type="hidden"
          {...hiddenCapabilityField(capability)}
        />
      ))}
      {skillRefFields(props.refs)}
      <input
        type="hidden"
        name="skillRefs"
        value={`${selected.skillId}@${selected.currentRevision.revision}`}
      />
      <label>
        <span>Skill</span>
        <Select.Root
          name="skillSelection"
          items={props.available.map((skill) => ({
            value: skill.skillId,
            label: skill.title,
          }))}
          value={selected.skillId}
          onValueChange={selectValue.bind(null, setSelectedId)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {props.available.map((skill) => (
              <Select.Item key={skill.skillId} value={skill.skillId}>
                {skill.title}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <button type="submit" disabled={props.busy}>
        Attach skill
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function DetachSkillForm(
  props: SectionProps & {
    readonly refs: readonly AgentSkillRef[];
    readonly skill: Skill;
  },
): React.ReactNode {
  const formKey = `skill-detach:${props.definition.agentDefinitionId}:${props.skill.skillId}`;
  const revision = props.definition.currentRevision;
  const remaining = props.refs.filter(
    (ref) => ref.skillId !== props.skill.skillId,
  );
  return (
    <form
      className="inline-form"
      onSubmit={props.submit.bind(
        null,
        formKey,
        "publish_agent_definition_revision",
      )}
    >
      <input
        type="hidden"
        name="agentDefinitionId"
        value={props.definition.agentDefinitionId}
      />
      <input type="hidden" name="expectedRevision" value={revision.revision} />
      <input type="hidden" name="instructions" value={revision.instructions} />
      {revision.requestedCapabilities.map((capability) => (
        <input
          key={capability}
          type="hidden"
          {...hiddenCapabilityField(capability)}
        />
      ))}
      {skillRefFields(remaining)}
      <button type="submit" disabled={props.busy}>
        Remove {props.skill.title}
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function selectValue(
  setValue: React.Dispatch<React.SetStateAction<string>>,
  value: string | null,
): void {
  if (value !== null) setValue(value);
}

function ToolsSection(props: SectionProps): React.ReactNode {
  const revision = props.definition.currentRevision;
  const installations = installationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const formKey = `capabilities:${props.definition.agentDefinitionId}`;
  return (
    <section className="agent-section" aria-labelledby="agent-tools-title">
      <h3 id="agent-tools-title">Tools and access</h3>
      <p>
        What this agent asks to do, and what each assignment is allowed to do.
      </p>
      {props.canConfigure ? (
        <form
          className="stacked-form"
          key={`capabilities-${revision.revision}`}
          onSubmit={props.submit.bind(
            null,
            formKey,
            "publish_agent_definition_revision",
          )}
        >
          <input
            type="hidden"
            name="agentDefinitionId"
            value={props.definition.agentDefinitionId}
          />
          <input
            type="hidden"
            name="expectedRevision"
            value={revision.revision}
          />
          <input
            type="hidden"
            name="instructions"
            value={revision.instructions}
          />
          {skillRefFields(revision.skillRefs)}
          <CapabilityChoices
            name="requestedCapabilities"
            capabilities={AGENT_CAPABILITIES}
            selected={revision.requestedCapabilities}
            disabled={props.busy}
          />
          <button type="submit" disabled={props.busy}>
            Save requested permissions
          </button>
        </form>
      ) : (
        <div className="chip-list">
          {revision.requestedCapabilities.length === 0 ? (
            <p className="empty-state">This agent requests no permissions.</p>
          ) : (
            revision.requestedCapabilities.map((capability) => (
              <StatusChip
                key={capability}
                status={{ kind: "neutral", label: capabilityLabel(capability) }}
              />
            ))
          )}
        </div>
      )}
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
      <div className="agent-access">
        <h4>Assignments</h4>
        {installations.length === 0 ? (
          <p className="empty-state">
            Not active yet. Activate it above, or choose its operational area
            and tools here.
          </p>
        ) : (
          <div className="commerce-list">
            {installations.map(
              renderInstallationAccess.bind(
                null,
                props.snapshot,
                revision.requestedCapabilities,
              ),
            )}
          </div>
        )}
        {props.canConfigure ? <AssignAgentForm {...props} /> : null}
      </div>
    </section>
  );
}

function renderInstallationAccess(
  snapshot: AgentOperationsSnapshot,
  requested: readonly string[],
  installation: AgentInstallation,
): React.ReactNode {
  const missing = requested.filter(
    (capability) => !installation.grantedCapabilities.includes(capability),
  );
  return (
    <article className="commerce-card" key={installation.installationId}>
      <h4>{installationAreaNames(snapshot, installation)}</h4>
      <p>
        {installation.areaAssignments
          .map((assignment) => assignment.responsibility)
          .join("; ") || "No responsibility recorded."}
      </p>
      <div className="chip-list">
        {installation.grantedCapabilities.map((capability) => (
          <StatusChip
            key={capability}
            status={{ kind: "success", label: capabilityLabel(capability) }}
          />
        ))}
        {missing.map((capability) => (
          <StatusChip
            key={capability}
            status={{
              kind: "warning",
              label: `${capabilityLabel(capability)}: not granted`,
            }}
          />
        ))}
      </div>
    </article>
  );
}

function AssignAgentForm(props: SectionProps): React.ReactNode {
  const formKey = `assign:${props.definition.agentDefinitionId}`;
  const requested = props.definition.currentRevision.requestedCapabilities.map(
    buildCapabilityChoice,
  );
  const areas = props.snapshot.areas
    .filter((area) => area.lifecycle === "active")
    .map((area) => ({ value: area.areaId, label: area.name }));
  const scopes = props.snapshot.responsibilityScopes
    .filter((scope) => scope.lifecycle === "published")
    .map((scope) => ({ value: scope.scopeId, label: scope.scopeId }));
  return (
    <form
      className="stacked-form"
      onSubmit={submitAssignment.bind(null, props, formKey)}
    >
      <h5>Assign this agent</h5>
      <label>
        <span>Operational area</span>
        <Select.Root
          name="areaId"
          required
          items={areas}
          defaultValue={areas[0]?.value ?? null}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {areas.map((area) => (
              <Select.Item key={area.value} value={area.value}>
                {area.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <label>
        <span>Published responsibility scope</span>
        <Select.Root name="scopeIds" multiple items={scopes} defaultValue={[]}>
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {scopes.map((scope) => (
              <Select.Item key={scope.value} value={scope.value}>
                {scope.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
        <small>
          Scopes describe the business records. Explicit capabilities control
          read and command authority.
        </small>
      </label>
      <label>
        <span>Responsibility</span>
        <input
          name="responsibility"
          required
          minLength={2}
          defaultValue={props.definition.purpose}
        />
      </label>
      <CapabilityChoices
        name="grantedCapabilities"
        capabilities={requested}
        selected="all"
        disabled={props.busy}
      />
      <button type="submit" disabled={props.busy}>
        Assign agent
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function submitAssignment(
  props: SectionProps,
  formKey: string,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const areaId = readFormText(values, "areaId");
  const responsibility = readFormText(values, "responsibility");
  const scopeIds = readFormList(values, "scopeIds");
  const granted = readFormList(values, "grantedCapabilities");
  if (areaId === null || responsibility === null) return;
  const steps: readonly AgentOperationStep[] = [
    {
      kind: "install_agent",
      build: (current) => {
        const area = current.areas.find(
          (candidate) =>
            candidate.areaId === areaId && candidate.lifecycle === "active",
        );
        if (area === undefined) return null;
        return {
          kind: "install_agent",
          agentDefinitionId: props.definition.agentDefinitionId,
          definitionRevision: props.definition.currentRevision.revision,
          areaId: area.areaId,
          responsibility,
          scopeIds,
          policyRevision: 1,
          grantedCapabilities: granted,
        };
      },
    },
  ];
  void props.run(
    formKey,
    "Agent assigned.",
    props.snapshot,
    steps,
    event.currentTarget,
  );
}

function TriggersSection(props: SectionProps): React.ReactNode {
  const installations = activeInstallationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const cues = agentCueBindings(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const schedules = agentScheduleBindings(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const canAdd = props.canConfigure && installations.length > 0;
  const [adding, setAdding] = React.useState(false);
  const [kind, setKind] = React.useState<TriggerKind | null>(null);
  const signalKey = signalFormKey(props.definition.agentDefinitionId);
  const scheduleKey = scheduleFormKey(props.definition.agentDefinitionId);
  // A trigger that was added closes the drawer; the list shows it. A drawer
  // opened later keeps the same finished mutation and stays open.
  React.useEffect(() => {
    if (
      props.mutation.kind === "succeeded" &&
      (props.mutation.formKey === signalKey ||
        props.mutation.formKey === scheduleKey)
    )
      setAdding(false);
  }, [props.mutation, signalKey, scheduleKey]);
  return (
    <section className="agent-section" aria-labelledby="agent-triggers-title">
      <div className="agent-section-heading">
        <h3 id="agent-triggers-title">Triggers</h3>
        {canAdd ? (
          <button
            type="button"
            className="secondary-button"
            aria-haspopup="dialog"
            onClick={() => {
              setKind(null);
              setAdding(true);
            }}
          >
            Add trigger
          </button>
        ) : null}
      </div>
      <p>
        What starts this agent's work: signals from your commerce data and
        recurring schedules.
      </p>
      {cues.length === 0 && schedules.length === 0 ? (
        <p className="empty-state">
          No automatic triggers configured. Assign this agent to an active area
          to run it manually, or add an event or schedule to automate its work.
        </p>
      ) : (
        <div className="trigger-list">
          {cues.map(renderCueTrigger.bind(null, props))}
          {schedules.map(renderScheduleTrigger.bind(null, props))}
        </div>
      )}
      {!props.canConfigure ? null : installations.length === 0 ? (
        <p className="empty-state">Assign this agent before adding triggers.</p>
      ) : adding || props.mutation.kind !== "succeeded" ? null : (
        <>
          <MutationFeedback mutation={props.mutation} formKey={signalKey} />
          <MutationFeedback mutation={props.mutation} formKey={scheduleKey} />
        </>
      )}
      <SideDrawer
        open={canAdd && adding}
        title="Add trigger"
        close={setAdding.bind(null, false)}
      >
        <div className="side-drawer-body">
          <fieldset className="agent-trigger-kind">
            <legend>When should the agent run?</legend>
            {TRIGGER_KINDS.map((choice) => (
              <label key={choice.kind}>
                <input
                  type="radio"
                  name="triggerKind"
                  value={choice.kind}
                  checked={kind === choice.kind}
                  onChange={setKind.bind(null, choice.kind)}
                />
                <span>{choice.label}</span>
              </label>
            ))}
          </fieldset>
          {kind === "signal" ? (
            <AddSignalForm {...props} installations={installations} />
          ) : kind === "schedule" ? (
            <AddScheduleForm {...props} installations={installations} />
          ) : null}
        </div>
      </SideDrawer>
    </section>
  );
}

type TriggerKind = "signal" | "schedule";

const TRIGGER_KINDS: readonly {
  readonly kind: TriggerKind;
  readonly label: string;
}[] = [
  { kind: "signal", label: "When a signal arrives" },
  { kind: "schedule", label: "On a schedule" },
];

function signalFormKey(agentDefinitionId: string): string {
  return `trigger-signal:${agentDefinitionId}`;
}

function scheduleFormKey(agentDefinitionId: string): string {
  return `trigger-schedule:${agentDefinitionId}`;
}

function RunNowSection(props: SectionProps): React.ReactNode {
  if (!props.canConfigure) return null;
  const installations = activeInstallationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  return (
    <section className="agent-section" aria-labelledby="agent-run-now-title">
      <h3 id="agent-run-now-title">Run now</h3>
      {installations.length === 0 ? (
        <p className="empty-state">Assign this agent before you run it.</p>
      ) : (
        <RunNowForm {...props} installations={installations} />
      )}
    </section>
  );
}

function RunNowForm(
  props: SectionProps & {
    readonly installations: readonly AgentInstallation[];
  },
): React.ReactNode {
  const formKey = `manual-run:${props.definition.agentDefinitionId}`;
  const budgets = props.installations
    .map((installation) =>
      props.snapshot.governance.find(
        (entry) => entry.installationId === installation.installationId,
      ),
    )
    .filter((entry) => entry !== undefined);
  return (
    <form
      className="stacked-form"
      onSubmit={props.submit.bind(null, formKey, "dispatch_manual_run")}
    >
      <p>
        Start one run of this agent right away with the instruction below.
        {budgets.length > 0
          ? ` The session budget of ${budgets[0]?.maxSessionBudgetTokens.toLocaleString()} tokens applies.`
          : " The workspace policy budget applies."}
      </p>
      <AssignmentTargetFields
        snapshot={props.snapshot}
        installations={props.installations}
      />
      <label>
        <span>What should this run do?</span>
        <textarea name="instructionBody" required minLength={2} rows={4} />
      </label>
      <button type="submit" disabled={props.busy}>
        Run now
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function renderCueTrigger(
  props: SectionProps,
  binding: CueBinding,
): React.ReactNode {
  return renderTriggerRow(props, {
    bindingId: binding.bindingId,
    title: `On ${cueEventLabel(binding.cueEventType).toLowerCase()}`,
    detail: `Signal from ${humanizeIdentifier(binding.cueSource).toLowerCase()}`,
    enabled: binding.enabled,
    revision: binding.revision,
    instructionBody: binding.instructionBody,
    updateKind: "update_cue_binding",
  });
}

function renderScheduleTrigger(
  props: SectionProps,
  binding: ScheduleBinding,
): React.ReactNode {
  return renderTriggerRow(props, {
    bindingId: binding.bindingId,
    title: scheduleSpecLabel(binding.spec),
    detail:
      binding.spec.cadence === "hourly"
        ? "Recurring schedule"
        : `Recurring schedule · ${binding.spec.timezone}`,
    enabled: binding.enabled,
    revision: binding.revision,
    instructionBody: binding.instructionBody,
    updateKind: "update_schedule_binding",
  });
}

function scheduleSpecLabel(spec: ScheduleBinding["spec"]): string {
  switch (spec.cadence) {
    case "hourly":
      return `Hourly at :${String(spec.minuteOfHour).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${spec.timeOfDay}`;
    case "weekly":
      return `Weekly on ${WEEKDAY_LABELS[spec.weekday]} at ${spec.timeOfDay}`;
    default:
      return "Schedule";
  }
}

const CADENCES = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

const WEEKDAY_LABELS: Record<ScheduleWeekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function renderTriggerRow(
  props: SectionProps,
  row: {
    readonly bindingId: string;
    readonly title: string;
    readonly detail: string;
    readonly enabled: boolean;
    readonly revision: number;
    readonly instructionBody: string | null;
    readonly updateKind: "update_cue_binding" | "update_schedule_binding";
  },
): React.ReactNode {
  const formKey = `trigger:${row.bindingId}`;
  return (
    <div className="trigger-row" key={row.bindingId}>
      <div>
        <h4>{row.title}</h4>
        <p>{row.detail}</p>
        {row.instructionBody === null ? null : (
          <p className="trigger-instruction">
            When it fires: {row.instructionBody}
          </p>
        )}
      </div>
      <StatusChip
        status={
          row.enabled
            ? { kind: "success", label: "On" }
            : { kind: "neutral", label: "Off" }
        }
      />
      {props.canConfigure ? (
        <form
          className="inline-form"
          onSubmit={props.submit.bind(null, formKey, row.updateKind)}
        >
          <input type="hidden" name="bindingId" value={row.bindingId} />
          <input type="hidden" name="expectedRevision" value={row.revision} />
          <input type="hidden" name="enabled" value={String(!row.enabled)} />
          {row.instructionBody === null ? null : (
            <input
              type="hidden"
              name="instructionBody"
              value={row.instructionBody}
            />
          )}
          <button
            type="submit"
            className="secondary-button"
            disabled={props.busy}
          >
            {row.enabled ? "Turn off" : "Turn on"}
          </button>
        </form>
      ) : null}
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </div>
  );
}

function AddSignalForm(
  props: SectionProps & {
    readonly installations: readonly AgentInstallation[];
  },
): React.ReactNode {
  const formKey = signalFormKey(props.definition.agentDefinitionId);
  return (
    <form
      className="stacked-form"
      onSubmit={props.submit.bind(null, formKey, "configure_cue_binding")}
    >
      <input type="hidden" name="cueSource" value="commerce" />
      <input type="hidden" name="enabled" value="true" />
      <label>
        <span>Signal</span>
        <Select.Root
          name="cueEventType"
          items={CUE_CHOICES}
          defaultValue={CUE_CHOICES[0]?.value}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {CUE_CHOICES.map((choice) => (
              <Select.Item key={choice.value} value={choice.value}>
                {choice.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <AssignmentTargetFields
        snapshot={props.snapshot}
        installations={props.installations}
      />
      <label>
        <span>When it fires (optional)</span>
        <textarea
          name="instructionBody"
          rows={3}
          placeholder="Extra instructions for this trigger. Leave empty to use the built-in objective."
        />
      </label>
      <button type="submit" disabled={props.busy}>
        Add signal trigger
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function AddScheduleForm(
  props: SectionProps & {
    readonly installations: readonly AgentInstallation[];
  },
): React.ReactNode {
  const formKey = scheduleFormKey(props.definition.agentDefinitionId);
  const [cadence, setCadence] = React.useState<"hourly" | "daily" | "weekly">(
    "daily",
  );
  return (
    <form
      className="stacked-form"
      onSubmit={props.submit.bind(null, formKey, "configure_schedule_binding")}
    >
      <input type="hidden" name="enabled" value="true" />
      <label>
        <span>Cadence</span>
        <Select.Root
          name="cadence"
          items={CADENCES}
          value={cadence}
          onValueChange={selectCadence.bind(null, setCadence)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {CADENCES.map((choice) => (
              <Select.Item key={choice.value} value={choice.value}>
                {choice.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      {cadence === "hourly" ? (
        <label>
          <span>Minute of each hour</span>
          <input
            name="minuteOfHour"
            type="number"
            min={0}
            max={59}
            defaultValue="0"
            required
          />
        </label>
      ) : (
        <>
          {cadence === "weekly" ? (
            <label>
              <span>Day of week</span>
              <Select.Root name="weekday" items={WEEKDAY_LABELS} defaultValue="mon">
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Popup>
                  {Object.entries(WEEKDAY_LABELS).map(([value, label]) => (
                    <Select.Item key={value} value={value}>
                      {label}
                    </Select.Item>
                  ))}
                </Select.Popup>
              </Select.Root>
            </label>
          ) : null}
          <label>
            <span>Time of day</span>
            <input name="timeOfDay" type="time" defaultValue="07:00" required />
          </label>
          <label>
            <span>Timezone</span>
            <input name="timezone" defaultValue={defaultTimeZone()} required />
          </label>
        </>
      )}
      <AssignmentTargetFields
        snapshot={props.snapshot}
        installations={props.installations}
      />
      <label>
        <span>When it fires (optional)</span>
        <textarea
          name="instructionBody"
          rows={3}
          placeholder="What this agent should do on each run. Leave empty for a general review."
        />
      </label>
      <button type="submit" disabled={props.busy}>
        Add schedule
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function selectCadence(
  setCadence: React.Dispatch<
    React.SetStateAction<"hourly" | "daily" | "weekly">
  >,
  value: string | null,
): void {
  if (value === "hourly" || value === "daily" || value === "weekly")
    setCadence(value);
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

function AssignmentTargetFields(props: {
  readonly snapshot: AgentOperationsSnapshot;
  readonly installations: readonly AgentInstallation[];
}): React.ReactNode {
  const [selectedId, setSelectedId] = React.useState(
    props.installations[0]?.installationId ?? "",
  );
  const selected =
    props.installations.find(
      (installation) => installation.installationId === selectedId,
    ) ??
    props.installations[0] ??
    null;
  if (selected === null) return null;
  const areaId = selected.areaAssignments[0]?.areaId ?? "";
  const scopeIds = selected.areaAssignments[0]?.scopeIds ?? [];
  if (props.installations.length === 1) {
    return (
      <>
        <input
          type="hidden"
          name="installationId"
          value={selected.installationId}
        />
        <input type="hidden" name="areaId" value={areaId} />
        {scopeIds.map((scopeId) => (
          <input key={scopeId} type="hidden" name="scopeIds" value={scopeId} />
        ))}
      </>
    );
  }
  return (
    <>
      <label>
        <span>Assignment</span>
        <Select.Root
          name="installationId"
          items={props.installations.map((installation) => ({
            value: installation.installationId,
            label: installationAreaNames(props.snapshot, installation),
          }))}
          value={selected.installationId}
          onValueChange={selectValue.bind(null, setSelectedId)}
        >
          <Select.Trigger>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {props.installations.map((installation) => (
              <Select.Item
                key={installation.installationId}
                value={installation.installationId}
              >
                {installationAreaNames(props.snapshot, installation)}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </label>
      <input type="hidden" name="areaId" value={areaId} />
      {scopeIds.map((scopeId) => (
        <input key={scopeId} type="hidden" name="scopeIds" value={scopeId} />
      ))}
    </>
  );
}

function LimitsSection(props: SectionProps): React.ReactNode {
  const installations = activeInstallationsForDefinition(
    props.snapshot,
    props.definition.agentDefinitionId,
  );
  const areaIds = [
    ...new Set(
      installations.flatMap((installation) =>
        installation.areaAssignments.map((assignment) => assignment.areaId),
      ),
    ),
  ];
  return (
    <section className="agent-section" aria-labelledby="agent-limits-title">
      <h3 id="agent-limits-title">Limits</h3>
      <p>
        How much a session may spend, and when waiting work is raised to the
        owner.
      </p>
      {installations.length === 0 ? (
        <p className="empty-state">Assign this agent to configure limits.</p>
      ) : (
        <>
          {installations.map(renderBudgetForm.bind(null, props))}
          {areaIds.map((areaId) => renderEscalationForm(props, areaId))}
        </>
      )}
    </section>
  );
}

function renderBudgetForm(
  props: SectionProps,
  installation: AgentInstallation,
): React.ReactNode {
  const governance =
    props.snapshot.governance.find(
      (entry) => entry.installationId === installation.installationId,
    ) ?? null;
  const formKey = `budget:${installation.installationId}`;
  const label = installationAreaNames(props.snapshot, installation);
  if (!props.canConfigure) {
    return (
      <p key={installation.installationId}>
        {label}:{" "}
        {governance === null
          ? "uses the workspace policy budget."
          : `${governance.maxSessionBudgetTokens.toLocaleString()} tokens per session.`}
      </p>
    );
  }
  return (
    <form
      className="inline-form"
      key={`${installation.installationId}-${governance?.revision ?? 0}`}
      onSubmit={props.submit.bind(
        null,
        formKey,
        "configure_installation_governance",
      )}
    >
      <input
        type="hidden"
        name="installationId"
        value={installation.installationId}
      />
      <label>
        <span>Max tokens per session: {label}</span>
        <input
          name="maxSessionBudgetTokens"
          type="number"
          min={1}
          required
          defaultValue={
            governance === null ? "" : String(governance.maxSessionBudgetTokens)
          }
        />
      </label>
      <button type="submit" disabled={props.busy}>
        Save budget
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}

function renderEscalationForm(
  props: SectionProps,
  areaId: string,
): React.ReactNode {
  const policy =
    props.snapshot.escalationPolicies.find(
      (entry) => entry.areaId === areaId,
    ) ?? null;
  const area: OperationalArea | null = areaById(props.snapshot, areaId);
  const formKey = `escalation:${areaId}`;
  const scopeIds = props.snapshot.responsibilityScopes
    .filter(
      (scope) => scope.areaId === areaId && scope.lifecycle === "published",
    )
    .map((scope) => scope.scopeId);
  if (!props.canConfigure) {
    return (
      <p key={areaId}>
        {area?.name ?? humanizeIdentifier(areaId)}:{" "}
        {policy === null
          ? "no escalation rule yet."
          : `remind after ${Math.round(policy.approvalReminderAfterMs / 60_000)} min, escalate after ${Math.round(policy.escalateAfterMs / 60_000)} min.`}
      </p>
    );
  }
  return (
    <form
      className="inline-form"
      key={`${areaId}-${policy?.revision ?? 0}`}
      onSubmit={props.submit.bind(null, formKey, "configure_escalation_policy")}
    >
      <input type="hidden" name="areaId" value={areaId} />
      {scopeIds.map((scopeId) => (
        <input key={scopeId} type="hidden" name="scopeIds" value={scopeId} />
      ))}
      <input
        name="approvalReminderAfterMs"
        type="hidden"
        defaultValue={
          policy === null ? "" : String(policy.approvalReminderAfterMs)
        }
      />
      <label>
        <span>
          Remind after (minutes): {area?.name ?? humanizeIdentifier(areaId)}
        </span>
        <input
          type="number"
          min={1}
          required
          defaultValue={
            policy === null
              ? ""
              : String(Math.round(policy.approvalReminderAfterMs / 60_000))
          }
          onChange={setMillisecondField("approvalReminderAfterMs")}
        />
      </label>
      <input
        name="escalateAfterMs"
        type="hidden"
        defaultValue={policy === null ? "" : String(policy.escalateAfterMs)}
      />
      <label>
        <span>Escalate to owner after (minutes)</span>
        <input
          type="number"
          min={1}
          required
          defaultValue={
            policy === null
              ? ""
              : String(Math.round(policy.escalateAfterMs / 60_000))
          }
          onChange={setMillisecondField("escalateAfterMs")}
        />
      </label>
      <button type="submit" disabled={props.busy}>
        Save escalation
      </button>
      <MutationFeedback mutation={props.mutation} formKey={formKey} />
    </form>
  );
}
