import React from "react";
import { DirectionProvider } from "@base-ui/react/direction-provider";
import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  MoreHorizontal,
  Pin,
  PinOff,
} from "lucide-react";
import { ActionMenu, type ActionMenuItem } from "./action-menu";
import { EmptyState } from "./empty-state";
import "./crm-table.css";

export type CrmCalculation = "none" | "count" | "unique" | "sum" | "average";
export type CrmCellProps = {
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly cellKey?: string;
};

type ColumnBase<Row> = {
  readonly id: string;
  readonly label: string;
  readonly width?: number;
  readonly minWidth?: number;
  readonly align?: "start" | "end";
  readonly headerClassName?: string;
  readonly cellProps?: (row: Row, index: number) => CrmCellProps | undefined;
  readonly render: (row: Row, index: number) => React.ReactNode;
};
export type CrmColumn<Row> = ColumnBase<Row> &
  (
    | { readonly kind: "text"; readonly value: (row: Row) => string | null }
    | {
        readonly kind: "number";
        readonly value: (row: Row) => number | null;
        readonly format?: (value: number) => string;
      }
    | { readonly kind: "display"; readonly value?: never }
  );
export type CrmSelection = {
  readonly selectedIds: ReadonlySet<string>;
  readonly onChange: (ids: ReadonlySet<string>) => void;
};
export type CrmRowAction<Row> = {
  readonly id: string;
  readonly label: string;
  readonly tone?: "neutral" | "danger";
  /** Leaves the action out of this row's menu; a row with none has no menu. */
  readonly available?: (row: Row) => boolean;
  readonly onSelect: (row: Row) => void;
};
export type CrmTableProps<Row> = {
  readonly label: string;
  readonly className?: string;
  readonly rows: readonly Row[];
  readonly columns: readonly CrmColumn<Row>[];
  readonly rowId: (row: Row) => string;
  readonly rowLabel: (row: Row) => string;
  readonly isRowActive?: (row: Row) => boolean;
  /** The row's `data-surface-target`, where an agent's label shows. */
  readonly rowSurfaceTarget?: (row: Row) => string;
  readonly onRowClick?: (row: Row) => void;
  /** Optional full-width detail panel rendered immediately beneath a row. */
  readonly renderExpandedRow?: (row: Row, index: number) => React.ReactNode;
  readonly selection?: CrmSelection;
  readonly actions?: readonly CrmRowAction<Row>[];
  readonly initialPinned?: readonly string[];
  readonly initialCalculations?: Readonly<Record<string, CrmCalculation>>;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
};
type Sort =
  | { readonly kind: "none" }
  | {
      readonly kind: "column";
      readonly id: string;
      readonly direction: "ascending" | "descending";
    };
type Calculation = CrmCalculation;
type Resize =
  | { readonly kind: "idle" }
  | {
      readonly kind: "dragging";
      readonly id: string;
      readonly startX: number;
      readonly width: number;
      readonly direction: number;
    };
type State = {
  readonly direction: "ltr" | "rtl";
  readonly sort: Sort;
  readonly pinned: readonly string[];
  readonly widths: ReadonlyMap<string, number>;
  readonly calculations: ReadonlyMap<string, Calculation>;
};
const selectionColumnWidth = 32;

export class CrmTable<Row> extends React.Component<
  CrmTableProps<Row>,
  State,
  ReadonlyMap<string, number> | null
