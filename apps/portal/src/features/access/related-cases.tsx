import { Select } from "../../ui/select";
import React from "react";
import type {
  CaseContextCollectionMetadataView,
  CaseContextCollectionRelationshipDecision,
  CaseContextCollectionRelationshipView,
} from "@seams/control-api";
import type { AccessControlOption, AccessRouteTransport } from "@seams/control-api/portal/access-models";

type Props = Readonly<{
  organisationId: string;
  cases: readonly AccessControlOption[];
  transport: AccessRouteTransport;
  canReview: boolean;
}>;
type State =
  | Readonly<{ kind: "idle"; caseRef: "" }>
  | Readonly<{ kind: "loading" | "saving"; caseRef: string }>
  | Readonly<{
      kind: "ready";
      caseRef: string;
      caseContextCollections: readonly CaseContextCollectionMetadataView[];
    }>
  | Readonly<{ kind: "failed"; caseRef: string; message: string }>;

export class RelatedCases extends React.Component<Props, State> {
  state: State = { kind: "idle", caseRef: "" };
  private requestVersion = 0;
  private selection = React.createRef<HTMLButtonElement>();

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
      caseHasReference.bind(null, caseRef),
    );
    if (selected === undefined || selected.revision === null) return;
    const version = ++this.requestVersion;
    this.setState({ kind: "loading", caseRef });
    try {
      const caseContextCollections =
        await this.props.transport.readCaseContextCollections(
          this.props.organisationId,
          caseRef,
          selected.revision,
        );
      if (version === this.requestVersion)
        this.setState(
          { kind: "ready", caseRef, caseContextCollections },
          this.focusSelection.bind(this),
        );
    } catch {
      if (version === this.requestVersion)
        this.setState({
          kind: "failed",
          caseRef,
          message:
            "Related Cases are unavailable. Refresh access and try again.",
        });
    }
  }

  private refresh(): void {
    if (this.state.caseRef !== "") void this.load(this.state.caseRef);
  }

  private focusSelection(): void {
    this.selection.current?.focus();
  }

  private async review(
    caseContextCollection: CaseContextCollectionMetadataView,
    relationship: CaseContextCollectionRelationshipView,
    kind: CaseContextCollectionRelationshipDecision["kind"],
  ): Promise<void> {
    if (this.state.kind !== "ready" || !this.props.canReview) return;
    const caseRef = this.state.caseRef;
    const version = ++this.requestVersion;
    this.setState({ kind: "saving", caseRef });
    try {
      await this.props.transport.reviewCaseContextCollection(
        this.props.organisationId,
        caseContextCollection.caseContextCollectionId,
        caseContextCollection.revision,
        { kind, relationshipId: relationship.relationshipId },
      );
      if (version === this.requestVersion) await this.load(caseRef);
    } catch {
      if (version === this.requestVersion)
        this.setState({
          kind: "failed",
          caseRef,
          message:
            "The relationship could not be updated. Reload Related Cases before reviewing again.",
        });
    }
  }

  private renderCaseContextCollection(
    caseContextCollection: CaseContextCollectionMetadataView,
  ): React.ReactNode {
    return (
      <article key={caseContextCollection.caseContextCollectionId}>
        <h3>
          {caseContextCollection.issueKind.replaceAll("_", " ")} ·{" "}
          {caseContextCollection.issueInstance}
        </h3>
        <p>
          {caseContextCollection.lifecycle} · Anchor Case:{" "}
          {caseContextCollection.anchorCaseId}
        </p>
        <ul>
          {caseContextCollection.relationships.map(
            this.renderRelationship.bind(this, caseContextCollection),
          )}
        </ul>
      </article>
    );
  }

  private renderRelationship(
    caseContextCollection: CaseContextCollectionMetadataView,
    relationship: CaseContextCollectionRelationshipView,
  ): React.ReactNode {
    return (
      <li key={relationship.relationshipId}>
        <span>
          {relationship.caseId} · {relationship.kind}
        </span>{" "}
        {this.props.canReview &&
        caseContextCollection.lifecycle === "open" &&
        relationship.kind === "suggested" ? (
          <>
            <button
              type="button"
              onClick={this.review.bind(
                this,
                caseContextCollection,
                relationship,
                "confirm",
              )}
            >
              Confirm link
            </button>{" "}
            <button
              type="button"
              onClick={this.review.bind(
                this,
                caseContextCollection,
                relationship,
                "reject",
              )}
            >
              Reject link
            </button>
          </>
        ) : null}
        {this.props.canReview &&
        caseContextCollection.lifecycle === "open" &&
        relationship.kind === "attached" ? (
          <button
            type="button"
            onClick={this.review.bind(
              this,
              caseContextCollection,
              relationship,
              "detach",
            )}
          >
            Detach link
          </button>
        ) : null}
      </li>
    );
  }

  render(): React.ReactNode {
    const state = this.state;
    const busy = state.kind === "loading" || state.kind === "saving";
    return (
      <section
        className="portal-band access35-related-cases"
        aria-labelledby="related-cases-title"
      >
        <h2 id="related-cases-title">Related Cases</h2>
        <p>
          Review links between Cases you can read. Confirming a link preserves
          existing source permissions.
        </p>
        <div className="access35-related-controls">
          <label htmlFor="related-cases-selection">
            Case
            <Select.Root
              items={[
                { value: "", label: "Select a current Case" },
                ...this.props.cases.map(caseItem),
              ]}
              value={state.caseRef}
              onValueChange={this.select.bind(this)}
              disabled={busy}
            >
              <Select.Trigger id="related-cases-selection" ref={this.selection}>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                <Select.Item value="">Select a current Case</Select.Item>
                {this.props.cases.map(renderCaseOption)}
              </Select.Popup>
            </Select.Root>
          </label>
          <button
            type="button"
            onClick={this.refresh.bind(this)}
            disabled={busy || state.caseRef === ""}
          >
            Reload Related Cases
          </button>
        </div>
        <p role="status">{relatedCasesStatus(state)}</p>
        {state.kind === "failed" ? <p role="alert">{state.message}</p> : null}
        {state.kind === "ready"
          ? state.caseContextCollections.map(
              this.renderCaseContextCollection.bind(this),
            )
          : null}
      </section>
    );
  }
}

function relatedCasesStatus(state: State): string {
  if (state.kind === "loading") return "Reading Related Cases…";
  if (state.kind === "saving") return "Updating the relationship…";
  if (state.kind === "ready" && state.caseContextCollections.length === 0)
    return "No related Cases are available to you for this Case.";
  return "";
}

function caseHasReference(
  reference: string,
  option: AccessControlOption,
): boolean {
  return option.refId === reference;
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
