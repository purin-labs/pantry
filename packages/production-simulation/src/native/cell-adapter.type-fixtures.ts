import type { NativeCell } from "./cell-adapter.ts";

declare const espresso: Extract<
  NativeCell,
  { fixture: "persistent-espresso/1" }
>;
declare const robot: Exclude<
  NativeCell,
  { fixture: "persistent-espresso/1" | "persistent-pour-over/1" }
>;
declare const pourOver: Extract<
  NativeCell,
  { fixture: "persistent-pour-over/1" }
>;

// @ts-expect-error Robot fixtures cannot carry an espresso selection through a spread.
const robotWithAppliance: NativeCell = { ...robot, appliance: "eagle-one" };
// @ts-expect-error An unsupported appliance cannot enter the core through a literal.
const unsupportedMachine: NativeCell = { ...espresso, appliance: "unknown" };
const { appliance: selected, ...missingMachine } = espresso;
// @ts-expect-error Espresso definitions require an explicit machine in core code.
const missingSelection: NativeCell = missingMachine;
// @ts-expect-error Robot fixtures cannot carry a pour-over station through a spread.
const robotWithStation: NativeCell = { ...robot, station: pourOver.station };
// @ts-expect-error A pour-over station cannot select an espresso machine.
const stationWithMachine: NativeCell = { ...pourOver, appliance: "linea" };
const { station: prepared, ...missingStation } = pourOver;
// @ts-expect-error Pour-over definitions require their prepared station in core code.
const missingPreparation: NativeCell = missingStation;
const colderKettle: NativeCell = {
  ...pourOver,
  // @ts-expect-error A kettle holds water at the declared 93 °C only.
  station: { ...pourOver.station, kettleWaterC: 80 },
};
void [
  robotWithAppliance,
  unsupportedMachine,
  missingSelection,
  selected,
  robotWithStation,
  stationWithMachine,
  missingPreparation,
  prepared,
  colderKettle,
];
