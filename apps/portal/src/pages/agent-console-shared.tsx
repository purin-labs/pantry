import React from "react";

import type {
  AgentConfigurationProposal,
  AgentDefinition,
  AgentInstallation,
  AgentOperationCommand,
  AgentOperationFormContext,
  AgentOperationKind,
  AgentOperationsSnapshot,
  CueBinding,
  OperationalArea,
  Skill,
  ScheduleBinding,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import {
  Notice,
  RecoverableError,
  type StatusChipStatus,
} from "../page-components";
import { humanizeIdentifier } from "../formatting";
import { assertNever } from "@purin-labs/std";
import type { AgentSkillRef } from "@purin-labs/control-api";

export type AgentOperationMutationState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "submitting";
      readonly formKey: string;
      readonly operation: AgentOperationKind;
    }
  | {
      readonly kind: "succeeded";
      readonly formKey: string;
      readonly message: string;
    }
  | {
      readonly kind: "failed";
      readonly formKey: string;
      readonly operation: AgentOperationKind;
      readonly message: string;
      readonly conflict: boolean;
    };

export type AgentOperationSubmitter = (
  formKey: string,
  kind: AgentOperationKind,
  event: React.FormEvent<HTMLFormElement>,
  context?: AgentOperationFormContext,
) => Promise<boolean>;

export type AgentOperationStep = {
  readonly kind: AgentOperationKind;
  readonly build: (
    current: AgentOperationsSnapshot,
    initial: AgentOperationsSnapshot,
  ) => AgentOperationCommand | null;
};

export type AgentOperationRunner = (
  formKey: string,
  successMessage: string,
  snapshot: AgentOperationsSnapshot,
  steps: readonly AgentOperationStep[],
  form: HTMLFormElement | null,
) => Promise<boolean>;

/** The area a workspace gets when it has none. An agent is active in one. */
const DEFAULT_AREA = {
  name: "General",
  purpose: "Work that agents do for this workspace.",
} as const;

/**
 * Makes an agent active: in the workspace's first area, with the tools that
 * its definition asks for. A workspace with no area gets one first. `find`
 * names the agent in the snapshot of the moment, so that the steps can
 * follow the step that creates it.
 */
export function activateAgentSteps(
  find: (
    current: AgentOperationsSnapshot,
    initial: AgentOperationsSnapshot,
  ) => AgentDefinition | null,
): readonly AgentOperationStep[] {
  return [
    {
      kind: "create_area",
      build: (current) =>
        current.areas.some(areaIsActive)
          ? null
          : { kind: "create_area", ...DEFAULT_AREA },
    },
    {
      kind: "install_agent",
      build: (current, initial) => {
        const definition = find(current, initial);
        const area = current.areas.find(areaIsActive);
        if (definition === null || area === undefined) return null;
        return {
          kind: "install_agent",
          agentDefinitionId: definition.agentDefinitionId,
          definitionRevision: definition.currentRevision.revision,
          areaId: area.areaId,
          responsibility: definition.purpose,
          scopeIds: [],
          policyRevision: 1,
          grantedCapabilities: definition.currentRevision.requestedCapabilities,
        };
      },
    },
  ];
}

function areaIsActive(area: AgentOperationsSnapshot["areas"][number]): boolean {
  return area.lifecycle === "active";
}

type CapabilityChoice = {
  readonly value: string;
  readonly label: string;
};

export const AGENT_CAPABILITIES: readonly CapabilityChoice[] = [
  {
    value: "commerce.entity_plane.context",
    label: "Read commerce data",
  },
  {
    value: "commerce.action.propose",
    label: "Propose commerce changes",
  },
];

export const CUE_CHOICES: readonly CapabilityChoice[] = [
  { value: "inventory_low_stock", label: "Low stock" },
  { value: "inventory_shortage", label: "Inventory shortage" },
];

export function cueEventLabel(value: string): string {
  const known = CUE_CHOICES.find(capabilityChoiceHasValue.bind(null, value));
  return known?.label ?? humanizeIdentifier(value);
}

export function capabilityLabel(value: string): string {
  const known = AGENT_CAPABILITIES.find(
    capabilityChoiceHasValue.bind(null, value),
  );
  return known?.label ?? humanizeIdentifier(value);
}

export function buildCapabilityChoice(value: string): CapabilityChoice {
  return { value, label: capabilityLabel(value) };
}

function capabilityChoiceHasValue(
  value: string,
  choice: CapabilityChoice,
): boolean {
  return choice.value === value;
}

export function MutationFeedback(props: {
  readonly mutation: AgentOperationMutationState;
  readonly formKey: string;
}): React.ReactNode {
  if (
    props.mutation.kind === "idle" ||
    props.mutation.formKey !== props.formKey
  )
    return null;
  switch (props.mutation.kind) {
    case "submitting":
      return (
        <Notice tone="neutral" announcement="polite">
          Saving…
        </Notice>
      );
    case "succeeded":
      return (
        <Notice tone="success" announcement="polite">
          {props.mutation.message}
        </Notice>
      );
    case "failed":
      return (
        <RecoverableError message={props.mutation.message} action={null} />
      );
    default:
      return assertNever(props.mutation, "Unhandled agent console value");
  }
}

