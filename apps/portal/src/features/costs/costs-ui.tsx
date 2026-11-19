import React from "react";
import { SlidersHorizontal } from "lucide-react";
import type {
  BakeryCostCalculation,
  CostValuationBasis,
} from "@purin-labs/control-api";
import type { ProjectedCostsSheet } from "./costs-sheet-draft";

type CostAssumptions = ProjectedCostsSheet["assumptions"];
import {
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  SCENARIO_BAKE_WASTE_CELL_KEY,
  SCENARIO_CHANNEL_FEE_CELL_KEY,
  SCENARIO_INCLUDED_TAX_CELL_KEY,
  SCENARIO_LOT_COST_BASIS_CELL_KEY,
  SCENARIO_PREP_REJECT_CELL_KEY,
} from "@purin-labs/costs-sheet-crdt";
import {
  formatMoneyMinor,
  formatSignedMoneyRounded as formatSignedMoney,
} from "../../formatting";
import { Popover, Select, Switch } from "../../ui";
import {
  CellPeerOutline,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";

export type FocusedCellLike = Readonly<{
  cellKey: string;
  raw: string;
}> | null;

const ORB_GRADIENTS: readonly string[] = [
  "linear-gradient(135deg, #f59e0b, #fbbf24 58%, #fde68a)",
  "linear-gradient(135deg, #78350f, #b45309 60%, #fcd34d)",
  "linear-gradient(135deg, #047857, #10b981 60%, #a7f3d0)",
  "linear-gradient(135deg, #ea580c, #fb923c 60%, #fed7aa)",
  "linear-gradient(135deg, #18181b, #52525b 62%, #a1a1aa)",
  "linear-gradient(135deg, #92400e, #d97706 60%, #fde68a)",
  "linear-gradient(135deg, #be123c, #fb7185 62%, #fecdd3)",
  "linear-gradient(135deg, #4f46e5, #818cf8 62%, #e0e7ff)",
  "linear-gradient(135deg, #57534e, #a8a29e 62%, #e7e5e4)",
];

function pickProductGradient(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("matcha") || lower.includes("pistachio")) {
    return "linear-gradient(135deg, #047857, #10b981 60%, #a7f3d0)";
  }
  if (lower.includes("sesame") || lower.includes("charcoal")) {
    return "linear-gradient(135deg, #18181b, #52525b 64%, #a1a1aa)";
  }
  if (
    lower.includes("coffee") ||
    lower.includes("espresso") ||
    lower.includes("chocolate") ||
    lower.includes("cacao")
  ) {
    return "linear-gradient(135deg, #78350f, #b45309 60%, #fcd34d)";
  }
  if (
    lower.includes("houjicha") ||
    lower.includes("tea") ||
    lower.includes("earl")
  ) {
    return "linear-gradient(135deg, #57534e, #a8a29e 64%, #e7e5e4)";
  }
  if (
    lower.includes("citrus") ||
    lower.includes("ginger") ||
    lower.includes("yuzu") ||
    lower.includes("orange")
  ) {
    return "linear-gradient(135deg, #ea580c, #fb923c 60%, #fed7aa)";
  }
  if (
    lower.includes("berry") ||
    lower.includes("strawberry") ||
    lower.includes("cherry") ||
    lower.includes("apple pie")
  ) {
    return "linear-gradient(135deg, #be123c, #fb7185 62%, #fecdd3)";
  }
  if (
    lower.includes("hazelnut") ||
    lower.includes("almond") ||
    lower.includes("pecan")
  ) {
    return "linear-gradient(135deg, #92400e, #d97706 60%, #fde68a)";
  }
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  return (
    ORB_GRADIENTS[Math.abs(hash) % ORB_GRADIENTS.length] ??
    "linear-gradient(135deg, #f59e0b, #fbbf24 58%, #fde68a)"
  );
}

