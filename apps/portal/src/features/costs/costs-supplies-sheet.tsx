import React from "react";
import type {
  CalculatedSupplyUsage,
  CostUnit,
  SupplyCostItem,
} from "@seams/control-api";
import { supplyFieldCellKey } from "@seams/costs-sheet-crdt";
import { formatMoneyMinor } from "../../formatting";
import { CrmTable, CrmTag, Select, type CrmColumn } from "../../ui";
import { compatibleUnitsForBase, formatCostQuantity } from "./api";
import {
  renderSupplyCoverageCell,
  renderSupplySkuReachCell,
  supplyStockCoverageSortValue,
} from "./costs-bom-inline";
import { renderSupplyLotCostCell } from "./costs-lots-drawer";
import {
  supplyDraftFromItem,
  type ProjectedCostsSheet,
  type SupplyRowDraft,
} from "./costs-sheet-draft";
import {
  handleCellBoxMouseDown,
  handleSheetKeyDown,
  type DirtyInspection,
} from "./costs-sheet-grid";
import {
  CellPeerOutline,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";
import { SupplyBadge } from "./costs-ui";

type SupplyNumberField = Exclude<keyof SupplyRowDraft, "packUnit">;

type SheetFocusedCell = Readonly<{
  cellKey: string;
  raw: string;
  seed: string;
}>;

export function CostsSuppliesSheet(
  props: Readonly<{
    items: readonly SupplyCostItem[];
    usages: readonly CalculatedSupplyUsage[];
    projected: ProjectedCostsSheet;
    dirtyInfo: DirtyInspection;
    presence: PresenceIndex;
    focusedCell: SheetFocusedCell | null;
    canEdit: boolean;
    currency: string;
    currencySymbol: string;
    digits: number;
    onFocusCell: (
      cellKey: string,
      seed: string,
      input?: HTMLInputElement,
    ) => void;
    onBlurCell: (cellKey: string) => void;
    onUpdateSupplyField: (
      item: SupplyCostItem,
      currency: string,
      cellKey: string,
      raw: string,
      patch: Partial<SupplyRowDraft>,
    ) => void;
    onInspectSupplyLots: (inventoryItemId: string) => void;
  }>,
): React.ReactNode {
  const {
    items,
    usages,
    projected,
    dirtyInfo,
    presence,
    focusedCell,
    canEdit,
    currency,
    currencySymbol: sym,
    digits,
  } = props;

  const fmtMoney = (minor: number) =>
    formatMoneyMinor(Math.round(minor), currency);
  const usageByItemId = new Map(
    usages.map((usage) => [usage.inventoryItemId, usage]),
  );

  const draftFor = (item: SupplyCostItem): SupplyRowDraft =>
    projected.supplyEdits[item.id] ?? supplyDraftFromItem(item, currency);

  /** One number cell of a supply row, with its peers and an optional prefix. */
  const numberCell = (
    item: SupplyCostItem,
    rowIndex: number,
    field: SupplyNumberField,
    cell: Readonly<{
      column: string;
      label: string;
      min: number;
      step: number | "any";
      placeholder?: string;
      prefix?: React.ReactNode;
    }>,
  ): React.ReactNode => {
    const value = draftFor(item)[field];
    const key = supplyFieldCellKey(item.id, field);
    const peers = presence.peersByCell.get(key);
    return (
      <div
        className={`costs-cell-box${peers?.length ? " has-peer" : ""}`}
        style={peerCellStyle(peers)}
        onMouseDown={handleCellBoxMouseDown}
      >
        <CellPeerOutline peers={peers} below={rowIndex === 0} />
        {cell.prefix}
        <input
          type="number"
          className="costs-cell-input"
          min={cell.min}
          step={cell.step}
          placeholder={cell.placeholder}
          disabled={!canEdit}
          data-sheet-row={rowIndex}
          data-sheet-col={cell.column}
          aria-label={`${item.name} ${cell.label}`}
          value={cellValue(focusedCell, key, value)}
          onFocus={(e) => props.onFocusCell(key, value, e.currentTarget)}
          onBlur={() => props.onBlurCell(key)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            props.onUpdateSupplyField(item, currency, key, raw, {
              [field]: raw,
            });
          }}
          onKeyDown={(event) =>
            handleSheetKeyDown(event, rowIndex, cell.column)
          }
        />
      </div>
    );
  };
  const priceStep = digits === 0 ? 10 : "any";

  const columns: readonly CrmColumn<SupplyCostItem>[] = [
    {
      id: "supply",
      label: "Ingredient or packaging",
      kind: "text",
      width: 244,
      minWidth: 184,
      value: (item) => item.name,
      render: (item) => (
        <div className="costs-product-cell">
          <SupplyBadge category={item.category} />
          <div className="costs-product-meta">
            <span className="costs-product-title">{item.name}</span>
            <span className="costs-product-sub">
              {formatSupplyCategory(item.category)}
              {item.merchantCode.length > 0
                ? ` · ${item.merchantCode}`
                : ` · ${item.baseUnit}`}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "packQty",
      label: "Pack qty",
      kind: "number",
      width: 92,
      minWidth: 78,
      value: (item) => {
        const n = Number(draftFor(item).packQuantity);
        return Number.isFinite(n) ? n : null;
      },
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "packQuantity"),
      }),
      render: (item, rowIndex) =>
        numberCell(item, rowIndex, "packQuantity", {
          column: "pack_qty",
          label: "pack quantity",
          min: 0.001,
          step: "any",
          prefix: dirtyInfo.dirtySupplies.has(item.id) && (
            <span className="costs-dirty-dot" aria-hidden="true" />
          ),
        }),
    },
    {
      id: "packUnit",
      label: "Unit",
      kind: "text",
      width: 88,
      minWidth: 76,
      value: (item) => draftFor(item).packUnit,
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "packUnit"),
      }),
      render: (item, rowIndex) => {
        const draft = draftFor(item);
        const key = supplyFieldCellKey(item.id, "packUnit");
        const peers = presence.peersByCell.get(key);
        const allowedUnits = compatibleUnitsForBase(item.baseUnit);
        return (
          <div
            className={`costs-cell-box is-select${peers?.length ? " has-peer" : ""}`}
            style={peerCellStyle(peers)}
            onMouseDown={handleCellBoxMouseDown}
          >
            <CellPeerOutline peers={peers} below={rowIndex === 0} />
            <Select.Root
              items={allowedUnits.map((unitOption) => ({
                value: unitOption,
                label: unitOption,
              }))}
              disabled={!canEdit}
              value={draft.packUnit}
              onValueChange={(raw) => {
                if (raw === null) {
                  return;
                }
                props.onUpdateSupplyField(item, currency, key, raw, {
                  packUnit: raw as CostUnit,
                });
              }}
            >
              <Select.Trigger
                variant="ghost"
                className="costs-cell-select"
                data-sheet-row={rowIndex}
                data-sheet-col="pack_unit"
                aria-label={`${item.name} pack unit`}
                onFocus={() => props.onFocusCell(key, draft.packUnit)}
                onBlur={() => props.onBlurCell(key)}
                onKeyDown={(event) => {
                  handleSheetKeyDown(event, rowIndex, "pack_unit");
                  if (event.defaultPrevented) {
                    event.preventBaseUIHandler();
                  }
                }}
              >
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {allowedUnits.map((unitOption) => (
                  <Select.Item key={unitOption} value={unitOption}>
                    {unitOption}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </div>
        );
      },
    },
    {
      id: "packPrice",
      label: "Pack price",
      kind: "number",
      width: 98,
      minWidth: 82,
      value: (item) => {
        const n = Number(draftFor(item).packPriceMajor);
        return Number.isFinite(n) ? Math.round(n * 10 ** digits) : null;
      },
      format: fmtMoney,
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "packPriceMajor"),
      }),
      render: (item, rowIndex) =>
        numberCell(item, rowIndex, "packPriceMajor", {
          column: "pack_price",
          label: "pack price",
          min: 0,
          step: priceStep,
          prefix: <span className="costs-cell-affix">{sym}</span>,
        }),
    },
    {
      id: "bulkMin",
      label: "7d min",
      kind: "number",
      width: 86,
      minWidth: 72,
      value: (item) => {
        const raw = draftFor(item).bulkMin7dQuantity;
        const n = raw.length > 0 ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : null;
      },
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "bulkMin7dQuantity"),
      }),
      render: (item, rowIndex) =>
        numberCell(item, rowIndex, "bulkMin7dQuantity", {
          column: "bulk_min",
          label: "7-day bulk minimum",
          min: 0,
          step: "any",
          placeholder: "—",
        }),
    },
    {
      id: "bulkQty",
      label: "Bulk qty",
      kind: "number",
      width: 86,
      minWidth: 72,
      value: (item) => {
        const raw = draftFor(item).bulkPackQuantity;
        const n = raw.length > 0 ? Number(raw) : NaN;
        return Number.isFinite(n) ? n : null;
      },
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "bulkPackQuantity"),
      }),
      render: (item, rowIndex) =>
        numberCell(item, rowIndex, "bulkPackQuantity", {
          column: "bulk_qty",
          label: "bulk pack quantity",
          min: 0,
          step: "any",
          placeholder: "—",
        }),
    },
    {
      id: "bulkPrice",
      label: "Bulk price",
      kind: "number",
      width: 96,
      minWidth: 80,
      value: (item) => {
        const raw = draftFor(item).bulkPackPriceMajor;
        const n = raw.length > 0 ? Number(raw) : NaN;
        return Number.isFinite(n) ? Math.round(n * 10 ** digits) : null;
      },
      format: fmtMoney,
      cellProps: (item) => ({
        cellKey: supplyFieldCellKey(item.id, "bulkPackPriceMajor"),
      }),
      render: (item, rowIndex) =>
        numberCell(item, rowIndex, "bulkPackPriceMajor", {
          column: "bulk_price",
          label: "bulk pack price",
          min: 0,
          step: priceStep,
          placeholder: "—",
          prefix: draftFor(item).bulkPackPriceMajor.length > 0 && (
            <span className="costs-cell-affix">{sym}</span>
          ),
        }),
    },
    {
      id: "usage7d",
      label: "7d usage",
      kind: "number",
      align: "end",
      width: 96,
      minWidth: 80,
      value: (item) => usageByItemId.get(item.id)?.sevenDayBaseUsage ?? 0,
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:usage7d`,
      }),
      render: (item, rowIndex) => {
        const usage = usageByItemId.get(item.id);
        return (
          <div
            className="costs-cell-box is-readonly"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="usage7d"
            aria-label={`${item.name} 7-day usage`}
            onKeyDown={(event) =>
              handleSheetKeyDown(event, rowIndex, "usage7d")
            }
          >
            <span className="costs-cell-muted">
              {usage !== undefined
                ? formatCostQuantity(usage.sevenDayBaseUsage, item.baseUnit)
                : "0"}
            </span>
          </div>
        );
      },
    },
    {
      id: "stockCoverage",
      label: "Stock coverage",
      kind: "number",
      align: "start",
      width: 132,
      minWidth: 108,
      value: (item) => supplyStockCoverageSortValue(usageByItemId.get(item.id)),
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:stockCoverage`,
      }),
      render: (item, rowIndex) =>
        renderSupplyCoverageCell({
          item,
          rowIndex,
          usage: usageByItemId.get(item.id),
          onInspectSupply: props.onInspectSupplyLots,
          onKeyDown: (event) =>
            handleSheetKeyDown(event, rowIndex, "stock_coverage"),
        }),
    },
    {
      id: "usedInSkus",
      label: "Used in SKUs",
      kind: "number",
      align: "start",
      width: 96,
      minWidth: 82,
      value: (item) => usageByItemId.get(item.id)?.usedInProductCount ?? 0,
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:usedInSkus`,
      }),
      render: (item, rowIndex) =>
        renderSupplySkuReachCell({
          item,
          rowIndex,
          usage: usageByItemId.get(item.id),
          onInspectSupply: props.onInspectSupplyLots,
          onKeyDown: (event) =>
            handleSheetKeyDown(event, rowIndex, "used_in_skus"),
        }),
    },
    {
      id: "lotCost",
      label: "Lot cost",
      kind: "number",
      width: 118,
      minWidth: 96,
      value: (item) => {
        const usage = usageByItemId.get(item.id);
        return projected.assumptions.lotCostBasis === "weighted_lot"
          ? (usage?.weightedEquivalentPackPriceMinor ??
              usage?.fifoEquivalentPackPriceMinor ??
              null)
          : (usage?.fifoEquivalentPackPriceMinor ??
              usage?.weightedEquivalentPackPriceMinor ??
              null);
      },
      format: fmtMoney,
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:lotCost`,
      }),
      render: (item, rowIndex) =>
        renderSupplyLotCostCell({
          item,
          usage: usageByItemId.get(item.id),
          lotCostBasis: projected.assumptions.lotCostBasis,
          currency,
          rowIndex,
          onKeyDown: (event) => handleSheetKeyDown(event, rowIndex, "lot_cost"),
          onOpenLots: props.onInspectSupplyLots,
        }),
    },
    {
      id: "tier",
      label: "Active tier",
      kind: "text",
      width: 96,
      minWidth: 84,
      value: (item) => {
        const usage = usageByItemId.get(item.id);
        if (usage?.effectiveCostPerBaseUnitMinor == null) {
          return "Unpriced";
        }
        if (usage.costSource === "fifo_lot") {
          return "FIFO lot";
        }
        if (usage.costSource === "weighted_lot") {
          return "Weighted lot";
        }
        return usage.bulkUnlocked ? "Bulk tier" : "Standard";
      },
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:tier`,
      }),
      render: (item, rowIndex) => {
        const usage = usageByItemId.get(item.id);
        const tag =
          usage?.effectiveCostPerBaseUnitMinor == null ? (
            <CrmTag tone="warning">Unpriced</CrmTag>
          ) : usage.costSource === "fifo_lot" ? (
            <CrmTag tone="positive">FIFO lot</CrmTag>
          ) : usage.costSource === "weighted_lot" ? (
            <CrmTag tone="positive">Weighted lot</CrmTag>
          ) : usage.bulkUnlocked ? (
            <CrmTag tone="positive">Bulk tier</CrmTag>
          ) : (
            <CrmTag>Standard</CrmTag>
          );
        return (
          <div
            className="costs-cell-box is-readonly is-align-start"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="tier"
            aria-label={`${item.name} active cost tier`}
            onKeyDown={(event) => handleSheetKeyDown(event, rowIndex, "tier")}
          >
            {tag}
          </div>
        );
      },
    },
    {
      id: "dailySpend",
      label: "Daily spend",
      kind: "number",
      width: 96,
      minWidth: 82,
      value: (item) =>
        Math.round(usageByItemId.get(item.id)?.dailySpendMinor ?? 0),
      format: fmtMoney,
      cellProps: (item) => ({
        cellKey: `supply:${item.id}:dailySpend`,
      }),
      render: (item, rowIndex) => (
        <div
          className="costs-cell-box is-readonly"
          tabIndex={0}
          data-sheet-row={rowIndex}
          data-sheet-col="dailySpend"
          aria-label={`${item.name} daily spend`}
          onKeyDown={(event) =>
            handleSheetKeyDown(event, rowIndex, "dailySpend")
          }
        >
          <span>
            {formatMoneyMinor(
              Math.round(usageByItemId.get(item.id)?.dailySpendMinor ?? 0),
              currency,
            )}
          </span>
        </div>
      ),
    },
  ];

  return (
    <CrmTable
      key="supplies"
      className="costs-crm-sheet"
      label="Supplier pack prices spreadsheet"
      rows={items}
      columns={columns}
      rowId={(item) => item.id}
      rowLabel={(item) => item.name}
      initialPinned={["supply"]}
      initialCalculations={{
        packPrice: "average",
        dailySpend: "sum",
      }}
      emptyTitle="No matching supplies"
      emptyDescription="Clear the search box to view all stock items."
    />
  );
}

function cellValue(
  focused: SheetFocusedCell | null,
  cellKey: string,
  formatted: string,
): string {
  return focused?.cellKey === cellKey ? focused.raw : formatted;
}

function formatSupplyCategory(section: string): string {
  if (section.length === 0) {
    return "General";
  }
  const spaced = section.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
