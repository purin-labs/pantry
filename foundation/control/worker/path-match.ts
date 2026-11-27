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

/** The capture groups of a pattern, or null when the path does not match. */
export function pathCaptures(
  pathname: string,
  pattern: RegExp,
): readonly string[] | null {
  const result = pattern.exec(pathname);
  return result === null ? null : result.slice(1);
}

/**
 * A decoded capture of a pattern that matched. A missing capture is a
 * programmer error, and a malformed escape throws its URIError.
 */
export function decodeCapture(value: string | undefined): string {
  if (value === undefined) throw new Error("Control route capture is missing");
  return decodeURIComponent(value);
}

/**
 * The decoded Organisation id of `/v1/control/organisations/<id>/<suffix>`,
 * or null when the path is not that path.
 */
export function organisationPath(
  pathname: string,
  suffix: string,
): string | null {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const captures = pathCaptures(
    pathname,
    new RegExp(`^/v1/control/organisations/([^/]+)/${escaped}$`, "u"),
  );
  return captures === null ? null : decodeCapture(captures[0]);
}

/**
 * The decoded Organisation id and the decoded second capture of a pattern,
 * or null when the path does not match.
 */
export function organisationPathPair(
  pathname: string,
  pattern: RegExp,
): Readonly<{ organisationIdRaw: string; valueRaw: string }> | null {
  const result = pattern.exec(pathname);
  return result?.[1] === undefined || result[2] === undefined
    ? null
    : {
        organisationIdRaw: decodeURIComponent(result[1]),
        valueRaw: decodeURIComponent(result[2]),
      };
}
