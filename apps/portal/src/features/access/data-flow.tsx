import { Select } from "@purin-labs/ui/select";
import React from "react";
import { Link } from "react-router";

import {
  cancelDialog,
  DialogHeading,
  findOption,
  optionItem,
  renderOption,
  syncDialog,
} from "./dialog-elements";
import type {
  AccessControlGrantView,
  AccessControlOption,
  AccessControlSourcePolicyView,
  AccessControlSubjectView,
  AccessControlView,
} from "@purin-labs/control-api/portal/access-models";
import { Fact, StatusIcon } from "./presentation";

export type DataFlowCheck =
  | Readonly<{
      kind: "conversation_delivery";
      authority: AccessControlOption;
      destination: AccessControlOption;
    }>
  | Readonly<{
      kind: "tool_effect";
      authority: AccessControlOption;
      targetGrant: AccessControlGrantView;
    }>
  | Readonly<{
      kind: "context_read";
      authority: AccessControlOption;
      caseOption: AccessControlOption;
    }>;

type DataFlowCheckKind = DataFlowCheck["kind"];

const CHECK_KINDS: ReadonlyArray<{ value: DataFlowCheckKind; label: string }> =
  [
    {
      value: "conversation_delivery",
      label: "Deliver to a conversation or workflow",
    },
    { value: "tool_effect", label: "Use for a tool effect" },
    { value: "context_read", label: "Read into a Case" },
  ];

export function SourcePolicyListView(
  props: Readonly<{
    view: AccessControlView;
    accessPath: string;
    selectedSourceRefs: ReadonlySet<string>;
    toggleSource: (source: AccessControlSourcePolicyView) => void;
    checkSource: (source: AccessControlSourcePolicyView) => void;
    loadMore: () => void;
    loadingMore: boolean;
  }>,
): React.ReactNode {
  return (
    <section
      className="access35-section"
      aria-labelledby="access35-sources-title"
    >
      <div className="access35-section-heading">
        <div>
          <h2 id="access35-sources-title">Can this data be shared?</h2>
          <p>
            Select the information to include, then check its destination. Every
            source must permit delivery.
          </p>
        </div>
      </div>
      {props.view.sourceFlowPolicies.items.length === 0 ? (
        <div className="access35-empty">
          <h3>No protected sources yet</h3>
          <p>
            Granting read access to a connected resource creates its source
            policy here.
          </p>
          <Link className="access35-empty-action" to={props.accessPath}>
            Go to access grants
          </Link>
        </div>
      ) : (
        <ul className="access35-card-list">
          {props.view.sourceFlowPolicies.items.map(
            renderSource.bind(
              null,
              props.selectedSourceRefs,
              props.toggleSource,
              props.checkSource,
            ),
          )}
        </ul>
      )}
      {props.view.sourceFlowPolicies.nextCursor === null ? null : (
        <button
          type="button"
          className="secondary access35-load-more"
          disabled={props.loadingMore}
          onClick={props.loadMore}
        >
          {props.loadingMore ? "Loading more sources…" : "Load more sources"}
        </button>
      )}
    </section>
  );
}

