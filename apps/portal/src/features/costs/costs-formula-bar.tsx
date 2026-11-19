import React from "react";
import { RotateCcw, Sparkles, TableProperties } from "lucide-react";
import {
  COST_COLUMN_LETTERS,
  backSolveDailyUnitsForNetDay,
  backSolveGrossPriceMinorForMargin,
  backSolveGrossPriceMinorForUnitNet,
  defaultCostColumnFormula,
  evaluateCostFormula,
  isCostFormulaColumn,
  isFormulaExpression,
  type CalculatedProductMargin,
  type CostFormulaColumn,
  type CostFormulaRowContext,
  type CostScenarioAssumptions,
  type CostsOverview,
} from "@purin-labs/control-api";
import {
  productCogsCellKey,
  productDailyCellKey,
  productMarginSelectionKey,
  productNetDaySelectionKey,
  productPriceCellKey,
  productSpoilCellKey,
  productUnitNetSelectionKey,
  productWasteCellKey,
  type CostsSheetCellChange,
} from "@purin-labs/costs-sheet-crdt";
import {
  changesForDailyUnits,
  changesForProductCogsMinor,
  changesForProductFormula,
  changesForProductPriceMinor,
  changesForProductSpoilBps,
  changesForProductWasteMinor,
  currencyDigits,
  minorToMajorString,
  type ProjectedCostsSheet,
} from "./costs-sheet-draft";

export type CostFormulaBarColumn = CostFormulaColumn | "taxFee";

const COLUMN_LABELS: Readonly<Record<CostFormulaBarColumn, string>> = {
  units: "Units / d",
  spoil: "Spoil %",
  price: "Price",
  cogs: "COGS",
  waste: "Waste",
  taxFee: "Tax & fee",
  unitNet: "Unit net",
  margin: "Margin %",
  netDay: "Net / day",
};

export function selectionKeyForProductColumn(
  productId: string,
  column: CostFormulaBarColumn,
): string {
  switch (column) {
    case "units":
      return productDailyCellKey(productId);
    case "spoil":
      return productSpoilCellKey(productId);
    case "price":
      return productPriceCellKey(productId);
    case "cogs":
      return productCogsCellKey(productId);
    case "waste":
      return productWasteCellKey(productId);
    case "taxFee":
      return `product:${productId}:taxFee`;
    case "unitNet":
      return productUnitNetSelectionKey(productId);
    case "margin":
      return productMarginSelectionKey(productId);
    case "netDay":
      return productNetDaySelectionKey(productId);
  }
}

export function parseProductColumnFromCellKey(
  cellKey: string | null,
): Readonly<{ productId: string; column: CostFormulaBarColumn }> | null {
  if (cellKey === null || !cellKey.startsWith("product:")) {
    return null;
  }
  const rest = cellKey.slice("product:".length);
  const fxIdx = rest.indexOf(":fx:");
  if (fxIdx > 0) {
    const productId = rest.slice(0, fxIdx);
    const col = rest.slice(fxIdx + ":fx:".length);
    if (isCostFormulaColumn(col)) {
      return { productId, column: col };
    }
    return null;
  }
  const mapping: readonly [string, CostFormulaBarColumn][] = [
    [":daily", "units"],
    [":spoil", "spoil"],
    [":price", "price"],
    [":cogs", "cogs"],
    [":waste", "waste"],
    [":taxFee", "taxFee"],
    [":unitNet", "unitNet"],
    [":margin", "margin"],
    [":netDay", "netDay"],
  ];
  for (const [suffix, column] of mapping) {
    if (rest.endsWith(suffix)) {
      const productId = rest.slice(0, -suffix.length);
      if (productId.length > 0) {
        return { productId, column };
      }
    }
  }
  return null;
}

