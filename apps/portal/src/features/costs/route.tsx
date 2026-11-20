import React from "react";
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  LineChart,
  Package,
  PanelRight,
  Search,
  TrendingUp,
  Zap,
} from "lucide-react";
import { Link } from "react-router";
import {
  calculateBakery12WeekForecast,
  calculateBakeryCostsAndMargins,
  calculateBakeryPlanVsActuals,
  isFormulaExpression,
  parseCostsOverview,
  type ActualsWindowDays,
  type CalculatedProductMargin,
  type CostFormulaColumn,
  type CostsOverview,
  type PlanVsActualVarianceDriver,
  type SupplyCostItem,
  type SupplyLotCost,
} from "@purin-labs/kitchen-control-api";
import {
  FORECAST_CAPEX_MINOR_CELL_KEY,
  FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
  FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
  FORECAST_OPENING_CASH_CELL_KEY,
  OVERHEAD_LABOR_CELL_KEY,
  OVERHEAD_RENT_CELL_KEY,
  forecastWeekIndexCellKey,
  productDayCellKey,
  productFormulaCellKey,
  type CostsSheetCellChange,
  type CostsSheetTab,
} from "@purin-labs/costs-sheet-crdt";
import { controlRead, forgetControlReads } from "../../control-client";
import { formatMoneyMinor } from "../../formatting";
import { PageSkeleton, RecoverableError } from "../../page-components";
import { CrmTable, Select, type CrmColumn, type CrmRowAction } from "../../ui";
import { costsError, costsPath, type CostsMutation } from "./api";
import {
  CostsActualsKpiStrip,
  CostsActualsSheet,
  CostsMarginBridgeBar,
} from "./costs-actuals-sheet";
import {
  CostsForecastControlsBar,
  CostsForecastKpiStrip,
  CostsForecastSheet,
  CostsForecastTrajectoryChart,
} from "./costs-forecast-sheet";
import { CostsBomDrawer } from "./costs-bom-drawer";
import { CostsLotsDrawer, applyPreviewLotEdits } from "./costs-lots-drawer";
import { CostsSuppliesSheet } from "./costs-supplies-sheet";
import {
  CostsFormulaBar,
  commitEditableProductCell,
  formattedCellDisplayValue,
  isColumnOverridden,
  parseProductColumnFromCellKey,
  rawCellEditSeed,
  selectionKeyForProductColumn,
  type CostFormulaBarColumn,
} from "./costs-formula-bar";
import {
  applyPreviewSupplyEdits,
  buildSheetWritePayload,
  handleCellBoxMouseDown,
  handleSheetKeyDown,
  inspectDirtyCells,
  type DirtyInspection,
} from "./costs-sheet-grid";
import { CostsPageViewSource } from "./costs-page-view";
import { costsViewCommandState } from "./costs-view-commands";
import type { CostsViewCommand } from "@purin-labs/control-api";
import type { SurfaceCommandOutcome } from "../surface-observation";
import {
  CostsSheetClient,
  INITIAL_COSTS_SHEET_VIEW,
  type CostsSheetView,
} from "./costs-sheet-client";
import {
  changesForAssumptions,
  changesForForecastCapexMinor,
  changesForForecastDemandCurve,
  changesForForecastExtraShiftThresholdPct,
  changesForForecastExtraShiftWeeklyMinor,
  changesForForecastOpeningCashMinor,
  changesForForecastSupplierTerms,
  changesForForecastWeekDemandPct,
  changesForLaborMinor,
  changesForLotInvoicePatch,
  changesForMultiplierPreset,
  changesForRentMinor,
  changesForSupplyPatch,
  changesForWeekDayUnits,
  currencyDigits,
  minorToMajorString,
  projectCostsSheetDraft,
  type LotInvoiceRowDraft,
  type PresetId,
  type ProjectedCostsSheet,
  type SupplyRowDraft,
} from "./costs-sheet-draft";
import {
  CellPeerOutline,
  CostsMousePointerLayer,
  CostsPresenceBar,
  CostsTabPresenceDots,
  buildPresenceIndex,
  peerCellStyle,
  type PresenceIndex,
} from "./costs-sheet-presence";
import { CostsAssumptionsPopover, CostsKpiStrip, ProductOrb } from "./costs-ui";
import "./styles.css";
import type { Variant } from "@purin-labs/type-utils";

type Props = Readonly<{
  organisationId: string;
  canEdit: boolean;
  mutate: CostsMutation;
  recipesHref: string;
  productsHref: string;
  suppliesHref: string;
}>;

type FocusedCell = Readonly<{
  cellKey: string;
  raw: string;
  seed: string;
}>;

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      overview: CostsOverview;
      sheetView: CostsSheetView;
      focusedCell: FocusedCell | null;
      tab: CostsSheetTab;
      sectionFilter: string;
      search: string;
      selectedProductId: string | null;
      selectedSupplyItemId?: string | null;
      actualsWindowDays?: ActualsWindowDays;
      activeFormulaColumn: CostFormulaBarColumn;
      bomOpen: boolean;
      lotsOpen?: boolean;
      assumptionsOpen: boolean;
      saving: boolean;
      pendingSaveKey: string | null;
      notice: string;
      noticeIsError: boolean;
    };

const WEEKDAY_LABELS: readonly string[] = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
];

const PRESET_LABELS: Readonly<Record<PresetId, string>> = {
  saved: "Saved plan",
  weekend: "Weekend ×1.5",
  rainy: "Rainy ×0.7",
  custom: "Custom plan",
};

const SCENARIO_SELECT_ITEMS: readonly Readonly<{
  value: PresetId;
  label: string;
}>[] = [
  { value: "saved", label: PRESET_LABELS.saved },
  { value: "weekend", label: PRESET_LABELS.weekend },
  { value: "rainy", label: PRESET_LABELS.rainy },
  { value: "custom", label: PRESET_LABELS.custom },
];

export class CostsPage extends React.Component<Props, State> {
  state: State = { kind: "loading" };
  private mounted = false;
  private readonly surfaceRef = React.createRef<HTMLDivElement>();
  private sheetClient: CostsSheetClient | null = null;
  private initialSyncSeen = false;
  private lastObservedSavedAt: string | null = null;
  private readonly pageView = new CostsPageViewSource(this);