> {
  state: State = {
    direction: "ltr",
    sort: { kind: "none" },
    pinned: this.props.initialPinned ?? [],
    widths: new Map(),
    calculations: new Map(
      Object.entries(this.props.initialCalculations ?? {}) as [
        string,
        Calculation,
      ][],
    ),
  };
  private resize: Resize = { kind: "idle" };
  private scroll = React.createRef<HTMLDivElement>();
  private viewportObserver: ResizeObserver | null = null;

  componentDidMount(): void {
    this.updateScrollLayers();
    this.viewportObserver = new ResizeObserver(
      this.updateScrollLayers.bind(this),
    );
    if (this.scroll.current) this.viewportObserver.observe(this.scroll.current);
  }
  componentWillUnmount(): void {
    this.viewportObserver?.disconnect();
  }
  getSnapshotBeforeUpdate(
    previous: CrmTableProps<Row>,
    state: State,
  ): ReadonlyMap<string, number> | null {
    if (previous.rows === this.props.rows && state.sort === this.state.sort)
      return null;
    const body = this.scroll.current?.querySelector("tbody");
    if (!body) return null;
    const positions = new Map<string, number>();
    const origin = body.getBoundingClientRect().top;
    for (const row of body.rows) {
      const id = row.dataset.rowId;
      if (id !== undefined)
        positions.set(
          id,
          (row.cells[0]?.getBoundingClientRect().top ??
            row.getBoundingClientRect().top) - origin,
        );
    }
    return positions;
  }
  componentDidUpdate(
    _previous: CrmTableProps<Row>,
    _state: State,
    positions: ReadonlyMap<string, number> | null,
  ): void {
    this.updateScrollLayers();
    const root = this.scroll.current;
    const body = root?.querySelector("tbody");
    if (!root || !body || positions === null) return;
    const reduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      root.closest('[data-agent-preview-motion="reduced"]');
    const factor = root.closest('[data-agent-preview-motion="slow"]') ? 10 : 1;
    const origin = body.getBoundingClientRect().top;
    for (const row of body.rows) {
      const before = positions.get(row.dataset.rowId ?? "");
      const delta =
        before === undefined
          ? 0
          : before - (row.getBoundingClientRect().top - origin);
      for (const cell of row.cells) {
        for (const animation of cell.getAnimations()) animation.cancel();
        if (reduced || Math.abs(delta) < 0.5) continue;
        // Move cells, preserving sticky-column stacking above the scrolling cells.
        cell.animate(
          [
            { transform: `translateY(${Math.max(-8, Math.min(8, delta))}px)` },
            {
              transform: `translateY(${-Math.sign(delta) * 0.5}px)`,
              offset: 0.82,
            },
            { transform: "translateY(0)" },
          ],
          { duration: 160 * factor, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
      }
    }
  }
  private updateScrollLayers(): void {
    const root = this.scroll.current;
    const viewport = root?.parentElement;
    if (!root || !viewport) return;
    viewport.dataset.scrolledInline = String(Math.abs(root.scrollLeft) > 1);
    const edge = root.querySelector('thead [data-pinned-edge="true"]');
    const bounds = root.getBoundingClientRect();
    const frozen = edge?.getBoundingClientRect();
    const rtl = getComputedStyle(root).direction === "rtl";
    const direction = rtl ? "rtl" : "ltr";
    if (direction !== this.state.direction) this.setState({ direction });
    const width = frozen
      ? rtl
        ? bounds.right - frozen.left
        : frozen.right - bounds.left
      : 0;
    viewport.style.setProperty("--crm-frozen-edge", `${width}px`);
    viewport.style.setProperty(
      "--crm-viewport-height",
      `${root.clientHeight}px`,
    );
    viewport.dataset.hasFrozen = String(width > 0);
  }
  private lastPinnedId(): string | null {
    let last: string | null = null;
    for (const column of this.props.columns)
      if (this.state.pinned.includes(column.id)) last = column.id;
    return last;
  }

  private minWidth(column: CrmColumn<Row>): number {
    return column.minWidth !== undefined && Number.isFinite(column.minWidth)
      ? Math.max(40, Math.min(600, column.minWidth))
      : 100;
  }
  private width(column: CrmColumn<Row>): number {
    const min = this.minWidth(column);
    return (
      this.state.widths.get(column.id) ?? clampWidth(column.width ?? 180, min)
    );
  }
  private columns(): readonly CrmColumn<Row>[] {
    const pinned: CrmColumn<Row>[] = [];
    const rest: CrmColumn<Row>[] = [];
    for (const column of this.props.columns) {
      (this.state.pinned.includes(column.id) ? pinned : rest).push(column);
    }
    return [...pinned, ...rest];
  }
  private cellStyle(column: CrmColumn<Row>): React.CSSProperties {
    if (!this.state.pinned.includes(column.id)) return {};
    let offset = this.props.selection ? selectionColumnWidth : 0;
    for (const candidate of this.columns()) {
      if (candidate.id === column.id) break;
      offset += this.width(candidate);
    }
    return { position: "sticky", insetInlineStart: offset };
  }
  private pin(column: CrmColumn<Row>): void {
    const pinned = new Set(this.state.pinned);
    if (pinned.has(column.id)) pinned.delete(column.id);
    else pinned.add(column.id);
    this.setState({ pinned: [...pinned] });
  }
  private sort(column: CrmColumn<Row>): void {
    if (column.kind === "display") return;
    const current = this.state.sort;
    if (current.kind === "column" && current.id === column.id) {
      this.setState({
        sort:
          current.direction === "ascending"
            ? { kind: "column", id: column.id, direction: "descending" }
            : { kind: "none" },
      });
    } else
      this.setState({
        sort: { kind: "column", id: column.id, direction: "ascending" },
      });
  }
  private sortedRows(): readonly Row[] {
    const sort = this.state.sort;
    if (sort.kind === "none") return this.props.rows;
    for (const column of this.props.columns) {
      if (column.id === sort.id && column.kind !== "display") {
        return [...this.props.rows].sort(
          (compareRows<Row>).bind(null, column, sort.direction),
        );
      }
    }
    return this.props.rows;
  }
  private selectRow(row: Row): void {
    const selection = this.props.selection;
    if (!selection) return;
    const ids = new Set(selection.selectedIds);
    const id = this.props.rowId(row);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    selection.onChange(ids);
  }
  private selectedCount(): number {
    let count = 0;
    for (const row of this.props.rows)
      if (this.props.selection?.selectedIds.has(this.props.rowId(row)))
        count += 1;
    return count;
  }
  private selectAll(): void {
    const selection = this.props.selection;
    if (!selection) return;
    const ids = new Set(selection.selectedIds);
    const all = this.selectedCount() === this.props.rows.length;
    for (const row of this.props.rows) {
      const id = this.props.rowId(row);
      if (all) ids.delete(id);
      else ids.add(id);
    }
    selection.onChange(ids);
  }
  private setWidth(column: CrmColumn<Row>, width: number): void {
    const widths = new Map(this.state.widths);
    widths.set(column.id, clampWidth(width, this.minWidth(column)));
    this.setState({ widths });
  }
  private startResize(
    column: CrmColumn<Row>,
    event: React.PointerEvent<HTMLSpanElement>,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.resize = {
      kind: "dragging",
      id: column.id,
      startX: event.clientX,
      width: this.width(column),
      direction:
        getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1,
    };
  }
  private moveResize(
    column: CrmColumn<Row>,
    event: React.PointerEvent<HTMLSpanElement>,
  ): void {
    if (this.resize.kind !== "dragging" || this.resize.id !== column.id) return;
    this.setWidth(
      column,
      this.resize.width +
        (event.clientX - this.resize.startX) * this.resize.direction,
    );
  }
  private endResize(): void {
    this.resize = { kind: "idle" };
  }
  private resizeKey(
    column: CrmColumn<Row>,
    event: React.KeyboardEvent<HTMLSpanElement>,
  ): void {
    const direction =
      getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
    let width = this.width(column);
    switch (event.key) {
      case "ArrowRight":
        width += 16 * direction;
        break;
      case "ArrowLeft":
        width -= 16 * direction;
        break;
      case "Home":
        width = this.minWidth(column);
        break;
      case "End":
        width = 600;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.setWidth(column, width);
  }
  private calculate(column: CrmColumn<Row>, value: Calculation): void {
    const calculations = new Map(this.state.calculations);
    calculations.set(column.id, value);
    this.setState({ calculations });
  }
  private renderHeader(column: CrmColumn<Row>): React.ReactNode {
    const sort = this.state.sort;
    const direction =
      sort.kind === "column" && sort.id === column.id ? sort.direction : "none";
    const pinned = this.state.pinned.includes(column.id);
    const min = this.minWidth(column);
    return (
      <th
        key={column.id}
        scope="col"
        className={column.headerClassName}
        aria-sort={column.kind === "display" ? undefined : direction}
        data-pinned={pinned}
        data-pinned-edge={this.lastPinnedId() === column.id}
        data-numeric={column.kind === "number" || column.align === "end"}
        style={this.cellStyle(column)}
      >
        <div className="crm-column-heading">
          {column.kind === "display" ? (
            <span>{column.label}</span>
          ) : (
            <button
              type="button"
              className="crm-sort"
              onClick={this.sort.bind(this, column)}
            >
              <span>{column.label}</span>
              <span
                className="crm-icon-stack"
                data-icon={direction}
                aria-hidden="true"
              >
                <ArrowUpDown size={13} data-visible={direction === "none"} />
                <ArrowUp size={13} data-visible={direction === "ascending"} />
                <ArrowDown
                  size={13}
                  data-visible={direction === "descending"}
                />
              </span>
            </button>
          )}
          <button
            className="crm-pin"
            type="button"
            aria-label={`${pinned ? "Unpin" : "Pin"} ${column.label}`}
            aria-pressed={pinned}
            onClick={this.pin.bind(this, column)}
          >
            <span className="crm-icon-stack" aria-hidden="true">
              <PinOff size={13} data-visible={pinned} />
              <Pin size={13} data-visible={!pinned} />
            </span>
          </button>
        </div>
        <span
          className="crm-resizer"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={`Resize ${column.label}`}
          aria-valuemin={min}
          aria-valuemax={600}
          aria-valuenow={this.width(column)}
          onPointerDown={this.startResize.bind(this, column)}
          onPointerMove={this.moveResize.bind(this, column)}
          onPointerUp={this.endResize.bind(this)}
          onPointerCancel={this.endResize.bind(this)}
          onLostPointerCapture={this.endResize.bind(this)}
          onKeyDown={this.resizeKey.bind(this, column)}
        />
      </th>
    );
  }
  private renderCell(
    row: Row,
    index: number,
    column: CrmColumn<Row>,
  ): React.ReactNode {
    const extra = column.cellProps?.(row, index);
    const baseStyle = this.cellStyle(column);
    const style =
      extra?.style === undefined
        ? baseStyle
        : { ...baseStyle, ...extra.style };
    return (
      <td
        key={column.id}
        className={extra?.className}
        data-cell-key={extra?.cellKey}
        data-pinned={this.state.pinned.includes(column.id)}
        data-pinned-edge={this.lastPinnedId() === column.id}
        data-numeric={column.kind === "number" || column.align === "end"}
        style={style}
      >
        {column.render(row, index)}
      </td>
    );
  }
  private rowActionItem(row: Row, action: CrmRowAction<Row>): ActionMenuItem {
    return {
      id: action.id,
      label: action.label,
      ...(action.tone === undefined ? {} : { tone: action.tone }),
      onSelect: action.onSelect.bind(null, row),
    };
  }
  private calculationItem(
    column: CrmColumn<Row>,
    kind: Calculation,
    label: string,
  ): ActionMenuItem {
    return {
      id: kind,
      label,
      onSelect: this.calculate.bind(this, column, kind),
    };
  }
  private renderRow(row: Row, index: number): React.ReactNode {
    const id = this.props.rowId(row);
    const label = this.props.rowLabel(row);
    const columns = this.columns();
    const hasActions = Boolean(
      this.props.actions && this.props.actions.length > 0,
    );
    const rowActions =
      this.props.actions?.filter(
        (action) => action.available?.(row) ?? true,
      ) ?? [];
    const expanded = this.props.renderExpandedRow?.(row, index);
    const hasExpanded =
      expanded !== undefined && expanded !== null && expanded !== false;
    const mainRow = (
      <tr
        key={hasExpanded ? undefined : id}
        data-row-id={id}
        data-surface-target={this.props.rowSurfaceTarget?.(row)}
        data-selected={this.props.selection?.selectedIds.has(id) ?? false}
        data-active={this.props.isRowActive?.(row) ?? false}
        data-expanded={hasExpanded || undefined}
        onClick={
          this.props.onRowClick
            ? () => this.props.onRowClick?.(row)
            : undefined
        }
      >
        {this.props.selection && (
          <td
            className="crm-selection"
            data-pinned-edge={this.lastPinnedId() === null}
          >
            <SelectionCheckbox
              label={`Select ${label}`}
              mixed={false}
              disabled={false}
              checked={this.props.selection.selectedIds.has(id)}
              onChange={this.selectRow.bind(this, row)}
            />
          </td>
        )}
        {columns.map(this.renderCell.bind(this, row, index))}
        {hasActions && (
          <td className="crm-actions">
            {rowActions.length === 0 ? null : (
              <ActionMenu
                label={`Actions for ${label}`}
                align="end"
                trigger={
                  <button type="button" aria-label={`Actions for ${label}`}>
                    <MoreHorizontal size={18} />
                  </button>
                }
                sections={[
                  {
                    id: "actions",
                    items: rowActions.map(this.rowActionItem.bind(this, row)),
                  },
                ]}
              />
            )}
          </td>
        )}
      </tr>
    );
    if (!hasExpanded) return mainRow;
    const colSpan =
      columns.length + (this.props.selection ? 1 : 0) + (hasActions ? 1 : 0);
    return (
      <React.Fragment key={id}>
        {mainRow}
        <tr className="crm-expanded-row" data-expanded-for={id}>
          <td colSpan={colSpan} className="crm-expanded-cell">
            {expanded}
          </td>
        </tr>
      </React.Fragment>
    );
  }
  private renderCalculation(column: CrmColumn<Row>): React.ReactNode {
    if (column.kind === "display")
      return (
        <td
          key={column.id}
          data-pinned={this.state.pinned.includes(column.id)}
          data-pinned-edge={this.lastPinnedId() === column.id}
          style={this.cellStyle(column)}
        />
      );
    const calculation = this.state.calculations.get(column.id) ?? "none";
    return (
      <td
        key={column.id}
        data-pinned={this.state.pinned.includes(column.id)}
        data-pinned-edge={this.lastPinnedId() === column.id}
        data-numeric={column.kind === "number" || column.align === "end"}
        style={this.cellStyle(column)}
      >
        <ActionMenu
          label={`Calculate ${column.label}`}
          trigger={
            <button
              type="button"
              className="crm-calculation"
              data-active={calculation !== "none"}
              aria-label={`Calculate ${column.label}`}
            >
              {calculateValue(this.props.rows, column, calculation)}
            </button>
          }
          sections={[
            {
              id: "calculations",
              items: [
                this.calculationItem(column, "none", "None"),
                this.calculationItem(column, "count", "Count values"),
                this.calculationItem(column, "unique", "Count unique"),
                ...(column.kind === "number"
                  ? [
                      this.calculationItem(column, "sum", "Sum"),
                      this.calculationItem(column, "average", "Average"),
                    ]
                  : []),
              ],
            },
          ]}
        />
      </td>
    );
  }
  private renderColumn(column: CrmColumn<Row>): React.ReactNode {
    return <col key={column.id} style={{ width: this.width(column) }} />;
  }
  render(): React.ReactNode {
    const columns = this.columns();
    const actions = Boolean(this.props.actions?.length);
    let width =
      (this.props.selection ? selectionColumnWidth : 0) + (actions ? 48 : 0);
    for (const column of columns) width += this.width(column);
    const count = this.selectedCount();
    return (
      <section
        className={
          this.props.className ? `crm-table ${this.props.className}` : "crm-table"
        }
        aria-label={this.props.label}
      >
        <DirectionProvider direction={this.state.direction}>
          <ScrollArea.Root className="crm-viewport">
            <ScrollArea.Viewport
              className="crm-scroll"
              ref={this.scroll}
              onScroll={this.updateScrollLayers.bind(this)}
              tabIndex={0}
              role="region"
              aria-label={`${this.props.label} table`}
            >
              <ScrollArea.Content>
                <table style={{ width }}>
                  <caption className="crm-sr-only">{this.props.label}</caption>
                  <colgroup>
                    {this.props.selection && (
                      <col style={{ width: selectionColumnWidth }} />
                    )}
                    {columns.map(this.renderColumn.bind(this))}
                    {actions && <col style={{ width: 48 }} />}
                  </colgroup>
                  <thead>
                    <tr>
                      {this.props.selection && (
                        <th
                          className="crm-selection"
                          scope="col"
                          data-pinned-edge={this.lastPinnedId() === null}
                        >
                          <SelectionCheckbox
                            checked={
                              count > 0 && count === this.props.rows.length
                            }
                            mixed={count > 0 && count < this.props.rows.length}
                            disabled={this.props.rows.length === 0}
                            onChange={this.selectAll.bind(this)}
                            label="Select all visible rows"
                          />
                        </th>
                      )}
                      {columns.map(this.renderHeader.bind(this))}
                      {actions && (
                        <th scope="col" className="crm-actions">
                          <span className="crm-sr-only">Actions</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {this.sortedRows().map(this.renderRow.bind(this))}
                  </tbody>
                  {this.props.rows.length > 0 && (
                    <tfoot>
                      <tr>
                        {this.props.selection && (
                          <td
                            className="crm-selection"
                            data-pinned-edge={this.lastPinnedId() === null}
                          />
                        )}
                        {columns.map(this.renderCalculation.bind(this))}
                        {actions && <td className="crm-actions" />}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </ScrollArea.Content>
            </ScrollArea.Viewport>
            <span className="crm-frozen-shadow" aria-hidden="true" />
            <ScrollArea.Scrollbar
              className="crm-scrollbar"
              orientation="vertical"
            >
              <ScrollArea.Thumb className="crm-scroll-thumb" />
            </ScrollArea.Scrollbar>
            <ScrollArea.Scrollbar
              className="crm-scrollbar"
              orientation="horizontal"
            >
              <ScrollArea.Thumb className="crm-scroll-thumb" />
            </ScrollArea.Scrollbar>
            <ScrollArea.Corner />
          </ScrollArea.Root>
        </DirectionProvider>
        {this.props.rows.length === 0 && (
          <EmptyState
            title={this.props.emptyTitle ?? "No records found"}
            description={
              this.props.emptyDescription ?? "Try changing your filters."
            }
          />
        )}
        <div className="crm-table-status" role="status">
          {this.props.rows.length}{" "}
          {this.props.rows.length === 1 ? "record" : "records"} in view
          {count > 0 ? ` · ${count} selected in view` : ""}
        </div>
      </section>
    );
  }
}

function clampWidth(value: number, minWidth = 100): number {
  return Number.isFinite(value)
    ? Math.max(minWidth, Math.min(600, value))
    : 180;
}
function compareRows<Row>(
  column: Exclude<CrmColumn<Row>, { kind: "display" }>,
  direction: "ascending" | "descending",
  a: Row,
  b: Row,
): number {
  const left = column.value(a);
  const right = column.value(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const result =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true });
  return direction === "ascending" ? result : -result;
}
function calculateValue<Row>(
  rows: readonly Row[],
  column: Exclude<CrmColumn<Row>, { kind: "display" }>,
  calculation: Calculation,
): string {
  if (calculation === "none") return "+ Calculate";
  const unique = new Set<string | number>();
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const value = column.value(row);
    if (
      value === null ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      continue;
    unique.add(value);
    count += 1;
    if (typeof value === "number") sum += value;
  }
  switch (calculation) {
    case "count":
      return `Count ${count}`;
    case "unique":
      return `Unique ${unique.size}`;
    case "sum":
    case "average": {
      if (count === 0) return "—";
      const value = calculation === "average" ? sum / count : sum;
      const formatted =
        column.kind === "number" && column.format
          ? column.format(value)
          : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return `${calculation === "sum" ? "Sum" : "Avg"} ${formatted}`;
    }
  }
}
class SelectionCheckbox extends React.Component<{
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}> {
  private input = React.createRef<HTMLInputElement>();
  componentDidMount(): void {
    this.updateMixed();
  }
  componentDidUpdate(): void {
    this.updateMixed();
  }
  private updateMixed(): void {
    if (this.input.current) this.input.current.indeterminate = this.props.mixed;
  }
  render(): React.ReactNode {
    return (
      <label className="crm-check">
        <input
          ref={this.input}
          type="checkbox"
          checked={this.props.checked}
          disabled={this.props.disabled}
          aria-label={this.props.label}
          onChange={this.props.onChange}
        />
      </label>
    );
  }
}
