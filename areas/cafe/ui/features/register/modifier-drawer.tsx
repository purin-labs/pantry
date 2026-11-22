import React from "react";
import type {
  CounterRegisterMenuEntry,
  CounterRegisterModifierGroup,
} from "@purin-labs/control-api";
import { SideDrawer } from "@purin-labs/ui/index";

export type ModifierDrawerSelection = Readonly<{
  entry: CounterRegisterMenuEntry;
  modifierOptionIds: readonly string[];
  quantity: number;
}>;

export function RegisterModifierDrawer(
  props: Readonly<{
    entry: CounterRegisterMenuEntry | null;
    close: () => void;
    onAdd: (selection: ModifierDrawerSelection) => void;
  }>,
): React.ReactNode {
  const [selected, setSelected] = React.useState<Record<string, readonly string[]>>({});
  const [quantity, setQuantity] = React.useState(1);

  React.useEffect(() => {
    if (props.entry === null) return;
    const defaults: Record<string, readonly string[]> = {};
    for (const group of props.entry.modifierGroups) {
      defaults[group.modifierGroupId] =
        group.minimumSelections > 0 && group.options.length > 0
          ? group.options
              .slice(0, group.minimumSelections)
              .map((opt) => opt.modifierOptionId)
          : [];
    }
    setSelected(defaults);
    setQuantity(1);
  }, [props.entry]);

  const entry = props.entry;
  const chosenIds =
    entry === null
      ? []
      : entry.modifierGroups.flatMap(
          (group) => selected[group.modifierGroupId] ?? [],
        );
  const deltaMinor =
    entry === null
      ? 0
      : entry.modifierGroups.reduce((sum, group) => {
          const picked = new Set(selected[group.modifierGroupId] ?? []);
          return (
            sum +
            group.options
              .filter((opt) => picked.has(opt.modifierOptionId))
              .reduce((acc, opt) => acc + opt.priceDeltaMinor, 0)
          );
        }, 0);
  const unitMinor = (entry?.unitPrice.amountMinor ?? 0) + deltaMinor;
  const lineTotalMinor = unitMinor * quantity;
  const isValid =
    entry !== null &&
    entry.modifierGroups.every((group) => {
      const count = (selected[group.modifierGroupId] ?? []).length;
      return (
        count >= group.minimumSelections &&
        (group.maximumSelections <= 0 || count <= group.maximumSelections)
      );
    });

  function toggleOption(
    group: CounterRegisterModifierGroup,
    optionId: string,
  ): void {
    setSelected((prev) => {
      const current = prev[group.modifierGroupId] ?? [];
      if (group.maximumSelections === 1) {
        const next =
          current.includes(optionId) && group.minimumSelections === 0
            ? []
            : [optionId];
        return { ...prev, [group.modifierGroupId]: next };
      }
      if (current.includes(optionId)) {
        return {
          ...prev,
          [group.modifierGroupId]: current.filter((id) => id !== optionId),
        };
      }
      if (
        group.maximumSelections > 0 &&
        current.length >= group.maximumSelections
      ) {
        return prev;
      }
      return {
        ...prev,
        [group.modifierGroupId]: [...current, optionId],
      };
    });
  }

  return (
    <SideDrawer
      open={entry !== null}
      title={entry?.title ?? "Customize item"}
      close={props.close}
      footer={
        entry === null ? undefined : (
          <button
            type="button"
            className="register-primary-btn"
            disabled={!isValid}
            onClick={() => {
              props.onAdd({
                entry,
                modifierOptionIds: chosenIds,
                quantity,
              });
              props.close();
            }}
          >
            Add {quantity} · {formatMoney(lineTotalMinor, entry.unitPrice.currency)}
          </button>
        )
      }
    >
      {entry === null ? null : (
        <div className="side-drawer-body">
          {entry.description ? <p>{entry.description}</p> : null}
          {entry.modifierGroups.map((group) => {
            const picked = selected[group.modifierGroupId] ?? [];
            const isRadio = group.maximumSelections === 1;
            return (
              <section
                key={group.modifierGroupId}
                className="register-modifier-group"
              >
                <h3>
                  {group.name}
                  {group.minimumSelections > 0 ? " (Required)" : ""}
                </h3>
                {group.options.map((opt) => {
                  const checked = picked.includes(opt.modifierOptionId);
                  return (
                    <label
                      key={opt.modifierOptionId}
                      className="register-modifier-option"
                    >
                      <span>
                        <input
                          type={isRadio ? "radio" : "checkbox"}
                          name={group.modifierGroupId}
                          checked={checked}
                          onChange={() =>
                            toggleOption(group, opt.modifierOptionId)
                          }
                        />{" "}
                        {opt.name}
                      </span>
                      <span>
                        {opt.priceDeltaMinor > 0
                          ? `+${formatMoney(opt.priceDeltaMinor, opt.currency)}`
                          : "Included"}
                      </span>
                    </label>
                  );
                })}
              </section>
            );
          })}
          <div className="register-basket-controls">
            <span>Quantity</span>
            <button
              type="button"
              className="register-qty-btn"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span>{quantity}</span>
            <button
              type="button"
              className="register-qty-btn"
              onClick={() => setQuantity((q) => Math.min(20, q + 1))}
            >
              +
            </button>
          </div>
        </div>
      )}
    </SideDrawer>
  );
}

export function formatMoney(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "JPY") {
    return `¥${amountMinor.toLocaleString("ja-JP")}`;
  }
  return `${code} ${(amountMinor / 100).toFixed(2)}`;
}