  componentDidMount(): void {
    this.mounted = true;
    this.pageView.register();
    void this.load();
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.organisationId !== this.props.organisationId) {
      this.disposeSheetClient();
      this.setState({ kind: "loading" });
      void this.load();
      return;
    }
    this.ensureSheetClient();
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.pageView.unregister();
    this.disposeSheetClient();
  }

  private ensureSheetClient(): void {
    if (!this.mounted || this.state.kind !== "ready") return;
    if (this.sheetClient !== null) return;
    const surface = this.surfaceRef.current;
    if (surface === null) return;
    this.initialSyncSeen = false;
    this.lastObservedSavedAt = null;
    this.sheetClient = new CostsSheetClient(
      this.props.organisationId,
      this.state.tab,
      surface,
      this.handleSheetView,
    );
  }

  private disposeSheetClient(): void {
    this.sheetClient?.dispose();
    this.sheetClient = null;
    this.initialSyncSeen = false;
    this.lastObservedSavedAt = null;
  }

  private readonly handleSheetView = (sheetView: CostsSheetView): void => {
    if (!this.mounted) return;
    let shouldReloadBaseline = false;
    if (!this.initialSyncSeen) {
      if (sheetView.kind === "syncing" || sheetView.kind === "synced") {
        this.initialSyncSeen = true;
        this.lastObservedSavedAt = sheetView.savedAt;
      }
    } else if (
      sheetView.savedAt !== null &&
      sheetView.savedAt !== this.lastObservedSavedAt
    ) {
      this.lastObservedSavedAt = sheetView.savedAt;
      shouldReloadBaseline = this.state.kind === "ready" && !this.state.saving;
    }

    if (this.state.kind === "ready") {
      this.setState({
        ...this.state,
        sheetView,
        pendingSaveKey: null,
      });
    }
    if (shouldReloadBaseline && this.state.kind === "ready") {
      forgetControlReads();
      void this.load(this.state.notice);
    }
  };

  private async load(preserveNotice = ""): Promise<void> {
    if (this.state.kind !== "ready") {
      this.setState({ kind: "loading" });
    }
    try {
      const path = costsPath(this.props.organisationId);
      const overview = parseCostsOverview(await controlRead(path));
      if (!this.mounted) return;
      const prev = this.state.kind === "ready" ? this.state : null;
      this.setState({
        kind: "ready",
        overview,
        sheetView: prev?.sheetView ?? INITIAL_COSTS_SHEET_VIEW,
        focusedCell: prev?.focusedCell ?? null,
        tab: prev?.tab ?? "margins",
        sectionFilter: prev?.sectionFilter ?? "all",
        search: prev?.search ?? "",
        selectedProductId:
          prev?.selectedProductId ?? overview.products[0]?.productId ?? null,
        selectedSupplyItemId: prev?.selectedSupplyItemId ?? null,
        activeFormulaColumn: prev?.activeFormulaColumn ?? "margin",
        bomOpen: prev?.bomOpen ?? false,
        assumptionsOpen: prev?.assumptionsOpen ?? false,
        saving: false,
        pendingSaveKey: null,
        notice: preserveNotice,
        noticeIsError: false,
      });
    } catch (error) {
      if (this.mounted) {
        this.setState({ kind: "failed", message: costsError(error) });
      }
    }
  }

  private canEditSheet(state: Variant<State, "ready">): boolean {
    if (!this.props.canEdit) return false;
    if (
      state.sheetView.kind === "synced" ||
      state.sheetView.kind === "syncing"
    ) {
      return state.sheetView.access === "edit";
    }
    return true;
  }

  private applyCellChanges(changes: readonly CostsSheetCellChange[]): void {
    if (this.state.kind !== "ready" || changes.length === 0) return;
    if (this.sheetClient !== null) {
      this.sheetClient.setCells(changes);
      return;
    }
    this.setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const nextCells: Record<string, string> = { ...prev.sheetView.cells };
      for (const change of changes) {
        if (change.value === null) {
          delete nextCells[change.cellKey];
        } else {
          nextCells[change.cellKey] = change.value;
        }
      }
      return {
        ...prev,
        sheetView: { ...prev.sheetView, cells: nextCells },
        pendingSaveKey: null,
      };
    });
  }

  /** Runs an agent's view command as the person's own click does (Plan 87). */
  runViewCommand(command: CostsViewCommand): Promise<SurfaceCommandOutcome> {
    if (this.state.kind !== "ready")
      return Promise.resolve({
        kind: "rejected",
        message: "Costs & margins is still loading.",
      });
    const step = costsViewCommandState(this.state, command);
    if (step.kind === "rejected") return Promise.resolve(step);
    if (command.name === "open_tab")
      this.sheetClient?.select(command.tab, null);
    return new Promise(this.settleViewCommand.bind(this, step.state));
  }

  private settleViewCommand(
    next: State,
    resolve: (outcome: SurfaceCommandOutcome) => void,
  ): void {
    this.setState(next, resolve.bind(null, { kind: "done" }));
  }

  private selectTab(tab: CostsSheetTab): void {
    if (this.state.kind !== "ready") return;
    this.setState({
      ...this.state,
      tab,
      focusedCell: null,
    });
    this.sheetClient?.select(tab, null);
  }

  private inspectSupplyFromBom(inventoryItemId: string): void {
    this.setState((prev) => {
      if (prev.kind !== "ready") return prev;
      return {
        ...prev,
        tab: "supplies",
        search: "",
        selectedSupplyItemId: inventoryItemId,
        lotsOpen: true,
      };
    });
    this.sheetClient?.select("supplies", null);
  }

  private selectProductFromSupplyDrawer(productId: string): void {
    this.setState((prev) => {
      if (prev.kind !== "ready") return prev;
      const prod = prev.overview.products.find(
        (candidate) => candidate.productId === productId,
      );
      const nextFilter =
        prod !== undefined &&
        prev.sectionFilter !== "all" &&
        prev.sectionFilter !== prod.productType
          ? "all"
          : prev.sectionFilter;
      return {
        ...prev,
        tab: "margins",
        sectionFilter: nextFilter,
        search: "",
        selectedProductId: productId,
        activeFormulaColumn: "cogs",
        lotsOpen: false,
        bomOpen: true,
      };
    });
    this.sheetClient?.select(
      "margins",
      selectionKeyForProductColumn(productId, "cogs"),
    );
  }

  private focusCell(
    cellKey: string,
    raw: string,
    selectElement?: HTMLInputElement,
  ): void {
    if (this.state.kind !== "ready") return;
    if (selectElement !== undefined) {
      selectElement.select();
      requestAnimationFrame(() => {
        if (document.activeElement === selectElement) {
          selectElement.select();
        }
      });
    }
    const parsed = parseProductColumnFromCellKey(cellKey);
    this.setState((prev) =>
      prev.kind === "ready"
        ? {
            ...prev,
            focusedCell: { cellKey, raw, seed: raw },
            ...(parsed !== null
              ? {
                  selectedProductId: parsed.productId,
                  activeFormulaColumn: parsed.column,
                }
              : {}),
          }
        : prev,
    );
    this.sheetClient?.select(this.state.tab, cellKey);
  }

  private updateFocusedRaw(cellKey: string, raw: string): void {
    if (this.state.kind !== "ready") return;
    this.setState((prev) =>
      prev.kind === "ready" && prev.focusedCell?.cellKey === cellKey
        ? {
            ...prev,
            focusedCell: { ...prev.focusedCell, raw },
            pendingSaveKey: null,
          }
        : prev,
    );
  }

  private blurCell(cellKey: string, onCommit?: () => void): void {
    onCommit?.();
    this.setState((prev) =>
      prev.kind === "ready" && prev.focusedCell?.cellKey === cellKey
        ? { ...prev, focusedCell: null }
        : prev,
    );
    if (
      this.state.kind === "ready" &&
      this.state.focusedCell?.cellKey === cellKey
    ) {
      this.sheetClient?.select(this.state.tab, null);
    }
  }

  private resetSheet(): void {
    if (this.state.kind !== "ready") return;
    this.sheetClient?.clearAll();
    this.setState({
      ...this.state,
      focusedCell: null,
      pendingSaveKey: null,
      notice: "",
      noticeIsError: false,
    });
    this.sheetClient?.select(this.state.tab, null);
  }

  private applyMultiplierPreset(preset: "saved" | "weekend" | "rainy"): void {
    if (this.state.kind !== "ready" || !this.canEditSheet(this.state)) return;
    this.applyCellChanges(
      changesForMultiplierPreset(this.state.overview, preset),
    );
  }

  private handleProductCellChange(
    projected: ProjectedCostsSheet,
    allRows: readonly CalculatedProductMargin[],
    row: CalculatedProductMargin,
    rowIndex: number,
    column: CostFormulaColumn,
    raw: string,
  ): void {
    if (this.state.kind !== "ready") return;
    const cellKey = selectionKeyForProductColumn(row.productId, column);
    this.updateFocusedRaw(cellKey, raw);
    const trimmed = raw.trim();
    if (trimmed.length === 0 || isFormulaExpression(trimmed)) {
      return;
    }
    if (
      column === "units" ||
      column === "spoil" ||
      column === "price" ||
      column === "cogs" ||
      column === "waste"
    ) {
      const outcome = commitEditableProductCell({
        overview: this.state.overview,
        projected,
        row,
        rowNumber1Based: rowIndex + 1,
        allRows,
        column,
        raw,
      });
      if (outcome.ok && outcome.changes.length > 0) {
        this.applyCellChanges(outcome.changes);
      }
    }
  }

  private commitProductCell(
    projected: ProjectedCostsSheet,
    allRows: readonly CalculatedProductMargin[],
    row: CalculatedProductMargin,
    rowIndex: number,
    column: CostFormulaColumn,
    explicitRaw?: string,
  ): void {
    if (this.state.kind !== "ready") return;
    const cellKey = selectionKeyForProductColumn(row.productId, column);
    const fxBarKey = productFormulaCellKey(row.productId, column);
    const focused = this.state.focusedCell;
    const rawToCommit =
      explicitRaw !== undefined
        ? explicitRaw
        : focused !== null &&
            (focused.cellKey === cellKey || focused.cellKey === fxBarKey)
          ? focused.raw
          : null;
    if (rawToCommit === null) return;
    if (
      explicitRaw === undefined &&
      focused !== null &&
      focused.raw === focused.seed
    ) {
      return;
    }
    const outcome = commitEditableProductCell({
      overview: this.state.overview,
      projected,
      row,
      rowNumber1Based: rowIndex + 1,
      allRows,
      column,
      raw: rawToCommit,
    });
    if (!outcome.ok) {
      this.setState((prev) =>
        prev.kind === "ready"
          ? {
              ...prev,
              focusedCell: null,
              notice: outcome.error,
              noticeIsError: true,
            }
          : prev,
      );
      this.sheetClient?.select(this.state.tab, null);
      return;
    }
    this.setState((prev) =>
      prev.kind === "ready"
        ? {
            ...prev,
            focusedCell: null,
            pendingSaveKey: null,
            notice: "",
            noticeIsError: false,
          }
        : prev,
    );
    this.sheetClient?.select(this.state.tab, null);
    if (outcome.changes.length > 0) {
      this.applyCellChanges(outcome.changes);
    }
  }

  private updateWeekDayUnits(
    projected: ProjectedCostsSheet,
    productId: string,
    dayIndex: number,
    raw: string,
  ): void {
    if (this.state.kind !== "ready") return;
    const cellKey = productDayCellKey(productId, dayIndex);
    this.updateFocusedRaw(cellKey, raw);
    if (raw.trim().length === 0) return;
    const parsed = parseNonNegativeInteger(raw);
    this.applyCellChanges(
      changesForWeekDayUnits(
        this.state.overview,
        projected.weeklyTargets,
        productId,
        dayIndex,
        parsed,
      ),
    );
  }

  private updateSupplyField(
    item: SupplyCostItem,
    defaultCurrency: string,
    cellKey: string,
    raw: string,
    patch: Partial<SupplyRowDraft>,
  ): void {
    if (this.state.kind !== "ready") return;
    this.updateFocusedRaw(cellKey, raw);
    this.applyCellChanges(changesForSupplyPatch(item, defaultCurrency, patch));
  }

  private updateLotField(
    lot: SupplyLotCost,
    defaultCurrency: string,
    cellKey: string,
    raw: string,
    patch: Partial<LotInvoiceRowDraft>,
  ): void {
    if (this.state.kind !== "ready") return;
    this.updateFocusedRaw(cellKey, raw);
    this.applyCellChanges(
      changesForLotInvoicePatch(lot, defaultCurrency, patch),
    );
  }

  private async saveChanges(projected: ProjectedCostsSheet): Promise<void> {
    if (
      this.state.kind !== "ready" ||
      this.state.saving ||
      !this.canEditSheet(this.state)
    ) {
      return;
    }
    const built = buildSheetWritePayload(this.state.overview, projected);
    if (!built.ok) {
      this.setState({
        ...this.state,
        notice: built.error,
        noticeIsError: true,
      });
      return;
    }
    if (
      built.planWrite === null &&
      built.priceWrites.length === 0 &&
      built.supplyWrites.length === 0 &&
      built.lotWrites.length === 0
    ) {
      return;
    }

    const idempotencyKey = this.state.pendingSaveKey ?? crypto.randomUUID();
    this.setState({
      ...this.state,
      saving: true,
      pendingSaveKey: idempotencyKey,
      notice: "",
      noticeIsError: false,
    });

    try {
      const path = costsPath(this.props.organisationId);
      await this.props.mutate(
        path,
        {
          kind: "save_sheet",
          merchantRevision: this.state.overview.merchantRevision,
          requestedAt: new Date().toISOString(),
          planWrite: built.planWrite,
          priceWrites: built.priceWrites,
          supplyWrites: built.supplyWrites,
          ...(built.lotWrites.length > 0 ? { lotWrites: built.lotWrites } : {}),
        },
        { kind: "prepared", idempotencyKey },
      );
      const parts: string[] = [];
      if (built.priceWrites.length > 0) {
        parts.push(
          `${built.priceWrites.length} ${built.priceWrites.length === 1 ? "price" : "prices"}`,
        );
      }
      if (built.planWrite !== null) {
        parts.push("organisation cost plan");
      }
      if (built.supplyWrites.length > 0) {
        parts.push(
          `${built.supplyWrites.length} supplier ${built.supplyWrites.length === 1 ? "pack" : "packs"}`,
        );
      }
      if (built.lotWrites.length > 0) {
        parts.push(
          `${built.lotWrites.length} lot ${built.lotWrites.length === 1 ? "invoice" : "invoices"}`,
        );
      }
      forgetControlReads();
      await this.load(`Saved ${parts.join(", ")}.`);
    } catch (error) {
      if (this.mounted && this.state.kind === "ready") {
        this.setState({
          ...this.state,
          saving: false,
          notice: costsError(error),
          noticeIsError: true,
        });
      }
    }
  }

  render(): React.ReactNode {
    const state = this.state;
    if (state.kind === "loading") {
      return <PageSkeleton label="Loading costs and margins" />;
    }
    if (state.kind === "failed") {
      return (
        <RecoverableError
          message={state.message}
          action={
            <button type="button" onClick={() => void this.load()}>
              Try again
            </button>
          }
        />
      );
    }

    const canEdit = this.canEditSheet(state);
    const projected = projectCostsSheetDraft(
      state.overview,
      state.sheetView.cells,
    );
    const presence = buildPresenceIndex(
      state.sheetView.participants,
      state.sheetView.agents,
    );

    const effectiveOverview = applyPreviewLotEdits(
      applyPreviewSupplyEdits(state.overview, projected.supplyEdits),
      projected.lotEdits,
    );
    const spoilPctOverrides: Record<string, number> = {};
    for (const product of state.overview.products) {
      const spoilBps = projected.spoilBpsOverrides[product.productId];
      if (spoilBps !== undefined && spoilBps !== null) {
        spoilPctOverrides[product.productId] = spoilBps / 100;
      }
    }

    const calculation = calculateBakeryCostsAndMargins({
      overview: effectiveOverview,
      dailyTargets: projected.dailyTargets,
      weeklyTargets: projected.weeklyTargets,
      demandMode: state.tab === "weekly" ? "weekly" : "daily",
      productSpoilagePctOverrides: spoilPctOverrides,
      priceOverridesMinor: projected.priceOverridesMinor,
      cogsOverridesMinor: projected.cogsOverridesMinor,
      wasteOverridesMinor: projected.wasteOverridesMinor,
      productFormulas: projected.productFormulas,
      dailyLaborMinor: projected.dailyLaborMinor,
      dailyRentMinor: projected.dailyRentMinor,
      assumptions: projected.assumptions,
    });

    const actualsWindowDays: ActualsWindowDays = state.actualsWindowDays ?? 7;
    const actualsCalculation = calculateBakeryPlanVsActuals({
      overview: effectiveOverview,
      windowDays: actualsWindowDays,
      weeklyTargets: projected.weeklyTargets,
      productSpoilagePctOverrides: spoilPctOverrides,
      priceOverridesMinor: projected.priceOverridesMinor,
      cogsOverridesMinor: projected.cogsOverridesMinor,
      wasteOverridesMinor: projected.wasteOverridesMinor,
      productFormulas: projected.productFormulas,
      dailyLaborMinor: projected.dailyLaborMinor,
      dailyRentMinor: projected.dailyRentMinor,
      assumptions: projected.assumptions,
    });

    const forecastCalculation = calculateBakery12WeekForecast({
      overview: effectiveOverview,
      forecastPlan: projected.forecast,
      weeklyTargets: projected.weeklyTargets,
      productSpoilagePctOverrides: spoilPctOverrides,
      priceOverridesMinor: projected.priceOverridesMinor,
      cogsOverridesMinor: projected.cogsOverridesMinor,
      wasteOverridesMinor: projected.wasteOverridesMinor,
      productFormulas: projected.productFormulas,
      dailyLaborMinor: projected.dailyLaborMinor,
      dailyRentMinor: projected.dailyRentMinor,
      assumptions: projected.assumptions,
    });

    const dirtyInfo = inspectDirtyCells(state.overview, projected);
    const hasAnyDraftCell = hasNonMetaDraftCells(state.sheetView.cells);
    const currency = calculation.summary.currency;
    const digits = currencyDigits(currency);
    const currencySymbol = formatCurrencySymbol(currency);

    const sections = distinctProductTypes(state.overview);
    const searchLower = state.search.trim().toLowerCase();

    const filteredProducts = calculation.products.filter((row) => {
      if (
        state.sectionFilter !== "all" &&
        row.productType !== state.sectionFilter
      ) {
        return false;
      }
      if (searchLower.length === 0) return true;
      return (
        row.productTitle.toLowerCase().includes(searchLower) ||
        row.productType.toLowerCase().includes(searchLower) ||
        (row.recipeName?.toLowerCase().includes(searchLower) ?? false)
      );
    });

    const filteredActualsRows = actualsCalculation.products.filter((row) => {
      if (
        state.sectionFilter !== "all" &&
        row.productType !== state.sectionFilter
      ) {
        return false;
      }
      if (searchLower.length === 0) return true;
      return (
        row.productTitle.toLowerCase().includes(searchLower) ||
        row.productType.toLowerCase().includes(searchLower) ||
        row.primaryNote.toLowerCase().includes(searchLower)
      );
    });
    const leakCount = actualsCalculation.drivers.filter(
      (driver) => driver.profitImpactMinor < 0,
    ).length;

    const allSupplies = state.overview.items.filter(
      (item) => item.category !== "finished_good",
    );
    const filteredSupplies = allSupplies.filter((item) => {
      if (searchLower.length === 0) return true;
      return (
        item.name.toLowerCase().includes(searchLower) ||
        item.merchantCode.toLowerCase().includes(searchLower) ||
        item.category.toLowerCase().includes(searchLower)
      );
    });

    const selectedProduct =
      filteredProducts.find(
        (row) => row.productId === state.selectedProductId,
      ) ??
      filteredProducts[0] ??
      calculation.products.find(
        (row) => row.productId === state.selectedProductId,
      ) ??
      null;
    const selectedRecipe =
      selectedProduct?.recipeId != null
        ? (calculation.recipes.find(
            (recipe) => recipe.recipeId === selectedProduct.recipeId,
          ) ?? null)
        : null;
    const selectedActualsRow =
      state.tab === "actuals" && selectedProduct !== null
        ? (actualsCalculation.products.find(
            (row) => row.productId === selectedProduct.productId,
          ) ?? null)
        : null;

    const showDrawer =
      state.bomOpen &&
      selectedProduct !== null &&
      state.tab !== "supplies" &&
      state.tab !== "forecast";
    const selectedSupplyItem =
      allSupplies.find((item) => item.id === state.selectedSupplyItemId) ??
      filteredSupplies[0] ??
      allSupplies[0] ??
      null;
    const selectedSupplyUsage =
      selectedSupplyItem !== null
        ? (calculation.supplies.find(
            (usage) => usage.inventoryItemId === selectedSupplyItem.id,
          ) ?? null)
        : null;
    const selectedSupplyLots =
      selectedSupplyItem !== null
        ? (state.overview.lots ?? []).filter(
            (lot) => lot.inventoryItemId === selectedSupplyItem.id,
          )
        : [];
    const showLotsDrawer =
      state.lotsOpen === true &&
      selectedSupplyItem !== null &&
      state.tab === "supplies";
    this.pageView.snapshot = {
      state,
      projected,
      calculation,
      selectedProduct,
      unsaved: dirtyInfo.totalDirtyCount + dirtyInfo.whatIfPriceCount > 0,
      products: filteredProducts,
      actuals: actualsCalculation,
      actualsRows: filteredActualsRows,
      forecast: forecastCalculation,
      supplies: filteredSupplies,
    };

    const actualShelfText =
      state.overview.measuredWaste.measuredShelfWastePct !== null
        ? `${state.overview.measuredWaste.measuredShelfWastePct.toFixed(1)}% shelf`
        : "no 30d shelf loss";
    const actualRejectText =
      state.overview.measuredWaste.measuredBatchRejectPct !== null
        ? `${state.overview.measuredWaste.measuredBatchRejectPct.toFixed(1)}% reject`
        : "no 30d rejects";

    const laborFormatted = minorToMajorString(
      projected.dailyLaborMinor,
      digits,
    );
    const rentFormatted = minorToMajorString(projected.dailyRentMinor, digits);

    const headerActions = (
      <>
        {dirtyInfo.whatIfPriceCount > 0 && !state.overview.canEditPrices && (
          <span className="costs-whatif-pill">
            Price {currencySymbol} is what-if
          </span>
        )}
        <button
          type="button"
          className="costs-ghost-btn"
          disabled={
            !canEdit ||
            state.saving ||
            (!hasAnyDraftCell &&
              dirtyInfo.totalDirtyCount === 0 &&
              dirtyInfo.whatIfPriceCount === 0 &&
              projected.preset === "saved")
          }
          onClick={() => this.resetSheet()}
        >
          Reset
        </button>
        {canEdit && (
          <button
            type="button"
            className="costs-save-pill-btn"
            disabled={state.saving || dirtyInfo.saveableDirtyCount === 0}
            onClick={() => void this.saveChanges(projected)}
          >
            {state.saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </>
    );

    return (
      <div ref={this.surfaceRef} className="costs-sheet-page">
        <CostsMousePointerLayer
          participants={state.sheetView.participants}
          colorBySession={presence.colorBySession}
        />

        <div className="costs-workspace-split">
          <div className="costs-page-canvas">
            {state.notice.length > 0 && (
              <div
                className={`costs-notice-banner${state.noticeIsError ? " is-error" : ""}`}
                role="status"
              >
                <span>{state.notice}</span>
                <button
                  type="button"
                  className="costs-ghost-btn"
                  onClick={() =>
                    this.setState({
                      ...state,
                      notice: "",
                      noticeIsError: false,
                    })
                  }
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className="costs-tabs-header-bar">
              <div
                className="costs-underline-tabs"
                role="tablist"
                aria-label="Costs workbook tabs"
              >
                <button
                  type="button"
                  role="tab"
                  className="costs-underline-tab"
                  aria-selected={
                    state.tab === "margins" || state.tab === "weekly"
                  }
                  data-surface-target={
                    state.tab === "weekly" ? "tab:weekly" : "tab:margins"
                  }
                  onClick={() =>
                    this.selectTab(
                      state.tab === "weekly" ? "weekly" : "margins",
                    )
                  }
                >
                  <TrendingUp size={15} aria-hidden="true" />
                  <span>Menu</span>
                  <span className="costs-tab-count">
                    {state.overview.products.length}
                  </span>
                  <CostsTabPresenceDots
                    peers={[
                      ...presence.peersByTab.margins,
                      ...presence.peersByTab.weekly.filter(
                        (peer) =>
                          !presence.peersByTab.margins.some(
                            (m) => m.id === peer.id,
                          ),
                      ),
                    ]}
                  />
                </button>

                <button
                  type="button"
                  role="tab"
                  className="costs-underline-tab"
                  aria-selected={state.tab === "supplies"}
                  data-surface-target="tab:supplies"
                  onClick={() => this.selectTab("supplies")}
                >
                  <Package size={15} aria-hidden="true" />
                  <span>Supplies</span>
                  <span className="costs-tab-count">{allSupplies.length}</span>
                  <CostsTabPresenceDots peers={presence.peersByTab.supplies} />
                </button>

                <button
                  type="button"
                  role="tab"
                  className="costs-underline-tab"
                  aria-selected={state.tab === "actuals"}
                  data-surface-target="tab:actuals"
                  onClick={() => this.selectTab("actuals")}
                >
                  <Activity size={15} aria-hidden="true" />
                  <span>Actuals</span>
                  <span
                    className={`costs-tab-count${leakCount > 0 ? " is-alert" : ""}`}
                  >
                    {leakCount > 0
                      ? `${leakCount} leak${leakCount === 1 ? "" : "s"}`
                      : `${actualsWindowDays}d`}
                  </span>
                  <CostsTabPresenceDots peers={presence.peersByTab.actuals} />
                </button>

                <button
                  type="button"
                  role="tab"
                  className="costs-underline-tab"
                  aria-selected={state.tab === "forecast"}
                  data-surface-target="tab:forecast"
                  onClick={() => this.selectTab("forecast")}
                >
                  <LineChart size={15} aria-hidden="true" />
                  <span>12w Cash</span>
                  <span
                    className={`costs-tab-count${forecastCalculation.summary.hasCashShortfall ? " is-alert" : ""}`}
                  >
                    {forecastCalculation.summary.hasCashShortfall
                      ? "Shortfall"
                      : "12w"}
                  </span>
                  <CostsTabPresenceDots peers={presence.peersByTab.forecast} />
                </button>
              </div>

              <CostsPresenceBar
                view={state.sheetView}
                presence={presence}
                unsavedCount={dirtyInfo.totalDirtyCount}
                onJumpToTab={(sheet) => this.selectTab(sheet)}
                onRetry={() => this.sheetClient?.retry()}
                actions={headerActions}
              />
            </div>

            {state.tab === "actuals" ? (
              <CostsActualsKpiStrip actuals={actualsCalculation} />
            ) : state.tab === "forecast" ? (
              <CostsForecastKpiStrip forecast={forecastCalculation} />
            ) : (
              <CostsKpiStrip
                calculation={calculation}
                productCount={state.overview.products.length}
                currency={currency}
                currencySymbol={currencySymbol}
                dailyLaborMinor={projected.dailyLaborMinor}
                dailyRentMinor={projected.dailyRentMinor}
                laborFormatted={laborFormatted}
                rentFormatted={rentFormatted}
                laborDirty={dirtyInfo.laborDirty}
                rentDirty={dirtyInfo.rentDirty}
                canEdit={canEdit}
                focusedCell={state.focusedCell}
                presence={presence}
                onFocusCell={(key, raw, input) =>
                  this.focusCell(key, raw, input)
                }
                onBlurCell={(key) => this.blurCell(key)}
                onChangeLaborRaw={(raw) => {
                  this.updateFocusedRaw(OVERHEAD_LABOR_CELL_KEY, raw);
                  const cleaned = raw.replace(/,/gu, "").trim();
                  if (cleaned.length === 0) return;
                  const num = Number(cleaned);
                  if (!Number.isFinite(num) || num < 0) return;
                  const minor = Math.max(0, Math.round(num * 10 ** digits));
                  this.applyCellChanges(
                    changesForLaborMinor(state.overview, minor),
                  );
                }}
                onChangeRentRaw={(raw) => {
                  this.updateFocusedRaw(OVERHEAD_RENT_CELL_KEY, raw);
                  const cleaned = raw.replace(/,/gu, "").trim();
                  if (cleaned.length === 0) return;
                  const num = Number(cleaned);
                  if (!Number.isFinite(num) || num < 0) return;
                  const minor = Math.max(0, Math.round(num * 10 ** digits));
                  this.applyCellChanges(
                    changesForRentMinor(state.overview, minor),
                  );
                }}
              />
            )}

            {state.tab === "forecast" ? (
              <>
                <CostsForecastControlsBar
                  plan={projected.forecast}
                  currency={currency}
                  currencySymbol={currencySymbol}
                  digits={digits}
                  canEdit={canEdit}
                  focusedCell={state.focusedCell}
                  presence={presence}
                  onFocusCell={(key, raw, input) =>
                    this.focusCell(key, raw, input)
                  }
                  onBlurCell={(key) => this.blurCell(key)}
                  onSelectDemandCurve={(curve) =>
                    this.applyCellChanges(
                      changesForForecastDemandCurve(state.overview, curve),
                    )
                  }
                  onSelectSupplierTerms={(terms) =>
                    this.applyCellChanges(
                      changesForForecastSupplierTerms(state.overview, terms),
                    )
                  }
                  onChangeOpeningCashRaw={(raw) => {
                    this.updateFocusedRaw(FORECAST_OPENING_CASH_CELL_KEY, raw);
                    const cleaned = raw.replace(/,/gu, "").trim();
                    if (cleaned.length === 0) return;
                    const num = Number(cleaned);
                    if (!Number.isFinite(num) || num < 0) return;
                    const minor = Math.max(0, Math.round(num * 10 ** digits));
                    this.applyCellChanges(
                      changesForForecastOpeningCashMinor(state.overview, minor),
                    );
                  }}
                  onChangeExtraShiftThresholdRaw={(raw) => {
                    this.updateFocusedRaw(
                      FORECAST_EXTRA_SHIFT_THRESHOLD_PCT_CELL_KEY,
                      raw,
                    );
                    const cleaned = raw.trim();
                    if (cleaned.length === 0) return;
                    const num = Number(cleaned);
                    if (!Number.isFinite(num) || num < 101) return;
                    this.applyCellChanges(
                      changesForForecastExtraShiftThresholdPct(
                        state.overview,
                        Math.round(num),
                      ),
                    );
                  }}
                  onChangeExtraShiftWeeklyRaw={(raw) => {
                    this.updateFocusedRaw(
                      FORECAST_EXTRA_SHIFT_WEEKLY_MINOR_CELL_KEY,
                      raw,
                    );
                    const cleaned = raw.replace(/,/gu, "").trim();
                    if (cleaned.length === 0) return;
                    const num = Number(cleaned);
                    if (!Number.isFinite(num) || num < 0) return;
                    const minor = Math.max(0, Math.round(num * 10 ** digits));
                    this.applyCellChanges(
                      changesForForecastExtraShiftWeeklyMinor(
                        state.overview,
                        minor,
                      ),
                    );
                  }}
                  onChangeCapexRaw={(raw) => {
                    this.updateFocusedRaw(FORECAST_CAPEX_MINOR_CELL_KEY, raw);
                    const cleaned = raw.replace(/,/gu, "").trim();
                    if (cleaned.length === 0) return;
                    const num = Number(cleaned);
                    if (!Number.isFinite(num) || num < 0) return;
                    const minor = Math.max(0, Math.round(num * 10 ** digits));
                    this.applyCellChanges(
                      changesForForecastCapexMinor(state.overview, minor),
                    );
                  }}
                />
                <CostsForecastTrajectoryChart
                  forecast={forecastCalculation}
                  currencySymbol={currencySymbol}
                />
              </>
            ) : (
              <div className="costs-toolbar-row">
                {(state.tab === "margins" || state.tab === "weekly") && (
                  <div
                    className="costs-view-segmented"
                    role="group"
                    aria-label="Menu sheet view"
                  >
                    <button
                      type="button"
                      className="costs-view-seg-btn"
                      aria-pressed={state.tab === "margins"}
                      data-surface-target="tab:margins"
                      onClick={() => this.selectTab("margins")}
                    >
                      Margins
                    </button>
                    <button
                      type="button"
                      className="costs-view-seg-btn"
                      aria-pressed={state.tab === "weekly"}
                      data-surface-target="tab:weekly"
                      onClick={() => this.selectTab("weekly")}
                    >
                      7d
                    </button>
                  </div>
                )}

                <label className="costs-search-box">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder={
                      state.tab === "supplies"
                        ? "Search ingredients, codes, or packaging…"
                        : "Search menu items or SKUs…"
                    }
                    value={state.search}
                    onChange={(event) =>
                      this.setState({
                        ...state,
                        search: event.currentTarget.value,
                      })
                    }
                  />
                </label>

                {state.tab !== "supplies" && (
                  <Select.Root
                    name="categoryFilter"
                    items={[
                      {
                        value: "all",
                        label: `All categories (${state.overview.products.length})`,
                      },
                      ...sections.map((section) => ({
                        value: section,
                        label: formatSectionName(section),
                      })),
                    ]}
                    value={state.sectionFilter}
                    onValueChange={(next) => {
                      if (typeof next === "string" && next.length > 0) {
                        this.setState({ ...state, sectionFilter: next });
                      }
                    }}
                  >
                    <Select.Trigger
                      size="sm"
                      className="costs-scenario-select costs-category-select"
                      aria-label="Menu category filter"
                      data-surface-target={
                        state.sectionFilter === "all"
                          ? "category:all"
                          : `category:${state.sectionFilter}`
                      }
                    >
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup align="start" alignItemWithTrigger={false}>
                      <Select.Item value="all">
                        All categories ({state.overview.products.length})
                      </Select.Item>
                      {sections.map((section) => (
                        <Select.Item key={section} value={section}>
                          {formatSectionName(section)}
                        </Select.Item>
                      ))}
                    </Select.Popup>
                  </Select.Root>
                )}

                {(state.tab === "margins" || state.tab === "weekly") && (
                  <Select.Root
                    name="scenario"
                    items={SCENARIO_SELECT_ITEMS}
                    disabled={!canEdit}
                    value={projected.preset}
                    onValueChange={(next) => {
                      if (
                        next === "saved" ||
                        next === "weekend" ||
                        next === "rainy"
                      ) {
                        this.applyMultiplierPreset(next);
                      }
                    }}
                  >
                    <Select.Trigger
                      size="sm"
                      className="costs-scenario-select"
                      aria-label="Demand scenario"
                    >
                      <Zap
                        size={13.5}
                        className="costs-scenario-icon"
                        aria-hidden="true"
                      />
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup align="end" alignItemWithTrigger={false}>
                      {(["saved", "weekend", "rainy"] as const).map(
                        (preset) => (
                          <Select.Item key={preset} value={preset}>
                            {PRESET_LABELS[preset]}
                          </Select.Item>
                        ),
                      )}
                      {projected.preset === "custom" && (
                        <Select.Item value="custom" disabled>
                          {PRESET_LABELS.custom}
                        </Select.Item>
                      )}
                    </Select.Popup>
                  </Select.Root>
                )}

                {state.tab !== "actuals" && (
                  <CostsAssumptionsPopover
                    open={state.assumptionsOpen}
                    canEdit={canEdit}
                    assumptions={projected.assumptions}
                    focusedCell={state.focusedCell}
                    presence={presence}
                    actualShelfText={actualShelfText}
                    actualRejectText={actualRejectText}
                    onOpenChange={(assumptionsOpen) =>
                      this.setState({ ...state, assumptionsOpen })
                    }
                    onFocusCell={(key, raw) => this.focusCell(key, raw)}
                    onBlurCell={(key) => this.blurCell(key)}
                    onUpdateRaw={(key, raw) => this.updateFocusedRaw(key, raw)}
                    onCommitAssumptions={(next) =>
                      this.applyCellChanges(
                        changesForAssumptions(state.overview, next),
                      )
                    }
                  />
                )}

                {state.tab === "supplies" && selectedSupplyItem !== null && (
                  <button
                    type="button"
                    className="costs-control-btn"
                    aria-expanded={state.lotsOpen === true}
                    onClick={() =>
                      this.setState({
                        ...state,
                        lotsOpen: !(state.lotsOpen === true),
                      })
                    }
                  >
                    <PanelRight size={14} aria-hidden="true" />
                    <span>Lots &amp; contracts</span>
                  </button>
                )}
              </div>
            )}

            {state.tab === "actuals" && (
              <CostsMarginBridgeBar
                actuals={actualsCalculation}
                windowDays={actualsWindowDays}
                onChangeWindowDays={(nextWindow) =>
                  this.setState({ ...state, actualsWindowDays: nextWindow })
                }
                onSelectDriver={(driver) =>
                  this.handleVarianceDriverSelect(driver)
                }
              />
            )}

            <div className="costs-sheet-frame">
              {state.tab === "margins" &&
                selectedProduct !== null &&
                this.renderFormulaBarForProduct(
                  selectedProduct,
                  filteredProducts,
                  calculation,
                  projected,
                  canEdit,
                )}
              {state.tab === "margins" &&
                this.renderMarginsSheet(
                  filteredProducts,
                  calculation,
                  projected,
                  dirtyInfo,
                  presence,
                  canEdit,
                )}
              {state.tab === "weekly" &&
                this.renderWeeklySheet(
                  filteredProducts,
                  calculation,
                  projected,
                  dirtyInfo,
                  presence,
                  canEdit,
                )}
              {state.tab === "actuals" && (
                <CostsActualsSheet
                  actuals={actualsCalculation}
                  rows={filteredActualsRows}
                  selectedProductId={state.selectedProductId}
                  bomOpen={state.bomOpen}
                  presence={presence}
                  onSelectProduct={(productId) =>
                    this.setState({ ...state, selectedProductId: productId })
                  }
                  onOpenBomDrawer={(productId, open) =>
                    this.setState({
                      ...state,
                      selectedProductId: productId,
                      bomOpen: open,
                    })
                  }
                  onEditOnMarginsTab={(productId) => {
                    this.setState({
                      ...state,
                      tab: "margins",
                      selectedProductId: productId,
                    });
                    this.sheetClient?.select("margins", null);
                  }}
                  onFocusCell={(key, raw) => this.focusCell(key, raw)}
                  onBlurCell={(key) => this.blurCell(key)}
                />
              )}
              {state.tab === "forecast" && (
                <CostsForecastSheet
                  forecast={forecastCalculation}
                  canEdit={canEdit}
                  focusedCell={state.focusedCell}
                  presence={presence}
                  onFocusCell={(key, raw, input) =>
                    this.focusCell(key, raw, input)
                  }
                  onBlurCell={(key) => this.blurCell(key)}
                  onChangeWeekDemandPct={(weekIndex, raw) => {
                    const cellKey = forecastWeekIndexCellKey(weekIndex);
                    this.updateFocusedRaw(cellKey, raw);
                    const cleaned = raw.trim();
                    if (cleaned.length === 0) return;
                    const num = Number(cleaned);
                    if (!Number.isFinite(num) || num < 10) return;
                    this.applyCellChanges(
                      changesForForecastWeekDemandPct(
                        state.overview,
                        projected.forecast,
                        weekIndex,
                        Math.round(num),
                      ),
                    );
                  }}
                />
              )}
              {state.tab === "supplies" && (
                <CostsSuppliesSheet
                  items={filteredSupplies}
                  usages={calculation.supplies}
                  projected={projected}
                  dirtyInfo={dirtyInfo}
                  presence={presence}
                  focusedCell={state.focusedCell}
                  canEdit={canEdit}
                  currency={currency}
                  currencySymbol={currencySymbol}
                  digits={digits}
                  onFocusCell={(key, raw, input) =>
                    this.focusCell(key, raw, input)
                  }
                  onBlurCell={(key) => this.blurCell(key)}
                  onUpdateSupplyField={(item, cur, key, raw, patch) =>
                    this.updateSupplyField(item, cur, key, raw, patch)
                  }
                  onInspectSupplyLots={(itemId) =>
                    this.setState({
                      ...state,
                      selectedSupplyItemId: itemId,
                      lotsOpen: true,
                    })
                  }
                />
              )}
            </div>

            <div className="costs-bottom-bar">
              <nav
                className="costs-bottom-links"
                aria-label="Related kitchen pages"
              >
                <Link to={this.props.recipesHref}>
                  <span>Recipes</span>
                  <ArrowUpRight size={12} aria-hidden="true" />
                </Link>
                <Link to={this.props.productsHref}>
                  <span>Products</span>
                  <ArrowUpRight size={12} aria-hidden="true" />
                </Link>
                <Link to={this.props.suppliesHref}>
                  <span>Supplies</span>
                  <ArrowUpRight size={12} aria-hidden="true" />
                </Link>
              </nav>
            </div>
          </div>

          <CostsBomDrawer
            open={showDrawer}
            product={selectedProduct}
            recipe={selectedRecipe}
            actualsRow={selectedActualsRow}
            recipesHref={this.props.recipesHref}
            onClose={() => this.setState({ ...state, bomOpen: false })}
            onInspectSupply={(itemId) => this.inspectSupplyFromBom(itemId)}
          />

          <CostsLotsDrawer
            open={showLotsDrawer}
            item={selectedSupplyItem}
            usage={selectedSupplyUsage}
            lots={selectedSupplyLots}
            projected={projected}
            dirtyLots={dirtyInfo.dirtyLots}
            presence={presence}
            focusedCell={state.focusedCell}
            canEdit={canEdit}
            currency={currency}
            currencySymbol={currencySymbol}
            onClose={() => this.setState({ ...state, lotsOpen: false })}
            onFocusCell={(key, raw, input) => this.focusCell(key, raw, input)}
            onBlurCell={(key) => this.blurCell(key)}
            onUpdateLotField={(lot, cellKey, raw, patch) =>
              this.updateLotField(lot, currency, cellKey, raw, patch)
            }
            onUpdateSupplyField={(item, cur, cellKey, raw, patch) =>
              this.updateSupplyField(item, cur, cellKey, raw, patch)
            }
            onSelectProduct={(productId) =>
              this.selectProductFromSupplyDrawer(productId)
            }
          />
        </div>
      </div>
    );
  }

  private renderFormulaBarForProduct(
    selectedProduct: CalculatedProductMargin,
    filteredProducts: readonly CalculatedProductMargin[],
    calculation: ReturnType<typeof calculateBakeryCostsAndMargins>,
    projected: ProjectedCostsSheet,
    canEdit: boolean,
  ): React.ReactNode {
    const state = this.state;
    if (state.kind !== "ready") return null;
    const filteredIdx = filteredProducts.findIndex(
      (row) => row.productId === selectedProduct.productId,
    );
    const allIdx = calculation.products.findIndex(
      (row) => row.productId === selectedProduct.productId,
    );
    const rowIndex = filteredIdx >= 0 ? filteredIdx : Math.max(0, allIdx);
    const activeRows =
      filteredIdx >= 0 ? filteredProducts : calculation.products;
    const column = state.activeFormulaColumn;
    const cellKey = selectionKeyForProductColumn(
      selectedProduct.productId,
      column,
    );
    const fxBarKey =
      column === "taxFee"
        ? cellKey
        : productFormulaCellKey(selectedProduct.productId, column);
    const isEditing =
      column !== "taxFee" &&
      (state.focusedCell?.cellKey === fxBarKey ||
        (state.focusedCell?.cellKey === cellKey &&
          state.focusedCell.raw !== state.focusedCell.seed));
    const draftValue = isEditing ? (state.focusedCell?.raw ?? "") : "";
    const currency = calculation.summary.currency;
    const fmtMoney = (minor: number) =>
      formatMoneyMinor(Math.round(minor), currency);

    return (
      <CostsFormulaBar
        row={selectedProduct}
        rowNumber1Based={rowIndex + 1}
        allRows={activeRows}
        column={column}
        assumptions={projected.assumptions}
        draftValue={draftValue}
        isEditing={isEditing}
        canEdit={canEdit}
        formatMoney={fmtMoney}
        onFocusBar={(seed) => {
          this.setState((prev) =>
            prev.kind === "ready"
              ? {
                  ...prev,
                  focusedCell: { cellKey: fxBarKey, raw: seed, seed },
                }
              : prev,
          );
          this.sheetClient?.select(state.tab, cellKey);
        }}
        onChangeDraft={(next) => {
          this.setState((prev) => {
            if (prev.kind !== "ready") return prev;
            const activeKey =
              prev.focusedCell?.cellKey === cellKey ? cellKey : fxBarKey;
            const prevSeed = prev.focusedCell?.seed ?? "";
            return {
              ...prev,
              focusedCell: { cellKey: activeKey, raw: next, seed: prevSeed },
              pendingSaveKey: null,
            };
          });
        }}
        onCommit={(raw) => {
          if (column === "taxFee") return;
          this.commitProductCell(
            projected,
            activeRows,
            selectedProduct,
            rowIndex,
            column,
            raw,
          );
        }}
        onResetColumn={() => {
          if (column === "taxFee") return;
          this.commitProductCell(
            projected,
            activeRows,
            selectedProduct,
            rowIndex,
            column,
            "",
          );
        }}
        onOpenBom={() =>
          this.setState({
            ...state,
            selectedProductId: selectedProduct.productId,
            bomOpen: true,
          })
        }
      />
    );
  }

  private renderEditableMarginCell(
    opts: Readonly<{
      row: CalculatedProductMargin;
      rowIndex: number;
      allRows: readonly CalculatedProductMargin[];
      projected: ProjectedCostsSheet;
      dirtyInfo: DirtyInspection;
      presence: PresenceIndex;
      canEdit: boolean;
      column: CostFormulaColumn;
      ariaLabel: string;
      prefix?: string;
      suffix?: string;
      narrow?: boolean;
      compact?: boolean;
      toneClass?: string;
      tooltip?: string;
      leadAdornment?: React.ReactNode;
    }>,
  ): React.ReactNode {
    const state = this.state;
    if (state.kind !== "ready") return null;
    const {
      row,
      rowIndex,
      allRows,
      projected,
      dirtyInfo,
      presence,
      canEdit,
      column,
      ariaLabel,
      prefix,
      suffix,
      narrow,
      compact,
      toneClass,
      tooltip,
      leadAdornment,
    } = opts;
    const cellKey = selectionKeyForProductColumn(row.productId, column);
    const peers = presence.peersByCell.get(cellKey);
    const formatted = formattedCellDisplayValue(row, column);
    const editSeed = rawCellEditSeed(row, column);
    const currentVal = cellValue(state.focusedCell, cellKey, formatted);
    const isTypingFormula = isFormulaExpression(currentVal);
    const hasCustomFx = row.activeFormulas[column] !== undefined;
    const isOverridden = isColumnOverridden(
      row,
      column,
      dirtyInfo.dirtySpoilProducts.has(row.productId),
      dirtyInfo.dirtyPriceProducts.has(row.productId),
      dirtyInfo.dirtyUnitProducts.has(row.productId),
    );
    const isDirty =
      (column === "units" && dirtyInfo.dirtyUnitProducts.has(row.productId)) ||
      (column === "spoil" && dirtyInfo.dirtySpoilProducts.has(row.productId)) ||
      (column === "price" && dirtyInfo.dirtyPriceProducts.has(row.productId)) ||
      (column === "cogs" && dirtyInfo.dirtyCogsProducts.has(row.productId)) ||
      (column === "waste" && dirtyInfo.dirtyWasteProducts.has(row.productId)) ||
      dirtyInfo.dirtyFormulaCellKeys.has(`${row.productId}:${column}`);
    const isActiveBarTarget =
      state.selectedProductId === row.productId &&
      state.activeFormulaColumn === column;

    const titleText = hasCustomFx
      ? `Formula: ${row.activeFormulas[column]}${tooltip ? ` · ${tooltip}` : ""}`
      : tooltip;

    return (
      <div
        className={`costs-cell-box${compact ? " is-compact" : ""}${peers?.length ? " has-peer" : ""}${hasCustomFx ? " has-formula" : ""}${isOverridden ? " is-overridden" : ""}${isActiveBarTarget ? " is-fx-target" : ""}`}
        style={peerCellStyle(peers)}
        title={titleText}
        onMouseDown={handleCellBoxMouseDown}
      >
        <CellPeerOutline peers={peers} below={rowIndex === 0} />
        {leadAdornment}
        {isDirty ? (
          <span className="costs-dirty-dot" aria-hidden="true" />
        ) : hasCustomFx ? (
          <span className="costs-fx-dot" aria-hidden="true">
            fx
          </span>
        ) : null}
        {prefix !== undefined && !isTypingFormula && (
          <span className="costs-cell-affix">{prefix}</span>
        )}
        <input
          type="text"
          inputMode="decimal"
          className={`costs-cell-input${narrow && !isTypingFormula ? " is-narrow" : ""}${toneClass ? ` ${toneClass}` : ""}`}
          disabled={!canEdit}
          data-sheet-row={rowIndex}
          data-sheet-col={column}
          aria-label={ariaLabel}
          value={currentVal}
          onFocus={(event) =>
            this.focusCell(cellKey, editSeed, event.currentTarget)
          }
          onBlur={() =>
            this.blurCell(cellKey, () =>
              this.commitProductCell(projected, allRows, row, rowIndex, column),
            )
          }
          onChange={(event) =>
            this.handleProductCellChange(
              projected,
              allRows,
              row,
              rowIndex,
              column,
              event.currentTarget.value,
            )
          }
          onKeyDown={(event) =>
            handleSheetKeyDown(event, rowIndex, column, () =>
              this.commitProductCell(projected, allRows, row, rowIndex, column),
            )
          }
        />
        {suffix !== undefined && !isTypingFormula && (
          <span className="costs-cell-affix">{suffix}</span>
        )}
      </div>
    );
  }

  private renderMarginsSheet(
    rows: readonly CalculatedProductMargin[],
    calculation: ReturnType<typeof calculateBakeryCostsAndMargins>,
    projected: ProjectedCostsSheet,
    dirtyInfo: DirtyInspection,
    presence: PresenceIndex,
    canEdit: boolean,
  ): React.ReactNode {
    const state = this.state;
    if (state.kind !== "ready") return null;
    const currency = calculation.summary.currency;
    const sym = formatCurrencySymbol(currency);
    const fmtMoney = (minor: number) =>
      formatMoneyMinor(Math.round(minor), currency);
    const fmtSignedMoney = (minor: number) =>
      formatSignedMoneyMinor(Math.round(minor), currency);

    const actions: readonly CrmRowAction<CalculatedProductMargin>[] = [
      {
        id: "bom",
        label: "Inspect recipe BOM",
        onSelect: (row) =>
          this.setState({
            ...state,
            selectedProductId: row.productId,
            bomOpen:
              state.selectedProductId === row.productId ? !state.bomOpen : true,
          }),
      },
    ];

    const columns: readonly CrmColumn<CalculatedProductMargin>[] = [
      {
        id: "product",
        label: "Product",
        kind: "text",
        width: 248,
        minWidth: 196,
        value: (row) => row.productTitle,
        render: (row) => {
          const runSub =
            row.fulfillmentKind === "stocked"
              ? `Batch ${row.batchYield} · ${row.batchesPerDay} runs (${Math.round(row.producedUnits)} baked)`
              : `Prep to order · ${row.dailyTargetUnits}/d`;
          const meta =
            runSub +
            (row.missingCostItemIds.length > 0
              ? ` · ${row.missingCostItemIds.length} unpriced`
              : "");
          return (
            <div
              className="costs-product-cell"
              onClick={(event) => {
                event.stopPropagation();
                this.setState({
                  ...state,
                  selectedProductId: row.productId,
                  bomOpen:
                    state.selectedProductId === row.productId
                      ? !state.bomOpen
                      : true,
                });
              }}
            >
              <ProductOrb title={row.productTitle} imageUrl={row.imageUrl} />
              <div className="costs-product-meta">
                <span className="costs-product-title">{row.productTitle}</span>
                <span className="costs-product-sub">{meta}</span>
              </div>
            </div>
          );
        },
      },
      {
        id: "units",
        label: "Units / d",
        kind: "number",
        width: 92,
        minWidth: 78,
        value: (row) => row.dailyTargetUnits,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "units"),
        }),
        render: (row, rowIndex) =>
          this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "units",
            ariaLabel: `${row.productTitle} daily units`,
            narrow: true,
          }),
      },
      {
        id: "spoil",
        label: "Spoil",
        kind: "number",
        width: 88,
        minWidth: 74,
        value: (row) =>
          row.fulfillmentKind === "stocked"
            ? Number(row.effectiveSpoilagePct.toFixed(1))
            : null,
        format: (val) => `${val.toFixed(1)}%`,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "spoil"),
        }),
        render: (row, rowIndex) => {
          if (row.fulfillmentKind !== "stocked") {
            const cellKey = selectionKeyForProductColumn(
              row.productId,
              "spoil",
            );
            const peers = presence.peersByCell.get(cellKey);
            const isActiveBarTarget =
              state.selectedProductId === row.productId &&
              state.activeFormulaColumn === "spoil";
            return (
              <div
                className={`costs-cell-box is-readonly${peers?.length ? " has-peer" : ""}${isActiveBarTarget ? " is-fx-target" : ""}`}
                style={peerCellStyle(peers)}
                tabIndex={0}
                data-sheet-row={rowIndex}
                data-sheet-col="spoil"
                aria-label={`${row.productTitle} spoilage percent (prep to order)`}
                onFocus={() => this.focusCell(cellKey, "0")}
                onBlur={() => this.blurCell(cellKey)}
                onKeyDown={(event) =>
                  handleSheetKeyDown(event, rowIndex, "spoil")
                }
              >
                <CellPeerOutline peers={peers} below={rowIndex === 0} />
                <span className="costs-cell-muted">—</span>
              </div>
            );
          }
          return this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "spoil",
            ariaLabel: `${row.productTitle} spoilage percent`,
            suffix: "%",
            narrow: true,
          });
        },
      },
      {
        id: "price",
        label: "Price",
        kind: "number",
        width: 96,
        minWidth: 80,
        value: (row) => row.grossPriceMinor,
        format: fmtMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "price"),
        }),
        render: (row, rowIndex) =>
          this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "price",
            ariaLabel: `${row.productTitle} offer price`,
            prefix: sym,
          }),
      },
      {
        id: "cogs",
        label: "COGS",
        kind: "number",
        width: 98,
        minWidth: 82,
        value: (row) => Math.round(row.effectiveCogsUnitMinor),
        format: fmtMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "cogs"),
        }),
        render: (row, rowIndex) => {
          const isBomOpenForRow =
            state.bomOpen && state.selectedProductId === row.productId;
          return this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "cogs",
            ariaLabel: `${row.productTitle} unit COGS`,
            prefix: sym,
            compact: row.bomLines.length > 0,
            leadAdornment:
              row.bomLines.length > 0 ? (
                <button
                  type="button"
                  className={`costs-cogs-expand-btn${
                    isBomOpenForRow ? " is-expanded" : ""
                  }`}
                  aria-expanded={isBomOpenForRow}
                  aria-label={`Inspect recipe BOM for ${row.productTitle}`}
                  title={`Inspect ${row.bomLines.length} recipe inputs & wholesale rates`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    this.setState({
                      ...state,
                      selectedProductId: row.productId,
                      bomOpen: !isBomOpenForRow,
                    });
                  }}
                >
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              ) : undefined,
            tooltip: `Recipe BOM ${formatMoneyMinor(Math.round(row.bomUnitCostMinor), row.currency)} (Ingredients ${formatMoneyMinor(Math.round(row.ingredientUnitCostMinor), row.currency)} · Packaging ${formatMoneyMinor(Math.round(row.packagingUnitCostMinor), row.currency)})`,
          });
        },
      },
      {
        id: "waste",
        label: "Waste",
        kind: "number",
        width: 84,
        minWidth: 70,
        value: (row) => Math.round(row.wasteAndSurplusUnitMinor),
        format: fmtMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "waste"),
        }),
        render: (row, rowIndex) =>
          this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "waste",
            ariaLabel: `${row.productTitle} unit waste`,
            prefix: sym,
            tooltip: `Formula waste ${formatMoneyMinor(Math.round(row.formulaWasteUnitMinor), row.currency)}`,
          }),
      },
      {
        id: "taxFee",
        label: "Tax & fee",
        kind: "number",
        width: 84,
        minWidth: 72,
        value: (row) => Math.round(row.includedTaxMinor + row.channelFeeMinor),
        format: fmtMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "taxFee"),
        }),
        render: (row, rowIndex) => {
          const cellKey = selectionKeyForProductColumn(row.productId, "taxFee");
          const peers = presence.peersByCell.get(cellKey);
          const isActiveBarTarget =
            state.selectedProductId === row.productId &&
            state.activeFormulaColumn === "taxFee";
          const formattedTaxFee = formatMoneyMinor(
            Math.round(row.includedTaxMinor + row.channelFeeMinor),
            row.currency,
          );
          return (
            <div
              className={`costs-cell-box is-readonly${peers?.length ? " has-peer" : ""}${isActiveBarTarget ? " is-fx-target" : ""}`}
              style={peerCellStyle(peers)}
              tabIndex={0}
              data-sheet-row={rowIndex}
              data-sheet-col="taxFee"
              aria-label={`${row.productTitle} tax and payment fee ${formattedTaxFee}`}
              title={`Included tax ${formatMoneyMinor(Math.round(row.includedTaxMinor), row.currency)} + Payment fee ${formatMoneyMinor(Math.round(row.channelFeeMinor), row.currency)}`}
              onFocus={() => this.focusCell(cellKey, formattedTaxFee)}
              onBlur={() => this.blurCell(cellKey)}
              onKeyDown={(event) =>
                handleSheetKeyDown(event, rowIndex, "taxFee")
              }
            >
              <CellPeerOutline peers={peers} below={rowIndex === 0} />
              <span className="costs-cell-muted">{formattedTaxFee}</span>
            </div>
          );
        },
      },
      {
        id: "unitNet",
        label: "Unit net",
        kind: "number",
        width: 92,
        minWidth: 78,
        value: (row) => Math.round(row.netContributionUnitMinor),
        format: fmtSignedMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "unitNet"),
        }),
        render: (row, rowIndex) =>
          this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "unitNet",
            ariaLabel: `${row.productTitle} unit net contribution`,
            prefix: sym,
            tooltip:
              "Type a target unit net to back-solve Price, or type = formula",
          }),
      },
      {
        id: "margin",
        label: "Margin",
        kind: "number",
        width: 124,
        minWidth: 106,
        value: (row) => Number(row.netMarginPct.toFixed(1)),
        format: (val) => `${val.toFixed(1)}%`,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "margin"),
        }),
        render: (row, rowIndex) => {
          const pct = row.netMarginPct;
          const barColor =
            pct >= 40 ? "#10b981" : pct >= 32 ? "#f59e0b" : "#ef4444";
          const barWidth = `${Math.min(100, Math.max(10, pct * 1.65)).toFixed(0)}%`;
          return this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "margin",
            ariaLabel: `${row.productTitle} target margin percent`,
            suffix: "%",
            narrow: true,
            compact: true,
            leadAdornment: (
              <span className="costs-margin-track" aria-hidden="true">
                <span
                  className="costs-margin-fill"
                  style={{ width: barWidth, backgroundColor: barColor }}
                />
              </span>
            ),
            tooltip:
              "Type a target margin % to back-solve Price, or type = formula",
          });
        },
      },
      {
        id: "netDay",
        label: "Net / day",
        kind: "number",
        width: 106,
        minWidth: 90,
        value: (row) => Math.round(row.dailyNetContributionMinor),
        format: fmtSignedMoney,
        cellProps: (row) => ({
          cellKey: selectionKeyForProductColumn(row.productId, "netDay"),
        }),
        render: (row, rowIndex) =>
          this.renderEditableMarginCell({
            row,
            rowIndex,
            allRows: rows,
            projected,
            dirtyInfo,
            presence,
            canEdit,
            column: "netDay",
            ariaLabel: `${row.productTitle} daily net contribution`,
            prefix: sym,
            toneClass:
              row.dailyNetContributionMinor >= 0
                ? "costs-val-pos"
                : "costs-val-neg",
            tooltip:
              "Type a target daily net to back-solve Units / d, or type = formula",
          }),
      },
    ];

    return (
      <CrmTable
        key="margins"
        className="costs-crm-sheet"
        label="Product margins spreadsheet"
        rows={rows}
        columns={columns}
        rowId={(row) => row.variantId}
        rowLabel={(row) => row.productTitle}
        rowSurfaceTarget={(row) => `row:${row.productId}`}
        isRowActive={(row) =>
          state.selectedProductId === row.productId ||
          (rows.every((r) => r.productId !== state.selectedProductId) &&
            rows[0]?.productId === row.productId)
        }
        onRowClick={(row) =>
          this.setState({ ...state, selectedProductId: row.productId })
        }
        actions={actions}
        initialPinned={["product"]}
        initialCalculations={{
          units: "sum",
          price: "average",
          cogs: "average",
          unitNet: "average",
          margin: "average",
          netDay: "sum",
        }}
        emptyTitle="No matching products"
        emptyDescription="Clear the search box or select another category chip."
      />
    );
  }

  private renderWeeklySheet(
    rows: readonly CalculatedProductMargin[],
    calculation: ReturnType<typeof calculateBakeryCostsAndMargins>,
    projected: ProjectedCostsSheet,
    dirtyInfo: DirtyInspection,
    presence: PresenceIndex,
    canEdit: boolean,
  ): React.ReactNode {
    const state = this.state;
    if (state.kind !== "ready") return null;
    const currency = calculation.summary.currency;
    const fmtMoney = (minor: number) =>
      formatMoneyMinor(Math.round(minor), currency);
    const fmtSignedMoney = (minor: number) =>
      formatSignedMoneyMinor(Math.round(minor), currency);

    const dayColumns: readonly CrmColumn<CalculatedProductMargin>[] =
      WEEKDAY_LABELS.map((day, dayIdx) => ({
        id: `day_${dayIdx}`,
        label: day,
        kind: "number",
        width: 72,
        minWidth: 62,
        value: (row) => row.weekUnits[dayIdx] ?? 0,
        cellProps: (row) => ({
          cellKey: productDayCellKey(row.productId, dayIdx),
        }),
        render: (row, rowIndex) => {
          const dayKey = productDayCellKey(row.productId, dayIdx);
          const dayPeers = presence.peersByCell.get(dayKey);
          const dayFormatted = String(row.weekUnits[dayIdx] ?? 0);
          return (
            <div
              className={`costs-cell-box is-compact${dayPeers?.length ? " has-peer" : ""}`}
              style={peerCellStyle(dayPeers)}
              onMouseDown={handleCellBoxMouseDown}
            >
              <CellPeerOutline peers={dayPeers} below={rowIndex === 0} />
              <input
                type="number"
                className="costs-cell-input is-day"
                min={0}
                step={1}
                disabled={!canEdit}
                data-sheet-row={rowIndex}
                data-sheet-col={`day_${dayIdx}`}
                aria-label={`${row.productTitle} ${day} units`}
                value={cellValue(state.focusedCell, dayKey, dayFormatted)}
                onFocus={(e) =>
                  this.focusCell(dayKey, dayFormatted, e.currentTarget)
                }
                onBlur={() => this.blurCell(dayKey)}
                onChange={(event) =>
                  this.updateWeekDayUnits(
                    projected,
                    row.productId,
                    dayIdx,
                    event.currentTarget.value,
                  )
                }
                onKeyDown={(event) =>
                  handleSheetKeyDown(event, rowIndex, `day_${dayIdx}`)
                }
              />
            </div>
          );
        },
      }));

    const columns: readonly CrmColumn<CalculatedProductMargin>[] = [
      {
        id: "product",
        label: "Product",
        kind: "text",
        width: 214,
        minWidth: 184,
        value: (row) => row.productTitle,
        render: (row) => {
          const sub =
            row.fulfillmentKind === "stocked"
              ? `Yield ${row.batchYield} · ${row.sevenDayBatches} runs / wk`
              : `${formatSectionName(row.productType)} · to order`;
          return (
            <div className="costs-product-cell">
              <ProductOrb title={row.productTitle} imageUrl={row.imageUrl} />
              <div className="costs-product-meta">
                <span className="costs-product-title">{row.productTitle}</span>
                <span className="costs-product-sub">{sub}</span>
              </div>
            </div>
          );
        },
      },
      ...dayColumns,
      {
        id: "sevenDayUnits",
        label: "7d units",
        kind: "number",
        width: 84,
        minWidth: 72,
        value: (row) => row.sevenDayUnits,
        cellProps: (row) => ({
          cellKey: `${row.productId}:sevenDayUnits`,
        }),
        render: (row, rowIndex) => (
          <div
            className="costs-cell-box is-readonly"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="sevenDayUnits"
            aria-label={`${row.productTitle} 7-day units`}
            onKeyDown={(event) =>
              handleSheetKeyDown(event, rowIndex, "sevenDayUnits")
            }
          >
            <span>{row.sevenDayUnits.toLocaleString("en-US")}</span>
          </div>
        ),
      },
      {
        id: "avgDay",
        label: "Avg / d",
        kind: "number",
        width: 74,
        minWidth: 64,
        value: (row) => Number((row.sevenDayUnits / 7).toFixed(1)),
        format: (val) => val.toFixed(1),
        cellProps: (row) => ({
          cellKey: `${row.productId}:avgDay`,
        }),
        render: (row, rowIndex) => (
          <div
            className="costs-cell-box is-readonly"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="avgDay"
            aria-label={`${row.productTitle} average daily units`}
            onKeyDown={(event) => handleSheetKeyDown(event, rowIndex, "avgDay")}
          >
            <span className="costs-cell-muted">
              {(row.sevenDayUnits / 7).toFixed(1)}
            </span>
          </div>
        ),
      },
      {
        id: "sevenDayGross",
        label: "7d revenue",
        kind: "number",
        width: 98,
        minWidth: 84,
        value: (row) => Math.round(row.sevenDayGrossRevenueMinor),
        format: fmtMoney,
        cellProps: (row) => ({
          cellKey: `${row.productId}:sevenDayGross`,
        }),
        render: (row, rowIndex) => (
          <div
            className="costs-cell-box is-readonly"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="sevenDayGross"
            aria-label={`${row.productTitle} 7-day revenue`}
            onKeyDown={(event) =>
              handleSheetKeyDown(event, rowIndex, "sevenDayGross")
            }
          >
            <span className="costs-cell-muted">
              {formatMoneyMinor(
                Math.round(row.sevenDayGrossRevenueMinor),
                currency,
              )}
            </span>
          </div>
        ),
      },
      {
        id: "sevenDayContrib",
        label: "7d contrib",
        kind: "number",
        width: 102,
        minWidth: 88,
        value: (row) => Math.round(row.sevenDayNetContributionMinor),
        format: fmtSignedMoney,
        cellProps: (row) => ({
          cellKey: `${row.productId}:sevenDayContrib`,
        }),
        render: (row, rowIndex) => (
          <div
            className="costs-cell-box is-readonly"
            tabIndex={0}
            data-sheet-row={rowIndex}
            data-sheet-col="sevenDayContrib"
            aria-label={`${row.productTitle} 7-day contribution`}
            onKeyDown={(event) =>
              handleSheetKeyDown(event, rowIndex, "sevenDayContrib")
            }
          >
            <span
              className={
                row.sevenDayNetContributionMinor >= 0
                  ? "costs-val-pos"
                  : "costs-val-neg"
              }
            >
              {formatSignedMoneyMinor(
                Math.round(row.sevenDayNetContributionMinor),
                currency,
              )}
            </span>
          </div>
        ),
      },
    ];

    const dirtyRow = dirtyInfo.dirtyUnitProducts;
    void dirtyRow;

    return (
      <CrmTable
        key="weekly"
        className="costs-crm-sheet"
        label="Mon to Sun 7-day plan spreadsheet"
        rows={rows}
        columns={columns}
        rowId={(row) => row.variantId}
        rowLabel={(row) => row.productTitle}
        rowSurfaceTarget={(row) => `row:${row.productId}`}
        isRowActive={(row) =>
          state.bomOpen &&
          (state.selectedProductId === row.productId ||
            (rows.every((r) => r.productId !== state.selectedProductId) &&
              rows[0]?.productId === row.productId))
        }
        onRowClick={(row) =>
          this.setState({ ...state, selectedProductId: row.productId })
        }
        initialPinned={["product"]}
        initialCalculations={{
          day_0: "sum",
          day_1: "sum",
          day_2: "sum",
          day_3: "sum",
          day_4: "sum",
          day_5: "sum",
          day_6: "sum",
          sevenDayUnits: "sum",
          avgDay: "sum",
          sevenDayGross: "sum",
          sevenDayContrib: "sum",
        }}
        emptyTitle="No matching products"
        emptyDescription="Clear the search box or select another category chip."
      />
    );
  }

  private handleVarianceDriverSelect(driver: PlanVsActualVarianceDriver): void {
    const state = this.state;
    if (state.kind !== "ready") return;
    if (driver.inventoryItemId !== null) {
      this.inspectSupplyFromBom(driver.inventoryItemId);
      return;
    }
    if (driver.productId !== null) {
      this.setState({
        ...state,
        sectionFilter: "all",
        search: "",
        selectedProductId: driver.productId,
      });
    }
  }
}

