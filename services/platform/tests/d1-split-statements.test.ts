import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMigratedDatabase } from "./sqlite-d1";
import { schemaDatabase } from "./split-topology";

// The deployed schema is split over the global database (`env.DB`) and one
// regional database per placement cell. Most suites run on one combined
// schema, where a statement sent to the wrong database still finds its table.
// These checks read the platform's SQL without running it.
//
// A statement is one string or template literal, with the literals nested in
// its substitutions. A fragment that a statement interpolates by name is
// checked on its own.

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url).href);

// Receivers whose name says which database they are. A local `const` is
// followed to its initialiser, so `env.DB.withSession(…)` kept in `session`
// still reads as the global database.
const GLOBAL_RECEIVER =
  /(?:^|\.)(?:env\.DB|directory|identityDatabase|globalDatabase|manifestDatabase)$/u;
const REGIONAL_RECEIVER = /(?:scope|execution)(?:\.value)?\.database$/iu;

// Functions that prepare a statement on the global database under a name that
// does not say so (`db`, `input.db`), or return a fragment for one. Each was
// traced to `env.DB` at every production caller when it was listed. A new
// function that names a global-only table prepares it on a receiver matching
// GLOBAL_RECEIVER, or is traced the same way and listed here.
const GLOBAL_DATABASE_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  "account-platform/provisioning.ts": [
    "findVerifiedNativeUser",
    "persistProvisionIdentity",
    "readProvisionReplay",
    "readRetainedBinding",
  ],
  "actors/actor-placement-admission.ts": [
    "actorPlacementDirectoryAdmissionPredicate",
  ],
  "actors/actor-relocation.ts": [
    "ensureItemExported",
    "markRelocationItemImported",
    "readRelocationItems",
    "relocationSelect",
  ],
  "actors/actor-restore.ts": [
    "markRestoreItemImported",
    "prepareRestoreItemInsert",
    "readRestoreItems",
    "restoreSelect",
  ],
  "control/oidc.ts": [
    "beginGoogleOidc",
    "completeGoogleOidc",
    "consumeGoogleApprovalCeremony",
  ],
  "credential-vault/root-rotation.ts": [
    "failVaultRootRotation",
    "hasActiveRotation",
    "pauseVaultRootRotation",
    "persistRotationProgress",
    "readVaultRootRotation",
    "resumeVaultRootRotation",
    "startPendingRotation",
    "startVaultRootRotation",
  ],
  "data/control-plane.ts": [
    "issueControlSession",
    "renewControlSession",
    "resolveControlSession",
    "resolveControlSessionById",
    "resolveUser",
    "revokeControlSession",
    "rotateControlSession",
    "upsertUser",
    "validateControlCsrf",
  ],
  "data/onboarding-support-audit.ts": ["operatorSupportAccessStatement"],
  "data/onboarding-support.ts": ["resolveControlSupportRole"],
  "data/organisation.ts": ["ensureSystemUserId"],
  "data/placement-move.ts": [
    "abandonedMoveRecoversSql",
    "openMoveOf",
    "preparePlacementMovePublication",
    "prepareRecoveryRelocationStart",
  ],
  "data/provider-attempt.ts": ["readCurrentProviderManifestVersion"],
  "data/screen-pairing.ts": [
    "claimScreenPairing",
    "countOpenScreenPairings",
    "deleteExpiredScreenPairings",
    "insertScreenPairing",
    "readOpenScreenPairing",
    "readScreenPairingState",
  ],
  "data/shared-rows/placement-row.ts": ["publishOrganisationPlacementMove"],
  "data/slack-installation-records.ts": [
    "prepareSlackDmSelectionAuditEvent",
    "prepareSlackInstallationDisconnectAuditEvent",
    "readSlackConnectionIntegrationAccountId",
  ],
  "data/user-preferences.ts": ["readUserPreferences", "updateUserPreferences"],
  "slack/install-organisation.ts": ["resolveSlackInstallOrganisation"],
  "slack/organisation-routing.ts": [
    "activateSlackInstallation",
    "createSlackInstallation",
    "diagnoseChannelBindingFailure",
    "diagnoseRouteFailure",
    "listSlackOrganisationRouting",
    "parseSlackOrganisationRoutingRow",
    "prepareInitialChannelBinding",
    "prepareReplacementChannelBinding",
    "prepareSlackChannelThreadClaim",
    "prepareSlackDmThreadClaim",
    "prepareSlackRoutingAuditEvent",
    "prepareSlackThreadRouteRead",
    "prepareSoleConnectionDmSelection",
    "readSlackChannelDefault",
    "resolveSlackInstallation",
  ],
};

