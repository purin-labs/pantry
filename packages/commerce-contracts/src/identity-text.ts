import { Type } from "typebox";
// Unicode White_Space, as used by Rust str::trim.
const whitespace =
  "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
export const trimmedIdentityTextSchema = Type.String({
  minLength: 1,
  pattern: `^[^${whitespace}](?:[\\s\\S]*[^${whitespace}])?(?![\\s\\S])`,
});
export const nonBlankTextSchema = Type.String({ pattern: `[^${whitespace}]` });

/** Existing HTTP envelope text uses JavaScript trim, including U+FEFF and excluding U+0085. */
export const javascriptTrimmedTextSchema = Type.String({
  minLength: 1,
  pattern: "^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])",
});
