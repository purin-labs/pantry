import React from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Clock,
  TrendingUp,
} from "lucide-react";
import type {
  ActualsWindowDays,
  BakeryPlanVsActualsCalculation,
  CalculatedProductMargin,
  PlanVsActualVarianceDriver,
  ProductPlanVsActualRow,
} from "@seams/control-api";
import { formatMoneyMinor } from "../../formatting";
import { CrmTable, Select, type CrmColumn, type CrmRowAction } from "../../ui";
import { CostsInlineBomPanel } from "./costs-bom-inline";
import { handleSheetKeyDown } from "./costs-sheet-grid";
import {
  CellPeerOutline,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";
import { ProductOrb } from "./costs-ui";

const ACTUALS_WINDOW_ITEMS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
] as const;

export function CostsActualsKpiStrip(
  props: Readonly<{
    actuals: BakeryPlanVsActualsCalculation;
  }>,
): React.ReactNode {
  const { summary } = props.actuals;
  const { currency, windowDays } = summary;
  const fmtMoney = (minor: number) =>
    formatMoneyMinor(Math.round(minor), currency);
  const fmtSigned = (minor: number) =>
    minor > 0
      ? `+${fmtMoney(minor)}`
      : minor < 0
        ? `−${fmtMoney(Math.abs(minor))}`
        : fmtMoney(0);

  const hasOrders = summary.orderCount > 0;
  const salesPillClass =
    summary.salesDeltaPct === null
      ? "is-neutral"
      : summary.salesDeltaPct >= 0
        ? "is-pos"
        : "is-neg";

  const cogsExcess = summary.cogsDeltaMinor;
  const cogsPillClass =
    Math.abs(cogsExcess) < 50
      ? "is-neutral"
      : cogsExcess > 0
        ? "is-neg"
        : "is-pos";

  const wasteExcess = summary.wasteDeltaMinor;
  const wastePillClass =
    Math.abs(wasteExcess) < 50
      ? "is-neutral"
      : wasteExcess > 0
        ? "is-neg"
        : "is-pos";

  const profitDelta = summary.operatingProfitDeltaMinor;
  const profitPillClass =
    Math.abs(profitDelta) < 50
      ? "is-neutral"
      : profitDelta > 0
        ? "is-pos"
        : "is-neg";

  return (
    <div
      className="costs-kpi-strip costs-actuals-kpi-strip"
      role="region"
      aria-label={`${windowDays}-day plan vs actuals summary`}
    >
      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">
          Actual net sales ({windowDays}d)
        </span>
        <span className="costs-kpi-value">
          {hasOrders ? fmtMoney(summary.actualNetSalesMinor) : "—"}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${salesPillClass}`}>
            {hasOrders && summary.salesDeltaPct !== null
              ? `${summary.salesDeltaPct >= 0 ? "+" : "−"}${Math.abs(summary.salesDeltaPct).toFixed(1)}%`
              : `${summary.orderCount} orders`}
          </span>
          <span>
            {hasOrders
              ? `vs plan ${fmtMoney(summary.plannedGrossSalesMinor)} · ${summary.posOrderCount} POS, ${summary.onlineOrderCount} online`
              : `Plan ${fmtMoney(summary.plannedGrossSalesMinor)}`}
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">Realized COGS (invoices)</span>
        <span className="costs-kpi-value">
          {fmtMoney(summary.actualCogsMinor)}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${cogsPillClass}`}>
            {Math.abs(cogsExcess) < 50 ? "On plan" : fmtSigned(-cogsExcess)}
          </span>
          <span>
            {summary.actualCogsPctOfSales !== null
              ? `${summary.actualCogsPctOfSales.toFixed(1)}% vs ${summary.plannedCogsPctOfSales.toFixed(1)}%`
              : `Plan ${fmtMoney(summary.plannedCogsMinor)}`}
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">Realized bake &amp; shelf waste</span>
        <span className="costs-kpi-value">
          {fmtMoney(summary.actualWasteMinor)}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${wastePillClass}`}>
            {Math.abs(wasteExcess) < 50 ? "On plan" : fmtSigned(-wasteExcess)}
          </span>
          <span>
            {summary.actualWastePctOfSales !== null
              ? `${summary.actualWastePctOfSales.toFixed(1)}% vs ${summary.plannedWastePctOfSales.toFixed(1)}%`
              : `Plan ${fmtMoney(summary.plannedWasteMinor)}`}
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">
          Fixed labor &amp; rent ({windowDays}d)
        </span>
        <span className="costs-kpi-value">
          {fmtMoney(summary.actualFixedCostMinor)}
        </span>
        <span className="costs-kpi-sub">
          <span className="costs-actuals-pill is-neutral">
            {summary.payableCount > 0
              ? `${summary.payableCount} bill${summary.payableCount === 1 ? "" : "s"}`
              : "On plan"}
          </span>
          <span>
            {summary.payableCount > 0
              ? `Payables: ${fmtMoney(summary.settledPayablesMinor)} paid · ${fmtMoney(summary.openPayablesMinor)} open`
              : hasOrders && summary.actualNetSalesMinor > 0
                ? `${((summary.actualFixedCostMinor / summary.actualNetSalesMinor) * 100).toFixed(1)}% of sales`
                : `Daily × ${windowDays}d`}
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">
          Realized {windowDays}d operating profit
        </span>
        <span
          className={`costs-kpi-value ${
            summary.actualOperatingProfitMinor < 0 ? "costs-val-neg" : ""
          }`}
        >
          {fmtSigned(summary.actualOperatingProfitMinor).replace(/^\+/u, "")}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${profitPillClass}`}>
            {Math.abs(profitDelta) < 50 ? "On plan" : fmtSigned(profitDelta)}
          </span>
          <span>
            {summary.actualOperatingMarginPct !== null
              ? `${summary.actualOperatingMarginPct.toFixed(1)}% vs ${summary.plannedOperatingMarginPct.toFixed(1)}%`
              : `vs plan ${fmtMoney(summary.plannedOperatingProfitMinor)}`}
          </span>
        </span>
      </div>
    </div>
  );
}

