import React from "react";
import { CalendarRange, Landmark, Sparkles, TrendingUp } from "lucide-react";
import type {
  Bakery12WeekForecastCalculation,
  CostForecastPlan,
  ForecastDemandCurve,
  ForecastSupplierTerms,
  ForecastWeekColumn,
} from "@purin-labs/control-api";
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  forecastReadonlySelectionKey,
  forecastWeekIndexCellKey,
} from "@purin-labs/costs-sheet-crdt";
import { formatMoneyMinor } from "../../formatting";
import { CrmTable, Select, type CrmColumn } from "../../ui";
import { minorToMajorString } from "./costs-sheet-draft";
import {
  handleCellBoxMouseDown,
  handleSheetKeyDown,
} from "./costs-sheet-grid";
import {
  CellPeerOutline,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";

type FocusedCell = Readonly<{
  cellKey: string;
  raw: string;
  seed: string;
}>;

const DEMAND_CURVE_LABELS: Readonly<Record<ForecastDemandCurve, string>> = {
  seasonal_holiday: "Seasonal & holiday peak",
  steady: "Steady baseline (100%)",
  growth_ramp: "Organic growth (+3%/wk)",
  winter_dip: "Winter foot-traffic dip",
  custom: "Custom weekly curve",
};

const DEMAND_CURVE_SHORT: Readonly<Record<ForecastDemandCurve, string>> = {
  seasonal_holiday: "Holiday curve",
  steady: "Steady 100%",
  growth_ramp: "Growth ramp",
  winter_dip: "Winter dip",
  custom: "Custom curve",
};

const DEMAND_CURVE_SELECT_ITEMS: readonly Readonly<{
  value: ForecastDemandCurve;
  label: string;
}>[] = [
  {
    value: "seasonal_holiday",
    label: DEMAND_CURVE_LABELS.seasonal_holiday,
  },
  { value: "steady", label: DEMAND_CURVE_LABELS.steady },
  { value: "growth_ramp", label: DEMAND_CURVE_LABELS.growth_ramp },
  { value: "winter_dip", label: DEMAND_CURVE_LABELS.winter_dip },
  { value: "custom", label: DEMAND_CURVE_LABELS.custom },
];

const SUPPLIER_TERMS_LABELS: Readonly<Record<ForecastSupplierTerms, string>> = {
  net_30: "Net-30 month-end",
  net_15: "Net-15 bi-weekly",
  cod: "COD (weekly cash)",
};

const SUPPLIER_TERMS_SHORT: Readonly<Record<ForecastSupplierTerms, string>> = {
  net_30: "Net-30",
  net_15: "Net-15",
  cod: "COD",
};

function formatMajorGrouped(minor: number, digits: number): string {
  const factor = 10 ** digits;
  const major = minor / factor;
  return major.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const SUPPLIER_TERMS_SELECT_ITEMS: readonly Readonly<{
  value: ForecastSupplierTerms;
  label: string;
}>[] = [
  { value: "net_30", label: SUPPLIER_TERMS_LABELS.net_30 },
  { value: "net_15", label: SUPPLIER_TERMS_LABELS.net_15 },
  { value: "cod", label: SUPPLIER_TERMS_LABELS.cod },
];

export function CostsForecastKpiStrip(
  props: Readonly<{
    forecast: Bakery12WeekForecastCalculation;
  }>,
): React.ReactNode {
  const { summary } = props.forecast;
  const { currency } = summary;
  const fmtMoney = (minor: number) =>
    formatMoneyMinor(Math.round(minor), currency);
  const fmtSigned = (minor: number) =>
    minor > 0
      ? `+${fmtMoney(minor)}`
      : minor < 0
        ? `−${fmtMoney(Math.abs(minor))}`
        : fmtMoney(0);

  const profitClass =
    summary.totalOperatingProfitMinor > 0
      ? "is-positive"
      : summary.totalOperatingProfitMinor < 0
        ? "is-negative"
        : "";
  const profitPillClass =
    summary.totalOperatingProfitMinor > 0
      ? "is-pos"
      : summary.totalOperatingProfitMinor < 0
        ? "is-neg"
        : "is-neutral";

  const troughPillClass = summary.hasCashShortfall
    ? "is-neg"
    : summary.lowestCashMinor < summary.openingCashMinor
      ? "is-warn"
      : "is-neutral";

  const endingClass =
    summary.endingCashMinor < 0
      ? "is-negative"
      : summary.netCashBuildMinor > 0
        ? "is-positive"
        : "";
  const buildPillClass =
    summary.netCashBuildMinor > 0
      ? "is-pos"
      : summary.netCashBuildMinor < 0
        ? "is-neg"
        : "is-neutral";

  const endingNote =
    summary.capexMinor > 0
      ? summary.capexPaybackWeeks !== null
        ? `Capex payback ~${summary.capexPaybackWeeks}w`
        : "Capex payback > 12w"
      : "net cash build";

  return (
    <div
      className="costs-kpi-strip costs-forecast-kpi-strip"
      role="region"
      aria-label="12-week P&L and cash runway summary"
    >
      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">Opening bank cash</span>
        <span className="costs-kpi-value">
          {fmtMoney(summary.openingCashMinor)}
        </span>
        <span className="costs-kpi-sub">
          {summary.openPayablesIncludedMinor > 0 ? (
            <>
              <span className="costs-actuals-pill is-warn">
                Open AP {formatCompactMoney(summary.openPayablesIncludedMinor, currency)}
              </span>
              <span>queued in payables</span>
            </>
          ) : (
            <span>Starting cash reserve · {SUPPLIER_TERMS_LABELS[summary.supplierTerms]}</span>
          )}
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">12-week projected sales</span>
        <span className="costs-kpi-value">
          {fmtMoney(summary.totalGrossSalesMinor)}
        </span>
        <span className="costs-kpi-sub">
          <span className="costs-actuals-pill is-info">
            {DEMAND_CURVE_SHORT[summary.demandCurve]}
          </span>
          <span>
            Peak {summary.peakDemandWeekCode} ({summary.peakDemandIndexPct}%) ·{" "}
            {summary.totalPlannedUnits.toLocaleString("en-US")} units
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">12-week operating profit</span>
        <span className={`costs-kpi-value ${profitClass}`}>
          {fmtSigned(summary.totalOperatingProfitMinor)}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${profitPillClass}`}>
            {summary.operatingMarginPct.toFixed(1)}%
          </span>
          <span>
            {summary.extraShiftWeeksCount > 0
              ? `incl. ${summary.extraShiftWeeksCount} extra-shift wk${summary.extraShiftWeeksCount === 1 ? "" : "s"}`
              : "Base shift staffing"}
          </span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">Lowest cash trough</span>
        <span
          className={`costs-kpi-value${summary.hasCashShortfall ? " is-negative" : ""}`}
        >
          {fmtSignedIfNegative(summary.lowestCashMinor, currency)}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${troughPillClass}`}>
            {summary.lowestCashWeekCode}
          </span>
          <span>{summary.lowestCashReason}</span>
        </span>
      </div>

      <div className="costs-kpi-cell">
        <span className="costs-kpi-label">Ending bank cash (W12)</span>
        <span className={`costs-kpi-value ${endingClass}`}>
          {fmtSignedIfNegative(summary.endingCashMinor, currency)}
        </span>
        <span className="costs-kpi-sub">
          <span className={`costs-actuals-pill ${buildPillClass}`}>
            {formatCompactSignedMoney(summary.netCashBuildMinor, currency)}
          </span>
          <span>{endingNote}</span>
        </span>
      </div>
    </div>
  );
}

export function CostsForecastControlsBar(
  props: Readonly<{
    plan: CostForecastPlan;
    currency: string;
    currencySymbol: string;
    digits: number;
    canEdit: boolean;
    focusedCell: FocusedCell | null;
    presence: PresenceIndex;
    onFocusCell: (
      cellKey: string,
      raw: string,
      input?: HTMLInputElement,
    ) => void;
    onBlurCell: (cellKey: string) => void;
    onSelectDemandCurve: (
      curve: Exclude<ForecastDemandCurve, "custom">,
    ) => void;
    onSelectSupplierTerms: (terms: ForecastSupplierTerms) => void;
    onChangeOpeningCashRaw: (raw: string) => void;
    onChangeExtraShiftThresholdRaw: (raw: string) => void;
    onChangeExtraShiftWeeklyRaw: (raw: string) => void;
    onChangeCapexRaw: (raw: string) => void;
  }>,
): React.ReactNode {
  const {
    plan,
    currencySymbol,
    digits,
    canEdit,
    focusedCell,
    presence,
  } = props;

  const openingRaw = minorToMajorString(plan.openingCashMinor, digits);
  const openingDisplay = formatMajorGrouped(plan.openingCashMinor, digits);
  const shiftThresholdFormatted = String(plan.extraShiftThresholdPct);
  const shiftCostRaw = minorToMajorString(plan.extraShiftWeeklyMinor, digits);
  const shiftCostDisplay = formatMajorGrouped(
    plan.extraShiftWeeklyMinor,
    digits,
  );
  const capexRaw = minorToMajorString(plan.capexMinor, digits);
  const capexDisplay = formatMajorGrouped(plan.capexMinor, digits);

  const openingPeers = presence.peersByCell.get(FORECAST_OPENING_CASH_CELL_KEY);
  const thresholdPeers = presence.peersByCell.get(
    FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  );
  const shiftCostPeers = presence.peersByCell.get(
    FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  );
  const capexPeers = presence.peersByCell.get(FORECAST_CAPEX_MINOR_CELL_KEY);

  return (
    <div
      className="costs-forecast-controls-bar"
      role="region"
      aria-label="12-week forecast scenario and cash levers"
    >
      <div className="costs-forecast-control-group">
        <span className="costs-forecast-control-label">
          <CalendarRange size={13} aria-hidden="true" />
          <span>Seasonality</span>
        </span>
        <Select.Root
          name="forecastDemandCurve"
          items={DEMAND_CURVE_SELECT_ITEMS}
          disabled={!canEdit}
          value={plan.demandCurve}
          onValueChange={(next) => {
            if (
              next === "seasonal_holiday" ||
              next === "steady" ||
              next === "growth_ramp" ||
              next === "winter_dip"
            ) {
              props.onSelectDemandCurve(next);
            }
          }}
        >
          <Select.Trigger
            size="sm"
            className="costs-forecast-select"
            aria-label="12-week demand curve"
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Popup align="start" alignItemWithTrigger={false}>
            {(
              [
                "seasonal_holiday",
                "steady",
                "growth_ramp",
                "winter_dip",
              ] as const
            ).map((curve) => (
              <Select.Item key={curve} value={curve}>
                {DEMAND_CURVE_LABELS[curve]}
              </Select.Item>
            ))}
            {plan.demandCurve === "custom" && (
              <Select.Item value="custom" disabled>
                {DEMAND_CURVE_LABELS.custom}
              </Select.Item>
            )}
          </Select.Popup>
        </Select.Root>
      </div>

      <div className="costs-forecast-control-group">
        <span className="costs-forecast-control-label">
          <Landmark size={13} aria-hidden="true" />
          <span>Payables</span>
        </span>
        <Select.Root
          name="forecastSupplierTerms"
          items={SUPPLIER_TERMS_SELECT_ITEMS}
          disabled={!canEdit}
          value={plan.supplierTerms}
          onValueChange={(next) => {
            if (next === "net_30" || next === "net_15" || next === "cod") {
              props.onSelectSupplierTerms(next);
            }
          }}
        >
          <Select.Trigger
            size="sm"
            className="costs-forecast-select"
            aria-label="Supplier payment terms"
          >
            <Select.Value />
          </Select.Trigger>
          <Select.Popup align="start" alignItemWithTrigger={false}>
            {(["net_30", "net_15", "cod"] as const).map((terms) => (
              <Select.Item key={terms} value={terms}>
                {SUPPLIER_TERMS_LABELS[terms]}
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Root>
      </div>

      <label
        className={`costs-forecast-inline-field${openingPeers?.length ? " has-peer" : ""}`}
        style={peerCellStyle(openingPeers)}
      >
        <CellPeerOutline peers={openingPeers} />
        <span className="costs-forecast-field-tag">Opening cash</span>
        <span className="costs-forecast-field-affix">{currencySymbol}</span>
        <input
          type="text"
          inputMode="decimal"
          disabled={!canEdit}
          aria-label="Opening bank cash"
          value={resolveInputValue(
            focusedCell,
            FORECAST_OPENING_CASH_CELL_KEY,
            openingDisplay,
          )}
          onFocus={(e) =>
            props.onFocusCell(
              FORECAST_OPENING_CASH_CELL_KEY,
              openingRaw,
              e.currentTarget,
            )
          }
          onBlur={() => props.onBlurCell(FORECAST_OPENING_CASH_CELL_KEY)}
          onChange={(e) => props.onChangeOpeningCashRaw(e.currentTarget.value)}
        />
      </label>

      <div className="costs-forecast-shift-pair">
        <label
          className={`costs-forecast-inline-field is-narrow${thresholdPeers?.length ? " has-peer" : ""}`}
          style={peerCellStyle(thresholdPeers)}
        >
          <CellPeerOutline peers={thresholdPeers} />
          <span className="costs-forecast-field-tag">Extra shift ≥</span>
          <input
            type="number"
            min={101}
            max={400}
            step={5}
            disabled={!canEdit}
            aria-label="Extra shift demand threshold percent"
            value={resolveInputValue(
              focusedCell,
              FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
              shiftThresholdFormatted,
            )}
            onFocus={(e) =>
              props.onFocusCell(
                FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
                shiftThresholdFormatted,
                e.currentTarget,
              )
            }
            onBlur={() =>
              props.onBlurCell(FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY)
            }
            onChange={(e) =>
              props.onChangeExtraShiftThresholdRaw(e.currentTarget.value)
            }
          />
          <span className="costs-forecast-field-affix">%</span>
        </label>

        <label
          className={`costs-forecast-inline-field${shiftCostPeers?.length ? " has-peer" : ""}`}
          style={peerCellStyle(shiftCostPeers)}
        >
          <CellPeerOutline peers={shiftCostPeers} />
          <span className="costs-forecast-field-tag">+Shift / wk</span>
          <span className="costs-forecast-field-affix">{currencySymbol}</span>
          <input
            type="text"
            inputMode="decimal"
            disabled={!canEdit}
            aria-label="Extra shift weekly labor cost"
            value={resolveInputValue(
              focusedCell,
              FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
              shiftCostDisplay,
            )}
            onFocus={(e) =>
              props.onFocusCell(
                FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
                shiftCostRaw,
                e.currentTarget,
              )
            }
            onBlur={() =>
              props.onBlurCell(FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY)
            }
            onChange={(e) =>
              props.onChangeExtraShiftWeeklyRaw(e.currentTarget.value)
            }
          />
        </label>
      </div>

      <label
        className={`costs-forecast-inline-field${capexPeers?.length ? " has-peer" : ""}`}
        style={peerCellStyle(capexPeers)}
      >
        <CellPeerOutline peers={capexPeers} />
        <span className="costs-forecast-field-tag">
          <Sparkles size={11} aria-hidden="true" />
          <span>W1 Capex</span>
        </span>
        <span className="costs-forecast-field-affix">{currencySymbol}</span>
        <input
          type="text"
          inputMode="decimal"
          disabled={!canEdit}
          aria-label="Week 1 equipment capex"
          value={resolveInputValue(
            focusedCell,
            FORECAST_CAPEX_MINOR_CELL_KEY,
            capexDisplay,
          )}
          onFocus={(e) =>
            props.onFocusCell(
              FORECAST_CAPEX_MINOR_CELL_KEY,
              capexRaw,
              e.currentTarget,
            )
          }
          onBlur={() => props.onBlurCell(FORECAST_CAPEX_MINOR_CELL_KEY)}
          onChange={(e) => props.onChangeCapexRaw(e.currentTarget.value)}
        />
      </label>
    </div>
  );
}

export function CostsForecastTrajectoryChart(
  props: Readonly<{
    forecast: Bakery12WeekForecastCalculation;
    currencySymbol: string;
  }>,
): React.ReactNode {
  const { weeks, summary } = props.forecast;
  const baselineY = 92;
  const topY = 14;
  const chartSpan = baselineY - topY;

  const maxBarMagnitude = Math.max(
    1,
    ...weeks.map((wk) =>
      Math.max(Math.abs(wk.operatingProfitMinor), wk.lumpOutflowMinor),
    ),
  );

  const cashValues = [
    summary.openingCashMinor,
    ...weeks.map((wk) => wk.endingCashMinor),
  ];
  const minCash = Math.min(...cashValues);
  const maxCash = Math.max(...cashValues, minCash + 1);
  const cashRange = Math.max(1, maxCash - minCash);

  const xForWeek = (idx: number): number => 65 + idx * 80;
  const yForCash = (cashMinor: number): number => {
    const ratio = (cashMinor - minCash) / cashRange;
    return Math.round((baselineY - 12 - ratio * (chartSpan - 16)) * 10) / 10;
  };

  const polylinePoints = weeks
    .map((wk, idx) => `${xForWeek(idx)},${yForCash(wk.endingCashMinor)}`)
    .join(" ");

  let peakWeekIdx = 0;
  for (let i = 1; i < weeks.length; i += 1) {
    if ((weeks[i]?.demandIndexPct ?? 0) > (weeks[peakWeekIdx]?.demandIndexPct ?? 0)) {
      peakWeekIdx = i;
    }
  }

  return (
    <div
      className="costs-forecast-chart-card"
      role="region"
      aria-label="12-week operating profit and bank cash trajectory"
    >
      <div className="costs-forecast-chart-head">
        <div className="costs-forecast-chart-title">
          <TrendingUp size={14} aria-hidden="true" />
          <strong>
            12-Week Operating Profit &amp; Bank Cash Trajectory (
            {props.currencySymbol})
          </strong>
          {summary.peakExtraBulkTiersUnlocked > 0 && (
            <span className="costs-actuals-pill is-pos">
              +{summary.peakExtraBulkTiersUnlocked} peak bulk tier
              {summary.peakExtraBulkTiersUnlocked === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="costs-forecast-chart-legend">
          <span>
            <i className="costs-legend-swatch is-profit" aria-hidden="true" />
            Weekly operating profit
          </span>
          <span>
            <i className="costs-legend-swatch is-lump" aria-hidden="true" />
            Rent, {SUPPLIER_TERMS_SHORT[summary.supplierTerms]} &amp; capex
            outflows
          </span>
          <span>
            <i className="costs-legend-swatch is-cash" aria-hidden="true" />
            Ending bank cash
          </span>
        </div>
      </div>

      <svg
        viewBox="0 0 1010 116"
        width="100%"
        height="116"
        className="costs-forecast-svg"
        aria-label="12-week cash and operating profit chart"
      >
        <line
          x1="28"
          y1={baselineY}
          x2="988"
          y2={baselineY}
          stroke="var(--costs-border)"
          strokeWidth="1"
        />
        <line
          x1="28"
          y1="54"
          x2="988"
          y2="54"
          stroke="var(--costs-border-soft)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <line
          x1="28"
          y1="18"
          x2="988"
          y2="18"
          stroke="var(--costs-border-soft)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />

        {weeks.map((wk, idx) => {
          const cx = xForWeek(idx);
          const profitHeight = Math.max(
            4,
            Math.round(
              (Math.abs(wk.operatingProfitMinor) / maxBarMagnitude) * 74,
            ),
          );
          const isNeg = wk.operatingProfitMinor < 0;
          const isPeak = idx === peakWeekIdx && wk.demandIndexPct > 105;
          const lumpHeight =
            wk.lumpOutflowMinor > 0
              ? Math.max(
                  6,
                  Math.round((wk.lumpOutflowMinor / maxBarMagnitude) * 44),
                )
              : 0;
          return (
            <g key={wk.weekCode}>
              <rect
                x={cx - 14}
                y={baselineY - profitHeight}
                width={26}
                height={profitHeight}
                rx={3}
                fill={
                  isNeg
                    ? "#e11d48"
                    : isPeak
                      ? "#059669"
                      : "#10b981"
                }
                opacity={isPeak ? 0.96 : 0.84}
              >
                <title>
                  {`${wk.shortLabel}: Profit ${formatMoneyMinor(wk.operatingProfitMinor, summary.currency)}`}
                </title>
              </rect>
              {lumpHeight > 0 && (
                <rect
                  x={cx + 15}
                  y={baselineY - lumpHeight}
                  width={11}
                  height={lumpHeight}
                  rx={2}
                  fill="#fbbf24"
                >
                  <title>
                    {`${wk.shortLabel}: Lump outflow ${formatMoneyMinor(wk.lumpOutflowMinor, summary.currency)}`}
                  </title>
                </rect>
              )}
            </g>
          );
        })}

        <polyline
          fill="none"
          stroke="#2563eb"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={polylinePoints}
        />

        {weeks.map((wk, idx) => {
          const isTrough = idx === summary.lowestCashWeekIndex;
          const isEnding = idx === weeks.length - 1;
          const isPeak = idx === peakWeekIdx;
          if (!isTrough && !isEnding && !isPeak) return null;
          const fill =
            isTrough && summary.hasCashShortfall
              ? "#dc2626"
              : isTrough
                ? "#f59e0b"
                : isEnding
                  ? "#059669"
                  : "#2563eb";
          return (
            <circle
              key={`dot-${wk.weekCode}`}
              cx={xForWeek(idx)}
              cy={yForCash(wk.endingCashMinor)}
              r={4.2}
              fill={fill}
              stroke="#ffffff"
              strokeWidth="1.6"
            >
              <title>
                {`${wk.shortLabel} ending cash: ${formatMoneyMinor(wk.endingCashMinor, summary.currency)}`}
              </title>
            </circle>
          );
        })}

        <g fontSize="11.5" textAnchor="middle">
          {weeks.map((wk, idx) => {
            const isHighlighted =
              idx === peakWeekIdx || idx === summary.lowestCashWeekIndex;
            const axisText =
              idx === 0 || idx === 3 || idx === 7
                ? wk.shortLabel
                : wk.milestoneTag !== null
                  ? `${wk.weekCode} ${wk.milestoneTag}`
                  : wk.weekCode;
            return (
              <text
                key={`lbl-${wk.weekCode}`}
                x={xForWeek(idx)}
                y={109}
                fill={
                  isHighlighted
                    ? "var(--costs-ink)"
                    : "var(--costs-ink-muted)"
                }
                fontWeight={isHighlighted ? 600 : 400}
              >
                {axisText}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

type ForecastSheetRow = Readonly<{
  id:
    | "demand_index"
    | "gross_sales"
    | "cogs"
    | "waste_tax_fees"
    | "gross_contrib"
    | "labor"
    | "rent"
    | "operating_profit"
    | "cash_outflows"
    | "ending_cash";
  label: string;
  emphasis: "bold" | "section" | "muted" | "normal";
}>;

const FORECAST_ROWS: readonly ForecastSheetRow[] = [
  {
    id: "demand_index",
    label: "Seasonality demand index",
    emphasis: "bold",
  },
  {
    id: "gross_sales",
    label: "Gross revenue (counter + online)",
    emphasis: "normal",
  },
  {
    id: "cogs",
    label: "− Ingredient & packaging COGS",
    emphasis: "muted",
  },
  {
    id: "waste_tax_fees",
    label: "− Bake waste, tax & card fees",
    emphasis: "muted",
  },
  {
    id: "gross_contrib",
    label: "= Gross contribution",
    emphasis: "section",
  },
  {
    id: "labor",
    label: "− Baker & barista labor (shift step)",
    emphasis: "muted",
  },
  {
    id: "rent",
    label: "− Shop rent & occupancy (accrual)",
    emphasis: "muted",
  },
  {
    id: "operating_profit",
    label: "= Weekly operating profit",
    emphasis: "section",
  },
  {
    id: "cash_outflows",
    label: "Cash bills paid (suppliers, rent, capex)",
    emphasis: "muted",
  },
  {
    id: "ending_cash",
    label: "Ending bank cash",
    emphasis: "bold",
  },
];

export function CostsForecastSheet(
  props: Readonly<{
    forecast: Bakery12WeekForecastCalculation;
    canEdit: boolean;
    focusedCell: FocusedCell | null;
    presence: PresenceIndex;
    onFocusCell: (
      cellKey: string,
      raw: string,
      input?: HTMLInputElement,
    ) => void;
    onBlurCell: (cellKey: string) => void;
    onChangeWeekDemandPct: (weekIndex: number, raw: string) => void;
  }>,
): React.ReactNode {
  const { forecast, canEdit, focusedCell, presence } = props;
  const { weeks, summary } = forecast;
  const { currency } = summary;

  const weekColumns: readonly CrmColumn<ForecastSheetRow>[] = weeks.map(
    (wk, wIdx) => ({
      id: `w_${wIdx}`,
      label: wk.shortLabel,
      kind: "number",
      width: 106,
      minWidth: 96,
      value: (row) => numericCellForWeek(row.id, wk),
      cellProps: (row) => ({
        cellKey:
          row.id === "demand_index"
            ? forecastWeekIndexCellKey(wIdx)
            : forecastReadonlySelectionKey(row.id, wk.weekCode),
      }),
      render: (row, rowIndex) => {
        if (row.id === "demand_index") {
          const cellKey = forecastWeekIndexCellKey(wIdx);
          const peers = presence.peersByCell.get(cellKey);
          const formatted = String(wk.demandIndexPct);
          return (
            <div
              className={`costs-cell-box is-compact${peers?.length ? " has-peer" : ""}`}
              style={peerCellStyle(peers)}
              onMouseDown={handleCellBoxMouseDown}
            >
              <CellPeerOutline peers={peers} below={rowIndex === 0} />
              <input
                type="number"
                className="costs-cell-input is-day"
                min={10}
                max={500}
                step={1}
                disabled={!canEdit}
                data-sheet-row={rowIndex}
                data-sheet-col={`w_${wIdx}`}
                aria-label={`${wk.shortLabel} seasonality demand index percent`}
                value={resolveInputValue(focusedCell, cellKey, formatted)}
                onFocus={(e) =>
                  props.onFocusCell(cellKey, formatted, e.currentTarget)
                }
                onBlur={() => props.onBlurCell(cellKey)}
                onChange={(e) =>
                  props.onChangeWeekDemandPct(wIdx, e.currentTarget.value)
                }
                onKeyDown={(e) => handleSheetKeyDown(e, rowIndex, `w_${wIdx}`)}
              />
              <span className="costs-cell-suffix">%</span>
            </div>
          );
        }

        const selKey = forecastReadonlySelectionKey(row.id, wk.weekCode);
        const peers = presence.peersByCell.get(selKey);
        const rendered = renderForecastWeekValue(
          row.id,
          wk,
          wIdx === summary.lowestCashWeekIndex,
          currency,
        );

        return (
          <div
            className={`costs-cell-box is-readonly${row.emphasis === "section" ? " is-forecast-section" : ""}${peers?.length ? " has-peer" : ""}`}
            style={peerCellStyle(peers)}
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col={`w_${wIdx}`}
            title={rendered.tooltip}
            aria-label={`${row.label} ${wk.shortLabel}`}
            onFocus={() => props.onFocusCell(selKey, rendered.plainText)}
            onBlur={() => props.onBlurCell(selKey)}
            onKeyDown={(e) => handleSheetKeyDown(e, rowIndex, `w_${wIdx}`)}
          >
            <CellPeerOutline peers={peers} below={rowIndex === 0} />
            {rendered.node}
          </div>
        );
      },
    }),
  );

  const columns: readonly CrmColumn<ForecastSheetRow>[] = [
    {
      id: "line",
      label: "Weekly P&L & cash line",
      kind: "text",
      width: 248,
      minWidth: 214,
      value: (row) => row.label,
      render: (row) => (
        <span
          className={`costs-forecast-row-label is-${row.emphasis}`}
        >
          {row.label}
        </span>
      ),
    },
    ...weekColumns,
    {
      id: "total",
      label: "12w Total",
      kind: "number",
      width: 112,
      minWidth: 98,
      value: (row) => numericTotalForRow(row.id, forecast),
      cellProps: (row) => ({
        cellKey: forecastReadonlySelectionKey(row.id, "total"),
      }),
      render: (row, rowIndex) => {
        const selKey = forecastReadonlySelectionKey(row.id, "total");
        const peers = presence.peersByCell.get(selKey);
        const rendered = renderForecastTotalValue(row.id, forecast);
        return (
          <div
            className={`costs-cell-box is-readonly is-forecast-total${row.emphasis === "section" ? " is-forecast-section" : ""}${peers?.length ? " has-peer" : ""}`}
            style={peerCellStyle(peers)}
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="total"
            title={rendered.tooltip}
            aria-label={`${row.label} 12-week total`}
            onFocus={() => props.onFocusCell(selKey, rendered.plainText)}
            onBlur={() => props.onBlurCell(selKey)}
            onKeyDown={(e) => handleSheetKeyDown(e, rowIndex, "total")}
          >
            <CellPeerOutline peers={peers} below={rowIndex === 0} />
            {rendered.node}
          </div>
        );
      },
    },
  ];

  return (
    <CrmTable
      key="forecast"
      className="costs-crm-sheet costs-forecast-crm-sheet"
      label="12-week rolling P&L and cash runway forecast spreadsheet"
      rows={FORECAST_ROWS}
      columns={columns}
      rowId={(row) => row.id}
      rowLabel={(row) => row.label}
      rowSurfaceTarget={(row) => `forecast:${row.id}`}
      initialPinned={["line"]}
      emptyTitle="No forecast rows"
      emptyDescription="Configure weekly products and supplier costs to project 12-week cash."
    />
  );
}

function numericCellForWeek(
  rowId: ForecastSheetRow["id"],
  wk: ForecastWeekColumn,
): number {
  switch (rowId) {
    case "demand_index":
      return wk.demandIndexPct;
    case "gross_sales":
      return wk.grossSalesMinor;
    case "cogs":
      return wk.cogsMinor;
    case "waste_tax_fees":
      return wk.wasteTaxFeeMinor;
    case "gross_contrib":
      return wk.grossContributionMinor;
    case "labor":
      return wk.laborMinor;
    case "rent":
      return wk.accrualRentMinor;
    case "operating_profit":
      return wk.operatingProfitMinor;
    case "cash_outflows":
      return (
        wk.supplierCashOutMinor + wk.rentCashOutMinor + wk.capexCashOutMinor
      );
    case "ending_cash":
      return wk.endingCashMinor;
  }
}

function numericTotalForRow(
  rowId: ForecastSheetRow["id"],
  forecast: Bakery12WeekForecastCalculation,
): number {
  const s = forecast.summary;
  switch (rowId) {
    case "demand_index":
      return s.averageDemandIndexPct;
    case "gross_sales":
      return s.totalGrossSalesMinor;
    case "cogs":
      return s.totalCogsMinor;
    case "waste_tax_fees":
      return s.totalWasteTaxFeeMinor;
    case "gross_contrib":
      return s.totalGrossContributionMinor;
    case "labor":
      return s.totalLaborMinor;
    case "rent":
      return s.totalAccrualRentMinor;
    case "operating_profit":
      return s.totalOperatingProfitMinor;
    case "cash_outflows":
      return forecast.weeks.reduce(
        (sum, wk) =>
          sum +
          wk.supplierCashOutMinor +
          wk.rentCashOutMinor +
          wk.capexCashOutMinor,
        0,
      );
    case "ending_cash":
      return s.endingCashMinor;
  }
}

function renderForecastWeekValue(
  rowId: ForecastSheetRow["id"],
  wk: ForecastWeekColumn,
  isLowestTrough: boolean,
  currency: string,
): Readonly<{
  node: React.ReactNode;
  plainText: string;
  tooltip: string;
}> {
  const exact = (minor: number) => formatMoneyMinor(Math.round(minor), currency);
  const compact = (minor: number) => formatCompactMoney(minor, currency);

  switch (rowId) {
    case "demand_index": {
      const txt = `${wk.demandIndexPct}%`;
      return { node: <span>{txt}</span>, plainText: txt, tooltip: txt };
    }
    case "gross_sales": {
      const txt = compact(wk.grossSalesMinor);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip: `${exact(wk.grossSalesMinor)} · ${wk.plannedUnits.toLocaleString("en-US")} units`,
      };
    }
    case "cogs": {
      const txt = compact(wk.cogsMinor);
      const hasBulkGain = wk.extraBulkTiersUnlocked > 0;
      return {
        node: hasBulkGain ? (
          <span className="costs-forecast-tagged-val is-pos">
            <span>{txt}</span>
            <span className="costs-forecast-mini-tag is-pos">bulk</span>
          </span>
        ) : (
          <span className="costs-cell-muted">{txt}</span>
        ),
        plainText: hasBulkGain ? `${txt} (bulk)` : txt,
        tooltip: hasBulkGain
          ? `${exact(wk.cogsMinor)} · +${wk.extraBulkTiersUnlocked} bulk tier unlocked (saves ${exact(wk.weeklyTierSavingsMinor)}/wk)`
          : exact(wk.cogsMinor),
      };
    }
    case "waste_tax_fees": {
      const txt = compact(wk.wasteTaxFeeMinor);
      return {
        node: <span className="costs-cell-muted">{txt}</span>,
        plainText: txt,
        tooltip: `Waste ${exact(wk.wasteMinor)} + Tax ${exact(wk.includedTaxMinor)} + Fees ${exact(wk.channelFeeMinor)}`,
      };
    }
    case "gross_contrib": {
      const txt = compact(wk.grossContributionMinor);
      return {
        node: <strong>{txt}</strong>,
        plainText: txt,
        tooltip: exact(wk.grossContributionMinor),
      };
    }
    case "labor": {
      const txt = compact(wk.laborMinor);
      return {
        node: wk.extraShiftActive ? (
          <span className="costs-forecast-tagged-val is-warn">
            <span>{txt}</span>
            <span className="costs-forecast-mini-tag is-warn">+shift</span>
          </span>
        ) : (
          <span className="costs-cell-muted">{txt}</span>
        ),
        plainText: wk.extraShiftActive ? `${txt} (+shift)` : txt,
        tooltip: wk.extraShiftActive
          ? `${exact(wk.laborMinor)} · Includes peak extra baker/barista shift`
          : exact(wk.laborMinor),
      };
    }
    case "rent": {
      const txt = compact(wk.accrualRentMinor);
      return {
        node: <span className="costs-cell-muted">{txt}</span>,
        plainText: txt,
        tooltip: `${exact(wk.accrualRentMinor)} weekly accrual`,
      };
    }
    case "operating_profit": {
      const txt = formatCompactSignedMoney(wk.operatingProfitMinor, currency);
      const cls =
        wk.operatingProfitMinor >= 0 ? "costs-val-pos" : "costs-val-neg";
      return {
        node: <strong className={cls}>{txt}</strong>,
        plainText: txt,
        tooltip: `${exact(wk.operatingProfitMinor)} (${wk.operatingMarginPct.toFixed(1)}%)`,
      };
    }
    case "cash_outflows": {
      const totalOut =
        wk.supplierCashOutMinor + wk.rentCashOutMinor + wk.capexCashOutMinor;
      const txt = totalOut === 0 ? "—" : compact(totalOut);
      const tag =
        wk.capexCashOutMinor > 0
          ? "capex"
          : wk.rentCashOutMinor > 0
            ? "rent"
            : null;
      return {
        node:
          tag !== null ? (
            <span className="costs-forecast-tagged-val is-warn">
              <span>{txt}</span>
              <span className="costs-forecast-mini-tag is-warn">{tag}</span>
            </span>
          ) : (
            <span className="costs-cell-muted">{txt}</span>
          ),
        plainText: txt,
        tooltip: `Suppliers ${exact(wk.supplierCashOutMinor)} · Rent paid ${exact(wk.rentCashOutMinor)}${wk.capexCashOutMinor > 0 ? ` · Capex ${exact(wk.capexCashOutMinor)}` : ""}`,
      };
    }
    case "ending_cash": {
      const txt = formatCompactSignedIfNegative(wk.endingCashMinor, currency);
      const cls =
        wk.endingCashMinor < 0
          ? "costs-val-neg"
          : isLowestTrough
            ? "costs-val-warn"
            : "";
      return {
        node: <strong className={cls}>{txt}</strong>,
        plainText: txt,
        tooltip: `${exact(wk.endingCashMinor)} (net wk cash ${formatCompactSignedMoney(wk.netCashFlowMinor, currency)})`,
      };
    }
  }
}

function renderForecastTotalValue(
  rowId: ForecastSheetRow["id"],
  forecast: Bakery12WeekForecastCalculation,
): Readonly<{
  node: React.ReactNode;
  plainText: string;
  tooltip: string;
}> {
  const s = forecast.summary;
  const { currency } = s;
  const exact = (minor: number) => formatMoneyMinor(Math.round(minor), currency);
  const compact = (minor: number) => formatCompactMoney(minor, currency);

  switch (rowId) {
    case "demand_index": {
      const txt = `Avg ${Math.round(s.averageDemandIndexPct)}%`;
      return {
        node: <span className="costs-cell-muted">{txt}</span>,
        plainText: txt,
        tooltip: `12-week average demand index ${s.averageDemandIndexPct.toFixed(1)}%`,
      };
    }
    case "gross_sales": {
      const txt = compact(s.totalGrossSalesMinor);
      return {
        node: <strong>{txt}</strong>,
        plainText: txt,
        tooltip: exact(s.totalGrossSalesMinor),
      };
    }
    case "cogs": {
      const txt = compact(s.totalCogsMinor);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip:
          s.totalBulkTierSavingsMinor > 0
            ? `${exact(s.totalCogsMinor)} (total bulk savings ${exact(s.totalBulkTierSavingsMinor)})`
            : exact(s.totalCogsMinor),
      };
    }
    case "waste_tax_fees": {
      const txt = compact(s.totalWasteTaxFeeMinor);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip: exact(s.totalWasteTaxFeeMinor),
      };
    }
    case "gross_contrib": {
      const txt = compact(s.totalGrossContributionMinor);
      return {
        node: <strong>{txt}</strong>,
        plainText: txt,
        tooltip: exact(s.totalGrossContributionMinor),
      };
    }
    case "labor": {
      const txt = compact(s.totalLaborMinor);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip: exact(s.totalLaborMinor),
      };
    }
    case "rent": {
      const txt = compact(s.totalAccrualRentMinor);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip: exact(s.totalAccrualRentMinor),
      };
    }
    case "operating_profit": {
      const txt = formatCompactSignedMoney(s.totalOperatingProfitMinor, currency);
      const cls =
        s.totalOperatingProfitMinor >= 0 ? "costs-val-pos" : "costs-val-neg";
      return {
        node: <strong className={cls}>{txt}</strong>,
        plainText: txt,
        tooltip: `${exact(s.totalOperatingProfitMinor)} (${s.operatingMarginPct.toFixed(1)}%)`,
      };
    }
    case "cash_outflows": {
      const totalOut = numericTotalForRow("cash_outflows", forecast);
      const txt = compact(totalOut);
      return {
        node: <span>{txt}</span>,
        plainText: txt,
        tooltip: `${exact(totalOut)}${s.endingPayablesBalanceMinor > 0 ? ` · Unsettled net payables at W12: ${exact(s.endingPayablesBalanceMinor)}` : ""}`,
      };
    }
    case "ending_cash": {
      const txt = formatCompactSignedIfNegative(s.endingCashMinor, currency);
      const cls = s.endingCashMinor < 0 ? "costs-val-neg" : "costs-val-pos";
      return {
        node: <strong className={cls}>{txt}</strong>,
        plainText: txt,
        tooltip: `Ending bank cash ${exact(s.endingCashMinor)} (12w build ${formatCompactSignedMoney(s.netCashBuildMinor, currency)})`,
      };
    }
  }
}

function resolveInputValue(
  focused: FocusedCell | null,
  cellKey: string,
  formatted: string,
): string {
  return focused?.cellKey === cellKey ? focused.raw : formatted;
}

function fmtSignedIfNegative(amountMinor: number, currency: string): string {
  if (amountMinor < 0) {
    return `−${formatMoneyMinor(Math.abs(Math.round(amountMinor)), currency)}`;
  }
  return formatMoneyMinor(Math.round(amountMinor), currency);
}

function formatCompactMoney(amountMinor: number, currency: string): string {
  const abs = Math.abs(Math.round(amountMinor));
  const upper = currency.toUpperCase();
  if (upper === "JPY") {
    if (abs >= 1_000_000) {
      return `¥${(abs / 1_000_000).toFixed(2)}M`;
    }
    if (abs >= 10_000) {
      return `¥${Math.round(abs / 1_000).toLocaleString("en-US")}k`;
    }
    return formatMoneyMinor(abs, currency);
  }
  const major = abs / 100;
  const sym = upper === "USD" ? "$" : upper === "EUR" ? "€" : `${upper} `;
  if (major >= 1_000_000) {
    return `${sym}${(major / 1_000_000).toFixed(2)}M`;
  }
  if (major >= 10_000) {
    return `${sym}${(major / 1_000).toFixed(1)}k`;
  }
  return formatMoneyMinor(abs, currency);
}

function formatCompactSignedMoney(
  amountMinor: number,
  currency: string,
): string {
  const rounded = Math.round(amountMinor);
  if (rounded > 0) return `+${formatCompactMoney(rounded, currency)}`;
  if (rounded < 0) return `−${formatCompactMoney(Math.abs(rounded), currency)}`;
  return formatCompactMoney(0, currency);
}

function formatCompactSignedIfNegative(
  amountMinor: number,
  currency: string,
): string {
  const rounded = Math.round(amountMinor);
  if (rounded < 0) return `−${formatCompactMoney(Math.abs(rounded), currency)}`;
  return formatCompactMoney(rounded, currency);
}
