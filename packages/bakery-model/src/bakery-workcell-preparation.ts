export type BakeryRehearsalExample =
  "table-to-rack" | "table-to-oven" | "oven-cycle" | "rack-cycle";

export type BakeryWorkcellPreparation = Readonly<{ dispatchSeconds: number }> &
  (
    | Readonly<{ source: "example"; example: BakeryRehearsalExample }>
    | Readonly<{ source: "recording"; example?: never }>
  );

export function parseBakeryWorkcellPreparation(
  raw: unknown,
): BakeryWorkcellPreparation | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !("dispatchSeconds" in raw) ||
    typeof raw.dispatchSeconds !== "number" ||
    !Number.isInteger(raw.dispatchSeconds) ||
    raw.dispatchSeconds < 0 ||
    raw.dispatchSeconds > 43_200 ||
    !("source" in raw)
  )
    return null;
  const dispatchSeconds = raw.dispatchSeconds;
  const keys = Object.keys(raw);
  switch (raw.source) {
    case "recording":
      return keys.length === 2
        ? { source: "recording", dispatchSeconds }
        : null;
    case "example":
      if (keys.length !== 3 || !("example" in raw)) return null;
      switch (raw.example) {
        case "table-to-rack":
        case "table-to-oven":
        case "oven-cycle":
        case "rack-cycle":
          return { source: "example", example: raw.example, dispatchSeconds };
        default:
          return null;
      }
    default:
      return null;
  }
}
