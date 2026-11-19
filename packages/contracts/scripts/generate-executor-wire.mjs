import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { format } from "prettier";
import { executorWireSchemas } from "../src/workspace-executor.ts";

const schemas = executorWireSchemas;
const definitions = new Map();
const requestTypes = new Set(["WorkspaceExecutorPreparationRequestWire"]);
for (const [name, schema] of Object.entries(schemas)) {
  definitions.set(name, schema);
  collectDefinitions(schema);
}

function collectDefinitions(schema) {
  if (schema.title) definitions.set(schema.title, schema);
  for (const child of Object.values(schema.properties ?? {}))
    collectDefinitions(child);
  if (schema.items) collectDefinitions(schema.items);
  for (const child of schema.anyOf ?? []) collectDefinitions(child);
}

function collectRequestTypes(schema) {
  if (schema.title) requestTypes.add(schema.title);
  for (const child of Object.values(schema.properties ?? {}))
    collectRequestTypes(child);
  if (schema.items) collectRequestTypes(schema.items);
  for (const child of schema.anyOf ?? []) collectRequestTypes(child);
}

for (const name of requestTypes) collectRequestTypes(definitions.get(name));

function rustName(name) {
  return name.replace(/(^|_)([a-z])/gu, upperLetter);
}

function upperLetter(_match, _prefix, letter) {
  return letter.toUpperCase();
}

function fieldName(name) {
  return name.replace(/[A-Z]/gu, lowerFieldLetter);
}

function lowerFieldLetter(letter) {
  return `_${letter.toLowerCase()}`;
}

function fieldType(schema, name) {
  if (schema.title) return schema.title;
  if (schema.enum) {
    definitions.set(name, schema);
    return name;
  }
  switch (schema.type) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "integer":
      if (schema.minimum < 0)
        throw new Error(
          `Signed wire integer needs an explicit policy: ${name}`,
        );
      return schema.maximum === 4294967295 ? "u32" : "u64";
    case "array":
      return `Vec<${fieldType(schema.items, `${name}Item`)}>`;
    default:
      if (schema.type === "object" || schema.anyOf) {
        definitions.set(name, schema);
        return name;
      }
      throw new Error(`Unsupported wire schema: ${name}`);
  }
}

function fields(schema, name, variant) {
  const lines = [];
  for (const [field, value] of Object.entries(schema.properties)) {
    if (variant && field === "kind") continue;
    if (!schema.required.includes(field))
      throw new Error(`Optional core field: ${name}.${field}`);
    const type = fieldType(value, `${name}${rustName(field)}`);
    if (requestTypes.has(name) && definitions.has(type)) requestTypes.add(type);
    lines.push(`    ${variant ? "" : "pub "}${fieldName(field)}: ${type},`);
  }
  return lines.join("\n");
}

function variants(schema) {
  if (schema.anyOf) return schema.anyOf.flatMap(variants);
  return [schema];
}

function allowsUnknownFields(schema) {
  return schema.additionalProperties !== false;
}

function declaration(name, schema) {
  if (schema["x-rust-type"])
    return `pub type ${name} = ${schema["x-rust-type"]};`;
  if (schema.enum) {
    return `#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum ${name} {\n${schema.enum.map(rustName).join(",\n")},\n}`;
  }
  if (schema.anyOf || schema.properties?.kind?.const !== undefined) {
    const arms = [];
    for (const branch of variants(schema)) {
      const tag = branch.properties.kind.const;
      arms.push(`${rustName(tag)} {\n${fields(branch, name, true)}\n}`);
    }
    const denyUnknown = variants(schema).some(allowsUnknownFields)
      ? ""
      : ", deny_unknown_fields";
    const deserialize = requestTypes.has(name) ? ", serde::Deserialize" : "";
    return `#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize${deserialize})]\n#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase"${denyUnknown})]\npub enum ${name} {\n${arms.join(",\n")}\n}`;
  }
  if (schema.type === "object") {
    const deserialize = requestTypes.has(name) ? ", serde::Deserialize" : "";
    return `#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize${deserialize})]\n#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${name} {\n${fields(schema, name, false)}\n}`;
  }
  throw new Error(`Unsupported wire definition: ${name}`);
}

const declarations = [];
for (const [constant, schema] of [
  [
    "PREPARATION_REQUEST_SCHEMA_VERSION",
    schemas.WorkspaceExecutorPreparationRequestWire,
  ],
  ["RESPONSE_SCHEMA_VERSION", schemas.WorkspaceExecutorPreparationResponse],
]) {
  declarations.push(
    `pub const ${constant}: &str = ${JSON.stringify(schema.properties.schemaVersion.const)};`,
  );
}
for (const [name, schema] of definitions)
  declarations.push(declaration(name, schema));
const rust =
  "// Generated from TypeScript JSON Schema. Run pnpm --filter @purin-labs/contracts executor:generate.\n\n" +
  declarations.join("\n\n") +
  "\n";
const formatted = execFileSync("rustfmt", ["--edition", "2024"], {
  input: rust,
  encoding: "utf8",
});
const path = new URL(
  "../../../crates/workspace-executor/src/wire.rs",
  import.meta.url,
);
const jsonPath = new URL("../executor-wire.schema.json", import.meta.url);
const json = await format(JSON.stringify(schemas), { parser: "json" });
if (process.argv.includes("--check")) {
  if (
    (await readFile(path, "utf8")) !== formatted ||
    (await readFile(jsonPath, "utf8")) !== json
  ) {
    throw new Error(
      "Executor wire types are stale. Run pnpm --filter @purin-labs/contracts executor:generate",
    );
  }
} else {
  await writeFile(path, formatted);
  await writeFile(jsonPath, json);
}
