import React from "react";
import type {
  CounterRegisterBasketLine,
  CounterRegisterMenuEntry,
  CounterRegisterPaymentMethod,
  CounterRegisterSnapshot,
  RegisterViewCommand,
} from "@purin-labs/control-api";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";
import { EmptyState, useLatestRead } from "../../ui";
import {
  cancelCounterSaleCollection,
  collectCounterSale,
  counterSaleGuidance,
  defaultCounterSaleMutate,
  handOverCounterSale,
  markCounterSalePickupReady,
  openRegisterMenuSale,
  readCounterRegister,
  readCounterSale,
  reconcileCounterSale,
  recordCounterSaleCash,
} from "../terminals/counter-sale-api";
import { RegisterModifierDrawer, formatMoney } from "./modifier-drawer";
import { ReceiptPrintControl } from "./receipt-print";
import { RegisterPageViewSource } from "./register-surface";
import "./register.css";

const REFRESH_MS = 10_000;
const JPY_QUICK_BILLS = [1_000, 5_000, 10_000] as const;

export function RegisterRoute(
  props: Readonly<{ organisationId: string }>,
): React.ReactNode {
  const loadRegister = React.useCallback(
    () => readCounterRegister(props.organisationId),
    [props.organisationId],
  );
  const { read: registerRead, reload } = useLatestRead(loadRegister, REFRESH_MS);
  const snapshot = registerRead.kind === "ready" ? registerRead.value : null;

  const [selectedSectionId, setSelectedSectionId] = React.useState<string>("");
  const [basket, setBasket] = React.useState<readonly CounterRegisterBasketLine[]>([]);
  const [drawerEntry, setDrawerEntry] =
    React.useState<CounterRegisterMenuEntry | null>(null);
  const [cashInput, setCashInput] = React.useState<string>("");
  const [paymentMethod, setPaymentMethod] =
    React.useState<CounterRegisterPaymentMethod>("card");
  const [activeSale, setActiveSale] = React.useState<CounterSale | null>(null);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const snapshotRef = React.useRef<CounterRegisterSnapshot | null>(null);
  snapshotRef.current = snapshot;
  const activeSaleRef = React.useRef<CounterSale | null>(null);
  activeSaleRef.current = activeSale;

  // Recover an open or pending sale pinned in the URL query across reloads.
  React.useEffect(() => {
    const pinned = new URLSearchParams(window.location.search).get("sale");
    if (!pinned) return;
    void readCounterSale(props.organisationId, pinned)
      .then((sale) => setActiveSale(sale))
      .catch(() => setPinnedSaleId(null));
  }, [props.organisationId]);

  // Keep selected section valid as menu loads.
  React.useEffect(() => {
    const first = snapshot?.menu?.sections[0]?.sectionId ?? "";
    if (
      first.length > 0 &&
      !snapshot?.menu?.sections.some((s) => s.sectionId === selectedSectionId)
    ) {
      setSelectedSectionId(first);
    }
  }, [snapshot, selectedSectionId]);

  const addEntryToBasket = React.useCallback(
    (
      entry: CounterRegisterMenuEntry,
      modifierOptionIds: readonly string[],
      quantity: number,
    ) => {
      const menuId = snapshotRef.current?.menu?.menuId ?? "menu_cafe_main";
      const sortedIds = [...modifierOptionIds].sort();
      const lineKey = `${entry.menuEntryId}:${sortedIds.join(",")}`;
      const chosenOptions = entry.modifierGroups.flatMap((group) =>
        group.options.filter((opt) => sortedIds.includes(opt.modifierOptionId)),
      );
      const deltaMinor = chosenOptions.reduce(
        (sum, opt) => sum + opt.priceDeltaMinor,
        0,
      );
      const unitPriceMinor = entry.unitPrice.amountMinor + deltaMinor;
      setBasket((prev) => {
        const existing = prev.find((line) => line.lineKey === lineKey);
        if (existing !== undefined) {
          return prev.map((line) =>
            line.lineKey === lineKey
              ? { ...line, quantity: Math.min(20, line.quantity + quantity) }
              : line,
          );
        }
        return [
          ...prev,
          {
            lineKey,
            menuId,
            menuEntryId: entry.menuEntryId,
            title: entry.title,
            modifierOptionIds: sortedIds,
            modifierLabels: chosenOptions.map((opt) => opt.name),
            quantity,
            unitPriceMinor,
            currency: entry.unitPrice.currency,
          },
        ];
      });
      setErrorMessage(null);
    },
    [],
  );

  // Plan 87 / Plan 90 surface view source so Sous Chef can stage basket items
  // without touching money movement.
  const runSurfaceCommand = React.useCallback(
    async (command: RegisterViewCommand) => {
      if (activeSaleRef.current !== null) {
        return {
          kind: "rejected" as const,
          message: "Finish or clear the active sale before staging new items.",
        };
      }
      const current = snapshotRef.current;
      if (current?.menu === null || current === null) {
        return {
          kind: "rejected" as const,
          message: "No published café menu is loaded on Register.",
        };
      }
      switch (command.name) {
        case "register_add_item": {
          const entry = current.menu.sections
            .flatMap((section) => section.entries)
            .find((e) => e.menuEntryId === command.menuEntryId);
          if (entry === undefined) {
            return {
              kind: "rejected" as const,
              message: `Menu entry ${command.menuEntryId} is not on the published menu.`,
            };
          }
          if (!entry.available) {
            return {
              kind: "rejected" as const,
              message: `${entry.title} is currently sold out.`,
            };
          }
          addEntryToBasket(
            entry,
            command.modifierOptionIds ?? [],
            command.quantity ?? 1,
          );
          return { kind: "done" as const };
        }
        case "register_update_line":
          setBasket((prev) =>
            prev.map((line) =>
              line.lineKey === command.lineKey
                ? { ...line, quantity: command.quantity }
                : line,
            ),
          );
          return { kind: "done" as const };
        case "register_remove_line":
          setBasket((prev) =>
            prev.filter((line) => line.lineKey !== command.lineKey),
          );
          return { kind: "done" as const };
        case "register_clear_basket":
          setBasket([]);
          return { kind: "done" as const };
      }
    },
    [addEntryToBasket],
  );

  const surfaceRef = React.useRef<RegisterPageViewSource | null>(null);
  React.useEffect(() => {
    const source = new RegisterPageViewSource(
      props.organisationId,
      runSurfaceCommand,
    );
    surfaceRef.current = source;
    source.register();
    return () => {
      source.unregister();
      surfaceRef.current = null;
    };
  }, [props.organisationId, runSurfaceCommand]);

  if (surfaceRef.current !== null) {
    surfaceRef.current.state =
      snapshot === null ? null : { snapshot, basket, activeSale };
  }

  if (registerRead.kind === "loading") {
    return <p>Loading counter register…</p>;
  }
  if (registerRead.kind === "failed" || snapshot === null) {
    return (
      <EmptyState
        title="Register is unavailable"
        description="Seams Pantry could not load the published café menu and counter policy."
      />
    );
  }
  if (snapshot.menu === null || snapshot.menu.sections.length === 0) {
    return (
      <EmptyState
        title="No published café menu"
        description="Publish the café menu in Café › Menus before ringing up counter sales."
      />
    );
  }

  const activeSection =
    snapshot.menu.sections.find((s) => s.sectionId === selectedSectionId) ??
    snapshot.menu.sections[0]!;
  const basketTotalMinor = basket.reduce(
    (sum, line) => sum + line.unitPriceMinor * line.quantity,
    0,
  );
  const parsedCashMinor = parseCashMinor(cashInput, basketTotalMinor);
  const changeDueMinor =
    parsedCashMinor !== null && parsedCashMinor >= basketTotalMinor
      ? parsedCashMinor - basketTotalMinor
      : null;
  const canCash = snapshot.policy?.cashEnabled === true;
  const canTerminal = snapshot.terminal.assigned && snapshot.terminal.ready;

  function onTileClick(entry: CounterRegisterMenuEntry): void {
    if (!entry.available || activeSale !== null) return;
    if (entry.modifierGroups.length > 0) {
      setDrawerEntry(entry);
      return;
    }
    addEntryToBasket(entry, [], 1);
  }

  async function handleCashSale(): Promise<void> {
    if (snapshot === null || basket.length === 0 || parsedCashMinor === null) return;
    if (parsedCashMinor < basketTotalMinor) {
      setErrorMessage("Cash received is less than the basket total.");
      return;
    }
    setBusyAction("cash");
    setErrorMessage(null);
    try {
      const opened = await openRegisterMenuSale(props.organisationId, {
        satyrLocationId: snapshot.satyrLocationId,
        tenderMode: "cash",
        lines: basket,
      });
      setPinnedSaleId(opened.checkoutId);
      const settled = await recordCounterSaleCash(props.organisationId, opened, {
        amountMinor: parsedCashMinor,
        currency: snapshot.currency,
      });
      setActiveSale(settled);
      setBasket([]);
      setCashInput("");
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTerminalSale(): Promise<void> {
    if (snapshot === null || basket.length === 0) return;
    setBusyAction("terminal");
    setErrorMessage(null);
    try {
      const opened = await openRegisterMenuSale(props.organisationId, {
        satyrLocationId: snapshot.satyrLocationId,
        tenderMode: "terminal",
        lines: basket,
      });
      setPinnedSaleId(opened.checkoutId);
      setActiveSale(opened);
      await collectCounterSale(
        props.organisationId,
        opened,
        opened.quote?.amount ?? {
          amountMinor: basketTotalMinor,
          currency: snapshot.currency,
        },
        defaultCounterSaleMutate,
        paymentMethod,
      );
      const updated = await readCounterSale(props.organisationId, opened.checkoutId);
      setActiveSale(updated);
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCheckTerminal(): Promise<void> {
    if (activeSale === null) return;
    setBusyAction("reconcile");
    setErrorMessage(null);
    try {
      const updated = await reconcileCounterSale(
        props.organisationId,
        activeSale.checkoutId,
        defaultCounterSaleMutate,
      );
      setActiveSale(updated);
      if (updated.state === "complete") setBasket([]);
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCancelTerminal(): Promise<void> {
    if (activeSale === null) return;
    setBusyAction("cancel");
    setErrorMessage(null);
    try {
      const updated = await cancelCounterSaleCollection(
        props.organisationId,
        activeSale.checkoutId,
      );
      setActiveSale(updated);
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSwitchToCash(): Promise<void> {
    if (
      activeSale === null ||
      snapshot === null ||
      activeSale.quote === null ||
      (activeSale.state !== "awaiting_collection" &&
        activeSale.state !== "declined" &&
        activeSale.state !== "expired")
    ) {
      return;
    }
    const targetMinor = activeSale.quote.amount.amountMinor;
    const cashMinor = parseCashMinor(cashInput, targetMinor) ?? targetMinor;
    if (cashMinor < targetMinor) {
      setErrorMessage("Cash received is less than the sale total.");
      return;
    }
    setBusyAction("cash");
    setErrorMessage(null);
    try {
      // If the prior terminal checkout expired/declined, open a fresh cash checkout
      // from the staged basket; otherwise settle the open checkout directly.
      let saleToSettle = activeSale;
      if (activeSale.state !== "awaiting_collection" && basket.length > 0) {
        saleToSettle = await openRegisterMenuSale(props.organisationId, {
          satyrLocationId: snapshot.satyrLocationId,
          tenderMode: "cash",
          lines: basket,
        });
        setPinnedSaleId(saleToSettle.checkoutId);
      }
      const settled = await recordCounterSaleCash(
        props.organisationId,
        saleToSettle,
        { amountMinor: cashMinor, currency: snapshot.currency },
      );
      setActiveSale(settled);
      setBasket([]);
      setCashInput("");
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleHandOverNow(): Promise<void> {
    if (activeSale === null) return;
    setBusyAction("handover");
    setErrorMessage(null);
    try {
      let sale = activeSale;
      if (sale.afterSale?.fulfillment.state !== "ready_for_pickup") {
        sale = await markCounterSalePickupReady(
          props.organisationId,
          sale.checkoutId,
          defaultCounterSaleMutate,
        );
      }
      sale = await handOverCounterSale(
        props.organisationId,
        sale.checkoutId,
        defaultCounterSaleMutate,
      );
      setActiveSale(sale);
      reload();
    } catch (error) {
      setErrorMessage(errorText(error));
    } finally {
      setBusyAction(null);
    }
  }

  function handleNewSale(): void {
    setActiveSale(null);
    setPinnedSaleId(null);
    setBasket([]);
    setCashInput("");
    setErrorMessage(null);
  }

  const canSwitchToCash =
    canCash &&
    activeSale !== null &&
    (activeSale.state === "awaiting_collection" ||
      activeSale.state === "declined" ||
      activeSale.state === "expired");

  return (
    <div className="register-layout">
      <section className="register-catalog" aria-label="Café menu">
        <div className="register-header-bar">
          <div className="register-status-pills">
            <span className="register-pill" data-tone={canCash ? "ready" : undefined}>
              Cash: {canCash ? "Ready" : "Off"}
            </span>
            <span
              className="register-pill"
              data-tone={canTerminal ? "ready" : undefined}
            >
              Terminal:{" "}
              {canTerminal
                ? snapshot.terminal.provider === "gmo_stera"
                  ? "GMO stera (LAN)"
                  : "Square Terminal"
                : "Not assigned"}
            </span>
            <span className="register-pill">
              Open queue: {snapshot.openQueueCount}
            </span>
          </div>
        </div>

        <div className="register-tabs" role="tablist" aria-label="Menu sections">
          {snapshot.menu.sections.map((section) => (
            <button
              key={section.sectionId}
              type="button"
              role="tab"
              className="register-tab"
              aria-selected={section.sectionId === activeSection.sectionId}
              onClick={() => setSelectedSectionId(section.sectionId)}
            >
              {section.name}
            </button>
          ))}
        </div>

        <div className="register-grid">
          {activeSection.entries.map((entry) => (
            <button
              key={entry.menuEntryId}
              type="button"
              className="register-tile"
              data-surface-target={`register:item:${entry.menuEntryId}`}
              disabled={!entry.available || activeSale !== null}
              onClick={() => onTileClick(entry)}
            >
              <span className="register-tile-title">{entry.title}</span>
              <span className="register-tile-meta">
                <span className="register-tile-price">
                  {formatMoney(entry.unitPrice.amountMinor, entry.unitPrice.currency)}
                </span>
                {!entry.available ? (
                  <span className="register-sold-out-badge">Sold out</span>
                ) : entry.modifierGroups.length > 0 ? (
                  <span>Options</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </section>

      <aside
        className="register-ticket"
        aria-label="Counter basket and payment"
        data-surface-target="register:basket"
      >
        {errorMessage !== null ? (
          <div className="register-error" role="alert">
            {errorMessage}
          </div>
        ) : null}

        {activeSale !== null ? (
          <ActiveSalePanel
            organisationId={props.organisationId}
            sale={activeSale}
            busyAction={busyAction}
            canSwitchToCash={canSwitchToCash}
            cashInput={cashInput}
            setCashInput={setCashInput}
            onCheckTerminal={handleCheckTerminal}
            onCancelTerminal={handleCancelTerminal}
            onSwitchToCash={handleSwitchToCash}
            onHandOverNow={handleHandOverNow}
            onNewSale={handleNewSale}
          />
        ) : (
          <>
            <div className="register-header-bar">
              <h2>Basket</h2>
              {basket.length > 0 ? (
                <button
                  type="button"
                  className="register-secondary-btn"
                  onClick={() => setBasket([])}
                >
                  Clear
                </button>
              ) : null}
            </div>

            {basket.length === 0 ? (
              <p>Tap items on the menu to ring up a counter order.</p>
            ) : (
              <ul className="register-basket-list">
                {basket.map((line) => (
                  <li
                    key={line.lineKey}
                    className="register-basket-row"
                    data-surface-target={`register:line:${line.lineKey}`}
                  >
                    <div className="register-basket-info">
                      <strong>{line.title}</strong>
                      {line.modifierLabels.length > 0 ? (
                        <span className="register-basket-mods">
                          {line.modifierLabels.join(" · ")}
                        </span>
                      ) : null}
                      <span>
                        {formatMoney(
                          line.unitPriceMinor * line.quantity,
                          line.currency,
                        )}
                      </span>
                    </div>
                    <div className="register-basket-controls">
                      <button
                        type="button"
                        className="register-qty-btn"
                        aria-label={`Decrease ${line.title}`}
                        onClick={() =>
                          setBasket((prev) =>
                            prev
                              .map((l) =>
                                l.lineKey === line.lineKey
                                  ? { ...l, quantity: l.quantity - 1 }
                                  : l,
                              )
                              .filter((l) => l.quantity > 0),
                          )
                        }
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        type="button"
                        className="register-qty-btn"
                        aria-label={`Increase ${line.title}`}
                        onClick={() =>
                          setBasket((prev) =>
                            prev.map((l) =>
                              l.lineKey === line.lineKey
                                ? { ...l, quantity: Math.min(20, l.quantity + 1) }
                                : l,
                            ),
                          )
                        }
                      >
                        +
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="register-totals">
              <div className="register-total-row register-total-grand">
                <span>Total</span>
                <span>{formatMoney(basketTotalMinor, snapshot.currency)}</span>
              </div>
              {snapshot.policy?.tax.kind === "percentage" ? (
                <div className="register-total-row register-total-tax">
                  <span>
                    {snapshot.policy.tax.inclusion === "included"
                      ? `Includes ${(snapshot.policy.tax.basisPoints / 100).toFixed(0)}% tax`
                      : `Plus ${(snapshot.policy.tax.basisPoints / 100).toFixed(0)}% tax`}
                  </span>
                </div>
              ) : null}
            </div>

            {canCash ? (
              <div className="register-tender-section">
                <h3>Cash</h3>
                <div className="register-quick-row">
                  <button
                    type="button"
                    className="register-quick-btn"
                    aria-pressed={cashInput === "" || cashInput === String(basketTotalMinor)}
                    disabled={basketTotalMinor === 0}
                    onClick={() => setCashInput(String(basketTotalMinor))}
                  >
                    Exact
                  </button>
                  {snapshot.currency.toUpperCase() === "JPY"
                    ? JPY_QUICK_BILLS.map((bill) => (
                        <button
                          key={bill}
                          type="button"
                          className="register-quick-btn"
                          aria-pressed={cashInput === String(bill)}
                          disabled={basketTotalMinor === 0}
                          onClick={() => setCashInput(String(bill))}
                        >
                          {formatMoney(bill, "JPY")}
                        </button>
                      ))
                    : null}
                </div>
                <input
                  type="number"
                  min={0}
                  className="register-cash-input"
                  aria-label="Cash received"
                  placeholder={`Cash received (${formatMoney(basketTotalMinor, snapshot.currency)})`}
                  value={cashInput}
                  onChange={(event) => setCashInput(event.target.value)}
                />
                {changeDueMinor !== null && basketTotalMinor > 0 ? (
                  <div className="register-change-preview">
                    <span>Change due</span>
                    <strong>{formatMoney(changeDueMinor, snapshot.currency)}</strong>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="register-primary-btn"
                  disabled={
                    basket.length === 0 ||
                    busyAction !== null ||
                    parsedCashMinor === null ||
                    parsedCashMinor < basketTotalMinor
                  }
                  onClick={() => void handleCashSale()}
                >
                  {busyAction === "cash"
                    ? "Recording cash…"
                    : `Complete cash sale (${formatMoney(basketTotalMinor, snapshot.currency)})`}
                </button>
              </div>
            ) : null}

            {canTerminal ? (
              <div className="register-tender-section">
                <h3>Terminal</h3>
                <div className="register-method-row">
                  {(
                    [
                      ["card", "Card"],
                      ["felica", "FeliCa"],
                      ["qr_code", "QR"],
                    ] as const
                  ).map(([method, label]) => (
                    <button
                      key={method}
                      type="button"
                      className="register-method-btn"
                      aria-pressed={paymentMethod === method}
                      onClick={() => setPaymentMethod(method)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="register-primary-btn"
                  disabled={basket.length === 0 || busyAction !== null}
                  onClick={() => void handleTerminalSale()}
                >
                  {busyAction === "terminal"
                    ? "Sending to terminal…"
                    : `Charge terminal · ${paymentMethodLabel(paymentMethod)}`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </aside>

      <RegisterModifierDrawer
        entry={drawerEntry}
        close={() => setDrawerEntry(null)}
        onAdd={({ entry, modifierOptionIds, quantity }) =>
          addEntryToBasket(entry, modifierOptionIds, quantity)
        }
      />
    </div>
  );
}

function ActiveSalePanel(
  props: Readonly<{
    organisationId: string;
    sale: CounterSale;
    busyAction: string | null;
    canSwitchToCash: boolean;
    cashInput: string;
    setCashInput: (value: string) => void;
    onCheckTerminal: () => Promise<void>;
    onCancelTerminal: () => Promise<void>;
    onSwitchToCash: () => Promise<void>;
    onHandOverNow: () => Promise<void>;
    onNewSale: () => void;
  }>,
): React.ReactNode {
  const { sale } = props;
  const total = sale.quote?.amount;
  const completed = sale.state === "complete";
  const handedOver = sale.afterSale?.fulfillment.state === "completed";

  return (
    <div className="register-pickup-card">
      <div className="register-header-bar">
        <h2>{completed ? "Sale complete" : "Payment in progress"}</h2>
        <span>{sale.state}</span>
      </div>
      {sale.pickupCode ? (
        <div>
          <div>Pickup code</div>
          <div className="register-pickup-code">{sale.pickupCode}</div>
        </div>
      ) : null}
      <p>{counterSaleGuidance(sale)}</p>
      {total !== undefined ? (
        <div className="register-total-row">
          <span>Total</span>
          <strong>{formatMoney(total.amountMinor, total.currency)}</strong>
        </div>
      ) : null}
      {sale.manualTender !== undefined && sale.manualTender !== null ? (
        <div className="register-change-preview">
          <span>
            Cash received:{" "}
            {sale.manualTender.cashReceivedMinor !== null
              ? formatMoney(
                  sale.manualTender.cashReceivedMinor,
                  sale.manualTender.currency,
                )
              : "—"}
          </span>
          <strong>
            Change:{" "}
            {sale.manualTender.changeDueMinor !== null
              ? formatMoney(
                  sale.manualTender.changeDueMinor,
                  sale.manualTender.currency,
                )
              : "—"}
          </strong>
        </div>
      ) : null}
      {sale.paymentMethod ? (
        <div className="register-total-row">
          <span>Tender</span>
          <span>
            {paymentMethodLabel(sale.paymentMethod)}
            {sale.tenderBrand ? ` · ${sale.tenderBrand}` : ""}
            {sale.providerRefundable === false ? " (Cash refund only)" : ""}
          </span>
        </div>
      ) : null}

      {completed ? (
        <div className="register-action-row">
          {!handedOver ? (
            <button
              type="button"
              className="register-primary-btn"
              disabled={props.busyAction !== null}
              onClick={() => void props.onHandOverNow()}
            >
              {props.busyAction === "handover" ? "Handing over…" : "Hand over now"}
            </button>
          ) : (
            <p>Handed over to customer.</p>
          )}
          <ReceiptPrintControl
            organisationId={props.organisationId}
            checkoutId={sale.checkoutId}
          />
          <button
            type="button"
            className="register-secondary-btn"
            onClick={props.onNewSale}
          >
            {handedOver ? "New sale" : "Send to queue & new sale"}
          </button>
        </div>
      ) : (
        <div className="register-tender-section">
          <div className="register-action-row">
            <button
              type="button"
              className="register-primary-btn"
              disabled={props.busyAction !== null}
              onClick={() => void props.onCheckTerminal()}
            >
              {props.busyAction === "reconcile" ? "Checking…" : "Check terminal"}
            </button>
            {sale.state === "collecting" ? (
              <button
                type="button"
                className="register-secondary-btn"
                disabled={props.busyAction !== null}
                onClick={() => void props.onCancelTerminal()}
              >
                {props.busyAction === "cancel" ? "Cancelling…" : "Cancel collection"}
              </button>
            ) : null}
          </div>
          {props.canSwitchToCash ? (
            <div className="register-tender-section">
              <input
                type="number"
                min={0}
                className="register-cash-input"
                aria-label="Cash received to settle sale"
                placeholder="Cash received (leave empty for exact)"
                value={props.cashInput}
                onChange={(event) => props.setCashInput(event.target.value)}
              />
              <button
                type="button"
                className="register-secondary-btn"
                disabled={props.busyAction !== null}
                onClick={() => void props.onSwitchToCash()}
              >
                Switch to cash
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function parseCashMinor(raw: string, defaultTotal: number): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return defaultTotal > 0 ? defaultTotal : null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function paymentMethodLabel(method: CounterRegisterPaymentMethod): string {
  switch (method) {
    case "card":
      return "Card";
    case "felica":
      return "FeliCa";
    case "qr_code":
      return "QR";
  }
}

function setPinnedSaleId(checkoutId: string | null): void {
  const url = new URL(window.location.href);
  if (checkoutId === null) url.searchParams.delete("sale");
  else url.searchParams.set("sale", checkoutId);
  window.history.replaceState(null, "", url.toString());
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The counter register action failed.";
}