export function CapabilityChoices(props: {
  readonly name: "requestedCapabilities" | "grantedCapabilities";
  readonly capabilities: readonly CapabilityChoice[];
  readonly selected: readonly string[] | "all";
  readonly disabled: boolean;
}): React.ReactNode {
  return (
    <fieldset className="permission-choices">
      <legend>Permissions</legend>
      {props.capabilities.length === 0 ? (
        <p>This agent does not request any permissions.</p>
      ) : (
        <div>
          {props.capabilities.map(
            renderCapabilityChoice.bind(
              null,
              props.name,
              props.disabled,
              props.selected,
            ),
          )}
        </div>
      )}
    </fieldset>
  );
}

function renderCapabilityChoice(
  name: "requestedCapabilities" | "grantedCapabilities",
  disabled: boolean,
  selected: readonly string[] | "all",
  capability: CapabilityChoice,
): React.ReactNode {
  return (
    <label key={capability.value}>
      <input
        type="checkbox"
        name={name}
        value={capability.value}
        defaultChecked={
          selected === "all" || selected.includes(capability.value)
        }
        disabled={disabled}
      />
      <span>{capability.label}</span>
    </label>
  );
}

export function lifecycleChip(
  lifecycle: "active" | "archived" | "suspended" | "published",
): StatusChipStatus {
  switch (lifecycle) {
    case "active":
      return { kind: "success", label: "Active" };
    case "published":
      return { kind: "success", label: "Published" };
    case "suspended":
      return { kind: "warning", label: "Suspended" };
    case "archived":
      return { kind: "neutral", label: "Archived" };
    default:
      return assertNever(lifecycle, "Unhandled agent console value");
  }
}

export function installationsForDefinition(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): readonly AgentInstallation[] {
  return snapshot.installations.filter(
    (installation) => installation.agentDefinitionId === agentDefinitionId,
  );
}

export function activeInstallationsForDefinition(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): readonly AgentInstallation[] {
  return installationsForDefinition(snapshot, agentDefinitionId).filter(
    (installation) => installation.lifecycle === "active",
  );
}

export function areaById(
  snapshot: AgentOperationsSnapshot,
  areaId: string,
): OperationalArea | null {
  return snapshot.areas.find((area) => area.areaId === areaId) ?? null;
}

export function skillById(
  snapshot: AgentOperationsSnapshot,
  skillId: string,
): Skill | null {
  return snapshot.skills.find((skill) => skill.skillId === skillId) ?? null;
}

export function definitionById(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): AgentDefinition | null {
  return (
    snapshot.definitions.find(
      (definition) => definition.agentDefinitionId === agentDefinitionId,
    ) ?? null
  );
}

/**
 * The skills this agent runs. A definition revision owns its complete skill
 * set, so publication is the only place attachments change.
 */
export function attachedSkillRefs(
  definition: AgentDefinition,
): readonly AgentSkillRef[] {
  return definition.currentRevision.skillRefs;
}

export function agentCueBindings(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): readonly CueBinding[] {
  const installationIds = installationIdSet(snapshot, agentDefinitionId);
  return snapshot.cueBindings.filter((binding) =>
    installationIds.has(binding.installationId),
  );
}

export function agentScheduleBindings(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): readonly ScheduleBinding[] {
  const installationIds = installationIdSet(snapshot, agentDefinitionId);
  return snapshot.scheduleBindings.filter((binding) =>
    installationIds.has(binding.installationId),
  );
}

function installationIdSet(
  snapshot: AgentOperationsSnapshot,
  agentDefinitionId: string,
): ReadonlySet<string> {
  return new Set(
    installationsForDefinition(snapshot, agentDefinitionId).map(
      (installation) => installation.installationId,
    ),
  );
}

export function openProposalsForDefinition(
  snapshot: AgentOperationsSnapshot,
  definition: AgentDefinition,
): readonly AgentConfigurationProposal[] {
  const installationIds = installationIdSet(
    snapshot,
    definition.agentDefinitionId,
  );
  return snapshot.configurationProposals.filter(
    (proposal) =>
      proposal.status === "open" &&
      ((proposal.targetKind === "agent_instructions" &&
        proposal.targetId === definition.agentDefinitionId) ||
        installationIds.has(proposal.installationId)),
  );
}

export function readFormText(values: FormData, name: string): string | null {
  const value = values.get(name);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

export function readFormList(
  values: FormData,
  name: string,
): readonly string[] {
  return values
    .getAll(name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function setMillisecondField(
  name: string,
): React.ChangeEventHandler<HTMLInputElement> {
  return (event) => {
    const form = event.currentTarget.form;
    const hidden = form?.elements.namedItem(name);
    const minutes = Number(event.currentTarget.value);
    if (hidden instanceof HTMLInputElement) {
      hidden.value =
        Number.isSafeInteger(minutes) && minutes > 0
          ? String(minutes * 60_000)
          : "";
    }
  };
}

export { humanizeIdentifier } from "../formatting";

export function runAsync(operation: () => Promise<void>): void {
  void operation();
}