export function CostsMarginBridgeBar(
  props: Readonly<{
    actuals: BakeryPlanVsActualsCalculation;
    windowDays: ActualsWindowDays;
    onChangeWindowDays: (windowDays: ActualsWindowDays) => void;
    onSelectDriver: (driver: PlanVsActualVarianceDriver) => void;
  }>,
): React.ReactNode {
  const { actuals, windowDays } = props;
  const { summary, drivers } = actuals;
  const fmtSigned = (minor: number) => {
    const rounded = Math.round(minor);
    if (rounded < 0) {
      return `−${formatMoneyMinor(Math.abs(rounded), summary.currency)}`;
    }
    if (rounded > 0) {
      return `+${formatMoneyMinor(rounded, summary.currency)}`;
    }
    return formatMoneyMinor(0, summary.currency);
  };

  const hasLeaks = drivers.some((d) => d.profitImpactMinor < 0);
  const topChips = drivers.slice(0, 4);

  return (
    <div
      className={`costs-margin-bridge-bar${hasLeaks ? " has-leaks" : ""}`}
      role="region"
      aria-label="Margin variance bridge"
    >
      <div className="costs-margin-bridge-main">
        <span className="costs-margin-bridge-title">
          {hasLeaks ? (
            <AlertTriangle size={14} aria-hidden="true" />
          ) : (
            <TrendingUp size={14} aria-hidden="true" />
          )}
          <strong>Margin bridge ({windowDays}d):</strong>
        </span>

        {topChips.length > 0 ? (
          <div className="costs-margin-bridge-chips">
            {topChips.map((driver, idx) => {
              const isNegative = driver.profitImpactMinor < 0;
              return (
                <button
                  key={driver.id}
                  type="button"
                  className={`costs-leak-chip ${isNegative ? "is-neg" : "is-pos"}`}
                  title={`${driver.detail} — click to inspect`}
                  onClick={() => props.onSelectDriver(driver)}
                >
                  <span>
                    {idx + 1}. {driver.label}
                  </span>
                  <strong>{fmtSigned(driver.profitImpactMinor)}</strong>
                  <ArrowUpRight size={11} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : (
          <span className="costs-margin-bridge-empty">
            {summary.orderCount === 0
              ? "No invoice hikes, bake rejects, or stock losses recorded in this window yet."
              : "Realized volume, lot invoices, and waste are tracking plan."}
          </span>
        )}
      </div>

      <div className="costs-margin-bridge-controls">
        {summary.comparisonMode === "costs_and_waste_only" && (
          <span
            className="costs-margin-bridge-mode-note"
            title="No customer orders recorded in this window yet; variance reflects received lot invoices, batch rejects, and stock waste."
          >
            Invoices &amp; waste mode (0 orders)
          </span>
        )}
        <Select.Root
          name="actualsWindow"
          items={ACTUALS_WINDOW_ITEMS}
          value={String(windowDays)}
          onValueChange={(next) => {
            if (next === "7") props.onChangeWindowDays(7);
            else if (next === "30") props.onChangeWindowDays(30);
          }}
        >
          <Select.Trigger
            size="sm"
            className="costs-scenario-select"
            aria-label="Actuals lookback window"
          >
            <Clock
              size={13.5}
              className="costs-scenario-icon"
              aria-hidden="true"
            />
            <Select.Value />
          </Select.Trigger>
          <Select.Popup align="end" alignItemWithTrigger={false}>
            {ACTUALS_WINDOW_ITEMS.map((opt) => (
              <Select.Item key={opt.value} value={opt.value}>
                {opt.label}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </div>
    </div>
  );
}

export function CostsActualsSheet(
  props: Readonly<{
    actuals: BakeryPlanVsActualsCalculation;
    rows: readonly ProductPlanVsActualRow[];
    marginRowsByProductId: ReadonlyMap<string, CalculatedProductMargin>;
    selectedProductId: string | null;
    expandedProductIds: ReadonlySet<string> | undefined;
    presence: PresenceIndex;
    recipesHref: string;
    onSelectProduct: (productId: string) => void;
    onToggleInlineBom: (productId: string) => void;
    onOpenBomDrawer: (productId: string) => void;
    onInspectSupply: (inventoryItemId: string) => void;
    onEditOnMarginsTab: (productId: string) => void;
    onFocusCell: (cellKey: string, seed: string) => void;
    onBlurCell: (cellKey: string) => void;
  }>,
): React.ReactNode {
  const { actuals, rows, presence } = props;
  const { summary, windowDays } = actuals;
  const { currency } = summary;
  const hasOrders = summary.comparisonMode === "orders_and_costs";
  const fmtMoney = (minor: number) =>
    formatMoneyMinor(Math.round(minor), currency);

  const renderNavigableCell = (opts: {
    row: ProductPlanVsActualRow;
    rowIndex: number;
    col: string;
    ariaLabel: string;
    seed: string;
    alignStart?: boolean;
    children: React.ReactNode;
  }): React.ReactNode => {
    const cellKey = `actuals:${opts.row.productId}:${opts.col}`;
    const peers = presence.peersByCell.get(cellKey);
    return (
      <div
        className={`costs-cell-box is-readonly${opts.alignStart ? " is-align-start" : ""}${peers?.length ? " has-peer" : ""}`}
        style={peerCellStyle(peers)}
        tabIndex={0}
        data-sheet-row={opts.rowIndex}
        data-sheet-col={opts.col}
        aria-label={opts.ariaLabel}
        onFocus={() => {
          props.onSelectProduct(opts.row.productId);
          props.onFocusCell(cellKey, opts.seed);
        }}
        onBlur={() => props.onBlurCell(cellKey)}
        onKeyDown={(event) =>
          handleSheetKeyDown(event, opts.rowIndex, opts.col)
        }
      >
        <CellPeerOutline peers={peers} below={opts.rowIndex === 0} />
        {opts.children}
      </div>
    );
  };

  const columns: readonly CrmColumn<ProductPlanVsActualRow>[] = [
    {
      id: "product",
      label: `Menu item (${windowDays}d POS + online)`,
      kind: "text",
      width: 248,
      minWidth: 196,
      value: (row) => row.productTitle,
      render: (row) => (
        <div className="costs-product-cell">
          <ActualsStatusOrb row={row} />
          <div className="costs-product-meta">
            <span className="costs-product-title">{row.productTitle}</span>
            <span className="costs-product-sub">
              {formatCategoryName(row.productType)} · {row.primaryNote}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "plannedUnits",
      label: "Plan u",
      kind: "number",
      width: 82,
      minWidth: 68,
      value: (row) => row.plannedUnits,
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:plan_u`,
      }),
      render: (row, rowIndex) =>
        renderNavigableCell({
          row,
          rowIndex,
          col: "plan_u",
          ariaLabel: `${row.productTitle} planned ${windowDays}-day units`,
          seed: String(row.plannedUnits),
          children: <span>{row.plannedUnits}</span>,
        }),
    },
    {
      id: "actualUnits",
      label: "Actual u",
      kind: "number",
      width: 86,
      minWidth: 72,
      value: (row) => (hasOrders ? row.actualUnitsSold : null),
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:actual_u`,
      }),
      render: (row, rowIndex) =>
        renderNavigableCell({
          row,
          rowIndex,
          col: "actual_u",
          ariaLabel: `${row.productTitle} actual ${windowDays}-day units sold`,
          seed: hasOrders ? String(row.actualUnitsSold) : "0",
          children: hasOrders ? (
            <span
              title={`${row.posUnitsSold} POS · ${row.onlineUnitsSold} online`}
            >
              {row.actualUnitsSold}
            </span>
          ) : (
            <span className="costs-cell-muted">—</span>
          ),
        }),
    },
    {
      id: "volumeDelta",
      label: "Volume Δ",
      kind: "number",
      width: 92,
      minWidth: 78,
      value: (row) => (hasOrders ? row.volumeDeltaUnits : null),
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:vol_delta`,
      }),
      render: (row, rowIndex) => {
        const delta = row.volumeDeltaUnits;
        const tone =
          !hasOrders || delta === 0
            ? "costs-cell-muted"
            : delta > 0
              ? "costs-val-pos"
              : "costs-val-neg";
        const text = !hasOrders
          ? "—"
          : delta > 0
            ? `+${delta} u`
            : delta < 0
              ? `−${Math.abs(delta)} u`
              : "0 u";
        return renderNavigableCell({
          row,
          rowIndex,
          col: "vol_delta",
          ariaLabel: `${row.productTitle} volume variance`,
          seed: text,
          children: <span className={tone}>{text}</span>,
        });
      },
    },
    {
      id: "theoCogs",
      label: "Theo COGS",
      kind: "number",
      width: 96,
      minWidth: 82,
      value: (row) => Math.round(row.theoreticalUnitCogsMinor),
      format: fmtMoney,
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:theo_cogs`,
      }),
      render: (row, rowIndex) =>
        renderNavigableCell({
          row,
          rowIndex,
          col: "theo_cogs",
          ariaLabel: `${row.productTitle} theoretical standing unit COGS`,
          seed: fmtMoney(row.theoreticalUnitCogsMinor),
          children: (
            <span className="costs-cell-muted">
              {fmtMoney(row.theoreticalUnitCogsMinor)}
            </span>
          ),
        }),
    },
    {
      id: "actualCogs",
      label: "Actual COGS",
      kind: "number",
      width: 112,
      minWidth: 96,
      value: (row) => Math.round(row.actualUnitCogsMinor),
      format: fmtMoney,
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:actual_cogs`,
      }),
      render: (row, rowIndex) => {
        const isExpanded =
          props.expandedProductIds?.has(row.productId) === true;
        const hasBom = row.bomLines.length > 0;
        const cogsTone =
          row.unitCogsDeltaMinor >= 2
            ? "costs-val-warn"
            : row.unitCogsDeltaMinor <= -2
              ? "costs-val-pos"
              : "";
        return renderNavigableCell({
          row,
          rowIndex,
          col: "actual_cogs",
          ariaLabel: `${row.productTitle} realized invoice unit COGS`,
          seed: fmtMoney(row.actualUnitCogsMinor),
          children: (
            <span className="costs-actuals-cogs-cell">
              {hasBom && (
                <button
                  type="button"
                  className={`costs-bom-expand-btn${isExpanded ? " is-expanded" : ""}`}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.productTitle} realized ingredient cost chain`}
                  title={
                    isExpanded
                      ? "Hide ingredient & packaging cost chain"
                      : "Inspect realized invoice → recipe → SKU cost chain"
                  }
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleInlineBom(row.productId);
                  }}
                >
                  {isExpanded ? (
                    <ChevronDown size={13} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={13} aria-hidden="true" />
                  )}
                </button>
              )}
              <span className={cogsTone}>
                {fmtMoney(row.actualUnitCogsMinor)}
              </span>
            </span>
          ),
        });
      },
    },
    {
      id: "wasteBridge",
      label: "Waste (Plan → Act)",
      kind: "number",
      width: 136,
      minWidth: 116,
      value: (row) => row.actualWastePct ?? row.plannedWastePct,
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:waste`,
      }),
      render: (row, rowIndex) => {
        const planText = `${row.plannedWastePct.toFixed(1)}%`;
        if (row.actualWastePct === null) {
          return renderNavigableCell({
            row,
            rowIndex,
            col: "waste",
            ariaLabel: `${row.productTitle} waste comparison`,
            seed: `${planText} -> -`,
            children: <span className="costs-cell-muted">{planText} → —</span>,
          });
        }
        const actText = `${row.actualWastePct.toFixed(1)}%`;
        const excess = row.actualWastePct - row.plannedWastePct;
        const tone =
          excess > 2.5
            ? "costs-val-neg"
            : excess < -1.5
              ? "costs-val-pos"
              : "costs-cell-muted";
        return renderNavigableCell({
          row,
          rowIndex,
          col: "waste",
          ariaLabel: `${row.productTitle} planned vs actual waste`,
          seed: `${planText} -> ${actText}`,
          children: (
            <span
              className={tone}
              title={`Planned waste ${fmtMoney(row.plannedWasteMinor)} · Actual waste ${fmtMoney(row.actualWasteMinor)}`}
            >
              {planText} → {actText}
            </span>
          ),
        });
      },
    },
    {
      id: "actualMargin",
      label: "Actual margin",
      kind: "number",
      width: 138,
      minWidth: 118,
      value: (row) => row.actualMarginPct ?? row.plannedMarginPct,
      format: (v) => `${v.toFixed(1)}%`,
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:margin`,
      }),
      render: (row, rowIndex) =>
        renderNavigableCell({
          row,
          rowIndex,
          col: "margin",
          ariaLabel: `${row.productTitle} actual vs planned margin`,
          seed:
            row.actualMarginPct !== null
              ? `${row.actualMarginPct.toFixed(1)}%`
              : `${row.plannedMarginPct.toFixed(1)}%`,
          children:
            row.actualMarginPct !== null ? (
              <span>
                <strong>{row.actualMarginPct.toFixed(1)}%</strong>{" "}
                <span className="costs-cell-muted">
                  (plan {Math.round(row.plannedMarginPct)}%)
                </span>
              </span>
            ) : (
              <span className="costs-cell-muted">
                Plan {row.plannedMarginPct.toFixed(1)}%
              </span>
            ),
        }),
    },
    {
      id: "profitDelta",
      label: `${windowDays}d Profit Δ`,
      kind: "number",
      width: 118,
      minWidth: 98,
      value: (row) => Math.round(row.profitDeltaMinor),
      format: (minor) =>
        minor > 0
          ? `+${fmtMoney(minor)}`
          : minor < 0
            ? `−${fmtMoney(Math.abs(minor))}`
            : fmtMoney(0),
      cellProps: (row) => ({
        cellKey: `actuals:${row.productId}:profit_delta`,
      }),
      render: (row, rowIndex) => {
        const rounded = Math.round(row.profitDeltaMinor);
        const tone =
          Math.abs(rounded) < 10
            ? "costs-cell-muted"
            : rounded > 0
              ? "costs-val-pos"
              : "costs-val-neg";
        const text =
          rounded > 0
            ? `+${fmtMoney(rounded)}`
            : rounded < 0
              ? `−${fmtMoney(Math.abs(rounded))}`
              : fmtMoney(0);
        return renderNavigableCell({
          row,
          rowIndex,
          col: "profit_delta",
          ariaLabel: `${row.productTitle} ${windowDays}-day profit variance`,
          seed: text,
          children: <span className={tone}>{text}</span>,
        });
      },
    },
  ];

  const actions: readonly CrmRowAction<ProductPlanVsActualRow>[] = [
    {
      id: "inline_bom",
      label: "Toggle inline cost chain",
      onSelect: (row) => props.onToggleInlineBom(row.productId),
    },
    {
      id: "bom_drawer",
      label: "Open Recipe BOM drawer",
      onSelect: (row) => props.onOpenBomDrawer(row.productId),
    },
    {
      id: "edit_margins",
      label: "Re-price on Product margins",
      onSelect: (row) => props.onEditOnMarginsTab(row.productId),
    },
  ];

  return (
    <CrmTable
      key={`actuals-${windowDays}`}
      className="costs-crm-sheet"
      label={`${windowDays}-day plan vs actuals spreadsheet`}
      rows={rows}
      columns={columns}
      rowId={(row) => row.productId}
      rowLabel={(row) => row.productTitle}
      rowSurfaceTarget={(row) => `row:${row.productId}`}
      isRowActive={(row) =>
        props.selectedProductId === row.productId ||
        (rows.every((r) => r.productId !== props.selectedProductId) &&
          rows[0]?.productId === row.productId)
      }
      onRowClick={(row) => props.onSelectProduct(row.productId)}
      renderExpandedRow={(row) => {
        if (!props.expandedProductIds?.has(row.productId)) {
          return null;
        }
        const baseMargin = props.marginRowsByProductId.get(row.productId);
        if (baseMargin === undefined) {
          return null;
        }
        const realizedMarginRow: CalculatedProductMargin = {
          ...baseMargin,
          bomUnitCostMinor: row.actualUnitCogsMinor,
          bomLines: row.bomLines,
        };
        return (
          <CostsInlineBomPanel
            row={realizedMarginRow}
            recipesHref={props.recipesHref}
            onInspectSupply={props.onInspectSupply}
            onCollapse={() => props.onToggleInlineBom(row.productId)}
          />
        );
      }}
      actions={actions}
      initialPinned={["product"]}
      initialCalculations={{
        plannedUnits: "sum",
        ...(hasOrders ? { actualUnits: "sum" as const } : {}),
        theoCogs: "average",
        actualCogs: "average",
        actualMargin: "average",
        profitDelta: "sum",
      }}
      emptyTitle="No matching menu items"
      emptyDescription="Clear the search box or select another category chip."
    />
  );
}

function ActualsStatusOrb(
  props: Readonly<{ row: ProductPlanVsActualRow }>,
): React.ReactNode {
  const { row } = props;
  if (row.statusTone === "leak") {
    return (
      <span
        className="costs-actuals-status-orb is-leak"
        aria-hidden="true"
        title={row.primaryNote}
      >
        !
      </span>
    );
  }
  if (row.statusTone === "watch") {
    return (
      <span
        className="costs-actuals-status-orb is-watch"
        aria-hidden="true"
        title={row.primaryNote}
      >
        !
      </span>
    );
  }
  if (row.statusTone === "surplus") {
    return (
      <span
        className="costs-actuals-status-orb is-surplus"
        aria-hidden="true"
        title={row.primaryNote}
      >
        ↑
      </span>
    );
  }
  return (
    <ProductOrb
      title={row.productTitle}
      imageUrl={row.imageUrl}
    />
  );
}

function formatCategoryName(section: string): string {
  if (section.length === 0) return "General";
  const spaced = section.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
