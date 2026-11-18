import { Select } from "../../ui/select";
import React from "react";
import { CircleAlert } from "lucide-react";
import { Link } from "react-router";

import type { AccessControlCapabilityView, AccessControlView } from "@seams/control-api/portal/access-models";
import {
  availabilityLabel,
  categoryLabel,
  connectIntegrationHref,
  modeLabel,
  providerDependencyLabel,
  riskLabel,
} from "./presentation";

export function CapabilityListView(
  props: Readonly<{
    view: AccessControlView;
    /** The search that the page opens with, such as one system's name. */
    initialSearch: string;
    busy: boolean;
    integrationsPath: string | null;
    changeMode: (
      capability: AccessControlCapabilityView,
      mode: AccessControlCapabilityView["mode"],
    ) => void;
    applyDefaults: () => void;
  }>,
): React.ReactNode {
  const canManage = props.view.organisation.actions.kind === "manage";
  const [search, setSearch] = React.useState(props.initialSearch);
  const [modeFilter, setModeFilter] = React.useState<ModeFilter>("all");
  const terms = searchTerms(search);
  const matching = props.view.capabilities.filter(
    matchesCapability.bind(null, terms, modeFilter),
  );
  const narrowed = terms.length > 0 || modeFilter !== "all";
  return (
    <section
      className="access35-section"
      aria-labelledby="access35-capabilities-title"
    >
      <div className="access35-section-heading">
        <div>
          <h2 id="access35-capabilities-title">What can be done</h2>
          <p>Choose what runs by itself, what asks first, and what stays off.</p>
        </div>
        {canManage ? (
          <button
            type="button"
            className="connection-primary-action"
            disabled={props.busy}
            onClick={props.applyDefaults}
          >
            Apply recommended access
          </button>
        ) : null}
      </div>
      <div className="access35-filters" aria-label="Find an action">
        <label>
          <span>Find an action</span>
          <input
            type="search"
            value={search}
            onChange={changeSearch.bind(null, setSearch)}
            placeholder="Search actions, such as email or refund…"
          />
        </label>
        <label>
          <span>Show</span>
          <Select.Root
            items={MODE_FILTER_OPTIONS}
            value={modeFilter}
            onValueChange={changeModeFilter.bind(null, setModeFilter)}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {MODE_FILTER_OPTIONS.map(renderModeOption)}
            </Select.Popup>
          </Select.Root>
        </label>
      </div>
      {narrowed ? (
        <p className="access35-result-count" role="status">
          {matching.length === 0
            ? "No action matches. Clear the search or the mode."
            : `${matching.length} of ${props.view.capabilities.length} actions`}
        </p>
      ) : null}
      <div className="access35-capability-groups">
        {groupCapabilities(matching).map(
          renderCapabilityGroup.bind(
            null,
            props.busy,
            props.integrationsPath,
            props.changeMode,
          ),
        )}
      </div>
    </section>
  );
}

type ModeFilter = "all" | AccessControlCapabilityView["mode"];

const MODE_FILTER_OPTIONS: readonly Readonly<{
  value: ModeFilter;
  label: string;
}>[] = [
  { value: "all", label: "All actions" },
  { value: "enabled", label: modeLabel("enabled") },
  { value: "approval_required", label: modeLabel("approval_required") },
  { value: "disabled", label: modeLabel("disabled") },
];

function searchTerms(search: string): readonly string[] {
  return search.toLowerCase().split(/\s+/u).filter(isNotEmpty);
}

function isNotEmpty(term: string): boolean {
  return term.length > 0;
}

