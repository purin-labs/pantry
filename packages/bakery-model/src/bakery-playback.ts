export type BakeryPlaybackAction =
  | Readonly<{
      kind: "play" | "pause" | "restart" | "next_event";
      seconds?: never;
      speed?: never;
    }>
  | Readonly<{ kind: "seek"; seconds: number; speed?: never }>
  | Readonly<{ kind: "speed"; speed: number; seconds?: never }>;

export function parseBakeryPlaybackAction(
  raw: unknown,
): BakeryPlaybackAction | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !("kind" in raw)
  )
    return null;
  const keys = Object.keys(raw);
  switch (raw.kind) {
    case "play":
    case "pause":
    case "restart":
    case "next_event":
      return keys.length === 1 ? { kind: raw.kind } : null;
    case "seek":
      return keys.length === 2 &&
        "seconds" in raw &&
        typeof raw.seconds === "number" &&
        Number.isFinite(raw.seconds) &&
        raw.seconds >= 0
        ? { kind: "seek", seconds: raw.seconds }
        : null;
    case "speed":
      return keys.length === 2 &&
        "speed" in raw &&
        typeof raw.speed === "number" &&
        Number.isFinite(raw.speed) &&
        raw.speed > 0
        ? { kind: "speed", speed: raw.speed }
        : null;
    default:
      return null;
  }
}
