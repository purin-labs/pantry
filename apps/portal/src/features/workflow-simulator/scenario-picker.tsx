import React from "react";
import { ChevronRight, FileText } from "lucide-react";
import type { CommerceCursor } from "@purin-labs/contracts";
import {
  readSavedEntityPage,
  SAVED_PROCEDURES,
  SAVED_PRODUCTION_SCENARIOS,
  SAVED_SCENARIOS,
  type SavedEntityKind,
  type ScenarioChoice,
  type ScenarioPage,
} from "./scenario-api";

/** What a picker lists, and the words that it uses for it. */
type PickerKind = Readonly<{
  entity: SavedEntityKind;
  id: string;
  singular: string;
  plural: string;
  title: string;
  empty: string;
}>;

const SCENARIO_PICKER: PickerKind = {
  entity: SAVED_SCENARIOS,
  id: "scenario",
  singular: "scenario",
  plural: "scenarios",
  title: "Scenarios",
  empty: "No scenarios found. Try another search or save a scenario.",
};
export const PROCEDURE_PICKER: PickerKind = {
  entity: SAVED_PROCEDURES,
  id: "procedure",
  singular: "procedure",
  plural: "procedures",
  title: "Procedures",
  empty: "No procedures found. Try another search or load a workspace sample.",
};
export const PRODUCTION_SCENARIO_PICKER: PickerKind = {
  entity: SAVED_PRODUCTION_SCENARIOS,
  id: "production-scenario",
  singular: "production scenario",
  plural: "production scenarios",
  title: "Production scenarios",
  empty:
    "No production scenarios found. Try another search or save a scenario copy.",
};

type Cursors = readonly [null, ...CommerceCursor[]];
type Catalog = ScenarioPage & Readonly<{ query: string; cursors: Cursors }>;
type Activity =
  | Readonly<{ kind: "idle" | "loading" }>
  | Readonly<{ kind: "failed"; message: string }>;
type Props = Readonly<{
  organisationId: string;
  busy: boolean;
  onLoad: (id: string) => Promise<void>;
  kind?: PickerKind;
}>;
type State = Readonly<{
  query: string;
  catalog: Catalog | null;
  activity: Activity;
}>;

export class ScenarioPicker extends React.Component<Props, State> {
  state: State = { query: "", catalog: null, activity: { kind: "idle" } };
  private active = false;
  private generation = 0;
  private readonly heading = React.createRef<HTMLHeadingElement>();
  private readonly error = React.createRef<HTMLParagraphElement>();
  componentDidMount(): void {
    this.active = true;
    void this.loadPage("", [null]);
  }
  componentWillUnmount(): void {
    this.active = false;
    this.generation++;
  }
  componentDidUpdate(previous: Props): void {
    if (previous.organisationId !== this.props.organisationId) {
      this.generation++;
      this.setState({ query: "", catalog: null });
      void this.loadPage("", [null]);
    } else if (previous.busy && !this.props.busy) {
      void this.loadPage(this.state.query.trim(), [null]);
    }
  }
  private change(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ query: event.currentTarget.value });
  }
  private async search(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await this.loadPage(this.state.query.trim(), [null]);
  }
  private async next(): Promise<void> {
    const catalog = this.state.catalog;
    if (catalog !== null && catalog.nextCursor !== null)
      await this.loadPage(catalog.query, [
        ...catalog.cursors,
        catalog.nextCursor,
      ]);
  }
  private async previous(): Promise<void> {
    const catalog = this.state.catalog;
    if (catalog === null || catalog.cursors.length <= 1) return;
    const [, ...following] = catalog.cursors;
    await this.loadPage(catalog.query, [null, ...following.slice(0, -1)]);
  }
  private focusHeading(): void {
    this.heading.current?.focus();
  }
  private focusError(): void {
    this.error.current?.focus();
  }
  private async loadPage(query: string, cursors: Cursors): Promise<void> {
    if (this.props.busy) return;
    const generation = ++this.generation;
    const focus = this.state.catalog !== null;
    this.setState({ activity: { kind: "loading" } });
    try {
      const page = await readSavedEntityPage(
        this.props.organisationId,
        this.kind().entity,
        query,
        cursors.at(-1) ?? null,
      );
      if (this.active && generation === this.generation)
        this.setState(
          { catalog: { ...page, query, cursors }, activity: { kind: "idle" } },
          focus ? this.focusHeading.bind(this) : undefined,
        );
    } catch {
      if (this.active && generation === this.generation)
        this.setState(
          {
            activity: {
              kind: "failed",
              message: `Couldn’t load ${this.kind().plural}. Your current page is kept. Retry the page or search again.`,
            },
          },
          this.focusError.bind(this),
        );
    }
  }
  private renderChoice(choice: ScenarioChoice): React.ReactNode {
    return (
      <li key={choice.reference.entityId}>
        <button
          type="button"
          className="workflow-scenario-choice"
          aria-label={`Open ${choice.name}`}
          disabled={this.props.busy}
          onClick={this.props.onLoad.bind(null, choice.reference.entityId)}
        >
          <FileText size={18} aria-hidden="true" />
          <span>{choice.name}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </li>
    );
  }
  private kind(): PickerKind {
    return this.props.kind ?? SCENARIO_PICKER;
  }
  render(): React.ReactNode {
    const { catalog, activity } = this.state;
    const busy = this.props.busy || activity.kind === "loading";
    const kind = this.kind();
    const search = `workflow-${kind.id}-search`;
    return (
      <section
        className="workflow-scenario-picker"
        aria-label={`Find a saved ${kind.singular}`}
      >
        <form
          className="workflow-scenario-search"
          onSubmit={this.search.bind(this)}
        >
          <label htmlFor={search}>Find a {kind.singular}</label>
          <input
            id={search}
            type="search"
            maxLength={80}
            value={this.state.query}
            onChange={this.change.bind(this)}
            disabled={busy}
            aria-describedby={`${search}-help`}
          />
          <button type="submit" disabled={busy}>
            Search
          </button>
          <p id={`${search}-help`}>Leave blank to show all.</p>
        </form>
        <p role="status" ref={this.error} tabIndex={-1}>
          {activity.kind === "loading"
            ? "Loading…"
            : activity.kind === "failed"
              ? activity.message
              : catalog?.query
                ? `Results for “${catalog.query}”`
                : ""}
        </p>
        {catalog !== null ? (
          <>
            <h3 ref={this.heading} tabIndex={-1}>
              {kind.title} · Page {catalog.cursors.length}
            </h3>
            {catalog.choices.length === 0 ? (
              <p>{kind.empty}</p>
            ) : (
              <ul className="workflow-scenario-list">
                {catalog.choices.map(this.renderChoice.bind(this))}
              </ul>
            )}
            <button
              type="button"
              disabled={busy || catalog.cursors.length <= 1}
              onClick={this.previous.bind(this)}
            >
              Previous page
            </button>
            <button
              type="button"
              disabled={busy || catalog.nextCursor === null}
              onClick={this.next.bind(this)}
            >
              Next page
            </button>
          </>
        ) : null}
      </section>
    );
  }
}
