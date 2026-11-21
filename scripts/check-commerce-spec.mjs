#!/usr/bin/env node
// Fails when the Commerce spec (services/commerce/docs/spec.md)
// drifts from the code:
//
// - Appendix A must list every route of src/http-routes.ts and of each
//   built-in plugin's src/plugins/<plugin>/routes.ts, with the access
//   that src/api-access.ts gives it (a scope, `operator` or `buyer`), and no
//   route that the code does not have.
// - Appendix B must list every scope of COMMERCE_API_SCOPES
//   (packages/commerce-contracts/src/records/api-access.ts).
// - Appendix C must list every event kind that src/event-feed.ts and each
//   built-in plugin's src/plugins/<plugin>/events.ts name, with the command
//   that makes it.
// - Appendix D must show every state machine of
//   packages/commerce-contracts/src/commerce-machines.ts: its states, its
//   transitions and a diagram. Each machine must name a section of the spec.
// - Every entry must name a section of the spec, and every journey file that
//   the spec names must exist.
//
// `--write` rewrites the four appendices from the code. It keeps the
// section (or the scope text) of each entry that the spec already has; a new
// entry gets `?`, which fails the check until a person fills it in.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const service = join(root, "services/commerce");
const specPath = join(service, "docs/spec.md");
const write = process.argv.includes("--write");
const CODE_COLUMNS = new Set([
  "Method",
  "Path",
  "Route kind",
  "Scope",
  "Event kind",
  "Command kind",
  "State",
  "Event",
  "To",
]);

const routes = readRoutes();
const scopes = readScopes();
const events = readEvents();
const machines = readMachines();

let spec = readFileSync(specPath, "utf8");
const failures = [];

const routeRows = tableRows(spec, "routes");
const knownRouteSections = new Map(
  routeRows.map((row) => [`${row[0]} ${row[1]}`, row[row.length - 1]]),
);
const scopeRows = tableRows(spec, "scopes");
const knownScopeText = new Map(scopeRows.map((row) => [row[0], row[1]]));
const eventRows = tableRows(spec, "events");
const knownEventSections = new Map(
  eventRows.map((row) => [`${row[0]} ${row[1]}`, row[2]]),
);

const routeTable = table(
  ["Method", "Path", "Route kind", "Access", "Command", "Section"],
  routes.map((route) => [
    route.method,
    route.path,
    route.kind,
    route.access,
    route.command,
    knownRouteSections.get(`${route.method} ${route.path}`) ?? "?",
  ]),
);
const scopeTable = table(
  ["Scope", "Opens"],
  scopes.map((scope) => [scope, knownScopeText.get(scope) ?? "?"]),
);
const eventTable = table(
  ["Event kind", "Command kind", "Section"],
  events.map((event) => [
    event.kind,
    event.command,
    knownEventSections.get(`${event.kind} ${event.command}`) ?? "?",
  ]),
);

const expected = [
  ["routes", routeTable],
  ["scopes", scopeTable],
  ["events", eventTable],
  ["machines", machineText(machines)],
].reduce((text, [name, body]) => replaceBlock(text, name, body), spec);

if (write) {
  writeFileSync(specPath, expected);
  spec = expected;
} else if (expected !== spec) {
  failures.push(
    "The appendices do not match the code. Run `node scripts/check-commerce-spec.mjs --write`, then give each `?` entry a section.",
  );
}

