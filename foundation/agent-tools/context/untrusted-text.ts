/**
 * Normalization for text that came from outside.
 *
 * Product descriptions, order notes, customer messages, supplier replies,
 * device fault text and imported records are things the agent is reading
 * about. This makes them
 * safe to display and unambiguous to read: it does not make them safe to obey.
 * Authority, approval, and effect boundaries do that, and this function is no
 * substitute for them.
 *
 * External content may still legitimately inform a search term or a draft. The
 * rule it enforces is narrower: what an operator sees is what the record
 * contains, and no hidden character can make a value read as something else.
 */

/** How much text one source may contribute, before an excerpt is taken. */
type UntrustedTextSource = "display_name" | "description" | "note" | "message";

const SOURCE_LIMITS: Readonly<Record<UntrustedTextSource, number>> = {
  display_name: 200,
  description: 4_000,
  note: 2_000,
  message: 4_000,
};

type NormalizedUntrustedText = Readonly<{
  /** Safe to display and to place in a prompt as quoted evidence. */
  text: string;
  /** True when the source was longer than its limit and was cut. */
  truncated: boolean;
  /** True when characters were removed, so a reader can be told. */
  sanitized: boolean;
}>;

/**
 * Whether one code point is removed before the text is shown.
 *
 * C0 and C1 controls apart from tab and newline, the zero width marks, and the
 * bidirectional overrides and isolates. Each of these can make displayed text
 * differ from stored text, which is what turns a product name into a place to
 * hide something.
 */
function isUnsafeCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) return false;
  if (codePoint < 0x20) return true;
  if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
  return codePoint >= 0x2066 && codePoint <= 0x2069;
}

export function normalizeUntrustedText(
  value: string,
  source: UntrustedTextSource,
): NormalizedUntrustedText {
  const limit = SOURCE_LIMITS[source];
  let sanitized = false;
  let kept = "";
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isUnsafeCodePoint(codePoint)) {
      sanitized = true;
      continue;
    }
    kept += character;
  }
  const collapsed = kept
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const characters = [...collapsed];
  const truncated = characters.length > limit;
  return {
    text: truncated ? characters.slice(0, limit).join("") : collapsed,
    truncated,
    sanitized,
  };
}