export function DestinationCheckDialog(
  props: Readonly<{
    open: boolean;
    busy: boolean;
    sources: readonly AccessControlSourcePolicyView[];
    authorities: readonly AccessControlOption[];
    destinations: readonly AccessControlOption[];
    targetGrants: readonly AccessControlGrantView[];
    cases: readonly AccessControlOption[];
    close: () => void;
    submit: (check: DataFlowCheck) => void;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [checkKind, setCheckKind] = React.useState<DataFlowCheckKind>(
    "conversation_delivery",
  );
  const [authorityRef, setAuthorityRef] = React.useState("");
  const [targetRef, setTargetRef] = React.useState("");
  React.useEffect(syncDialog.bind(null, dialog, props.open), [props.open]);
  return (
    <dialog
      className="access35-dialog"
      ref={dialog}
      aria-labelledby="access35-data-flow-dialog-title"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <form
        method="dialog"
        onSubmit={submitDataFlowCheck.bind(
          null,
          props,
          checkKind,
          authorityRef,
          targetRef,
        )}
      >
        <DialogHeading
          id="access35-data-flow-dialog-title"
          title="Check destination"
          close={props.close}
        />
        <p>
          Evaluate these protected sources against one exact current
          destination, effect, or Case.
        </p>
        <ul className="access35-selected-sources">
          {props.sources.map(renderSelectedSource)}
        </ul>
        <label htmlFor="access35-check-kind">Question</label>
        <Select.Root
          required
          items={CHECK_KINDS}
          value={checkKind}
          onValueChange={changeCheckKind.bind(null, setCheckKind, setTargetRef)}
        >
          <Select.Trigger id="access35-check-kind" autoFocus>
            <Select.Value />
          </Select.Trigger>
          <Select.Popup>
            {CHECK_KINDS.map((item) => (
              <Select.Item
                key={item.value}
                value={item.value}
                disabled={
                  item.value === "context_read" && props.sources.length !== 1
                }
              >
                {item.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
        <label htmlFor="access35-authority">Who is using this data?</label>
        <Select.Root
          required
          items={props.authorities.map(optionItem)}
          value={authorityRef === "" ? null : authorityRef}
          onValueChange={(value) => setAuthorityRef(value ?? "")}
        >
          <Select.Trigger id="access35-authority">
            <Select.Value placeholder="Select a subject" />
          </Select.Trigger>
          <Select.Popup>{props.authorities.map(renderOption)}</Select.Popup>
        </Select.Root>
        <DataFlowTargetField
          checkKind={checkKind}
          targetRef={targetRef}
          destinations={props.destinations}
          targetGrants={props.targetGrants}
          cases={props.cases}
          change={setTargetRef}
        />
        <div className="access35-dialog-actions">
          <button type="button" className="secondary" onClick={props.close}>
            Cancel
          </button>
          <button type="submit" disabled={props.busy}>
            {props.busy ? "Checking data flow…" : "Check data flow"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DataFlowTargetField(
  props: Readonly<{
    checkKind: DataFlowCheckKind;
    targetRef: string;
    destinations: readonly AccessControlOption[];
    targetGrants: readonly AccessControlGrantView[];
    cases: readonly AccessControlOption[];
    change: React.Dispatch<React.SetStateAction<string>>;
  }>,
): React.ReactNode {
  switch (props.checkKind) {
    case "conversation_delivery":
      return (
        <>
          <label htmlFor="access35-check-target">Destination</label>
          <Select.Root
            required
            items={props.destinations.map(optionItem)}
            value={props.targetRef === "" ? null : props.targetRef}
            onValueChange={(value) => props.change(value ?? "")}
          >
            <Select.Trigger id="access35-check-target">
              <Select.Value placeholder="Select a conversation or workflow" />
            </Select.Trigger>
            <Select.Popup>
              {props.destinations.map(renderOption)}
            </Select.Popup>
          </Select.Root>
        </>
      );
    case "tool_effect":
      return (
        <>
          <label htmlFor="access35-check-target">Tool effect</label>
          <Select.Root
            required
            items={props.targetGrants.map(targetGrantItem)}
            value={props.targetRef === "" ? null : props.targetRef}
            onValueChange={(value) => props.change(value ?? "")}
          >
            <Select.Trigger id="access35-check-target">
              <Select.Value placeholder="Select a capability and exact target" />
            </Select.Trigger>
            <Select.Popup>
              {props.targetGrants.map(renderTargetGrantOption)}
            </Select.Popup>
          </Select.Root>
        </>
      );
    case "context_read":
      return (
        <>
          <label htmlFor="access35-check-target">Case</label>
          <Select.Root
            required
            items={props.cases.map(optionItem)}
            value={props.targetRef === "" ? null : props.targetRef}
            onValueChange={(value) => props.change(value ?? "")}
          >
            <Select.Trigger id="access35-check-target">
              <Select.Value placeholder="Select a current Case" />
            </Select.Trigger>
            <Select.Popup>{props.cases.map(renderOption)}</Select.Popup>
          </Select.Root>
        </>
      );
  }
}

function renderSource(
  selected: ReadonlySet<string>,
  toggle: (source: AccessControlSourcePolicyView) => void,
  check: (source: AccessControlSourcePolicyView) => void,
  source: AccessControlSourcePolicyView,
): React.ReactNode {
  const checked = selected.has(source.sourceRefId);
  return (
    <li className="access35-source-card" key={source.sourceRefId}>
      <div className="access35-card-lead">
        <StatusIcon
          status={
            source.availability.kind === "available"
              ? "available"
              : "unavailable"
          }
        />
        <div>
          <h3>{source.resourceLabel}</h3>
          <p>
            {source.owner.label} · {source.capability.label}
          </p>
        </div>
      </div>
      <dl className="access35-card-facts">
        <Fact
          label="Readers"
          value={
            source.readers.length === 0
              ? "None available"
              : source.readers.map(subjectLabel).join(", ")
          }
        />
        <Fact
          label="Status"
          value={
            source.availability.kind === "available"
              ? "Available"
              : "Unavailable"
          }
        />
      </dl>
      <div className="access35-source-actions">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={checked}
            onChange={toggle.bind(null, source)}
          />
          <span>Include in destination check</span>
        </label>
        <button
          type="button"
          className="secondary"
          onClick={check.bind(null, source)}
        >
          Check destination
        </button>
      </div>
    </li>
  );
}

function submitDataFlowCheck(
  props: Parameters<typeof DestinationCheckDialog>[0],
  checkKind: DataFlowCheckKind,
  authorityRef: string,
  targetRef: string,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const authority = findOption(props.authorities, authorityRef);
  if (authority === null) return;
  switch (checkKind) {
    case "conversation_delivery": {
      const destination = findOption(props.destinations, targetRef);
      if (destination !== null)
        props.submit({ kind: checkKind, authority, destination });
      return;
    }
    case "tool_effect": {
      const targetGrant = findTargetGrant(props.targetGrants, targetRef);
      if (targetGrant !== null)
        props.submit({ kind: checkKind, authority, targetGrant });
      return;
    }
    case "context_read": {
      const caseOption = findOption(props.cases, targetRef);
      if (caseOption !== null && props.sources.length === 1)
        props.submit({ kind: checkKind, authority, caseOption });
      return;
    }
  }
}

function changeCheckKind(
  setKind: React.Dispatch<React.SetStateAction<DataFlowCheckKind>>,
  setTarget: React.Dispatch<React.SetStateAction<string>>,
  kind: string | null,
): void {
  if (
    kind !== "conversation_delivery" &&
    kind !== "tool_effect" &&
    kind !== "context_read"
  )
    return;
  setKind(kind);
  setTarget("");
}

function findTargetGrant(
  grants: readonly AccessControlGrantView[],
  refId: string,
): AccessControlGrantView | null {
  for (const grant of grants) {
    if (targetGrantValue(grant) === refId) return grant;
  }
  return null;
}

function targetGrantItem(
  grant: AccessControlGrantView,
): Readonly<{ value: string; label: string }> {
  return {
    value: targetGrantValue(grant),
    label: `${grant.capability.label} · ${grant.resource.label}`,
  };
}

function renderTargetGrantOption(
  grant: AccessControlGrantView,
): React.ReactNode {
  return (
    <Select.Item
      key={targetGrantValue(grant)}
      value={targetGrantValue(grant)}
      disabled={grant.lifecycle.kind !== "active"}
    >
      {grant.capability.label} · {grant.resource.label}
    </Select.Item>
  );
}

function targetGrantValue(grant: AccessControlGrantView): string {
  return `${grant.grantId}:${grant.revision}`;
}

function renderSelectedSource(
  source: AccessControlSourcePolicyView,
): React.ReactNode {
  return (
    <li key={source.sourceRefId}>
      {source.resourceLabel} · {source.owner.label}
    </li>
  );
}

function subjectLabel(subject: AccessControlSubjectView): string {
  return subject.label;
}
