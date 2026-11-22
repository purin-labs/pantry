import React from "react";
import type { CaseScreenObservationView } from "@purin-labs/control-api";
import type {
  AccessControlOption,
  AccessRouteTransport,
} from "@purin-labs/control-api/portal/access-models";
import { navigationGroupTitle } from "@purin-labs/ui/route";
import { Select } from "@purin-labs/ui/select";
import "./case-screen-observations.css";

/**
 * Knowledge › Context › On screen (Plan 87 phase 5): the pages that the
 * agent of one Case received from a person's screen, with the time and the
 * records on screen. It shows no value from a page, and only the chats that
 * the reader may see.
 */
type Props = Readonly<{
  organisationId: string;
  cases: readonly AccessControlOption[];
  transport: AccessRouteTransport;
}>;

type State =
  | Readonly<{ kind: "idle"; caseRef: "" }>
  | Readonly<{ kind: "loading"; caseRef: string }>
  | Readonly<{
      kind: "ready";
      caseRef: string;
      observations: readonly CaseScreenObservationView[];
    }>
  | Readonly<{ kind: "failed"; caseRef: string; message: string }>;

export class CaseScreenObservations extends React.Component<Props, State> {
  state: State = { kind: "idle", caseRef: "" };
  private requestVersion = 0;

  componentWillUnmount(): void {
    this.requestVersion += 1;
  }

  private select(value: string | null): void {
    const caseRef = value ?? "";
    if (caseRef === "") {
      this.requestVersion += 1;
      this.setState({ kind: "idle", caseRef: "" });
    } else void this.load(caseRef);
  }

  private async load(caseRef: string): Promise<void> {
    const selected = this.props.cases.find(
      (option) => option.refId === caseRef,
    );
    if (selected === undefined || selected.revision === null) return;
    const version = ++this.requestVersion;
    this.setState({ kind: "loading", caseRef });
    try {
      const observations =
        await this.props.transport.readCaseScreenObservations(
          this.props.organisationId,
          caseRef,
          selected.revision,
        );
      if (version === this.requestVersion)
        this.setState({ kind: "ready", caseRef, observations });
    } catch {
      if (version === this.requestVersion)
        this.setState({
          kind: "failed",
          caseRef,
          message:
            "The pages on screen are unavailable. Refresh and try again.",
        });
    }
  }

  render(): React.ReactNode {
    const state = this.state;
    return (
      <section
        className="portal-band access35-related-cases"
        id="on-screen"
        aria-labelledby="on-screen-title"
      >
        <h2 id="on-screen-title">On screen</h2>
        <p>
          The pages that the agent of a Case received from a person's screen:
          the page, the time and the records on it. Values on the page are not
          shown here.
        </p>
        <div className="access35-related-controls">
          <label htmlFor="on-screen-selection">
            Case
            <Select.Root
              items={[
                { value: "", label: "Select a current Case" },
                ...this.props.cases.map(caseItem),
              ]}
              value={state.caseRef}
              onValueChange={this.select.bind(this)}
              disabled={state.kind === "loading"}
            >
              <Select.Trigger id="on-screen-selection">
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                <Select.Item value="">Select a current Case</Select.Item>
                {this.props.cases.map(renderCaseOption)}
              </Select.Popup>
            </Select.Root>
          </label>
        </div>
        {renderState(state)}
      </section>
    );
  }
}

function renderState(state: State): React.ReactNode {
  switch (state.kind) {
    case "idle":
      return null;
    case "loading":
      return <p role="status">Loading the pages on screen…</p>;
    case "failed":
      return <p role="alert">{state.message}</p>;
    case "ready":
      return state.observations.length === 0 ? (
        <p>No message of this Case carried a page that you may see.</p>
      ) : (
        <ul className="access-on-screen-list" aria-label="Pages on screen">
          {state.observations.map(renderObservation)}
        </ul>
      );
  }
}

function renderObservation(
  observation: CaseScreenObservationView,
  index: number,
): React.ReactNode {
  const page =
    observation.record === null
      ? observation.page
      : `${observation.page} › ${observation.record}`;
  return (
    <li key={`${observation.sentAt}:${index}`}>
      <span className="access-on-screen-page">{page}</span>
      <span className="access-on-screen-meta">
        {navigationGroupTitle(observation.area)} · on screen ·{" "}
        <time dateTime={new Date(observation.capturedAt).toISOString()}>
          {new Date(observation.capturedAt).toLocaleString()}
        </time>
      </span>
      <span className="access-on-screen-sources">
        {observation.sources.length === 0
          ? "No records named"
          : observation.sources
              .map(
                (source) =>
                  `${source.kind} ${source.id}${source.revision === null ? " (unsaved)" : ` · revision ${source.revision}`}`,
              )
              .join("; ")}
      </span>
    </li>
  );
}

function caseItem(
  option: AccessControlOption,
): Readonly<{ value: string; label: string }> {
  return { value: option.refId, label: option.label };
}

function renderCaseOption(option: AccessControlOption): React.ReactNode {
  return (
    <Select.Item
      key={option.refId}
      value={option.refId}
      disabled={option.revision === null}
    >
      {option.label}
    </Select.Item>
  );
}
