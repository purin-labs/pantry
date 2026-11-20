/**
 * The path helpers of a route matcher (Refactor 17). A matcher gives a path
 * and a pattern, and reads up to four segments.
 */

/** The four capture groups of a pattern; a group with no match is "". */
export function matchPath(
  pathname: string,
  pattern: RegExp,
): readonly [string, string, string, string] | null {
  const result = pattern.exec(pathname);
  if (result === null) return null;
  return [result[1] ?? "", result[2] ?? "", result[3] ?? "", result[4] ?? ""];
}

/** A decoded path segment; a segment that does not decode is "". */
export function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