type Statement = {
  readonly location: string;
  readonly file: string;
  readonly enclosingFunction: string;
  // The resolved receiver of `.prepare(…)`, or null for a fragment.
  readonly receiver: string | null;
  readonly globalOnly: readonly string[];
  readonly regionalOnly: readonly string[];
};

describe("statements on the split D1 topology", function splitStatements() {
  const schema = deployedTables();
  const statements = sourceStatements(schema);

  it("builds the combined test schema from the tables of the two deployed schemas", function combinedSchema() {
    const sqlite = new DatabaseSync(":memory:");
    createMigratedDatabase(sqlite);
    expect([...tableNames(sqlite)].sort()).toEqual(
      [...new Set([...schema.global, ...schema.regional])].sort(),
    );
  });

  it("names the tables of one database in each statement", function oneDatabasePerStatement() {
    // No database holds both sets, so such a statement fails wherever it runs.
    expect(
      statements.filter(namesBothDatabases).map(describeStatement),
    ).toEqual([]);
  });

  it("prepares each statement on a database that holds its tables", function namedReceivers() {
    const misplaced: string[] = [];
    for (const statement of statements) {
      if (statement.receiver === null) continue;
      if (
        GLOBAL_RECEIVER.test(statement.receiver) &&
        statement.regionalOnly.length > 0
      ) {
        misplaced.push(
          `${describeStatement(statement)} is prepared on the global database`,
        );
      }
      if (
        REGIONAL_RECEIVER.test(statement.receiver) &&
        statement.globalOnly.length > 0
      ) {
        misplaced.push(
          `${describeStatement(statement)} is prepared on a regional database`,
        );
      }
    }
    expect(misplaced).toEqual([]);
  });

  it("names global-only tables only where the global database is known", function knownGlobalDatabase() {
    const untraced = new Map<string, Set<string>>();
    for (const statement of statements) {
      if (statement.globalOnly.length === 0) continue;
      if (
        statement.receiver !== null &&
        GLOBAL_RECEIVER.test(statement.receiver)
      )
        continue;
      const functions = untraced.get(statement.file) ?? new Set<string>();
      functions.add(statement.enclosingFunction);
      untraced.set(statement.file, functions);
    }
    const found: Record<string, readonly string[]> = {};
    for (const [file, functions] of [...untraced].sort(byFirst))
      found[file] = [...functions].sort();
    // A function missing from the list names a global-only table on a database
    // nobody has traced. A listed function that is missing here no longer
    // needs its entry.
    expect(found).toEqual(GLOBAL_DATABASE_FUNCTIONS);
  });
});

function deployedTables(): {
  readonly global: ReadonlySet<string>;
  readonly regional: ReadonlySet<string>;
  readonly globalOnly: ReadonlySet<string>;
  readonly regionalOnly: ReadonlySet<string>;
} {
  const global = tableNames(schemaDatabase("migrations-global").sqlite);
  const regional = tableNames(schemaDatabase("migrations-regional").sqlite);
  return {
    global,
    regional,
    globalOnly: new Set([...global].filter((table) => !regional.has(table))),
    regionalOnly: new Set([...regional].filter((table) => !global.has(table))),
  };
}

function tableNames(sqlite: DatabaseSync): ReadonlySet<string> {
  const names = new Set<string>();
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  for (const row of rows) if (typeof row.name === "string") names.add(row.name);
  return names;
}