const sections = new Set(
  [...spec.matchAll(/^## (\d+)\. /gmu)].map((match) => match[1]),
);
for (const [name, column] of [
  ["routes", 5],
  ["scopes", 1],
  ["events", 2],
]) {
  for (const row of tableRows(spec, name)) {
    const cell = row[column];
    if (cell === "?")
      failures.push(`${name}: ${row[0]} ${row[1] ?? ""} has no section`);
    else if (name !== "scopes" && !sections.has(cell.replace(/^§/u, "")))
      failures.push(
        `${name}: ${row[0]} names section ${cell}, which the spec does not have`,
      );
  }
}

for (const machine of machines)
  if (!sections.has(String(machine.specSection)))
    failures.push(
      `machines: ${machine.name} names section ${machine.specSection}, which the spec does not have`,
    );

for (const journey of new Set(spec.match(/[\w./-]+\.test\.ts/gu) ?? [])) {
  const path = journey.startsWith("tests/e2e/")
    ? join(root, "services/platform", journey)
    : join(service, "tests", journey.replace(/^tests\//u, ""));
  if (!existsSync(path))
    failures.push(`The spec names ${journey}, which does not exist`);
}

if (failures.length > 0) {
  console.error(`commerce spec: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `commerce spec: ${routes.length} routes, ${scopes.length} scopes, ${events.length} event kinds and ${machines.length} state machines match the code`,
);

function readRoutes() {
  const routeSource = source("src/http-routes.ts");
  const accessSource = source("src/api-access.ts");
  const found = [];
  // The core's routes, then each plugin's, with its buyer kinds and access.
  const plugins = readdirSync(join(service, "src/plugins"), {
    withFileTypes: true,
  }).filter(
    (entry) =>
      entry.isDirectory() &&
      existsSync(join(service, "src/plugins", entry.name, "routes.ts")),
  );
  const buyer = new Set(stringArray(routeSource, "BUYER_ROUTE_KINDS"));
  const access = stringObject(accessSource, "ADMIN_ROUTE_ACCESS");
  const routeSources = [routeSource];
  for (const entry of plugins) {
    const file = source(`src/plugins/${entry.name}/routes.ts`);
    const prefix = entry.name.replaceAll("-", "_").toUpperCase();
    for (const kind of stringArray(file, `${prefix}_BUYER_ROUTE_KINDS`))
      buyer.add(kind);
    for (const [kind, scope] of stringObject(file, `${prefix}_ROUTE_ACCESS`))
      access.set(kind, scope);
    routeSources.push(file);
  }
  for (const file of routeSources)
    visit(file, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "route" &&
        node.arguments.length >= 3 &&
        node.arguments.slice(0, 3).every(ts.isStringLiteral)
      ) {
        const [method, path, kind] = node.arguments
          .slice(0, 3)
          .map((argument) => argument.text);
        // The command that the body becomes (Plan 80 step 1), if any.
        const commandArgument = node.arguments[3];
        const command =
          commandArgument !== undefined && ts.isStringLiteral(commandArgument)
            ? `\`${commandArgument.text}\``
            : "";
        const routeAccess = buyer.has(kind) ? "buyer" : access.get(kind);
        if (routeAccess === undefined)
          throw new Error(`Route ${kind} has no access in src/api-access.ts`);
        found.push({ method, path, kind, access: routeAccess, command });
      }
    });
  return found;
}

function readScopes() {
  return stringArray(
    ts.createSourceFile(
      "api-access.ts",
      readFileSync(
        join(root, "packages/commerce-contracts/src/records/api-access.ts"),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
    ),
    "COMMERCE_API_SCOPES",
  );
}

// The kinds that the feed names: the command table, and the commands that
// eventKind() names on its own. Any other command gives `<resource>.updated`.
function readEvents() {
  const feed = source("src/event-feed.ts");
  const commandEvents = stringObject(feed, "COMMAND_EVENTS");
  for (const entry of readdirSync(join(service, "src/plugins"), {
    withFileTypes: true,
  }))
    if (
      entry.isDirectory() &&
      existsSync(join(service, "src/plugins", entry.name, "events.ts"))
    )
      for (const [command, kind] of stringObject(
        source(`src/plugins/${entry.name}/events.ts`),
        `${entry.name.replaceAll("-", "_").toUpperCase()}_COMMAND_EVENTS`,
      ))
        commandEvents.set(command, kind);
  const found = [...commandEvents].map(([command, kind]) => ({
    kind,
    command,
  }));
  visit(feed, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== "eventKind")
      return;
    visit(node, (inner) => {
      if (!ts.isIfStatement(inner)) return;
      const command = commandOf(inner.expression);
      if (command === undefined) return;
      visit(inner.thenStatement, (literal) => {
        if (
          ts.isStringLiteral(literal) &&
          /^[a-z_]+\.[a-z_]+$/u.test(literal.text)
        )
          found.push({ kind: literal.text, command });
      });
    });
  });
  return found.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.command.localeCompare(right.command),
  );
}

// The generated machine tables: COMMERCE_MACHINES names one constant for each
// machine, and each constant is an object literal.
function readMachines() {
  const file = ts.createSourceFile(
    "commerce-machines.ts",
    readFileSync(
      join(root, "packages/commerce-contracts/src/commerce-machines.ts"),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
  );
  const index = initializerOf(file, "COMMERCE_MACHINES");
  if (!ts.isObjectLiteralExpression(index))
    throw new Error("COMMERCE_MACHINES is not an object");
  return index.properties.map((property) => {
    if (
      !ts.isPropertyAssignment(property) ||
      !ts.isIdentifier(property.initializer)
    )
      throw new Error("COMMERCE_MACHINES must name one constant per machine");
    return literalValue(initializerOf(file, property.initializer.text));
  });
}

function literalValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalValue);
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property))
          throw new Error("A machine table holds only plain properties");
        const name = ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : undefined;
        if (name === undefined) throw new Error("A machine key is not plain");
        return [name, literalValue(property.initializer)];
      }),
    );
  throw new Error(`A machine table holds a ${ts.SyntaxKind[node.kind]}`);
}

