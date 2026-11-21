#!/usr/bin/env node
// Fails when the Portal builds a dropdown without the shared Select.
//
// Every Portal dropdown is the Base UI Select in apps/portal/src/ui/select.tsx
// (Select.Root, Select.Trigger, Select.Value, Select.Popup, Select.Item, ...).
// Its stylesheet, ui/select.css, owns the caret. This check refuses, in Portal
// source:
//   1. a raw <select>, document.createElement("select"), an <optgroup>, or an
//      <option> outside a file that renders a <datalist>;
//   2. an import of @base-ui/react/select outside ui/select.tsx;
//   3. a <Select.Root> without `items`, because Select.Value then shows the
//      raw value instead of the label;
// and, in Portal CSS outside ui/select.css:
//   4. a rule whose subject is a `select` element (there is none; target
//      .pantry-select-trigger), or a rule that names .pantry-select-icon.
//
//   node scripts/check-portal-select.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /^apps\/portal\/src\/.+\.(ts|tsx)$/;
const STYLE = /^apps\/portal\/src\/.+\.css$/;
const COMPONENT = "apps/portal/src/ui/select.tsx";
const COMPONENT_STYLE = "apps/portal/src/ui/select.css";
const USE = "Use Select from apps/portal/src/ui/select.tsx.";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "apps/portal/src"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

function read(file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null; // listed by git but deleted in the working tree
  }
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// Blanks comments, and string literals when `strings` is set, but keeps every
// newline, so that indexes and line numbers stay true. A quoted string ends at
// its line, so an apostrophe in JSX text blanks at most the rest of one line.
function blank(text, strings) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") (out += " "), (i += 1);
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i += 1) out += text[i] === "\n" ? "\n" : " ";
    } else if (strings && (ch === '"' || ch === "'" || ch === "`")) {
      out += " ";
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (ch !== "`" && text[i] === "\n") break;
        if (text[i] === "\\") (out += " "), (i += 1);
        out += text[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      if (text[i] === ch) (out += " "), (i += 1);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// The JSX opening tag that starts at `start`, up to its closing `>`.
function openingTag(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

const errors = [];

for (const file of files.filter((f) => SOURCE.test(f) && f !== COMPONENT)) {
  const text = read(file);
  if (text === null) continue;
  const code = blank(text, true);
  const withStrings = blank(text, false);
  const at = (index) => `${file}:${lineAt(text, index)}`;
  for (const match of code.matchAll(/<select(?=[\s>/])/g))
    errors.push(`${at(match.index)} has a raw <select>. ${USE}`);
  for (const match of code.matchAll(/<optgroup(?=[\s>/])/g))
    errors.push(
      `${at(match.index)} has an <optgroup>. Use Select.Group and Select.GroupLabel.`,
    );
  if (!/<datalist(?=[\s>/])/.test(code))
    for (const match of code.matchAll(/<option(?=[\s>/])/g))
      errors.push(`${at(match.index)} has an <option>. Use Select.Item.`);
  for (const match of withStrings.matchAll(
    /createElement\(\s*["'`]select["'`]/g,
  ))
    errors.push(`${at(match.index)} creates a raw select. ${USE}`);
  for (const match of withStrings.matchAll(
    /from\s+["']@base-ui\/react\/select["']|import\(\s*["']@base-ui\/react\/select["']/g,
  ))
    errors.push(`${at(match.index)} imports @base-ui/react/select. ${USE}`);
  for (const match of code.matchAll(/<Select\.Root(?=[\s>])/g)) {
    const tag = openingTag(code, match.index);
    if (!/\sitems\s*=|\{\s*\.\.\./.test(tag))
      errors.push(
        `${at(match.index)} has a <Select.Root> without items. Pass the value and label pairs, so that Select.Value shows the label.`,
      );
  }
}

// The subject of a selector is its last compound. A select inside :has() or
// :not() is a condition on another element, not the subject.
function subjects(selectorList) {
  return splitTop(selectorList, ",").map((selector) => {
    const compounds = splitTop(selector.trim(), /[\s>+~]/);
    return removeFunctions(compounds.at(-1) ?? "", ["has", "not"]);
  });
}

function splitTop(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    const splits =
      depth === 0 &&
      (typeof separator === "string" ? ch === separator : separator.test(ch));
    if (splits) {
      if (current.trim()) parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function removeFunctions(compound, names) {
  let out = compound;
  for (const name of names) {
    let start = out.indexOf(`:${name}(`);
    while (start !== -1) {
      let depth = 0;
      let end = start + name.length + 1;
      for (; end < out.length; end += 1) {
        if (out[end] === "(") depth += 1;
        else if (out[end] === ")" && --depth === 0) break;
      }
      out = out.slice(0, start) + out.slice(end + 1);
      start = out.indexOf(`:${name}(`);
    }
  }
  return out;
}

for (const file of files.filter(
  (f) => STYLE.test(f) && f !== COMPONENT_STYLE,
)) {
  const text = read(file);
  if (text === null) continue;
  const css = blank(text, false);
  for (const match of css.matchAll(/([^{};]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith("@")) continue;
    const index = match.index + match[1].indexOf(prelude);
    const line = `${file}:${lineAt(text, index)}`;
    if (/\.pantry-select-icon(?![\w-])/.test(prelude))
      errors.push(
        `${line} styles .pantry-select-icon. apps/portal/src/ui/select.css owns the caret.`,
      );
    if (
      subjects(prelude).some((subject) =>
        /(^|[\s(,])select(?![\w-])/.test(subject),
      )
    )
      errors.push(
        `${line} styles a select element, and the Portal has none. Target .pantry-select-trigger, the Select trigger.`,
      );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(
  "portal select: every dropdown uses the Base UI Select from ui/select.tsx",
);
