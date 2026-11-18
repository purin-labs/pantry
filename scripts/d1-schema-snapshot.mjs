// Shared by check-d1-schema.mjs and check-d1-patch.mjs. A snapshot lists
// every table (with its columns, their defaults and its CHECK constraints),
// index and trigger of a SQLite database, so that a baseline file and a live
// D1 database can be compared object by object.
import { DatabaseSync } from "node:sqlite";

// Written for sqlite_master, so that the same statement runs in node:sqlite
// and in D1. Names that SQLite or D1 own are left out.
export const SNAPSHOT_QUERY = `
SELECT m.type AS type, m.name AS name, m.tbl_name AS owner, m.sql AS sql,
  p.name AS column_name, p.type AS column_type, p."notnull" AS not_null, p.pk AS pk,
  p.dflt_value AS column_default
FROM sqlite_master m
LEFT JOIN pragma_table_info(m.name) p ON m.type = 'table'
WHERE m.type IN ('table', 'index', 'trigger')
  AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
  AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
  AND m.name <> 'd1_migrations'
ORDER BY m.name, p.cid
`;

/** The snapshot of a baseline file, made in memory. */
export function snapshotOfBaseline(sql) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(sql);
    return snapshotOfRows(database.prepare(SNAPSHOT_QUERY).all());
  } finally {
    database.close();
  }
}

/** Rows of SNAPSHOT_QUERY become a Map of object name to its description. */
export function snapshotOfRows(rows) {
  const objects = new Map();
  for (const row of rows) {
    let object = objects.get(row.name);
    if (object === undefined) {
      object = {
        type: row.type,
        owner: row.owner,
        sql: normalSql(row.sql),
        checks: row.type === "table" ? checkConstraints(row.sql) : new Set(),
        columns: new Map(),
      };
      objects.set(row.name, object);
    }
    if (row.column_name !== null && row.column_name !== undefined) {
      object.columns.set(
        row.column_name,
        `${String(row.column_type).toUpperCase()}${Number(row.not_null) === 1 ? " NOT NULL" : ""}${Number(row.pk) > 0 ? " PRIMARY KEY" : ""}${row.column_default === null || row.column_default === undefined ? "" : ` DEFAULT ${compact(String(row.column_default))}`}`,
      );
    }
  }
  return objects;
}

/** The statement without comments and with one space between words. */
export function normalSql(sql) {
  if (typeof sql !== "string") return "";
  return sql
    .replace(/--[^\n]*/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Every CHECK (...) expression of a CREATE TABLE statement, without spaces. */
export function checkConstraints(sql) {
  const checks = new Set();
  if (typeof sql !== "string") return checks;
  const text = sql.replace(/--[^\n]*/gu, "");
  const pattern = /\bCHECK\s*\(/giu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    let depth = 1;
    let index = pattern.lastIndex;
    let quote = null;
    for (; index < text.length && depth > 0; index += 1) {
      const character = text[index];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    checks.add(compact(text.slice(pattern.lastIndex, index - 1)));
    pattern.lastIndex = index;
  }
  return checks;
}

function compact(text) {
  return text.replace(/\s+/gu, "");
}

/**
 * What the expected snapshot has and the actual one lacks or has different:
 * a missing table, index or trigger, a missing column, a column of another
 * type or default, or a missing CHECK constraint. The actual snapshot may have
 * more; a retired object is not an error.
 */
export function missingFrom(expected, actual) {
  const problems = [];
  for (const [name, object] of expected) {
    const found = actual.get(name);
    if (found === undefined) {
      problems.push(`missing ${object.type} ${name}`);
      continue;
    }
    if (found.type !== object.type) {
      problems.push(`${name} is a ${found.type}; expected a ${object.type}`);
      continue;
    }
    for (const check of object.checks) {
      if (!found.checks.has(check))
        problems.push(`missing CHECK on ${name}: ${check.slice(0, 120)}`);
    }
    for (const [column, definition] of object.columns) {
      const live = found.columns.get(column);
      if (live === undefined) problems.push(`missing column ${name}.${column}`);
      else if (live !== definition)
        problems.push(
          `column ${name}.${column} is ${live}; expected ${definition}`,
        );
    }
  }
  return problems;
}