export function ProductOrb(
  props: Readonly<{ title: string; imageUrl?: string | null }>,
): React.ReactNode {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const url = props.imageUrl?.trim() ?? "";
  if (url.length > 0 && failedUrl !== url) {
    return (
      <img
        className="costs-product-thumb"
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <span
      className="costs-product-orb"
      style={{ background: pickProductGradient(props.title) }}
      aria-hidden="true"
    />
  );
}

export function SupplyBadge(
  props: Readonly<{ category: string }>,
): React.ReactNode {
  const clean = props.category.replace(/_/gu, " ").trim();
  const code = clean.slice(0, 2).toUpperCase() || "IT";
  return (
    <span className="costs-supply-badge" aria-hidden="true">
      {code}
    </span>
  );
}

function buildSparklinePath(
  calculation: BakeryCostCalculation,
  dailyFixedMinor: number,
): string {
  const dayNet: number[] = [0, 0, 0, 0, 0, 0, 0];
  for (const row of calculation.products) {
    for (let d = 0; d < 7; d += 1) {
      const units = row.weekUnits[d] ?? row.dailyTargetUnits;
      dayNet[d] = (dayNet[d] ?? 0) + units * row.netContributionUnitMinor;
    }
  }
  const profits = dayNet.map((c) => c - dailyFixedMinor);
  const min = Math.min(...profits);
  const max = Math.max(...profits);
  const span = max - min;
  const xs = [2, 10, 18, 26, 34, 42, 50];
  return profits
    .map((val, idx) => {
      const x = xs[idx] ?? 2;
      const ratio = span > 0 ? (val - min) / span : 0.65;
      const y = (16.5 - ratio * 12.5).toFixed(1);
      return `${idx === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

function formatCompactMonthly(amountMinor: number, currency: string): string {
  const abs = Math.abs(amountMinor);
  if (currency === "JPY" && abs >= 1_000_000) {
    const m = (amountMinor / 1_000_000).toFixed(2);
    return `¥${m}M`;
  }
  return formatMoneyMinor(Math.round(amountMinor), currency);
}

export function CostsKpiStrip(
  props: Readonly<{
    calculation: BakeryCostCalculation;
    productCount: number;
    currency: string;
    currencySymbol: string;
    dailyLaborMinor: number;
    dailyRentMinor: number;
    laborFormatted: string;
    rentFormatted: string;
    laborDirty: boolean;
    rentDirty: boolean;
    canEdit: boolean;
    focusedCell: FocusedCellLike;
    presence: PresenceIndex;
    onFocusCell: (
      cellKey: string,
      raw: string,
      input: HTMLInputElement,
    ) => void;
    onBlurCell: (cellKey: string) => void;
    onChangeLaborRaw: (raw: string) => void;
    onChangeRentRaw: (raw: string) => void;
  }>,
): React.ReactNode {
  const { calculation, currency, currencySymbol } = props;
  const gross = calculation.summary.dailyGrossRevenueMinor;
  const cogsAndFees =
    calculation.summary.dailyIngredientSpendMinor +
    calculation.summary.dailyPackagingSpendMinor +
    calculation.summary.dailyWasteSpendMinor +
    calculation.summary.dailyIncludedTaxMinor +
    calculation.summary.dailyChannelFeeMinor;
  const cogsPct = gross > 0 ? (cogsAndFees / gross) * 100 : 0;
  const fixedMinor = props.dailyLaborMinor + props.dailyRentMinor;
  const netMinor = calculation.summary.dailyOperatingProfitMinor;
  const opMarginPct = calculation.summary.operatingMarginPct;
  const isPositive = netMinor >= 0;

  const laborPeers = props.presence.peersByCell.get(OVERHEAD_LABOR_CELL_KEY);
  const rentPeers = props.presence.peersByCell.get(OVERHEAD_RENT_CELL_KEY);
  const laborDisplay = Number(props.laborFormatted).toLocaleString("en-US");
  const rentDisplay = Number(props.rentFormatted).toLocaleString("en-US");

  const laborVal =
    props.focusedCell?.cellKey === OVERHEAD_LABOR_CELL_KEY
      ? props.focusedCell.raw
      : laborDisplay;
  const rentVal =
    props.focusedCell?.cellKey === OVERHEAD_RENT_CELL_KEY
      ? props.focusedCell.raw
      : rentDisplay;

  const sparkPath = buildSparklinePath(calculation, fixedMinor);

  return (
    <section className="costs-kpi-strip" aria-label="Daily unit economics">
      <div className="costs-kpi-cell">
        <div className="costs-kpi-top">
          <span className="costs-kpi-label">Daily revenue</span>
        </div>
        <div className="costs-kpi-value-row">
          <span className="costs-kpi-value">
            {formatMoneyMinor(Math.round(gross), currency)}
          </span>
        </div>
        <div className="costs-kpi-sub">
          {Math.round(calculation.summary.dailyUnitsSold).toLocaleString(
            "en-US",
          )}{" "}
          units/d · {props.productCount} SKUs
        </div>
      </div>

      <div className="costs-kpi-cell">
        <div className="costs-kpi-top">
          <span className="costs-kpi-label">COGS &amp; fees</span>
          <span className="costs-kpi-pill">{cogsPct.toFixed(1)}%</span>
        </div>
        <div className="costs-kpi-value-row">
          <span className="costs-kpi-value">
            {formatMoneyMinor(Math.round(cogsAndFees), currency)}
          </span>
        </div>
        <div className="costs-kpi-sub">
          {calculation.summary.unlockedBulkTierCount > 0
            ? `${calculation.summary.unlockedBulkTierCount} bulk tiers (−${formatMoneyMinor(Math.round(calculation.summary.dailyTierSavingsMinor), currency)}/d)`
            : `Tax ${formatMoneyMinor(Math.round(calculation.summary.dailyIncludedTaxMinor), currency)}/d`}
        </div>
      </div>

      <div className="costs-kpi-cell">
        <div className="costs-kpi-top">
          <span className="costs-kpi-label">Contribution</span>
          <span className="costs-kpi-pill">
            {calculation.summary.netMarginPct.toFixed(1)}%
          </span>
        </div>
        <div className="costs-kpi-value-row">
          <span className="costs-kpi-value">
            {formatMoneyMinor(
              Math.round(calculation.summary.dailyNetContributionMinor),
              currency,
            )}
          </span>
        </div>
        <div className="costs-kpi-sub">
          {formatCompactMonthly(
            calculation.summary.monthlyNetContributionMinor,
            currency,
          )}{" "}
          / {calculation.assumptions.operatingDaysPerMonth}d mo
        </div>
      </div>

      <div className="costs-kpi-cell">
        <div className="costs-kpi-top">
          <span className="costs-kpi-label">Fixed overhead</span>
          <span className="costs-kpi-pill">Daily</span>
        </div>
        <div className="costs-kpi-value-row">
          <span className="costs-kpi-value">
            {formatMoneyMinor(Math.round(fixedMinor), currency)}
          </span>
        </div>
        <div className="costs-overhead-chips">
          <label
            data-cell-key={OVERHEAD_LABOR_CELL_KEY}
            className={`costs-overhead-chip${props.laborDirty ? " is-dirty" : ""}${laborPeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(laborPeers)}
            title="Daily staff shift labor"
          >
            <CellPeerOutline peers={laborPeers} />
            <span className="costs-overhead-tag">Labor {currencySymbol}</span>
            <input
              type="text"
              inputMode="decimal"
              disabled={!props.canEdit}
              aria-label="Daily labor cost"
              value={laborVal}
              onFocus={(event) =>
                props.onFocusCell(
                  OVERHEAD_LABOR_CELL_KEY,
                  props.laborFormatted,
                  event.currentTarget,
                )
              }
              onBlur={() => props.onBlurCell(OVERHEAD_LABOR_CELL_KEY)}
              onChange={(event) =>
                props.onChangeLaborRaw(event.currentTarget.value)
              }
            />
          </label>

          <label
            data-cell-key={OVERHEAD_RENT_CELL_KEY}
            className={`costs-overhead-chip${props.rentDirty ? " is-dirty" : ""}${rentPeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(rentPeers)}
            title="Daily shop rent and utilities"
          >
            <CellPeerOutline peers={rentPeers} />
            <span className="costs-overhead-tag">Rent {currencySymbol}</span>
            <input
              type="text"
              inputMode="decimal"
              disabled={!props.canEdit}
              aria-label="Daily rent cost"
              value={rentVal}
              onFocus={(event) =>
                props.onFocusCell(
                  OVERHEAD_RENT_CELL_KEY,
                  props.rentFormatted,
                  event.currentTarget,
                )
              }
              onBlur={() => props.onBlurCell(OVERHEAD_RENT_CELL_KEY)}
              onChange={(event) =>
                props.onChangeRentRaw(event.currentTarget.value)
              }
            />
          </label>
        </div>
      </div>

      <div className="costs-kpi-cell">
        <div className="costs-kpi-top">
          <span className="costs-kpi-label">Operating profit</span>
          <span
            className={`costs-kpi-pill ${isPositive ? "is-positive" : "is-negative"}`}
          >
            {isPositive ? "+" : ""}
            {opMarginPct.toFixed(1)}%
          </span>
        </div>
        <div className="costs-kpi-value-row">
          <span className="costs-kpi-value">
            {formatSignedMoney(netMinor, currency)}
          </span>
          <svg
            width="52"
            height="20"
            viewBox="0 0 52 20"
            fill="none"
            aria-hidden="true"
            className="costs-kpi-spark"
          >
            <path
              d={sparkPath}
              stroke={isPositive ? "#10b981" : "#ef4444"}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="costs-kpi-sub">
          Break-even{" "}
          {calculation.summary.breakEvenUnitsPerDay === null
            ? "—"
            : `${calculation.summary.breakEvenUnitsPerDay} u/d`}
        </div>
      </div>
    </section>
  );
}

const LOT_VALUATION_ITEMS: readonly Readonly<{
  value: CostValuationBasis;
  label: string;
}>[] = [
  { value: "standing", label: "Standing pack terms" },
  { value: "fifo_lot", label: "FIFO lot invoices" },
  { value: "weighted_lot", label: "Weighted lot average" },
];

export function CostsAssumptionsPopover(
  props: Readonly<{
    open: boolean;
    canEdit: boolean;
    assumptions: CostAssumptions;
    focusedCell: FocusedCellLike;
    presence: PresenceIndex;
    actualShelfText: string;
    actualRejectText: string;
    onOpenChange: (open: boolean) => void;
    onFocusCell: (cellKey: string, raw: string) => void;
    onBlurCell: (cellKey: string) => void;
    onUpdateRaw: (cellKey: string, raw: string) => void;
    onCommitAssumptions: (next: CostAssumptions) => void;
  }>,
): React.ReactNode {
  const { assumptions, focusedCell, presence, canEdit } = props;
  const bakeWasteFormatted = String(assumptions.bakeShelfWastePct);
  const prepRejectFormatted = String(assumptions.prepRejectPct);
  const feeFormatted = (assumptions.channelFeeBps / 100).toFixed(1);
  const taxFormatted = (assumptions.includedTaxBps / 100).toFixed(1);
  const triggerTaxFormatted = (assumptions.includedTaxBps / 100).toFixed(0);

  const bakeWastePeers = presence.peersByCell.get(SCENARIO_BAKE_WASTE_CELL_KEY);
  const prepRejectPeers = presence.peersByCell.get(
    SCENARIO_PREP_REJECT_CELL_KEY,
  );
  const channelFeePeers = presence.peersByCell.get(
    SCENARIO_CHANNEL_FEE_CELL_KEY,
  );
  const includedTaxPeers = presence.peersByCell.get(
    SCENARIO_INCLUDED_TAX_CELL_KEY,
  );

  const val = (key: string, formatted: string) =>
    focusedCell?.cellKey === key ? focusedCell.raw : formatted;

  const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n));

  return (
    <Popover.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Popover.Trigger
        data-assumptions-trigger="true"
        className="costs-control-btn"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>Assumptions</span>
        <span className="costs-control-muted">
          {bakeWasteFormatted}% · {triggerTaxFormatted}%
        </span>
      </Popover.Trigger>

      <Popover.Popup
        align="end"
        sideOffset={8}
        className="costs-assumptions-popover"
        aria-label="Shop cost assumptions"
      >
        <div className="costs-pop-header">
          <Popover.Title className="costs-pop-title">
            Shop cost assumptions
          </Popover.Title>
          <Popover.Description className="costs-pop-desc">
            30d actuals: {props.actualShelfText} · {props.actualRejectText}
          </Popover.Description>
        </div>

        <div className="costs-pop-grid">
          <label
            data-cell-key={SCENARIO_BAKE_WASTE_CELL_KEY}
            className={`costs-pop-field${bakeWastePeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(bakeWastePeers)}
          >
            <CellPeerOutline peers={bakeWastePeers} />
            <span className="costs-pop-field-label">Default spoilage</span>
            <span className="costs-pop-input-wrap">
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                disabled={!canEdit}
                aria-label="Default shelf spoilage percent"
                value={val(SCENARIO_BAKE_WASTE_CELL_KEY, bakeWasteFormatted)}
                onFocus={() =>
                  props.onFocusCell(
                    SCENARIO_BAKE_WASTE_CELL_KEY,
                    bakeWasteFormatted,
                  )
                }
                onBlur={() => props.onBlurCell(SCENARIO_BAKE_WASTE_CELL_KEY)}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  props.onUpdateRaw(SCENARIO_BAKE_WASTE_CELL_KEY, raw);
                  if (raw.trim().length === 0) return;
                  const num = Number(raw);
                  if (!Number.isFinite(num)) return;
                  props.onCommitAssumptions({
                    ...assumptions,
                    bakeShelfWastePct: clamp(num, 0, 60),
                  });
                }}
              />
              <span className="costs-pop-suffix">%</span>
            </span>
          </label>

          <label
            data-cell-key={SCENARIO_PREP_REJECT_CELL_KEY}
            className={`costs-pop-field${prepRejectPeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(prepRejectPeers)}
          >
            <CellPeerOutline peers={prepRejectPeers} />
            <span className="costs-pop-field-label">Bake reject rate</span>
            <span className="costs-pop-input-wrap">
              <input
                type="number"
                min={0}
                max={50}
                step={0.5}
                disabled={!canEdit}
                aria-label="Prep reject percent"
                value={val(SCENARIO_PREP_REJECT_CELL_KEY, prepRejectFormatted)}
                onFocus={() =>
                  props.onFocusCell(
                    SCENARIO_PREP_REJECT_CELL_KEY,
                    prepRejectFormatted,
                  )
                }
                onBlur={() => props.onBlurCell(SCENARIO_PREP_REJECT_CELL_KEY)}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  props.onUpdateRaw(SCENARIO_PREP_REJECT_CELL_KEY, raw);
                  if (raw.trim().length === 0) return;
                  const num = Number(raw);
                  if (!Number.isFinite(num)) return;
                  props.onCommitAssumptions({
                    ...assumptions,
                    prepRejectPct: clamp(num, 0, 50),
                  });
                }}
              />
              <span className="costs-pop-suffix">%</span>
            </span>
          </label>

          <label
            data-cell-key={SCENARIO_CHANNEL_FEE_CELL_KEY}
            className={`costs-pop-field${channelFeePeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(channelFeePeers)}
          >
            <CellPeerOutline peers={channelFeePeers} />
            <span className="costs-pop-field-label">Payment card fee</span>
            <span className="costs-pop-input-wrap">
              <input
                type="number"
                min={0}
                max={30}
                step={0.1}
                disabled={!canEdit}
                aria-label="Payment channel fee percent"
                value={val(SCENARIO_CHANNEL_FEE_CELL_KEY, feeFormatted)}
                onFocus={() =>
                  props.onFocusCell(SCENARIO_CHANNEL_FEE_CELL_KEY, feeFormatted)
                }
                onBlur={() => props.onBlurCell(SCENARIO_CHANNEL_FEE_CELL_KEY)}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  props.onUpdateRaw(SCENARIO_CHANNEL_FEE_CELL_KEY, raw);
                  if (raw.trim().length === 0) return;
                  const num = Number(raw);
                  if (!Number.isFinite(num)) return;
                  props.onCommitAssumptions({
                    ...assumptions,
                    channelFeeBps: Math.round(clamp(num, 0, 30) * 100),
                  });
                }}
              />
              <span className="costs-pop-suffix">%</span>
            </span>
          </label>

          <label
            data-cell-key={SCENARIO_INCLUDED_TAX_CELL_KEY}
            className={`costs-pop-field${includedTaxPeers?.length ? " has-peer-focus" : ""}`}
            style={peerCellStyle(includedTaxPeers)}
          >
            <CellPeerOutline peers={includedTaxPeers} />
            <span className="costs-pop-field-label">Consumption tax</span>
            <span className="costs-pop-input-wrap">
              <input
                type="number"
                min={0}
                max={30}
                step={0.5}
                disabled={!canEdit}
                aria-label="Included consumption tax percent"
                value={val(SCENARIO_INCLUDED_TAX_CELL_KEY, taxFormatted)}
                onFocus={() =>
                  props.onFocusCell(
                    SCENARIO_INCLUDED_TAX_CELL_KEY,
                    taxFormatted,
                  )
                }
                onBlur={() => props.onBlurCell(SCENARIO_INCLUDED_TAX_CELL_KEY)}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  props.onUpdateRaw(SCENARIO_INCLUDED_TAX_CELL_KEY, raw);
                  if (raw.trim().length === 0) return;
                  const num = Number(raw);
                  if (!Number.isFinite(num)) return;
                  props.onCommitAssumptions({
                    ...assumptions,
                    includedTaxBps: Math.round(clamp(num, 0, 30) * 100),
                  });
                }}
              />
              <span className="costs-pop-suffix">%</span>
            </span>
          </label>
        </div>

        <div
          data-cell-key={SCENARIO_LOT_COST_BASIS_CELL_KEY}
          className="costs-pop-toggle-row"
        >
          <span>Lot cost valuation</span>
          <Select.Root
            items={LOT_VALUATION_ITEMS}
            value={assumptions.lotCostBasis}
            disabled={!canEdit}
            onValueChange={(nextValue) => {
              if (
                nextValue === "standing" ||
                nextValue === "fifo_lot" ||
                nextValue === "weighted_lot"
              ) {
                props.onCommitAssumptions({
                  ...assumptions,
                  lotCostBasis: nextValue,
                });
              }
            }}
          >
            <Select.Trigger size="sm" aria-label="Lot cost valuation basis">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {LOT_VALUATION_ITEMS.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </div>

        <label className="costs-pop-toggle-row">
          <span>Apply 7-day bulk supplier tiers</span>
          <Switch
            disabled={!canEdit}
            aria-label="Apply 7-day bulk supplier tiers"
            checked={assumptions.applyBulkTiers}
            onCheckedChange={(checked) =>
              props.onCommitAssumptions({
                ...assumptions,
                applyBulkTiers: checked,
              })
            }
          />
        </label>
      </Popover.Popup>
    </Popover.Root>
  );
}