function buildRowFormulaContext(
  row: CalculatedProductMargin,
  rowNumber1Based: number,
  assumptions: CostScenarioAssumptions,
  allRows?: readonly CalculatedProductMargin[],
): CostFormulaRowContext {
  const digits = currencyDigits(row.currency);
  const scale = 10 ** digits;
  const taxRate =
    assumptions.includedTaxBps > 0
      ? assumptions.includedTaxBps / (10_000 + assumptions.includedTaxBps)
      : 0;
  const feeRate = assumptions.channelFeeBps / 10_000;
  return {
    rowNumber: rowNumber1Based,
    fulfillmentKind: row.fulfillmentKind,
    units: row.dailyTargetUnits,
    spoilPct: Number(row.effectiveSpoilagePct.toFixed(2)),
    rejectPct: assumptions.prepRejectPct,
    priceMajor: Number((row.grossPriceMinor / scale).toFixed(digits)),
    bomMajor: Number((row.bomUnitCostMinor / scale).toFixed(digits)),
    ingrMajor: Number((row.ingredientUnitCostMinor / scale).toFixed(digits)),
    packMajor: Number((row.packagingUnitCostMinor / scale).toFixed(digits)),
    cogsMajor: Number((row.effectiveCogsUnitMinor / scale).toFixed(digits)),
    wasteMajor: Number((row.wasteAndSurplusUnitMinor / scale).toFixed(digits)),
    taxMajor: Number((row.includedTaxMinor / scale).toFixed(digits)),
    feeMajor: Number((row.channelFeeMinor / scale).toFixed(digits)),
    taxFeeMajor: Number(
      ((row.includedTaxMinor + row.channelFeeMinor) / scale).toFixed(digits),
    ),
    taxPct: assumptions.includedTaxBps / 100,
    feePct: assumptions.channelFeeBps / 100,
    taxRate,
    feeRate,
    unitNetMajor: Number(
      (row.netContributionUnitMinor / scale).toFixed(digits),
    ),
    marginPct: Number(row.netMarginPct.toFixed(2)),
    netDayMajor: Number(
      (row.dailyNetContributionMinor / scale).toFixed(digits),
    ),
    batchYield: row.batchYield,
    batchesPerDay: row.batchesPerDay,
    resolveCell:
      allRows === undefined
        ? undefined
        : (col, targetRow1Based) => {
            const target = allRows[targetRow1Based - 1];
            if (target === undefined) return null;
            const targetScale = 10 ** currencyDigits(target.currency);
            switch (col) {
              case "units":
                return target.dailyTargetUnits;
              case "spoil":
                return target.effectiveSpoilagePct;
              case "price":
                return target.grossPriceMinor / targetScale;
              case "cogs":
                return target.effectiveCogsUnitMinor / targetScale;
              case "waste":
                return target.wasteAndSurplusUnitMinor / targetScale;
              case "taxFee":
                return (
                  (target.includedTaxMinor + target.channelFeeMinor) /
                  targetScale
                );
              case "unitNet":
                return target.netContributionUnitMinor / targetScale;
              case "margin":
                return target.netMarginPct;
              case "netDay":
                return target.dailyNetContributionMinor / targetScale;
            }
          },
  };
}

export function formattedCellDisplayValue(
  row: CalculatedProductMargin,
  column: CostFormulaColumn,
): string {
  const digits = currencyDigits(row.currency);
  switch (column) {
    case "units":
      return String(row.dailyTargetUnits);
    case "spoil":
      return String(Number(row.effectiveSpoilagePct.toFixed(1)));
    case "price":
      return minorToMajorString(row.grossPriceMinor, digits);
    case "cogs":
      return minorToMajorString(Math.round(row.effectiveCogsUnitMinor), digits);
    case "waste":
      return minorToMajorString(
        Math.round(row.wasteAndSurplusUnitMinor),
        digits,
      );
    case "unitNet":
      return minorToMajorString(
        Math.round(row.netContributionUnitMinor),
        digits,
      );
    case "margin":
      return row.netMarginPct.toFixed(1);
    case "netDay":
      return minorToMajorString(
        Math.round(row.dailyNetContributionMinor),
        digits,
      );
  }
}

export function rawCellEditSeed(
  row: CalculatedProductMargin,
  column: CostFormulaColumn,
): string {
  return formattedCellDisplayValue(row, column);
}

