// The form of scripts/clones-ratchet.json, for scripts/check-clones.mjs and
// for scripts/refactor-17/move-module.mjs, which renames the files of a pair.

/** The key of a pair of files: the two names in order, with " = " between. */
export function clonePairKey(first, second) {
  return [first, second].sort().join(" = ");
}

/**
 * The text of the baseline: the totals, then one line for each pair in the
 * order of the keys, so that a change of one pair is one line.
 */
export function clonesBaselineText(total, pairs) {
  const lines = Object.entries(pairs)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([pair, entry]) =>
        `    ${JSON.stringify(pair)}: ${JSON.stringify(entry)}`,
    );
  return `{\n  "total": ${JSON.stringify(total)},\n  "pairs": {\n${lines.join(",\n")}\n  }\n}\n`;
}
