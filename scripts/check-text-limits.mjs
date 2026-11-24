#!/usr/bin/env node
// Fails when a file adds a bare `maxLength` limit to a string schema (FND-11).
//
// TypeBox `maxLength` counts grapheme clusters, so one letter with many
// combining marks counts as one: it is no size limit. A string schema that
// sets `maxLength` goes through `textLimit` of @purin-labs/contract-schema,
// which adds a check of the code points or the UTF-8 bytes.
//
// A string schema is an object literal that is an argument of `Type.String`,
// or that has `type: "string"` or a `type` array with "string". Its
// `maxLength` is bare when no `textLimit(...)` call holds the object. The
// baseline in scripts/text-limits-ratchet.json lists each file that still
// has bare limits, with its count. A listed file may not add one, and a new
// file may not have one. When a file loses one, lower its entry with --update.
//
//   node scripts/check-text-limits.mjs            check
//   node scripts/check-text-limits.mjs --update   lower entries, drop files at zero
//   node scripts/check-text-limits.mjs --init     write the baseline from the tree
import { createRequire } from "node:module";

import { runCountRatchet } from "./lib/count-ratchet.mjs";
import { SOURCE_ROOTS, inFolders } from "./lib/source-roots.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SOURCE = /\.(ts|tsx|mts)$/;
const EXCLUDED = [
  /(^|\/)node_modules\//,
  /(^|\/)tests?\//,
  /\.d\.(ts|mts)$/,
  /\.test\.[a-z]+$/,
  /\.type-fixtures\.ts$/,
  // The generated action registry's argsSchema is a JSON description of the
  // arguments; its generated parser checks each size with `.length`.
  /^foundation\/authority\/generated\/action-registry\.ts$/,
  /^workers\/platform\/scripts\/generate-actions\.ts$/,
];
const LIMIT_CALL = "textLimit";

runCountRatchet({
  name: "text limits ratchet",
  script: "scripts/check-text-limits.mjs",
  baseline: "scripts/text-limits-ratchet.json",
  count: (file, read) =>
    inFolders(file, SOURCE_ROOTS) &&
    SOURCE.test(file) &&
    !EXCLUDED.some((pattern) => pattern.test(file)) &&
    read().includes("maxLength")
      ? bareLimits(file, read())
      : 0,
  refusal: (file, found, allowed) =>
    `${file} has ${found} string schemas with a bare maxLength, ${allowed} allowed. TypeBox maxLength counts grapheme clusters; wrap the schema in textLimit of @purin-labs/contract-schema.`,
});

function bareLimits(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node) => {
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      propertyName(node.name) === "maxLength" &&
      isStringSchema(node.parent) &&
      !insideLimitCall(node.parent)
    )
      count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : undefined;
}

function isStringSchema(object) {
  if (!ts.isObjectLiteralExpression(object)) return false;
  const parent = object.parent;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.includes(object) &&
    calleeName(parent) === "String"
  )
    return true;
  return object.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === "type" &&
      namesString(property.initializer),
  );
}

function namesString(value) {
  const inner = ts.isAsExpression(value) ? value.expression : value;
  if (ts.isStringLiteral(inner)) return inner.text === "string";
  return (
    ts.isArrayLiteralExpression(inner) &&
    inner.elements.some(
      (element) => ts.isStringLiteral(element) && element.text === "string",
    )
  );
}

function calleeName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function insideLimitCall(node) {
  for (let child = node, parent = node.parent; parent;) {
    if (
      ts.isCallExpression(parent) &&
      calleeName(parent) === LIMIT_CALL &&
      parent.arguments[0] === child
    )
      return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}