export function isColumnOverridden(
  row: CalculatedProductMargin,
  column: CostFormulaColumn,
  dirtySpoil: boolean,
  dirtyPrice: boolean,
  dirtyUnits: boolean,
): boolean {
  if (row.activeFormulas[column] !== undefined) {
    return true;
  }
  switch (column) {
    case "units":
      return dirtyUnits;
    case "spoil":
      return dirtySpoil;
    case "price":
      return dirtyPrice;
    case "cogs":
      return row.hasCogsOverride;
    case "waste":
      return row.hasWasteOverride;
    case "unitNet":
    case "margin":
    case "netDay":
      return false;
  }
}

type CellCommitOutcome =
  | Readonly<{
      ok: true;
      changes: readonly CostsSheetCellChange[];
      notice?: string;
    }>
  | Readonly<{
      ok: false;
      error: string;
    }>;

export function commitEditableProductCell(
  input: Readonly<{
    overview: CostsOverview;
    projected: ProjectedCostsSheet;
    row: CalculatedProductMargin;
    rowNumber1Based: number;
    allRows: readonly CalculatedProductMargin[];
    column: CostFormulaColumn;
    raw: string;
  }>,
): CellCommitOutcome {
  const { overview, projected, row, rowNumber1Based, allRows, column, raw } =
    input;
  const trimmed = raw.trim();
  const digits = currencyDigits(row.currency);
  const scale = 10 ** digits;

  // Empty string or "default" resets overrides/formulas on that column
  if (trimmed.length === 0 || trimmed.toLowerCase() === "default") {
    const changes: CostsSheetCellChange[] = [
      ...changesForProductFormula(overview, row.productId, column, null),
    ];
    if (column === "cogs") {
      changes.push(
        ...changesForProductCogsMinor(overview, row.productId, null),
      );
    } else if (column === "waste") {
      changes.push(
        ...changesForProductWasteMinor(overview, row.productId, null),
      );
    } else if (column === "spoil") {
      changes.push(...changesForProductSpoilBps(overview, row.productId, null));
    }
    return { ok: true, changes };
  }

  // Excel-style `=...` formula
  if (isFormulaExpression(trimmed)) {
    const ctx = buildRowFormulaContext(
      row,
      rowNumber1Based,
      projected.assumptions,
      allRows,
    );
    const evaluated = evaluateCostFormula(trimmed, ctx);
    if (!evaluated.ok) {
      return { ok: false, error: evaluated.message };
    }
    const changes: CostsSheetCellChange[] = [
      ...changesForProductFormula(
        overview,
        row.productId,
        column,
        evaluated.normalized,
      ),
    ];
    if (column === "units") {
      changes.push(
        ...changesForDailyUnits(
          overview,
          projected.weeklyTargets,
          row.productId,
          Math.max(0, Math.round(evaluated.value)),
        ),
      );
    } else if (column === "spoil" && row.fulfillmentKind === "stocked") {
      const bps = Math.max(
        0,
        Math.min(9_500, Math.round(evaluated.value * 100)),
      );
      changes.push({
        cellKey: productSpoilCellKey(row.productId),
        value: String(bps),
      });
    } else if (column === "price") {
      const priceMinor = Math.max(0, Math.round(evaluated.value * scale));
      const baseProduct = overview.products.find(
        (item) => item.productId === row.productId,
      );
      changes.push({
        cellKey: productPriceCellKey(row.productId),
        value:
          baseProduct !== undefined && priceMinor === baseProduct.priceMinor
            ? null
            : String(priceMinor),
      });
    } else if (column === "cogs") {
      const cogsMinor = Math.max(0, Math.round(evaluated.value * scale));
      changes.push({
        cellKey: productCogsCellKey(row.productId),
        value: String(cogsMinor),
      });
    } else if (column === "waste") {
      const wasteMinor = Math.max(0, Math.round(evaluated.value * scale));
      changes.push({
        cellKey: productWasteCellKey(row.productId),
        value: String(wasteMinor),
      });
    }
    return { ok: true, changes };
  }

  // Plain numeric value
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      error: `Enter a number or a formula starting with '=' for ${COLUMN_LABELS[column]}.`,
    };
  }

  switch (column) {
    case "units": {
      if (numeric < 0) {
        return { ok: false, error: "Daily units cannot be negative." };
      }
      return {
        ok: true,
        changes: [
          ...changesForProductFormula(overview, row.productId, "units", null),
          ...changesForDailyUnits(
            overview,
            projected.weeklyTargets,
            row.productId,
            Math.round(numeric),
          ),
        ],
      };
    }
    case "spoil": {
      if (numeric < 0 || numeric > 95) {
        return {
          ok: false,
          error: "Spoilage percent must be between 0% and 95%.",
        };
      }
      const clampedBps = Math.max(
        0,
        Math.min(9_500, Math.round(numeric * 100)),
      );
      return {
        ok: true,
        changes: changesForProductSpoilBps(overview, row.productId, clampedBps),
      };
    }
    case "price": {
      if (numeric < 0) {
        return { ok: false, error: "Offer price cannot be negative." };
      }
      const priceMinor = Math.max(0, Math.round(numeric * scale));
      return {
        ok: true,
        changes: changesForProductPriceMinor(
          overview,
          row.productId,
          priceMinor,
        ),
      };
    }
    case "cogs": {
      if (numeric < 0) {
        return { ok: false, error: "COGS cannot be negative." };
      }
      const cogsMinor = Math.max(0, Math.round(numeric * scale));
      const bomRounded = Math.round(row.bomUnitCostMinor);
      return {
        ok: true,
        changes: changesForProductCogsMinor(
          overview,
          row.productId,
          cogsMinor === bomRounded ? null : cogsMinor,
        ),
      };
    }
    case "waste": {
      if (numeric < 0) {
        return { ok: false, error: "Waste cannot be negative." };
      }
      const wasteMinor = Math.max(0, Math.round(numeric * scale));
      const formulaRounded = Math.round(row.formulaWasteUnitMinor);
      return {
        ok: true,
        changes: changesForProductWasteMinor(
          overview,
          row.productId,
          wasteMinor === formulaRounded ? null : wasteMinor,
        ),
      };
    }
    case "unitNet": {
      const targetUnitNetMinor = Math.round(numeric * scale);
      const currentNetRounded = Math.round(row.netContributionUnitMinor);
      if (
        targetUnitNetMinor === currentNetRounded &&
        row.activeFormulas.unitNet === undefined
      ) {
        return { ok: true, changes: [] };
      }
      const solvedPriceMinor = backSolveGrossPriceMinorForUnitNet({
        fixedUnitCostMinor:
          row.effectiveCogsUnitMinor + row.wasteAndSurplusUnitMinor,
        includedTaxBps: projected.assumptions.includedTaxBps,
        channelFeeBps: projected.assumptions.channelFeeBps,
        targetUnitNetMinor,
      });
      if (solvedPriceMinor === null) {
        return {
          ok: false,
          error:
            "Could not solve an offer price for that target unit net after tax and fees.",
        };
      }
      return {
        ok: true,
        changes: [
          ...changesForProductFormula(overview, row.productId, "unitNet", null),
          ...changesForProductPriceMinor(
            overview,
            row.productId,
            solvedPriceMinor,
          ),
        ],
      };
    }
    case "margin": {
      if (
        Math.abs(numeric - Number(row.netMarginPct.toFixed(1))) < 1e-6 &&
        row.activeFormulas.margin === undefined
      ) {
        return { ok: true, changes: [] };
      }
      const solvedPriceMinor = backSolveGrossPriceMinorForMargin({
        fixedUnitCostMinor:
          row.effectiveCogsUnitMinor + row.wasteAndSurplusUnitMinor,
        includedTaxBps: projected.assumptions.includedTaxBps,
        channelFeeBps: projected.assumptions.channelFeeBps,
        targetNetMarginPct: numeric,
      });
      if (solvedPriceMinor === null) {
        return {
          ok: false,
          error:
            "That target margin exceeds 100% after included tax and payment fees.",
        };
      }
      return {
        ok: true,
        changes: [
          ...changesForProductFormula(overview, row.productId, "margin", null),
          ...changesForProductPriceMinor(
            overview,
            row.productId,
            solvedPriceMinor,
          ),
        ],
      };
    }
    case "netDay": {
      const targetDailyNetMinor = Math.round(numeric * scale);
      const currentDailyNetRounded = Math.round(row.dailyNetContributionMinor);
      if (
        targetDailyNetMinor === currentDailyNetRounded &&
        row.activeFormulas.netDay === undefined
      ) {
        return { ok: true, changes: [] };
      }
      const solvedUnits = backSolveDailyUnitsForNetDay({
        targetDailyNetMinor,
        unitNetContributionMinor: row.netContributionUnitMinor,
      });
      if (solvedUnits === null) {
        return {
          ok: false,
          error:
            "Raise the unit price above unit cost before solving daily units from net profit.",
        };
      }
      return {
        ok: true,
        changes: [
          ...changesForProductFormula(overview, row.productId, "netDay", null),
          ...changesForDailyUnits(
            overview,
            projected.weeklyTargets,
            row.productId,
            solvedUnits,
          ),
        ],
      };
    }
  }
}

