import { Select } from "../../ui/select";
import React from "react";
import { Link } from "react-router";

import { findOption, optionItem, renderOption } from "./dialog-elements";
import type {
  AccessControlOption,
  AccessControlSourcePolicyView,
} from "@purin-labs/control-api/portal/access-models";

/**
 * Answers the common data-flow question in place: may this shared data, used
 * by this recipient, reach this conversation or automation? Tool effects and
 * Case reads keep their full form on the data flow page.
 */
export function AccessCheckPanel(
  props: Readonly<{
    sources: readonly AccessControlSourcePolicyView[];
    authorities: readonly AccessControlOption[];
    destinations: readonly AccessControlOption[];
    busy: boolean;
    moreChecksPath: string;
    leave: () => void;
    submit: (
      source: AccessControlSourcePolicyView,
      authority: AccessControlOption,
      destination: AccessControlOption,
    ) => void;
  }>,
): React.ReactNode {
  const [sourceRef, setSourceRef] = React.useState("");
  const [authorityRef, setAuthorityRef] = React.useState("");
  const [destinationRef, setDestinationRef] = React.useState("");
  return (
    <form
      id="access35-check-panel"
      className="access35-check-panel"
      aria-label="Check access"
      onSubmit={submitCheck.bind(
        null,
        props,
        sourceRef,
        authorityRef,
        destinationRef,
      )}
    >
      {props.sources.length === 0 ? (
        <p>No shared data to check yet. Share a system first.</p>
      ) : (
        <>
          <p>Can data from one system reach one place?</p>
          <div className="access35-check-fields">
            <label>
              <span>Data from</span>
              <Select.Root
                required
                items={props.sources.map(sourceItem)}
                value={sourceRef === "" ? null : sourceRef}
                onValueChange={(value) => setSourceRef(value ?? "")}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select shared data" />
                </Select.Trigger>
                <Select.Popup>
                  {props.sources.map(renderSourceOption)}
                </Select.Popup>
              </Select.Root>
            </label>
            <label>
              <span>Used by</span>
              <Select.Root
                required
                items={props.authorities.map(optionItem)}
                value={authorityRef === "" ? null : authorityRef}
                onValueChange={(value) => setAuthorityRef(value ?? "")}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select who uses it" />
                </Select.Trigger>
                <Select.Popup>
                  {props.authorities.map(renderOption)}
                </Select.Popup>
              </Select.Root>
            </label>
            <label>
              <span>Sent to</span>
              <Select.Root
                required
                items={props.destinations.map(optionItem)}
                value={destinationRef === "" ? null : destinationRef}
                onValueChange={(value) => setDestinationRef(value ?? "")}
              >
                <Select.Trigger>
                  <Select.Value placeholder="Select a conversation or automation" />
                </Select.Trigger>
                <Select.Popup>
                  {props.destinations.map(renderOption)}
                </Select.Popup>
              </Select.Root>
            </label>
            <button type="submit" disabled={props.busy}>
              {props.busy ? "Checking…" : "Check"}
            </button>
          </div>
        </>
      )}
      <Link to={props.moreChecksPath} onClick={props.leave}>
        Check a tool action or a Case
      </Link>
    </form>
  );
}

function sourceItem(
  source: AccessControlSourcePolicyView,
): Readonly<{ value: string; label: string }> {
  return {
    value: source.sourceRefId,
    label: `${source.resourceLabel} · ${source.owner.label}`,
  };
}

function renderSourceOption(
  source: AccessControlSourcePolicyView,
): React.ReactNode {
  return (
    <Select.Item
      key={source.sourceRefId}
      value={source.sourceRefId}
      disabled={source.availability.kind !== "available"}
    >
      {source.resourceLabel} · {source.owner.label}
    </Select.Item>
  );
}

function submitCheck(
  props: Parameters<typeof AccessCheckPanel>[0],
  sourceRef: string,
  authorityRef: string,
  destinationRef: string,
  event: React.FormEvent<HTMLFormElement>,
): void {
  event.preventDefault();
  const authority = findOption(props.authorities, authorityRef);
  const destination = findOption(props.destinations, destinationRef);
  for (const source of props.sources) {
    if (source.sourceRefId !== sourceRef) continue;
    if (authority !== null && destination !== null)
      props.submit(source, authority, destination);
    return;
  }
}
