import React from "react";
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import type {
  CalculatedProductMargin,
  CalculatedRecipeCost,
  ProductPlanVsActualRow,
} from "@purin-labs/kitchen-control-api";
import {
  formatMoneyMinor,
  formatSignedMoneyRounded as formatSignedMinor,
} from "../../formatting";
import { SideDrawer } from "../../ui";
import { formatCostQuantity } from "./api";
import { ProductOrb } from "./costs-ui";

export function CostsBomDrawer(
  props: Readonly<{
    open: boolean;
    product: CalculatedProductMargin | null;
    recipe: CalculatedRecipeCost | null;
    actualsRow?: ProductPlanVsActualRow | null;
    recipesHref: string;
    onClose: () => void;
    onInspectSupply?: (inventoryItemId: string) => void;
  }>,
): React.ReactNode {
  const { product, recipe, actualsRow = null } = props;
  if (product === null) {
    return (
      <SideDrawer
        open={false}
        close={props.onClose}
        title=""
        className="costs-bom-side-drawer"
      />
    );
  }

  const currency = product.currency;
  const gross = Math.max(1, product.grossPriceMinor);

  const ingrMinor = Math.max(0, Math.round(product.ingredientUnitCostMinor));
  const packMinor = Math.max(0, Math.round(product.packagingUnitCostMinor));
  const wasteMinor = Math.max(0, Math.round(product.wasteAndSurplusUnitMinor));
  const taxFeeMinor = Math.max(
    0,
    Math.round(product.includedTaxMinor + product.channelFeeMinor),
  );
  const netMinor = Math.round(product.netContributionUnitMinor);
  const positiveNet = Math.max(0, netMinor);

  const totalBar = Math.max(
    1,
    ingrMinor + packMinor + wasteMinor + taxFeeMinor + positiveNet,
  );
  const pct = (part: number) => `${((part / totalBar) * 100).toFixed(1)}%`;

  const subtitle =
    recipe !== null
      ? `Batch yield: ${recipe.batchYield} pcs · ${product.batchesPerDay} runs/day (${Math.round(product.producedUnits)} baked)`
      : product.fulfillmentKind === "stocked"
        ? `Batch yield: ${product.batchYield} pcs · no linked recipe`
        : "Prepared to order · no linked recipe";

  return (
    <SideDrawer
      open={props.open}
      close={props.onClose}
      className="costs-bom-side-drawer"
      title={
        <span className="costs-bom-head-lead">
          <ProductOrb
            title={product.productTitle}
            imageUrl={product.imageUrl}
          />
          <span className="costs-bom-head-text">
            <span className="costs-bom-title">{product.productTitle}</span>
            <span className="costs-bom-sub">{subtitle}</span>
          </span>
        </span>
      }
      footer={
        <Link to={props.recipesHref} className="costs-bom-link">
          <span>
            {recipe !== null
              ? "Edit recipe weights in Recipes"
              : "Link recipe in Recipes"}
          </span>
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      }
    >
      <div className="side-drawer-body costs-bom-drawer-body">
        <div className="costs-bom-stack-card">
          <div className="costs-bom-stack-top">
            <span className="costs-bom-price-label">
              Unit price {formatMoneyMinor(gross, currency)}
            </span>
            <span
              className={`costs-bom-net-label ${netMinor >= 0 ? "is-pos" : "is-neg"}`}
            >
              {formatSignedMinor(netMinor, currency)} net ·{" "}
              {product.netMarginPct.toFixed(1)}%
            </span>
          </div>

          <div className="costs-bom-bar" aria-hidden="true">
            <span
              style={{ width: pct(ingrMinor), background: "#18181b" }}
              title="Ingredients"
            />
            <span
              style={{ width: pct(packMinor), background: "#71717a" }}
              title="Packaging"
            />
            <span
              style={{ width: pct(wasteMinor), background: "#f59e0b" }}
              title="Spoilage & surplus"
            />
            <span
              style={{ width: pct(taxFeeMinor), background: "#a1a1aa" }}
              title="Tax & card fee"
            />
            {positiveNet > 0 && (
              <span
                style={{ width: pct(positiveNet), background: "#10b981" }}
                title="Net contribution"
              />
            )}
          </div>

          <div className="costs-bom-legend">
            <div className="costs-bom-legend-item">
              <span>
                <i style={{ background: "#18181b" }} />
                Ingredients
              </span>
              <strong>{formatMoneyMinor(ingrMinor, currency)}</strong>
            </div>
            <div className="costs-bom-legend-item">
              <span>
                <i style={{ background: "#71717a" }} />
                Packaging
              </span>
              <strong>{formatMoneyMinor(packMinor, currency)}</strong>
            </div>
            <div className="costs-bom-legend-item">
              <span>
                <i style={{ background: "#f59e0b" }} />
                Spoilage
              </span>
              <strong>{formatMoneyMinor(wasteMinor, currency)}</strong>
            </div>
            <div className="costs-bom-legend-item">
              <span>
                <i style={{ background: "#a1a1aa" }} />
                Tax &amp; fee
              </span>
              <strong>{formatMoneyMinor(taxFeeMinor, currency)}</strong>
            </div>
          </div>
        </div>

        {(() => {
          const bomLines = actualsRow?.bomLines ?? product.bomLines;
          if (bomLines.length === 0) {
            return (
              <div className="costs-bom-empty">
                <p>No recipe or direct packaging is linked to this item yet.</p>
              </div>
            );
          }
          const isBatch =
            product.fulfillmentKind === "stocked" && product.batchYield > 1;
          const totalMinor =
            actualsRow !== null
              ? Math.round(
                  isBatch
                    ? actualsRow.actualUnitCogsMinor * product.batchYield
                    : actualsRow.actualUnitCogsMinor,
                )
              : Math.round(
                  isBatch
                    ? product.bomUnitCostMinor * product.batchYield
                    : product.bomUnitCostMinor,
                );
          return (
            <div className="costs-bom-section">
              <div className="costs-bom-list-header">
                <span>
                  {actualsRow !== null
                    ? isBatch
                      ? `Realized BOM (${product.batchYield} pcs)`
                      : "Realized unit BOM"
                    : isBatch
                      ? `Batch BOM (${product.batchYield} pcs)`
                      : "Unit BOM"}
                </span>
                <span>
                  {isBatch ? "Batch " : "Unit "}
                  {formatMoneyMinor(totalMinor, currency)}
                </span>
              </div>

              <div className="costs-bom-rows">
                {bomLines.map((line) => {
                  const sourceLabel = !line.hasCostTerms
                    ? "Missing pack price"
                    : line.costSource === "fifo_lot"
                      ? "FIFO lot invoice"
                      : line.costSource === "weighted_lot"
                        ? "Weighted lot avg"
                        : line.bulkUnlocked
                          ? "Bulk tier applied"
                          : "Standard pack tier";
                  const varianceText =
                    line.lotCostVariancePct !== null &&
                    Math.abs(line.lotCostVariancePct) >= 0.5
                      ? ` · ${line.lotCostVariancePct > 0 ? "+" : ""}${line.lotCostVariancePct.toFixed(1)}% vs pack`
                      : "";
                  return (
                    <button
                      key={`${line.source}:${line.inventoryItemId}`}
                      type="button"
                      className="costs-bom-row costs-bom-row-btn"
                      onClick={() =>
                        props.onInspectSupply?.(line.inventoryItemId)
                      }
                      title={`Inspect ${line.name} wholesale pack & lots`}
                    >
                      <div className="costs-bom-ing-meta">
                        <span className="costs-bom-ing-name">{line.name}</span>
                        <span className="costs-bom-ing-sub">
                          {line.source === "direct_packaging"
                            ? `Packaging · ${sourceLabel}${varianceText}`
                            : `${sourceLabel}${varianceText}`}
                        </span>
                      </div>
                      <span className="costs-bom-qty-pill">
                        {formatCostQuantity(
                          isBatch
                            ? line.quantityPerBatch
                            : line.quantityPerUnit,
                          line.unit,
                        )}
                      </span>
                      <span
                        className={`costs-bom-cost ${line.hasCostTerms ? "" : "is-missing"}`}
                      >
                        {line.hasCostTerms
                          ? formatMoneyMinor(
                              Math.round(
                                isBatch
                                  ? line.costPerBatchMinor
                                  : line.costPerUnitMinor,
                              ),
                              currency,
                            )
                          : "Unpriced"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
    </SideDrawer>
  );
}