export function CostsFormulaBar(props: {
  readonly row: CalculatedProductMargin;
  readonly rowNumber1Based: number;
  readonly allRows: readonly CalculatedProductMargin[];
  readonly column: CostFormulaBarColumn;
  readonly assumptions: CostScenarioAssumptions;
  readonly draftValue: string;
  readonly isEditing: boolean;
  readonly canEdit: boolean;
  readonly formatMoney: (minor: number) => string;
  readonly onChangeDraft: (next: string) => void;
  readonly onFocusBar: (seed: string) => void;
  readonly onCommit: (raw: string) => void;
  readonly onResetColumn: () => void;
  readonly onOpenBom: () => void;
}): React.ReactNode {
  const {
    row,
    rowNumber1Based,
    allRows,
    column,
    assumptions,
    draftValue,
    isEditing,
    canEdit,
    formatMoney,
  } = props;

  const isReadOnlyBarColumn =
    column === "taxFee" ||
    (column === "spoil" && row.fulfillmentKind !== "stocked");
  const colLetter = column === "taxFee" ? "G" : COST_COLUMN_LETTERS[column];
  const cellCoord = `${colLetter}${rowNumber1Based}`;
  const defaultFormula = defaultCostColumnFormula(column, row.fulfillmentKind);
  const activeCustomFormula =
    column === "taxFee" ? undefined : row.activeFormulas[column];
  const displayedFormula = isEditing
    ? draftValue
    : (activeCustomFormula ?? defaultFormula);

  const hasCustomState =
    activeCustomFormula !== undefined ||
    (column === "cogs" && row.hasCogsOverride) ||
    (column === "waste" && row.hasWasteOverride);

  const ctx = buildRowFormulaContext(
    row,
    rowNumber1Based,
    assumptions,
    allRows,
  );
  const liveEval = isFormulaExpression(displayedFormula)
    ? evaluateCostFormula(displayedFormula, ctx)
    : null;

  const solverHint = getSolverHint(
    column,
    row,
    assumptions,
    isEditing ? draftValue : null,
    formatMoney,
  );

  const variableTokens: readonly Readonly<{
    token: string;
    label: string;
  }>[] = [
    { token: "PRICE", label: `PRICE ${formatMoney(row.grossPriceMinor)}` },
    {
      token: "BOM",
      label: `BOM ${formatMoney(Math.round(row.bomUnitCostMinor))}`,
    },
    {
      token: "INGR",
      label: `INGR ${formatMoney(Math.round(row.ingredientUnitCostMinor))}`,
    },
    {
      token: "PACK",
      label: `PACK ${formatMoney(Math.round(row.packagingUnitCostMinor))}`,
    },
    {
      token: "COGS",
      label: `COGS ${formatMoney(Math.round(row.effectiveCogsUnitMinor))}`,
    },
    {
      token: "WASTE",
      label: `WASTE ${formatMoney(Math.round(row.wasteAndSurplusUnitMinor))}`,
    },
    {
      token: "TAX_FEE",
      label: `TAX_FEE ${formatMoney(Math.round(row.includedTaxMinor + row.channelFeeMinor))}`,
    },
    {
      token: "UNIT_NET",
      label: `UNIT_NET ${formatMoney(Math.round(row.netContributionUnitMinor))}`,
    },
    { token: "UNITS", label: `UNITS ${row.dailyTargetUnits}` },
  ];

  const handleInsertToken = (token: string): void => {
    if (!canEdit || isReadOnlyBarColumn) return;
    const base = isEditing
      ? draftValue
      : (activeCustomFormula ?? defaultFormula);
    const prefix = base.trimStart().startsWith("=") ? base : `= ${token}`;
    const next = base.trimStart().startsWith("=")
      ? `${base.trimEnd()} ${token}`
      : prefix;
    props.onChangeDraft(next);
  };

  return (
    <div
      className="costs-fx-bar"
      role="region"
      aria-label="Spreadsheet formula bar"
    >
      <div className="costs-fx-top">
        <div
          className="costs-fx-coord"
          title={`${row.productTitle} · ${COLUMN_LABELS[column]}`}
        >
          <span className="costs-fx-coord-cell">{cellCoord}</span>
          <span className="costs-fx-coord-product">{row.productTitle}</span>
          <span className="costs-fx-coord-sep">·</span>
          <span className="costs-fx-coord-col">{COLUMN_LABELS[column]}</span>
        </div>

        <label className="costs-fx-input-wrap">
          <span className="costs-fx-badge" aria-hidden="true">
            fx
          </span>
          <input
            type="text"
            className="costs-fx-input"
            disabled={!canEdit || isReadOnlyBarColumn}
            aria-label={`Formula or value for ${row.productTitle} ${COLUMN_LABELS[column]}`}
            placeholder={`${defaultFormula} or enter a target value…`}
            value={displayedFormula}
            onFocus={() =>
              props.onFocusBar(activeCustomFormula ?? defaultFormula)
            }
            onChange={(event) => props.onChangeDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onCommit(event.currentTarget.value);
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={(event) => {
              if (isEditing) {
                props.onCommit(event.currentTarget.value);
              }
            }}
          />
        </label>

        <div className="costs-fx-actions">
          {solverHint !== null ? (
            <span className="costs-fx-preview is-solver">
              <Sparkles size={12} aria-hidden="true" />
              {solverHint}
            </span>
          ) : liveEval !== null ? (
            <span
              className={`costs-fx-preview${liveEval.ok ? "" : " is-error"}`}
              title={liveEval.ok ? undefined : liveEval.message}
            >
              {liveEval.ok
                ? `= ${formatEvaluatedPreview(column, liveEval.value, formatMoney, row.currency)}`
                : liveEval.message}
            </span>
          ) : null}

          {hasCustomState && canEdit ? (
            <button
              type="button"
              className="costs-fx-btn is-reset"
              onClick={props.onResetColumn}
              title="Reset cell back to its default recipe/spoilage formula"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Reset to default
            </button>
          ) : null}

          {column === "cogs" ? (
            <button
              type="button"
              className="costs-fx-btn"
              onClick={props.onOpenBom}
            >
              <TableProperties size={12} aria-hidden="true" />
              Recipe BOM ({formatMoney(Math.round(row.bomUnitCostMinor))})
            </button>
          ) : null}
        </div>
      </div>

      {isEditing && isFormulaExpression(draftValue) ? (
        <div className="costs-fx-vars" aria-label="Row formula variables">
          <span className="costs-fx-vars-label">Variables:</span>
          {variableTokens.map((item) => (
            <button
              key={item.token}
              type="button"
              className="costs-fx-var-chip"
              disabled={!canEdit || isReadOnlyBarColumn}
              onMouseDown={(event) => {
                // Prevent blurring the fx input when clicking a variable token
                event.preventDefault();
                handleInsertToken(item.token);
              }}
              title={`Insert ${item.token} into formula`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatEvaluatedPreview(
  column: CostFormulaBarColumn,
  value: number,
  formatMoney: (minor: number) => string,
  currency: string,
): string {
  const scale = 10 ** currencyDigits(currency);
  switch (column) {
    case "units":
      return `${Math.round(value)} u/d`;
    case "spoil":
    case "margin":
      return `${value.toFixed(1)}%`;
    case "price":
    case "cogs":
    case "waste":
    case "taxFee":
    case "unitNet":
    case "netDay":
      return formatMoney(Math.round(value * scale));
  }
}

function getSolverHint(
  column: CostFormulaBarColumn,
  row: CalculatedProductMargin,
  assumptions: CostScenarioAssumptions,
  rawDraft: string | null,
  formatMoney: (minor: number) => string,
): string | null {
  const digits = currencyDigits(row.currency);
  const scale = 10 ** digits;

  if (rawDraft !== null && !isFormulaExpression(rawDraft)) {
    const num = Number(rawDraft.trim());
    if (Number.isFinite(num)) {
      if (column === "margin") {
        const solved = backSolveGrossPriceMinorForMargin({
          fixedUnitCostMinor:
            row.effectiveCogsUnitMinor + row.wasteAndSurplusUnitMinor,
          includedTaxBps: assumptions.includedTaxBps,
          channelFeeBps: assumptions.channelFeeBps,
          targetNetMarginPct: num,
        });
        return solved !== null
          ? `Solves Price → ${formatMoney(solved)}`
          : "Margin exceeds 100% after tax & fee";
      }
      if (column === "unitNet") {
        const solved = backSolveGrossPriceMinorForUnitNet({
          fixedUnitCostMinor:
            row.effectiveCogsUnitMinor + row.wasteAndSurplusUnitMinor,
          includedTaxBps: assumptions.includedTaxBps,
          channelFeeBps: assumptions.channelFeeBps,
          targetUnitNetMinor: Math.round(num * scale),
        });
        return solved !== null ? `Solves Price → ${formatMoney(solved)}` : null;
      }
      if (column === "netDay") {
        const solved = backSolveDailyUnitsForNetDay({
          targetDailyNetMinor: Math.round(num * scale),
          unitNetContributionMinor: row.netContributionUnitMinor,
        });
        return solved !== null ? `Solves Units / d → ${solved} u/d` : null;
      }
    }
  }

  switch (column) {
    case "margin":
      return `Type % to back-solve Price (${formatMoney(row.grossPriceMinor)}) or = formula`;
    case "unitNet":
      return `Type target net to back-solve Price (${formatMoney(row.grossPriceMinor)}) or = formula`;
    case "netDay":
      return `Type daily net to back-solve Units / d (${row.dailyTargetUnits}) or = formula`;
    case "cogs":
      return row.hasCogsOverride
        ? `Override active (Recipe BOM is ${formatMoney(Math.round(row.bomUnitCostMinor))})`
        : `Recipe BOM · ${row.bomLines.length} ${row.bomLines.length === 1 ? "line" : "lines"} (${formatMoney(Math.round(row.ingredientUnitCostMinor))} ingr + ${formatMoney(Math.round(row.packagingUnitCostMinor))} pack)`;
    case "waste":
      return row.hasWasteOverride
        ? `Override active (Formula waste is ${formatMoney(Math.round(row.formulaWasteUnitMinor))})`
        : `Spoil ${row.effectiveSpoilagePct.toFixed(1)}% + Reject ${assumptions.prepRejectPct.toFixed(1)}%`;
    case "taxFee":
      return `Tax ${(assumptions.includedTaxBps / 100).toFixed(1)}% (${formatMoney(Math.round(row.includedTaxMinor))}) + Fee ${(assumptions.channelFeeBps / 100).toFixed(1)}% (${formatMoney(Math.round(row.channelFeeMinor))})`;
    case "spoil":
      return row.fulfillmentKind !== "stocked"
        ? "Prep to order (no shelf spoilage)"
        : null;
    default:
      return null;
  }
}