function machineText(list) {
  return list
    .map((machine, position) => {
      const states = Object.entries(machine.states);
      const diagram = [
        "```mermaid",
        "stateDiagram-v2",
        ...states
          .filter(([, state]) => state.kind === "initial")
          .map(([name]) => `  [*] --> ${name}`),
        ...machine.transitions.flatMap((transition) =>
          transition.from
            .filter((from) => from !== transition.to)
            .map(
              (from) => `  ${from} --> ${transition.to}: ${transition.event}`,
            ),
        ),
        ...states
          .filter(([, state]) => state.kind === "terminal")
          .map(([name]) => `  ${name} --> [*]`),
        "```",
      ].join("\n");
      return [
        `### D.${position + 1} \`${machine.name}\` (§${machine.specSection})`,
        "",
        `States of \`${machine.lifecycle}\`:`,
        "",
        states.some(([, state]) => state.exit !== undefined)
          ? table(
              ["State", "Kind", "Meaning", "Exit"],
              states.map(([name, state]) => [
                name,
                state.kind,
                state.meaning,
                exitText(state.exit),
              ]),
            )
          : table(
              ["State", "Kind", "Meaning"],
              states.map(([name, state]) => [name, state.kind, state.meaning]),
            ),
        "",
        table(
          ["Event", "From", "To", "By", "Guards"],
          machine.transitions.map((transition) => [
            transition.event,
            transition.from.map((from) => `\`${from}\``).join(", "),
            transition.to,
            transition.by.join(", "),
            transition.guards.length === 0
              ? "none"
              : transition.guards.map((guard) => `\`${guard}\``).join(", "),
          ]),
        ),
        "",
        diagram,
      ].join("\n");
    })
    .join("\n\n");
}

// How a state that is not terminal ends (Refactor 15, S1): the alarm pass
// that reads it again, or the surface where staff act on it.
function exitText(exit) {
  if (exit === undefined) return "none";
  return exit.kind === "due"
    ? `due: \`${exit.reconciler}\``
    : `staff: \`${exit.surface}\``;
}

function commandOf(expression) {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isPropertyAccessExpression(expression.left) &&
    expression.left.name.text === "commandKind" &&
    ts.isStringLiteral(expression.right)
  )
    return expression.right.text;
  return undefined;
}

function source(path) {
  return ts.createSourceFile(
    path,
    readFileSync(join(service, path), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function visit(node, callback) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function initializerOf(file, name) {
  let found;
  visit(file, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    )
      found = node.initializer;
  });
  while (
    found !== undefined &&
    (ts.isAsExpression(found) ||
      ts.isSatisfiesExpression(found) ||
      ts.isParenthesizedExpression(found))
  )
    found = found.expression;
  if (found === undefined) throw new Error(`${name} is missing`);
  return found;
}

function stringArray(file, name) {
  const array = initializerOf(file, name);
  if (!ts.isArrayLiteralExpression(array))
    throw new Error(`${name} is not an array`);
  return array.elements
    .filter(ts.isStringLiteral)
    .map((element) => element.text);
}

function stringObject(file, name) {
  const object = initializerOf(file, name);
  if (!ts.isObjectLiteralExpression(object))
    throw new Error(`${name} is not an object`);
  const entries = new Map();
  for (const property of object.properties)
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      ts.isStringLiteral(property.initializer)
    )
      entries.set(property.name.text, property.initializer.text);
  return entries;
}

function blockPattern(name) {
  return new RegExp(
    `(<!-- commerce-spec:${name}:start -->\\n)([\\s\\S]*?)(<!-- commerce-spec:${name}:end -->)`,
    "u",
  );
}

function tableRows(text, name) {
  const block = blockPattern(name).exec(text);
  if (block === null) throw new Error(`The spec has no ${name} block`);
  return block[2]
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^`(.*)`$/u, "$1")),
    );
}

function table(header, rows) {
  const code = (column, cell) =>
    CODE_COLUMNS.has(header[column]) ? `\`${cell}\`` : cell;
  const cells = [
    header,
    ...rows.map((row) => row.map((cell, column) => code(column, cell))),
  ];
  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => row[column].length)),
  );
  const line = (row) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    line(cells[0]),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...cells.slice(1).map(line),
  ].join("\n");
}

function replaceBlock(text, name, body) {
  return text.replace(
    blockPattern(name),
    (_, start, __, end) => `${start}\n${body}\n\n${end}`,
  );
}