function cellValue(
  focused: FocusedCell | null,
  cellKey: string,
  formatted: string,
): string {
  return focused?.cellKey === cellKey ? focused.raw : formatted;
}

function hasNonMetaDraftCells(
  cells: Readonly<Record<string, string>>,
): boolean {
  for (const key of Object.keys(cells)) {
    if (key !== "meta:savedAt") return true;
  }
  return false;
}

function parseNonNegativeInteger(raw: string): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100_000, Math.round(num)));
}

function formatSignedMoneyMinor(amountMinor: number, currency: string): string {
  if (amountMinor < 0) {
    return `−${formatMoneyMinor(Math.abs(amountMinor), currency)}`;
  }
  return formatMoneyMinor(amountMinor, currency);
}

function formatCurrencySymbol(currency: string): string {
  if (currency === "JPY") return "¥";
  if (currency === "USD") return "$";
  if (currency === "EUR") return "€";
  return currency;
}

function distinctProductTypes(overview: CostsOverview): readonly string[] {
  const seen = new Set<string>();
  for (const product of overview.products) {
    if (product.productType.length > 0) seen.add(product.productType);
  }
  return [...seen];
}

function formatSectionName(section: string): string {
  if (section.length === 0) return "General";
  const spaced = section.replace(/_/gu, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
