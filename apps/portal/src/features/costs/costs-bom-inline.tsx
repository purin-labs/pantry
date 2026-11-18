import React from "react";
import { ArrowUpRight, ChevronUp } from "lucide-react";
import { Link } from "react-router";
import type {
  CalculatedProductBomLine,
  CalculatedProductMargin,
  CalculatedSupplyUsage,
  CostUnit,
  SupplyCostItem,
} from "@seams/control-api";
import { formatMoneyMinor } from "../../formatting";
import { formatCostQuantity } from "./api";
import { currencyDigits } from "./costs-sheet-draft";
import { SupplyBadge } from "./costs-ui";

const SHORT_UNIT_LABELS: Readonly<Record<CostUnit, string>> = {
  each: "ea",
  gram: "g",
  kilogram: "kg",
  milliliter: "ml",
  liter: "L",
};

function formatUnitCostPrecise(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (digits === 0 && minor > 0 && minor < 100 && Math.abs(minor - Math.round(minor)) >= 0.05) {
    const sym = currency === "JPY" ? "¥" : `${currency} `;
    return `${sym}${minor.toFixed(1)}`;
  }
  return formatMoneyMinor(Math.round(minor), currency);
}

function formatBaseRate(
  ratePerBaseMinor: number | null,
  baseUnit: CostUnit,
  currency: string,
): string | null {
  if (ratePerBaseMinor === null || !Number.isFinite(ratePerBaseMinor)) {
    return null;
  }
  const digits = currencyDigits(currency);
  const major = ratePerBaseMinor / 10 ** digits;
  const sym =
    currency === "JPY"
      ? "¥"
      : currency === "USD"
        ? "$"
        : currency === "EUR"
          ? "€"
          : `${currency} `;
  const decimals = major >= 10 ? 1 : major >= 1 ? 2 : 3;
  const trimmed = Number(major.toFixed(decimals));
  return `${sym}${trimmed}/${SHORT_UNIT_LABELS[baseUnit]}`;
}

function renderLineSourceBadge(line: CalculatedProductBomLine): React.ReactNode {
  if (!line.hasCostTerms) {
    return <span className="costs-bom-inline-pill is-warn">Unpriced</span>;
  }
  if (line.costSource === "fifo_lot" || line.costSource === "weighted_lot") {
    const basisText = line.costSource === "fifo_lot" ? "FIFO lot" : "Avg lot";
    return (
      <>
        <span className="costs-bom-inline-pill is-info">{basisText}</span>
        {line.lotCostVariancePct !== null &&
        Math.abs(line.lotCostVariancePct) >= 0.1 ? (
          <span
            className={`costs-lot-variance-pill ${
              line.lotCostVariancePct > 0 ? "is-higher" : "is-lower"
            }`}
          >
            {line.lotCostVariancePct > 0 ? "+" : ""}
            {line.lotCostVariancePct.toFixed(1)}%
          </span>
        ) : null}
      </>
    );
  }
  if (line.bulkUnlocked) {
    return <span className="costs-bom-inline-pill is-pos">Bulk tier</span>;
  }
  if (
    line.lotCostVariancePct !== null &&
    Math.abs(line.lotCostVariancePct) >= 0.5
  ) {
    return (
      <span
        className={`costs-lot-variance-pill ${
          line.lotCostVariancePct > 0 ? "is-higher" : "is-lower"
        }`}
        title="Received lot invoice differs from standing pack price"
      >
        Lot {line.lotCostVariancePct > 0 ? "+" : ""}
        {line.lotCostVariancePct.toFixed(1)}%
      </span>
    );
  }
  return null;
}

