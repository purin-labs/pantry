import React from "react";
import { ArrowUpRight, Receipt } from "lucide-react";
import {
  convertCostQuantity,
  type CalculatedSupplyUsage,
  type CostValuationBasis,
  type CostsOverview,
  type LotCostLineWrite,
  type SupplyCostItem,
  type SupplyLotCost,
  type SupplyLotInvoiceCost,
} from "@purin-labs/control-api";
import {
  lotInvoiceFieldCellKey,
  supplyFieldCellKey,
} from "@purin-labs/costs-sheet-crdt";
import { formatMoneyMinor, formatSignedMoneyRounded } from "../../formatting";
import { SideDrawer } from "../../ui";
import { formatCostQuantity } from "./api";
import {
  currencyDigits,
  lotDraftFromLot,
  sameLotDraft,
  supplyDraftFromItem,
  type LotInvoiceRowDraft,
  type ProjectedCostsSheet,
  type SupplyRowDraft,
} from "./costs-sheet-draft";
import {
  CellPeerOutline,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";
import { SupplyBadge, type FocusedCellLike } from "./costs-ui";

export function inspectDirtyLots(
  overview: CostsOverview,
  projected: ProjectedCostsSheet,
): ReadonlySet<string> {
  const dirty = new Set<string>();
  for (const lot of overview.lots ?? []) {
    const edit = projected.lotEdits[lot.id];
    if (edit === undefined) continue;
    const baseDraft = lotDraftFromLot(lot, overview.currency);
    if (!sameLotDraft(edit, baseDraft)) {
      dirty.add(lot.id);
    }
  }
  return dirty;
}

export function buildLotWritesForSheet(
  overview: CostsOverview,
  projected: ProjectedCostsSheet,
  dirtyLots: ReadonlySet<string>,
):
  | Readonly<{ ok: true; lotWrites: readonly LotCostLineWrite[] }>
  | Readonly<{ ok: false; error: string }> {
  if (dirtyLots.size === 0) {
    return { ok: true, lotWrites: [] };
  }
  const itemsById = new Map(overview.items.map((item) => [item.id, item]));
  const lotWrites: LotCostLineWrite[] = [];

  for (const lot of overview.lots ?? []) {
    if (!dirtyLots.has(lot.id)) continue;
    const edit = projected.lotEdits[lot.id];
    if (edit === undefined) continue;
    const item = itemsById.get(lot.inventoryItemId);
    const currency =
      lot.invoiceCost?.currency ??
      item?.costTerms?.currency ??
      overview.currency;
    const digits = currencyDigits(currency);
    const totalMajorRaw = edit.invoiceTotalMajor.trim();
    const totalMajor = totalMajorRaw.length > 0 ? Number(totalMajorRaw) : NaN;
    if (!Number.isFinite(totalMajor) || totalMajor < 0) {
      return {
        ok: false,
        error: `Enter a non-negative invoice total for lot ${lot.lotCode}.`,
      };
    }
    const invoiceTotalMinor = Math.round(totalMajor * 10 ** digits);
    const invoiceReference =
      edit.invoiceReference.trim().length > 0
        ? edit.invoiceReference.trim()
        : null;
    const expectedRevision =
      lot.invoiceCost?.source === "lot_invoice"
        ? lot.invoiceCost.revision
        : null;

    lotWrites.push({
      lotId: lot.id,
      inventoryItemId: lot.inventoryItemId,
      expectedRevision,
      currency,
      invoicedQuantity:
        lot.invoiceCost?.invoicedQuantity ?? lot.receivedQuantity,
      invoicedUnit: lot.invoiceCost?.invoicedUnit ?? lot.baseUnit,
      invoiceTotalMinor,
      invoiceReference,
      supplierId:
        lot.invoiceCost?.supplierId ?? item?.costTerms?.supplierId ?? null,
    });
  }

  return { ok: true, lotWrites };
}

export function applyPreviewLotEdits(
  overview: CostsOverview,
  edits: Readonly<Record<string, LotInvoiceRowDraft>>,
): CostsOverview {
  const existingLots = overview.lots;
  if (
    existingLots === undefined ||
    existingLots.length === 0 ||
    Object.keys(edits).length === 0
  ) {
    return overview;
  }
  const itemsById = new Map(overview.items.map((item) => [item.id, item]));
  const lots: SupplyLotCost[] = existingLots.map((lot) => {
    const edit = edits[lot.id];
    if (edit === undefined) return lot;
    const item = itemsById.get(lot.inventoryItemId);
    const currency =
      lot.invoiceCost?.currency ??
      item?.costTerms?.currency ??
      overview.currency;
    const digits = currencyDigits(currency);
    const totalMajor = Number(edit.invoiceTotalMajor);
    if (
      edit.invoiceTotalMajor.trim().length === 0 ||
      !Number.isFinite(totalMajor) ||
      totalMajor < 0
    ) {
      return lot;
    }
    const previewInvoice: SupplyLotInvoiceCost = {
      revision: lot.invoiceCost?.revision ?? 1,
      source: "lot_invoice",
      currency,
      invoicedQuantity:
        lot.invoiceCost?.invoicedQuantity ?? lot.receivedQuantity,
      invoicedUnit: lot.invoiceCost?.invoicedUnit ?? lot.baseUnit,
      invoiceTotalMinor: Math.round(totalMajor * 10 ** digits),
      invoiceReference:
        edit.invoiceReference.trim().length > 0
          ? edit.invoiceReference.trim()
          : null,
      supplierId:
        lot.invoiceCost?.supplierId ?? item?.costTerms?.supplierId ?? null,
    };
    return { ...lot, invoiceCost: previewInvoice };
  });
  return { ...overview, lots };
}

export function renderSupplyLotCostCell(
  input: Readonly<{
    item: SupplyCostItem;
    rowIndex?: number;
    usage: CalculatedSupplyUsage | undefined;
    lotCostBasis: CostValuationBasis;
    currency: string;
    onOpenLots: (itemId: string) => void;
    onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  }>,
): React.ReactNode {
  const {
    item,
    rowIndex,
    usage,
    lotCostBasis,
    currency,
    onOpenLots,
    onKeyDown,
  } = input;
  const activeCount = usage?.activeLotCount ?? 0;
  const pricedCount = usage?.pricedLotCount ?? 0;
  const eqPackMinor =
    lotCostBasis === "weighted_lot"
      ? (usage?.weightedEquivalentPackPriceMinor ??
        usage?.fifoEquivalentPackPriceMinor ??
        null)
      : (usage?.fifoEquivalentPackPriceMinor ??
        usage?.weightedEquivalentPackPriceMinor ??
        null);
  const variancePct = usage?.lotCostVariancePct ?? null;

  return (
    <div className="costs-cell-box is-lot-cell">
      <button
        type="button"
        className="costs-lot-cell-btn"
        data-sheet-row={rowIndex}
        data-sheet-col={rowIndex !== undefined ? "lot_cost" : undefined}
        onClick={() => onOpenLots(item.id)}
        onKeyDown={onKeyDown}
        aria-label={`Inspect lots and purchase invoices for ${item.name}`}
      >
        {eqPackMinor !== null ? (
          <span className="costs-lot-cell-price">
            {formatMoneyMinor(Math.round(eqPackMinor), currency)}
          </span>
        ) : activeCount > 0 ? (
          <span className="costs-lot-cell-unpriced">
            {activeCount} {activeCount === 1 ? "lot" : "lots"}
          </span>
        ) : (
          <span className="costs-cell-muted">—</span>
        )}
        {variancePct !== null && Math.abs(variancePct) >= 0.1 ? (
          <span
            className={`costs-lot-variance-pill ${
              variancePct > 0 ? "is-higher" : "is-lower"
            }`}
          >
            {variancePct > 0 ? "+" : ""}
            {variancePct.toFixed(1)}%
          </span>
        ) : activeCount > 0 ? (
          <span className="costs-lot-count-pill">
            {pricedCount}/{activeCount}
          </span>
        ) : null}
      </button>
    </div>
  );
}

export function CostsLotsDrawer(
  props: Readonly<{
    open: boolean;
    item: SupplyCostItem | null;
    usage: CalculatedSupplyUsage | null;
    lots: readonly SupplyLotCost[];
    projected: ProjectedCostsSheet;
    dirtyLots: ReadonlySet<string>;
    presence: PresenceIndex;
    focusedCell: FocusedCellLike;
    canEdit: boolean;
    currency: string;
    currencySymbol: string;
    onClose: () => void;
    onFocusCell: (
      cellKey: string,
      raw: string,
      input: HTMLInputElement,
    ) => void;
    onBlurCell: (cellKey: string) => void;
    onUpdateLotField: (
      lot: SupplyLotCost,
      cellKey: string,
      raw: string,
      patch: Partial<LotInvoiceRowDraft>,
    ) => void;
    onUpdateSupplyField?: (
      item: SupplyCostItem,
      currency: string,
      cellKey: string,
      raw: string,
      patch: Partial<SupplyRowDraft>,
    ) => void;
    onSelectProduct?: (productId: string) => void;
  }>,
): React.ReactNode {
  const { item, usage, lots, projected, currency, currencySymbol } = props;
  if (item === null) {
    return (
      <SideDrawer
        open={false}
        close={props.onClose}
        title=""
        className="costs-bom-side-drawer"
      />
    );
  }

  const supplyDraft =
    projected.supplyEdits[item.id] ?? supplyDraftFromItem(item, currency);
  const bulkMinKey = supplyFieldCellKey(item.id, "bulkMin7dQuantity");
  const bulkQtyKey = supplyFieldCellKey(item.id, "bulkPackQuantity");
  const bulkPriceKey = supplyFieldCellKey(item.id, "bulkPackPriceMajor");
  const bulkMinPeers = props.presence.peersByCell.get(bulkMinKey);
  const bulkQtyPeers = props.presence.peersByCell.get(bulkQtyKey);
  const bulkPricePeers = props.presence.peersByCell.get(bulkPriceKey);
  const bulkMinVal =
    props.focusedCell?.cellKey === bulkMinKey
      ? props.focusedCell.raw
      : supplyDraft.bulkMin7dQuantity;
  const bulkQtyVal =
    props.focusedCell?.cellKey === bulkQtyKey
      ? props.focusedCell.raw
      : supplyDraft.bulkPackQuantity;
  const bulkPriceVal =
    props.focusedCell?.cellKey === bulkPriceKey
      ? props.focusedCell.raw
      : supplyDraft.bulkPackPriceMajor;

  const basisLabel =
    projected.assumptions.lotCostBasis === "fifo_lot"
      ? "FIFO lot invoices active"
      : projected.assumptions.lotCostBasis === "weighted_lot"
        ? "Weighted lot average active"
        : "Standing pack terms active";

  const packQuantityBase =
    item.costTerms !== null
      ? convertCostQuantity(
          item.costTerms.packQuantity,
          item.costTerms.packUnit,
          item.baseUnit,
        )
      : null;

  return (
    <SideDrawer
      open={props.open}
      close={props.onClose}
      className="costs-bom-side-drawer"
      title={
        <span className="costs-bom-head-lead">
          <SupplyBadge category={item.category} />
          <span className="costs-bom-head-text">
            <span className="costs-bom-title">{item.name}</span>
            <span className="costs-bom-sub">
              {lots.length} received {lots.length === 1 ? "lot" : "lots"} ·{" "}
              {basisLabel}
            </span>
          </span>
        </span>
      }
    >
      <div className="side-drawer-body costs-bom-drawer-body">
        <div className="costs-bom-stack-card">
          <div className="costs-bom-stack-top">
            <span className="costs-bom-price-label">
              Standing pack{" "}
              {item.costTerms !== null
                ? `${formatMoneyMinor(item.costTerms.packPriceMinor, currency)} / ${formatCostQuantity(item.costTerms.packQuantity, item.costTerms.packUnit)}`
                : "unpriced"}
            </span>
            <span className="costs-bom-net-label">
              {usage?.fifoEquivalentPackPriceMinor != null
                ? `FIFO ${formatMoneyMinor(Math.round(usage.fifoEquivalentPackPriceMinor), currency)}`
                : "No priced lots"}
              {usage?.weightedEquivalentPackPriceMinor != null
                ? ` · Avg ${formatMoneyMinor(Math.round(usage.weightedEquivalentPackPriceMinor), currency)}`
                : ""}
            </span>
          </div>
          {usage !== null ? (
            <div className="costs-supply-drawer-coverage">
              <span>
                On hand:{" "}
                <strong>
                  {usage.onHandBaseQuantity !== null
                    ? formatCostQuantity(
                        usage.onHandBaseQuantity,
                        item.baseUnit,
                      )
                    : "Uncounted"}
                </strong>
                {" · "}7d need:{" "}
                <strong>
                  {formatCostQuantity(usage.sevenDayBaseUsage, item.baseUnit)}
                </strong>
              </span>
              {usage.daysOfSupply !== null ? (
                <span
                  className={`costs-coverage-pill ${
                    usage.reorderSuggested ? "is-reorder" : "is-healthy"
                  }`}
                >
                  {usage.reorderSuggested
                    ? `${usage.daysOfSupply.toFixed(1)}d left · Reorder`
                    : `${usage.daysOfSupply >= 99 ? "99d+" : `${usage.daysOfSupply.toFixed(1)}d`} on hand`}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {props.onUpdateSupplyField !== undefined ? (
          <div className="costs-bom-section">
            <div className="costs-bom-list-header">
              <span>Bulk volume contract tier</span>
              <span>
                {usage?.bulkUnlocked
                  ? "Bulk tier unlocked"
                  : supplyDraft.bulkMin7dQuantity.length > 0
                    ? "Below 7d threshold"
                    : "No bulk tier set"}
              </span>
            </div>
            <div className="costs-bulk-drawer-grid">
              <label
                data-cell-key={bulkMinKey}
                className={`costs-pop-field${bulkMinPeers?.length ? " has-peer-focus" : ""}`}
                style={peerCellStyle(bulkMinPeers)}
              >
                <CellPeerOutline peers={bulkMinPeers} />
                <span className="costs-pop-field-label">
                  7d min ({supplyDraft.packUnit})
                </span>
                <span className="costs-pop-input-wrap">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="—"
                    disabled={!props.canEdit}
                    aria-label={`${item.name} 7-day bulk minimum`}
                    value={bulkMinVal}
                    onFocus={(event) =>
                      props.onFocusCell(
                        bulkMinKey,
                        supplyDraft.bulkMin7dQuantity,
                        event.currentTarget,
                      )
                    }
                    onBlur={() => props.onBlurCell(bulkMinKey)}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      props.onUpdateSupplyField?.(
                        item,
                        currency,
                        bulkMinKey,
                        raw,
                        { bulkMin7dQuantity: raw },
                      );
                    }}
                  />
                </span>
              </label>

              <label
                data-cell-key={bulkQtyKey}
                className={`costs-pop-field${bulkQtyPeers?.length ? " has-peer-focus" : ""}`}
                style={peerCellStyle(bulkQtyPeers)}
              >
                <CellPeerOutline peers={bulkQtyPeers} />
                <span className="costs-pop-field-label">
                  Bulk qty ({supplyDraft.packUnit})
                </span>
                <span className="costs-pop-input-wrap">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    placeholder="—"
                    disabled={!props.canEdit}
                    aria-label={`${item.name} bulk pack quantity`}
                    value={bulkQtyVal}
                    onFocus={(event) =>
                      props.onFocusCell(
                        bulkQtyKey,
                        supplyDraft.bulkPackQuantity,
                        event.currentTarget,
                      )
                    }
                    onBlur={() => props.onBlurCell(bulkQtyKey)}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      props.onUpdateSupplyField?.(
                        item,
                        currency,
                        bulkQtyKey,
                        raw,
                        { bulkPackQuantity: raw },
                      );
                    }}
                  />
                </span>
              </label>

              <label
                data-cell-key={bulkPriceKey}
                className={`costs-pop-field${bulkPricePeers?.length ? " has-peer-focus" : ""}`}
                style={peerCellStyle(bulkPricePeers)}
              >
                <CellPeerOutline peers={bulkPricePeers} />
                <span className="costs-pop-field-label">
                  Bulk price ({currencySymbol})
                </span>
                <span className="costs-pop-input-wrap">
                  <span className="costs-pop-suffix">{currencySymbol}</span>
                  <input
                    type="number"
                    min={0}
                    step={currencyDigits(currency) === 0 ? 10 : "any"}
                    placeholder="—"
                    disabled={!props.canEdit}
                    aria-label={`${item.name} bulk pack price`}
                    value={bulkPriceVal}
                    onFocus={(event) =>
                      props.onFocusCell(
                        bulkPriceKey,
                        supplyDraft.bulkPackPriceMajor,
                        event.currentTarget,
                      )
                    }
                    onBlur={() => props.onBlurCell(bulkPriceKey)}
                    onChange={(event) => {
                      const raw = event.currentTarget.value;
                      props.onUpdateSupplyField?.(
                        item,
                        currency,
                        bulkPriceKey,
                        raw,
                        { bulkPackPriceMajor: raw },
                      );
                    }}
                  />
                </span>
              </label>
            </div>
          </div>
        ) : null}

        {usage !== null && usage.skuImpacts.length > 0 ? (
          <div className="costs-bom-section">
            <div className="costs-bom-list-header">
              <span>
                Downstream SKU impact ({usage.usedInProductCount}{" "}
                {usage.usedInProductCount === 1 ? "recipe" : "recipes"})
              </span>
              <span>
                +10% price →{" "}
                {formatSignedMoneyRounded(
                  Math.round(usage.tenPctHikeWeeklyImpactMinor),
                  currency,
                )}
                /wk
              </span>
            </div>

            {usage.weeklyLotVarianceImpactMinor !== null &&
            Math.abs(usage.weeklyLotVarianceImpactMinor) >= 1 ? (
              <div
                className={`costs-supply-variance-callout ${
                  usage.weeklyLotVarianceImpactMinor < 0 ? "is-neg" : "is-pos"
                }`}
              >
                Lot invoice variance (
                {usage.lotCostVariancePct !== null
                  ? `${usage.lotCostVariancePct > 0 ? "+" : ""}${usage.lotCostVariancePct.toFixed(1)}%`
                  : "active"}
                ) shifts 7d profit by{" "}
                <strong>
                  {formatSignedMoneyRounded(
                    Math.round(usage.weeklyLotVarianceImpactMinor),
                    currency,
                  )}
                  /wk
                </strong>
              </div>
            ) : null}

            <div className="costs-bom-rows">
              {usage.skuImpacts.slice(0, 8).map((impact) => {
                const hasLotDelta =
                  impact.lotMarginDeltaPct !== null &&
                  Math.abs(impact.lotMarginDeltaPct) >= 0.05;
                return (
                  <button
                    key={impact.productId}
                    type="button"
                    className="costs-supply-sku-row"
                    onClick={() => props.onSelectProduct?.(impact.productId)}
                  >
                    <div className="costs-bom-ing-meta">
                      <span className="costs-bom-ing-name">
                        {impact.productTitle}
                      </span>
                      <span className="costs-bom-ing-sub">
                        {formatCostQuantity(
                          Math.round(impact.quantityPerUnit * 100) / 100,
                          impact.unit,
                        )}
                        /pc ·{" "}
                        {formatMoneyMinor(
                          Math.round(impact.unitCostMinor),
                          currency,
                        )}{" "}
                        BOM share
                      </span>
                    </div>
                    <div className="costs-supply-sku-right">
                      <span className="costs-supply-sku-margin">
                        {impact.currentMarginPct.toFixed(1)}% margin
                      </span>
                      {hasLotDelta && impact.lotMarginDeltaPct !== null ? (
                        <span
                          className={`costs-lot-variance-pill ${
                            impact.lotMarginDeltaPct < 0
                              ? "is-higher"
                              : "is-lower"
                          }`}
                        >
                          Lot {impact.lotMarginDeltaPct > 0 ? "+" : ""}
                          {impact.lotMarginDeltaPct.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="costs-supply-sku-hike">
                          +10% → {impact.tenPctHikeMarginDeltaPct.toFixed(1)}%
                        </span>
                      )}
                    </div>
                    <ArrowUpRight
                      size={12}
                      className="costs-supply-sku-arrow"
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
            {usage.skuImpacts.length > 8 ? (
              <span className="costs-supply-sku-more">
                + {usage.skuImpacts.length - 8} more menu items use {item.name}
              </span>
            ) : null}
          </div>
        ) : null}

        {lots.length > 0 ? (
          <div className="costs-bom-section">
            <div className="costs-bom-list-header">
              <span>Received lots &amp; purchase invoices</span>
              <span>
                <Receipt size={12} aria-hidden="true" /> Invoice total (
                {currencySymbol})
              </span>
            </div>

            <div className="costs-bom-rows">
              {lots.map((lot) => {
                const draft =
                  projected.lotEdits[lot.id] ?? lotDraftFromLot(lot, currency);
                const refKey = lotInvoiceFieldCellKey(
                  lot.id,
                  "invoiceReference",
                );
                const totalKey = lotInvoiceFieldCellKey(
                  lot.id,
                  "invoiceTotalMajor",
                );
                const refPeers = props.presence.peersByCell.get(refKey);
                const totalPeers = props.presence.peersByCell.get(totalKey);
                const isDirty = props.dirtyLots.has(lot.id);

                const refVal =
                  props.focusedCell?.cellKey === refKey
                    ? props.focusedCell.raw
                    : draft.invoiceReference;
                const totalVal =
                  props.focusedCell?.cellKey === totalKey
                    ? props.focusedCell.raw
                    : draft.invoiceTotalMajor;

                const invoicedBase = convertCostQuantity(
                  lot.invoiceCost?.invoicedQuantity ?? lot.receivedQuantity,
                  lot.invoiceCost?.invoicedUnit ?? lot.baseUnit,
                  lot.baseUnit,
                );
                const totalMinor =
                  draft.invoiceTotalMajor.trim().length > 0 &&
                  Number.isFinite(Number(draft.invoiceTotalMajor))
                    ? Math.round(
                        Number(draft.invoiceTotalMajor) *
                          10 ** currencyDigits(currency),
                      )
                    : null;
                const eqPackMinor =
                  totalMinor !== null &&
                  invoicedBase !== null &&
                  invoicedBase > 0 &&
                  packQuantityBase !== null &&
                  packQuantityBase > 0
                    ? (totalMinor / invoicedBase) * packQuantityBase
                    : null;

                const sourceBadge =
                  lot.invoiceCost?.source === "supplier_payable"
                    ? "Payable"
                    : lot.invoiceCost?.source === "lot_invoice" || isDirty
                      ? "Invoice"
                      : "Unpriced";

                return (
                  <div key={lot.id} className="costs-lot-drawer-card">
                    <div className="costs-lot-drawer-top">
                      <div>
                        <span className="costs-bom-ing-name">
                          {lot.lotCode}
                        </span>
                        <span className="costs-bom-ing-sub">
                          {lot.receivedAt.slice(0, 10)} ·{" "}
                          {formatCostQuantity(
                            lot.remainingQuantity,
                            lot.baseUnit,
                          )}{" "}
                          of{" "}
                          {formatCostQuantity(
                            lot.receivedQuantity,
                            lot.baseUnit,
                          )}{" "}
                          left ({lot.lifecycle})
                        </span>
                      </div>
                      <span className="costs-bom-qty-pill">
                        {sourceBadge}
                        {eqPackMinor !== null
                          ? ` · ${formatMoneyMinor(Math.round(eqPackMinor), currency)}/pack`
                          : ""}
                      </span>
                    </div>

                    <div className="costs-lot-drawer-inputs">
                      <label
                        data-cell-key={refKey}
                        className={`costs-pop-field${refPeers?.length ? " has-peer-focus" : ""}`}
                        style={peerCellStyle(refPeers)}
                      >
                        <CellPeerOutline peers={refPeers} />
                        <span className="costs-pop-field-label">
                          Invoice reference
                        </span>
                        <span className="costs-pop-input-wrap">
                          <input
                            type="text"
                            placeholder={
                              lot.purchaseRequestId ??
                              lot.receiptId ??
                              "INV-2026-..."
                            }
                            disabled={!props.canEdit}
                            aria-label={`${lot.lotCode} invoice reference`}
                            value={refVal}
                            onFocus={(event) =>
                              props.onFocusCell(
                                refKey,
                                draft.invoiceReference,
                                event.currentTarget,
                              )
                            }
                            onBlur={() => props.onBlurCell(refKey)}
                            onChange={(event) => {
                              const raw = event.currentTarget.value;
                              props.onUpdateLotField(lot, refKey, raw, {
                                invoiceReference: raw,
                              });
                            }}
                          />
                        </span>
                      </label>

                      <label
                        data-cell-key={totalKey}
                        className={`costs-pop-field${totalPeers?.length ? " has-peer-focus" : ""}`}
                        style={peerCellStyle(totalPeers)}
                      >
                        <CellPeerOutline peers={totalPeers} />
                        <span className="costs-pop-field-label">
                          Invoice total (
                          {formatCostQuantity(
                            lot.receivedQuantity,
                            lot.baseUnit,
                          )}
                          )
                        </span>
                        <span className="costs-pop-input-wrap">
                          <span className="costs-pop-suffix">
                            {currencySymbol}
                          </span>
                          <input
                            type="number"
                            min={0}
                            step="any"
                            placeholder="0"
                            disabled={!props.canEdit}
                            aria-label={`${lot.lotCode} invoice total`}
                            value={totalVal}
                            onFocus={(event) =>
                              props.onFocusCell(
                                totalKey,
                                draft.invoiceTotalMajor,
                                event.currentTarget,
                              )
                            }
                            onBlur={() => props.onBlurCell(totalKey)}
                            onChange={(event) => {
                              const raw = event.currentTarget.value;
                              props.onUpdateLotField(lot, totalKey, raw, {
                                invoiceTotalMajor: raw,
                              });
                            }}
                          />
                        </span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="costs-bom-empty">
            <p>No inventory lots have been received for this item yet.</p>
          </div>
        )}
      </div>
    </SideDrawer>
  );
}