/** Each term must be in the action's name, description, group or provider. */
function matchesCapability(
  terms: readonly string[],
  modeFilter: ModeFilter,
  capability: AccessControlCapabilityView,
): boolean {
  if (modeFilter !== "all" && capability.mode !== modeFilter) return false;
  const text = [
    capability.definition.label,
    capability.definition.description,
    capability.definition.capabilityId,
    categoryLabel(capability.definition.category),
    providerDependencyLabel(capability.definition.providerDependency),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every(isIn.bind(null, text));
}

function isIn(text: string, term: string): boolean {
  return text.includes(term);
}

function changeSearch(
  change: (value: string) => void,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  change(event.currentTarget.value);
}

function changeModeFilter(
  change: (value: ModeFilter) => void,
  value: string | null,
): void {
  if (
    value === "all" ||
    value === "enabled" ||
    value === "approval_required" ||
    value === "disabled"
  )
    change(value);
}

function renderCapability(
  busy: boolean,
  integrationsPath: string | null,
  changeMode: (
    capability: AccessControlCapabilityView,
    mode: AccessControlCapabilityView["mode"],
  ) => void,
  capability: AccessControlCapabilityView,
): React.ReactNode {
  const modes = capabilityModeOptions(capability);
  return (
    <li
      className="access35-action-row"
      key={`${capability.definition.capabilityId}@${capability.definition.capabilityVersion}`}
    >
      <div className="access35-action-text">
        <h4>{capability.definition.label}</h4>
        <p>{capability.definition.description}</p>
        <small>{capabilityMeta(capability)}</small>
        {renderCapabilityNote(integrationsPath, capability)}
      </div>
      {capability.actions.kind === "change_capability_mode" ? (
        <Select.Root
          items={modes}
          value={capability.mode}
          disabled={busy}
          onValueChange={changeCapabilityMode.bind(
            null,
            changeMode,
            capability,
          )}
        >
          <Select.Trigger aria-label={`Mode for ${capability.definition.label}`}>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>{modes.map(renderModeOption)}</Select.Popup>
        </Select.Root>
      ) : (
        <p className="access35-mode-readonly">{modeLabel(capability.mode)}</p>
      )}
    </li>
  );
}

/** What the action does, what it needs and who has it, in one quiet line. */
function capabilityMeta(capability: AccessControlCapabilityView): string {
  const { definition, activeGrantCount, availability } = capability;
  const parts = [riskLabel(definition.risk)];
  if (definition.providerDependency.kind !== "none")
    parts.push(`Uses ${providerDependencyLabel(definition.providerDependency)}`);
  if (activeGrantCount > 0) parts.push(`Shared with ${activeGrantCount}`);
  if (availability !== "available") parts.push(availabilityLabel(availability));
  return parts.join(" · ");
}

function renderCapabilityNote(
  integrationsPath: string | null,
  capability: AccessControlCapabilityView,
): React.ReactNode {
  if (capability.mode === "disabled" && capability.activeGrantCount > 0) {
    return (
      <p className="access35-note">
        <CircleAlert aria-hidden="true" size={17} /> Off for everyone it is
        shared with. The shares stay listed and work again when you turn it on.
      </p>
    );
  }
  if (
    capability.availability !== "unavailable" ||
    capability.definition.providerDependency.kind === "none"
  )
    return null;
  const dependency = providerDependencyLabel(
    capability.definition.providerDependency,
  );
  return (
    <p className="access35-note">
      <CircleAlert aria-hidden="true" size={17} />
      {integrationsPath === null ? (
        `Needs ${dependency} connected.`
      ) : (
        <>
          Needs {dependency} connected.{" "}
          <Link
            to={connectIntegrationHref(
              integrationsPath,
              capability.definition.providerDependency,
            )}
          >
            Connect it in Integrations
          </Link>
        </>
      )}
    </p>
  );
}

type CapabilityGroup = Readonly<{
  category: string;
  capabilities: readonly AccessControlCapabilityView[];
}>;

function groupCapabilities(
  capabilities: readonly AccessControlCapabilityView[],
): readonly CapabilityGroup[] {
  const categories = new Map<string, AccessControlCapabilityView[]>();
  for (const capability of capabilities) {
    const existing = categories.get(capability.definition.category);
    if (existing === undefined)
      categories.set(capability.definition.category, [capability]);
    else existing.push(capability);
  }
  const groups: CapabilityGroup[] = [];
  for (const [category, grouped] of categories)
    groups.push({ category, capabilities: grouped });
  return groups;
}

function renderCapabilityGroup(
  busy: boolean,
  integrationsPath: string | null,
  changeMode: (
    capability: AccessControlCapabilityView,
    mode: AccessControlCapabilityView["mode"],
  ) => void,
  group: CapabilityGroup,
): React.ReactNode {
  return (
    <section
      className="access35-capability-group"
      key={group.category}
      aria-labelledby={`access35-category-${group.category}`}
    >
      <h3 id={`access35-category-${group.category}`}>
        {categoryLabel(group.category)}
      </h3>
      <ul className="access35-action-list">
        {group.capabilities.map(
          renderCapability.bind(null, busy, integrationsPath, changeMode),
        )}
      </ul>
    </section>
  );
}

function capabilityModeOptions(capability: AccessControlCapabilityView) {
  switch (capability.definition.policyModes) {
    case "enabled_disabled":
      return [
        { value: "enabled", label: modeLabel("enabled") },
        { value: "disabled", label: modeLabel("disabled") },
      ];
    case "approval_required_disabled":
      return [
        { value: "approval_required", label: modeLabel("approval_required") },
        { value: "disabled", label: modeLabel("disabled") },
      ];
    case "enabled_approval_required_disabled":
      return [
        { value: "enabled", label: modeLabel("enabled") },
        { value: "approval_required", label: modeLabel("approval_required") },
        { value: "disabled", label: modeLabel("disabled") },
      ];
  }
}

function renderModeOption(
  option: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={option.value} value={option.value}>
      {option.label}
    </Select.Item>
  );
}

function changeCapabilityMode(
  change: (
    capability: AccessControlCapabilityView,
    mode: AccessControlCapabilityView["mode"],
  ) => void,
  capability: AccessControlCapabilityView,
  mode: string | null,
): void {
  if (mode === "enabled" || mode === "approval_required" || mode === "disabled")
    change(capability, mode);
}
