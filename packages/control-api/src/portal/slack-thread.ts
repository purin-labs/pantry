export function parseSharedThreadResponse(raw: unknown): string | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("ok" in raw) ||
    raw.ok !== true ||
    !("threadUrl" in raw) ||
    (raw.threadUrl !== null && typeof raw.threadUrl !== "string")
  ) {
    throw new Error("invalid shared thread response");
  }
  return raw.threadUrl;
}
