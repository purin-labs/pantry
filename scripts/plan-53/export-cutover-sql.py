#!/usr/bin/env python3
"""Export a prepared SQLite cutover for D1 import, including large text values."""

import argparse
import os
from pathlib import Path
import sqlite3


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    if isinstance(value, str):
        if "\x00" in value:
            return "CAST(X'" + value.encode().hex() + "' AS TEXT)"
        return "'" + value.replace("'", "''") + "'"
    return str(value)


def write_row(output, table, row):
    values = [literal(value) for value in row]
    prefix = "INSERT INTO " + identifier(table) + " VALUES ("
    statement = prefix + ",".join(values) + ");\n"
    if len(statement.encode()) < 80000:
        output.write(statement)
        return
    output.write("DELETE FROM _p55_restore_text;\n")
    for column, value in enumerate(row):
        if not isinstance(value, (str, bytes)):
            continue
        text = value.hex() if isinstance(value, bytes) else value
        for start in range(0, len(text), 8000):
            output.write(
                "INSERT INTO _p55_restore_text VALUES (" + str(column) + "," +
                str(start) + "," + literal(text[start:start + 8000]) + ");\n"
            )
        expression = (
            "(SELECT coalesce(group_concat(value,''),'') FROM "
            "(SELECT value FROM _p55_restore_text WHERE column_id=" + str(column) +
            " ORDER BY position))"
        )
        values[column] = "unhex(" + expression + ")" if isinstance(value, bytes) else expression
    output.write(prefix + ",".join(values) + ");\n")


def write_table(output, database, table):
    prefix = "INSERT INTO " + identifier(table) + " VALUES "
    pending = []
    pending_bytes = len(prefix.encode())
    for row in database.execute("SELECT * FROM " + identifier(table)):
        values = "(" + ",".join(literal(value) for value in row) + ")"
        size = len(values.encode()) + 1
        if pending and (pending_bytes + size >= 80000 or len(pending) == 100):
            output.write(prefix + ",".join(pending) + ";\n")
            pending = []
            pending_bytes = len(prefix.encode())
        if len(prefix.encode()) + size >= 80000:
            write_row(output, table, row)
        else:
            pending.append(values)
            pending_bytes += size
    if pending:
        output.write(prefix + ",".join(pending) + ";\n")


def ordered_tables(database, schema):
    pending = {}
    for table, kind, _ in schema:
        if kind == "table":
            pending[table] = {
                row[2] for row in database.execute("PRAGMA foreign_key_list(" + identifier(table) + ")")
                if row[2] != table
            }
    ordered = []
    while pending:
        ready = sorted(table for table, parents in pending.items() if not parents.intersection(pending))
        if not ready:
            raise ValueError("Cross-table foreign-key cycle requires a coordinated import")
        for table in ready:
            ordered.append(table)
            del pending[table]
    return ordered


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    source = args.source.resolve()
    database = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    try:
        schema = database.execute(
            "SELECT name,type,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid"
        ).fetchall()
        shadows = {row[1] for row in database.execute("PRAGMA table_list") if row[2] == "shadow"}
        schema = [row for row in schema if row[0] not in shadows and
                  not row[0].startswith(("sqlite_", "_cf_"))]
        if any(row[0] == "_p55_restore_text" for row in schema):
            raise ValueError("Source conflicts with the temporary import table")
        tables = ordered_tables(database, schema)
        with args.output.open("x") as output:
            output.write("PRAGMA defer_foreign_keys = ON;\n")
            for _, kind, sql in schema:
                if kind in ("table", "index"):
                    output.write(sql + ";\n")
            output.write(
                "CREATE TABLE _p55_restore_text (column_id INTEGER, position INTEGER, value TEXT);\n"
            )
            for table in tables:
                write_table(output, database, table)
            output.write("DROP TABLE _p55_restore_text;\n")
            for _, kind, sql in schema:
                if kind in ("trigger", "view"):
                    output.write(sql + ";\n")
            output.write("PRAGMA foreign_key_check;\n")
    finally:
        database.close()


if __name__ == "__main__":
    main()
