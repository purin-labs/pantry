import React from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { SideDrawer } from "@purin-labs/ui/index";
import { FilterCount } from "../filter-bar";
import "./board-list.css";

/**
 * A list of commerce entries: lane filters with counts, one row for each entry,
 * and a side drawer with every fact and the actions of the entry. The
 * Replenishment Queue uses it. The caller builds the rows, so this module
 * knows no commerce list.
 */

export type CommerceBoardListFact = Readonly<{
  /** The attribute id, so a drawer can leave out a fact that it edits. */
  id: string;
  label: string;
  value: React.ReactNode;
  numeric: boolean;
}>;

export type CommerceBoardListColumn = Readonly<{
  id: string;
  text: string;
  numeric: boolean;
}>;

export type CommerceBoardListLane = Readonly<{
  id: string;
  label: string;
  count: number;
}>;

export type CommerceBoardListRow = Readonly<{
  /** Stable across revisions, so an open drawer survives a refresh. */
  key: string;
  laneId: string;
  name: string;
  secondary: string | null;
  columns: readonly CommerceBoardListColumn[];
  laneTag: React.ReactNode;
  /** The drawer of this entry. `open` turns false while the drawer closes. */
  drawer: (open: boolean, close: () => void) => React.ReactNode;
}>;

type DrawerSelection = Readonly<{ key: string; open: boolean }> | null;

export function CommerceBoardList(
  props: Readonly<{
    label: string;
    lanes: readonly CommerceBoardListLane[];
    rows: readonly CommerceBoardListRow[];
  }>,
): React.ReactNode {
  const [filter, setFilter] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<DrawerSelection>(null);
  const active = props.lanes.some(laneHasId.bind(null, filter)) ? filter : null;
  const shown =
    active === null
      ? props.rows
      : props.rows.filter(rowInLane.bind(null, active));
  const selected =
    selection === null
      ? undefined
      : props.rows.find(rowHasKey.bind(null, selection.key));
  const close = closeDrawer.bind(null, setSelection);
  return (
    <div className="commerce-board-list">
      <div
        className="commerce-filter-bar"
        role="group"
        aria-label={`Show ${props.label} by lane`}
      >
        {renderLaneFilter(
          setFilter,
          active === null,
          null,
          "All",
          props.rows.length,
        )}
        {props.lanes
          .filter(laneIsShownAsFilter.bind(null, active))
          .map(renderLaneFilterFor.bind(null, setFilter, active))}
      </div>
      {shown.length === 0 ? (
        <p className="empty-state commerce-empty">
          {props.rows.length === 0
            ? "Nothing in this view yet."
            : "Nothing in this lane."}
        </p>
      ) : (
        <ul className="commerce-board-rows" aria-label={props.label}>
          {shown.map(renderBoardRow.bind(null, setSelection))}
        </ul>
      )}
      {selected === undefined || selection === null
        ? null
        : selected.drawer(selection.open, close)}
    </div>
  );
}

function renderLaneFilterFor(
  setFilter: React.Dispatch<React.SetStateAction<string | null>>,
  active: string | null,
  lane: CommerceBoardListLane,
): React.ReactNode {
  return renderLaneFilter(
    setFilter,
    active === lane.id,
    lane.id,
    lane.label,
    lane.count,
  );
}

function renderLaneFilter(
  setFilter: React.Dispatch<React.SetStateAction<string | null>>,
  pressed: boolean,
  laneId: string | null,
  label: string,
  count: number,
): React.ReactNode {
  return (
    <button
      type="button"
      key={laneId ?? "all"}
      aria-pressed={pressed}
      onClick={setFilter.bind(null, laneId)}
    >
      {label}
      <FilterCount value={count} />
    </button>
  );
}

function renderBoardRow(
  setSelection: React.Dispatch<React.SetStateAction<DrawerSelection>>,
  row: CommerceBoardListRow,
): React.ReactNode {
  return (
    <li key={row.key}>
      <button
        type="button"
        className="commerce-board-row"
        aria-haspopup="dialog"
        onClick={setSelection.bind(null, { key: row.key, open: true })}
      >
        <span className="commerce-board-row-name">
          <strong>{row.name}</strong>
          {row.secondary === null ? null : <span>{row.secondary}</span>}
        </span>
        {/* Columns on a wide screen; one wrapping line on a phone. */}
        <span className="commerce-board-row-values">
          {row.columns.map(renderBoardColumn)}
        </span>
        <span className="commerce-board-row-lane">{row.laneTag}</span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

function renderBoardColumn(column: CommerceBoardListColumn): React.ReactNode {
  return (
    <span
      key={column.id}
      className="commerce-board-row-value"
      data-numeric={column.numeric ? "true" : undefined}
    >
      {column.text}
    </span>
  );
}

/**
 * The drawer of one entry: the entry's facts, its lane control and, when the
 * caller has one, a form with its own save in the footer.
 */
export function CommerceBoardEntryDrawer(
  props: Readonly<{
    open: boolean;
    close: () => void;
    title: string;
    href: string | null;
    facts: readonly CommerceBoardListFact[];
    laneControl: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }>,
): React.ReactNode {
  return (
    <SideDrawer
      open={props.open}
      title={props.title}
      close={props.close}
      className="commerce-entry-drawer"
      footer={props.footer}
    >
      <div className="side-drawer-body">
        <dl className="commerce-entry-drawer-facts">
          {props.facts.map(renderCommerceFact)}
          {props.laneControl === null ? null : (
            <div>
              <dt>Lane</dt>
              <dd>{props.laneControl}</dd>
            </div>
          )}
        </dl>
        {props.children}
        {props.href === null ? null : (
          <Link className="commerce-entry-drawer-link" to={props.href}>
            Open the record
          </Link>
        )}
      </div>
    </SideDrawer>
  );
}

/** One fact as a label and its value, in a drawer or on a record page. */
export function renderCommerceFact(
  fact: CommerceBoardListFact,
): React.ReactNode {
  return (
    <div key={fact.id}>
      <dt>{fact.label}</dt>
      <dd data-numeric={fact.numeric ? "true" : undefined}>{fact.value}</dd>
    </div>
  );
}

function closeDrawer(
  setSelection: React.Dispatch<React.SetStateAction<DrawerSelection>>,
): void {
  setSelection(keepClosedSelection);
}

function keepClosedSelection(selection: DrawerSelection): DrawerSelection {
  return selection === null ? null : { key: selection.key, open: false };
}

function laneHasId(id: string | null, lane: CommerceBoardListLane): boolean {
  return lane.id === id;
}

function laneIsShownAsFilter(
  active: string | null,
  lane: CommerceBoardListLane,
): boolean {
  return lane.count > 0 || lane.id === active;
}

function rowInLane(laneId: string, row: CommerceBoardListRow): boolean {
  return row.laneId === laneId;
}

function rowHasKey(key: string, row: CommerceBoardListRow): boolean {
  return row.key === key;
}