export function CostsInlineBomPanel(
  props: Readonly<{
    row: CalculatedProductMargin;
    recipesHref: string;
    onInspectSupply: (inventoryItemId: string) => void;
    onCollapse: () => void;
  }>,
): React.ReactNode {
  const { row } = props;
  const currency = row.currency;
  const batchBomMinor = Math.round(row.bomUnitCostMinor * row.batchYield);
  const unitBomMinor = Math.round(row.bomUnitCostMinor);

  return (
    <div
      className="costs-inline-bom"
      role="region"
      aria-label={`Recipe BOM wholesale cost chain for ${row.productTitle}`}
    >
      <div className="costs-inline-bom-head">
        <div className="costs-inline-bom-lead">
          <span className="costs-inline-bom-kicker">
            Recipe BOM → Wholesale Cost Chain
          </span>
          <span className="costs-inline-bom-meta">
            {row.recipeId !== null
              ? `${row.recipeName ?? row.recipeId}${
                  row.recipeRevision !== null ? ` · rev ${row.recipeRevision}` : ""
                }`
              : "Direct packaging only"}
            {" · "}
            {row.fulfillmentKind === "stocked"
              ? `Batch yield ${row.batchYield} pcs (${formatMoneyMinor(batchBomMinor, currency)} / batch → ${formatMoneyMinor(unitBomMinor, currency)} / pc)`
              : `Prepared to order (${formatMoneyMinor(unitBomMinor, currency)} / serving)`}
          </span>
          {row.hasCogsOverride ? (
            <span className="costs-bom-inline-pill is-warn">
              Manual COGS override{" "}
              {formatMoneyMinor(Math.round(row.effectiveCogsUnitMinor), currency)}
            </span>
          ) : null}
        </div>

        <div className="costs-inline-bom-actions">
          <Link to={props.recipesHref} className="costs-inline-bom-link">
            <span>Open in Recipes</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
          <button
            type="button"
            className="costs-inline-bom-close"
            onClick={props.onCollapse}
            aria-label={`Collapse recipe BOM for ${row.productTitle}`}
          >
            <ChevronUp size={13} aria-hidden="true" />
            <span>Hide</span>
          </button>
        </div>
      </div>

      {row.bomLines.length > 0 ? (
        <div
          className="costs-inline-bom-grid"
          role="table"
          aria-label={`${row.productTitle} recipe inputs and wholesale rates`}
        >
          <div className="costs-inline-bom-row is-header" role="row">
            <span role="columnheader">Ingredient / Packaging supply</span>
            <span role="columnheader" className="is-num">
              Batch qty
            </span>
            <span role="columnheader" className="is-num">
              Per piece
            </span>
            <span role="columnheader" className="is-num">
              Active wholesale rate
            </span>
            <span role="columnheader" className="is-num">
              Batch cost
            </span>
            <span role="columnheader" className="is-num">
              Unit COGS
            </span>
          </div>

          {row.bomLines.map((line, idx) => {
            const baseRateText = formatBaseRate(
              line.effectiveRatePerBaseUnitMinor,
              line.baseUnit,
              currency,
            );
            const wholesaleText =
              line.hasCostTerms &&
              line.activePackPriceMinor !== null &&
              line.activePackQuantity !== null &&
              line.activePackUnit !== null
                ? `${formatMoneyMinor(Math.round(line.activePackPriceMinor), currency)} / ${formatCostQuantity(line.activePackQuantity, line.activePackUnit)}${
                    baseRateText !== null ? ` (${baseRateText})` : ""
                  }`
                : "Set pack price →";

            return (
              <div
                key={`${line.source}:${line.inventoryItemId}:${idx}`}
                className="costs-inline-bom-row is-interactive"
                role="row"
              >
                <span role="cell" className="costs-inline-bom-supply-cell">
                  <button
                    type="button"
                    className="costs-inline-bom-supply-btn"
                    onClick={() => props.onInspectSupply(line.inventoryItemId)}
                    title={`Inspect ${line.name} wholesale packs, stock coverage, and lot invoices`}
                  >
                    <SupplyBadge category={line.category} />
                    <span className="costs-inline-bom-supply-name">
                      {line.name}
                    </span>
                    {renderLineSourceBadge(line)}
                    {line.reorderSuggested ? (
                      <span className="costs-bom-inline-pill is-reorder">
                        Reorder
                      </span>
                    ) : null}
                  </button>
                </span>
                <span role="cell" className="is-num is-muted">
                  {formatCostQuantity(line.quantityPerBatch, line.unit)}
                </span>
                <span role="cell" className="is-num">
                  {formatCostQuantity(
                    Math.round(line.quantityPerUnit * 100) / 100,
                    line.unit,
                  )}
                </span>
                <span
                  role="cell"
                  className={`is-num ${line.hasCostTerms ? "is-muted" : "is-warn"}`}
                >
                  {wholesaleText}
                </span>
                <span role="cell" className="is-num is-muted">
                  {line.hasCostTerms
                    ? formatMoneyMinor(
                        Math.round(line.costPerBatchMinor),
                        currency,
                      )
                    : "—"}
                </span>
                <span role="cell" className="is-num costs-inline-bom-unit-cell">
                  <strong>
                    {line.hasCostTerms
                      ? formatUnitCostPrecise(line.costPerUnitMinor, currency)
                      : "Unpriced"}
                  </strong>
                  {line.hasCostTerms && line.shareOfBomPct >= 1 ? (
                    <span className="costs-inline-bom-share">
                      {Math.round(line.shareOfBomPct)}%
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}

          <div className="costs-inline-bom-row is-footer" role="row">
            <span role="cell">
              Total recipe BOM ({row.bomLines.length}{" "}
              {row.bomLines.length === 1 ? "input" : "inputs"})
            </span>
            <span role="cell" className="is-num">
              Ingredients{" "}
              {formatMoneyMinor(Math.round(row.ingredientUnitCostMinor), currency)}
            </span>
            <span role="cell" className="is-num">
              Packaging{" "}
              {formatMoneyMinor(Math.round(row.packagingUnitCostMinor), currency)}
            </span>
            <span role="cell" className="is-num is-muted">
              Spoilage +{" "}
              {formatMoneyMinor(
                Math.round(row.wasteAndSurplusUnitMinor),
                currency,
              )}
              /pc
            </span>
            <span role="cell" className="is-num">
              {formatMoneyMinor(batchBomMinor, currency)}
            </span>
            <span role="cell" className="is-num">
              <strong>{formatMoneyMinor(unitBomMinor, currency)} / pc</strong>
            </span>
          </div>
        </div>
      ) : (
        <div className="costs-inline-bom-empty">
          No recipe or direct packaging inputs are linked to this menu item yet.{" "}
          <Link to={props.recipesHref}>Link a recipe in Recipes ↗</Link>
        </div>
      )}
    </div>
  );
}

export function supplyStockCoverageSortValue(
  usage: CalculatedSupplyUsage | undefined,
): number | null {
  if (usage === undefined || usage.onHandBaseQuantity === null) {
    return null;
  }
  if (usage.daysOfSupply !== null) {
    return Math.round(usage.daysOfSupply * 10) / 10;
  }
  return 999;
}

export function renderSupplyCoverageCell(input: Readonly<{
  item: SupplyCostItem;
  rowIndex: number;
  usage: CalculatedSupplyUsage | undefined;
  onInspectSupply: (itemId: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}>): React.ReactNode {
  const { item, rowIndex, usage, onInspectSupply, onKeyDown } = input;
  let badge: React.ReactNode;
  if (usage === undefined || usage.onHandBaseQuantity === null) {
    badge = <span className="costs-cell-muted">Uncounted</span>;
  } else if (usage.daysOfSupply !== null) {
    if (usage.reorderSuggested) {
      badge = (
        <span className="costs-coverage-pill is-reorder">
          {usage.daysOfSupply.toFixed(1)}d left · Reorder
        </span>
      );
    } else {
      const daysText =
        usage.daysOfSupply >= 99 ? "99d+" : `${usage.daysOfSupply.toFixed(1)}d`;
      badge = (
        <span className="costs-coverage-pill is-healthy">
          {daysText} on hand
        </span>
      );
    }
  } else {
    badge = (
      <span className="costs-cell-muted">
        {formatCostQuantity(usage.onHandBaseQuantity, item.baseUnit)}
      </span>
    );
  }

  const onHandHint =
    usage?.onHandBaseQuantity != null
      ? `On hand: ${formatCostQuantity(usage.onHandBaseQuantity, item.baseUnit)}`
      : "Stock not counted yet";

  return (
    <div className="costs-cell-box is-lot-cell">
      <button
        type="button"
        className="costs-lot-cell-btn"
        data-sheet-row={rowIndex}
        data-sheet-col="stock_coverage"
        title={onHandHint}
        aria-label={`${item.name} stock coverage (${onHandHint})`}
        onClick={() => onInspectSupply(item.id)}
        onKeyDown={onKeyDown}
      >
        {badge}
      </button>
    </div>
  );
}

export function renderSupplySkuReachCell(input: Readonly<{
  item: SupplyCostItem;
  rowIndex: number;
  usage: CalculatedSupplyUsage | undefined;
  onInspectSupply: (itemId: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}>): React.ReactNode {
  const { item, rowIndex, usage, onInspectSupply, onKeyDown } = input;
  const count = usage?.usedInProductCount ?? 0;

  return (
    <div className="costs-cell-box is-lot-cell">
      <button
        type="button"
        className="costs-lot-cell-btn"
        data-sheet-row={rowIndex}
        data-sheet-col="used_in_skus"
        title={
          count > 0
            ? `Inspect downstream margin sensitivity across ${count} menu items`
            : "Not currently used in active product recipes"
        }
        aria-label={`${item.name} used in ${count} menu items`}
        onClick={() => onInspectSupply(item.id)}
        onKeyDown={onKeyDown}
      >
        {count > 0 ? (
          <span className="costs-sku-reach-pill">
            {count} {count === 1 ? "SKU" : "SKUs"}
          </span>
        ) : (
          <span className="costs-cell-muted">Unused</span>
        )}
      </button>
    </div>
  );
}