function sourceStatements(
  schema: ReturnType<typeof deployedTables>,
): readonly Statement[] {
  const statements: Statement[] = [];
  for (const path of sourceFiles(SOURCE_ROOT)) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const file = relative(SOURCE_ROOT, path);
    const visit = (node: ts.Node): void => {
      if (!isTextLiteral(node)) return ts.forEachChild(node, visit);
      const named = namedTables(literalText(node));
      const globalOnly = named.filter((table) => schema.globalOnly.has(table));
      const regionalOnly = named.filter((table) =>
        schema.regionalOnly.has(table),
      );
      if (globalOnly.length === 0 && regionalOnly.length === 0) return;
      const line =
        source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      statements.push({
        location: `${file}:${line}`,
        file,
        enclosingFunction: enclosingFunctionName(node),
        receiver: prepareReceiver(node),
        globalOnly,
        regionalOnly,
      });
    };
    visit(source);
  }
  return statements;
}

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

type TextLiteral =
  ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;

function isTextLiteral(node: ts.Node): node is TextLiteral {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

function literalText(node: TextLiteral): string {
  if (!ts.isTemplateExpression(node)) return node.text;
  const parts = [node.head.text];
  for (const span of node.templateSpans) {
    const collect = (child: ts.Node): void => {
      if (isTextLiteral(child)) parts.push(literalText(child));
      else ts.forEachChild(child, collect);
    };
    collect(span.expression);
    parts.push(span.literal.text);
  }
  return parts.join(" ");
}

// The identifiers a statement uses as tables: `FROM x`, `JOIN x`, `INTO x`,
// `UPDATE x`. An alias, a column or a quoted value is in none of these places.
function namedTables(sql: string): readonly string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(
    /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:OR\s+\w+\s+)?"?([A-Za-z_][A-Za-z0-9_]*)/giu,
  )) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

function prepareReceiver(literal: ts.Node): string | null {
  const call = literal.parent;
  if (
    !ts.isCallExpression(call) ||
    call.arguments[0] !== literal ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== "prepare"
  )
    return null;
  return resolveReceiver(call.expression.expression, 0);
}

function resolveReceiver(expression: ts.Expression, depth: number): string {
  const receiver = withoutSession(expression);
  if (!ts.isIdentifier(receiver) || depth > 4)
    return receiver.getText().replace(/\s+/gu, "");
  for (
    let scope: ts.Node | undefined = receiver.parent;
    scope !== undefined;
    scope = scope.parent
  ) {
    if (declaresParameter(scope, receiver.text)) return receiver.text;
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === receiver.text &&
          declaration.initializer !== undefined &&
          declaration.getStart() < receiver.getStart()
        )
          return resolveReceiver(declaration.initializer, depth + 1);
      }
    }
  }
  return receiver.text;
}

function withoutSession(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === "withSession"
    ) {
      current = current.expression.expression;
    } else {
      return current;
    }
  }
}

// A parameter or loop variable of this name hides any outer `const`.
function declaresParameter(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(scope))
    return scope.parameters.some((parameter) =>
      bindsName(parameter.name, name),
    );
  if (
    (ts.isForOfStatement(scope) || ts.isForInStatement(scope)) &&
    ts.isVariableDeclarationList(scope.initializer)
  )
    return scope.initializer.declarations.some((declaration) =>
      bindsName(declaration.name, name),
    );
  return false;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

function enclosingFunctionName(node: ts.Node): string {
  for (
    let parent: ts.Node | undefined = node.parent;
    parent !== undefined;
    parent = parent.parent
  ) {
    if (
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name !== undefined
    )
      return parent.name.getText();
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name) &&
      ts.isSourceFile(parent.parent.parent.parent)
    )
      return parent.name.text;
  }
  return "(module)";
}

function namesBothDatabases(statement: Statement): boolean {
  return statement.globalOnly.length > 0 && statement.regionalOnly.length > 0;
}

function describeStatement(statement: Statement): string {
  const tables = [
    ...statement.globalOnly.map((table) => `${table} (global)`),
    ...statement.regionalOnly.map((table) => `${table} (regional)`),
  ];
  return `${statement.location} names ${tables.join(", ")}`;
}

function byFirst(
  left: readonly [string, unknown],
  right: readonly [string, unknown],
): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}
