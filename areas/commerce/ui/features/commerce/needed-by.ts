/**
 * A production request is needed by a date in the operator's local zone. The
 * request stores the start of that day (00:00 local), so the batch is ready
 * when the shop opens on that date. Older requests can hold another time.
 */

/** The local `YYYY-MM-DD` value of a date input for an instant. */
export function neededByDateInput(instant: Date): string {
  const year = String(instant.getFullYear()).padStart(4, "0");
  const month = String(instant.getMonth() + 1).padStart(2, "0");
  const day = String(instant.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Tomorrow in the local zone: the default date of a new request. */
export function defaultNeededByDate(now: Date): string {
  return neededByDateInput(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
  );
}

/** The ISO timestamp for the start of a local `YYYY-MM-DD` date. */
export function neededByTimestamp(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new Error("Choose the date the batch is needed.");
  const start = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  if (neededByDateInput(start) !== date)
    throw new Error("Choose the date the batch is needed.");
  return start.toISOString();
}

/** The date alone at the start of a local day; else the date and time. */
export function formatNeededBy(value: string): string {
  const instant = new Date(value);
  return instant.getHours() === 0 &&
    instant.getMinutes() === 0 &&
    instant.getSeconds() === 0
    ? instant.toLocaleDateString()
    : instant.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
