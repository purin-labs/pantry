/** The hobs of the FR10 recipe benches: the same four in each recipe model. */
export type InductionHob =
  "maruzen" | "vollrath" | "panasonic-kz-ck1402" | "rinnai-rsb-150pj";

/** The hob choices of a scenario form. */
export const INDUCTION_HOB_ITEMS = [
  { value: "maruzen", label: "Maruzen MIH-02C (2.0 kW)" },
  { value: "vollrath", label: "Vollrath Mirage Pro 59500P" },
  {
    value: "panasonic-kz-ck1402",
    label: "Panasonic KZ-CK1402 (1.4 kW / 100 V)",
  },
  { value: "rinnai-rsb-150pj", label: "Rinnai RSB-150PJ (5.23 kW gas)" },
];

/** The hob of a chosen value; Maruzen when the value names none. */
export function inductionHob(value: string): InductionHob {
  return value === "vollrath" ||
    value === "panasonic-kz-ck1402" ||
    value === "rinnai-rsb-150pj"
    ? value
    : "maruzen";
}

/** The hob's name in a station readout. */
export function inductionHobTitle(hob: InductionHob): string {
  return hob === "maruzen"
    ? "Maruzen MIH-02C (2.0 kW)"
    : hob === "vollrath"
      ? "Vollrath Mirage Pro 59500P"
      : hob === "rinnai-rsb-150pj"
        ? "Rinnai RSB-150PJ (5.23 kW gas)"
        : "Panasonic KZ-CK1402 (1.4 kW)";
}
