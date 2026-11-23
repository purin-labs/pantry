# FND-11 — Contracts

A contract in Purin Pantry is a TypeBox schema, the TypeScript type that comes from it
and the parser that checks a value against it. TypeScript holds the source of each
contract. The executor and the shop gateway read some contracts in Rust with their own
code (see Open work). A schema is JSON Schema, so request bodies, stored records, Actor
messages and agent tool inputs use one schema system. The schema kit
`@purin-labs/contract-schema` gives the strict objects, the safe integers, the parsers
and one refusal format. `@purin-labs/contracts` and `@purin-labs/control-api` hold the
contracts of Pantry. `@purin-labs/commerce-contracts` holds the contracts of the
commerce engine. The contract packages also hold the pure logic that belongs to their
types, such as the Session reducer and the commerce query planner.

## What it does

### Schemas, types and parsers

- A contract module writes a schema with `Type` from `typebox`. The type is `Static` of
  the schema. The parser returns a result and does not throw.
- `StrictObject` refuses a field that the schema does not name. `OpenObject` accepts
  other fields, and a record parser removes them from its result.
- A check does not change the type of a value to make it fit. The text `"5"` where the
  schema has an integer is a refusal.
- Most parsers check with `Value.Check` and `Value.Errors` from `typebox/value`. No code
  uses the TypeBox `Compile` path, because a Worker forbids code that is made at run
  time.
- The Session reducer does not use `typebox/value`. Its functions `matchesShape` and
  `normalize` walk the schema, and they apply a private `rule` keyword that TypeBox
  ignores. They make three conversions, as serde does. Inside a tagged variant, they
  accept a variant index for the tag and write the tag name. They read
  `{"name": null}` as `"name"`. They write a SHA-256 in lower case.
- `goal.ts` and `page-browser-context.ts` check by hand with no schema. They return
  `null` for a refusal.
- A rule that JSON Schema cannot state is a plain function after the schema check, as in
  `message.ts`. The commerce record schemas state such a rule with `Type.Refine`, and
  `Type.Codec` rewrites a checked value, for example a code to upper case.
- Each package pins `typebox` 1.3.27, and the lockfile holds one copy.
- The type checks (`pnpm check:packages` and the type check of each service) show each
  caller that does not agree with a changed contract.

### The schema kit

`packages/contract-schema` exports these parts from `src/schema.ts` and
`src/sorted-unions.ts`:

| Export                                                                | What it does                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StrictObject`, `OpenObject`, `ReadonlyRecord`                        | Object schemas that refuse or accept other fields, and a record with a read-only index                                                                      |
| `SafeInteger`, `NonNegativeInteger`, `PositiveInteger`                | Integer schemas inside the safe range of JavaScript                                                                                                         |
| `parseContract(schema, value, reject)`                                | Makes a JSON copy with the integer rules, checks it, and gives the first fault to `reject`, the mapper of the area                                          |
| `normalizeContractInput`, `jsonSafeInteger`, `UnsafeJsonIntegerError` | The JSON copy of `parseContract`, its `JSON.stringify` replacer and the error that the replacer throws for an integer outside the safe range                |
| `checkContract`                                                       | The same check with no JSON copy                                                                                                                            |
| `recordParser(schema, name?)`                                         | The parser of a stored record or a response. It fills defaults, makes its own JSON copy, checks, removes the unknown fields of open records and runs codecs |
| `decodeRecord(parser, input)`, `ContractRefusalError`                 | Returns the value, or throws `ContractRefusalError` at a boundary that throws                                                                               |
| `parseContractArray`, `contractRefusal`                               | The first refusal of an array, and a refusal value                                                                                                          |
| `canonicalContractDigest`                                             | SHA-256 of canonical JSON with the keys in code-point order                                                                                                 |
| `cleanValue`, `decodeValue`, `decodeChecked`                          | The TypeBox clean and decode passes. They keep the sorted unions of each schema, so the sort runs one time for each schema                                  |
| `organisationIdSchema`, `integrationAccountIdSchema`                  | The ids that Pantry records and commerce records both carry                                                                                                 |

### Refusals

`ContractDecodeResult<T>` is `{ ok: true, value }` or `{ ok: false, error }`. The error
is a `ContractDecodeError`:

| `kind`                | `code`                 | When                                                                                                 |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `input_invalid`       | `invalid_json`         | The value has no JSON form, or it has 128 levels of objects and arrays                               |
| `input_invalid`       | `invalid_json_integer` | An integer is outside the safe range, or a number with a fraction is where the schema has an integer |
| `validation_rejected` | The code of the area   | The value fails its schema, or a rule that runs after the schema                                     |

- `recordParser` gives the code `invalid_record` and `details.field`, the JSON pointer
  of the first field that fails (`/` for the root). With a name, the reason also names
  the field, for example `checkout.source.buyerContact.emailDigest`.
- The JSON copy of `recordParser` differs from the copy of `parseContract`. It has no
  depth limit, and each `bigint` becomes a number with no safe-range refusal. A number
  with a fraction where the schema has an integer still gives `invalid_json_integer`.
- The `kind`, the `code` and the field path are stable. The `reason` text is for a
  person or an agent. One function reads it: `plannerFailure` in `commerce-wasm.ts`
  reads the code at the start of a composed `code: reason` text.
- Some areas keep their own result form with the same parts. The message parsers return
  a `MessageRejection` (`message-shape.ts`). The access decoders return the code
  `invalid_access_contract`. The media parsers return `invalid_media_contract`, and the
  executor request parser returns `invalid_request`.
- The commerce validators that the Portal and the client call throw
  `LexiconValidationError` with the same `code`.

### Numbers, text, time and digests

The helpers follow the Rust and serde rules that their comments name. For example,
`rustTrim` removes what `str::trim` removes, and `utf8ByteLength` is `String::len`.

- **Integers.** `SafeInteger` refuses an integer outside the safe range, and so does
  the JSON copy of `parseContract`. In that copy a safe `bigint` becomes a number.
  `checkContract` and `recordParser` do not refuse such an integer, so only the schema
  can (see Open work).
- **Commerce integers.** A commerce integer value is a `bigint` in TypeScript.
  `commerceIntegerSchema` decodes a safe integer to a `bigint`, and the browser
  validators return each `kind: "integer"` value as a `bigint`.
- **Text.** `@purin-labs/std` gives `utf8ByteLength`, `codePointCount`,
  `compareCodePoints`, `rustTrim` and `hasLoneSurrogate`. A size limit is a plain check
  with one of them after the schema check.
- **Lone surrogates.** The message and attachment parsers refuse a string or an object
  key with a lone surrogate before the schema check (`admitJson`, code
  `invalid_request`). The Session reducer refuses such a string as `invalid_input`.
- **Schema length.** `minLength` and `maxLength` in TypeBox 1.3.27 count grapheme
  clusters. A letter with its combining marks counts as one. They are not a limit on
  code points or bytes.
- **Unicode.** `normalizeCommerceUnicodeV1` (`commerce-contracts/src/unicode.ts`) does
  NFKC, the full case fold, the removal of default ignorable code points and NFKC again.
  Its tables are Unicode 17.0.0 (`COMMERCE_UNICODE_VERSION`). `generate-unicode.mjs`
  writes them from data files with pinned SHA-256 values. Its `--check` also runs the
  NFKC lines of `NormalizationTest.txt` against `normalizeCommerceNfkc`.
- **Time.** `commerce-timestamp.ts` reads an RFC 3339 timestamp as text and keeps
  nanoseconds.
- **Digests.** A digest uses an encoder that writes the fields in a fixed order:
  `encodeModelRoute`, `encodeHarnessCheckpointRecord` (the id is `checkpoint_` and the
  SHA-256), `encodeUserMessageDigest` (prefix `pantry.user_message.v1`),
  `encodeCommerceQueryFingerprint` and `encodeSupplierPayoutEconomics`. The digest thus
  does not depend on the key order of a parsed object.

### Logic in the contract packages

- **Pantry.** `session-reducer.ts` holds `advanceSessionCommand`, `restoreSession` and
  two checkpoint validators. Each takes a request with a `schema` version, for example
  `pantry.actor.advance-session-command.v1`. Each returns `{ status: "ok", value }` or
  `{ status: "error", error: { code } }`. A shape fault is `invalid_input`, and another
  version is `unsupported_schema_version`.
- `message.ts` holds the message parsers, the stored attachment builder and the message
  views. `attachment-preparation.ts`, `goal.ts` and `access-control.ts` hold their
  parsers.
- **Commerce.** `commerce-contracts` holds the graph query parser and planner, the query
  plan, cursors, authority checks, observations, the Shopify and lab normalizers, cue
  facts and supplier payouts.
- The 23 commerce state machines (`commerce-machines.ts`) and the 13 built-in plugins
  (`commerce-plugins.ts`) are TypeScript data. `commerce-data:check` checks them.
- `commerce-client` declares the TypeScript types of most API records. A
  `*.schema.type-fixtures.ts` file fails the type check when a client type and its
  schema type differ. The client takes the types of seven record files from the
  contract package and declares no second type for them.

### Agent tool inputs

- The `input` of a tool is a TypeBox schema, or a JSON Schema in `jsonSchema(...)`
  (`foundation/agent-tools/define-tool.ts`). `Value.Check` checks a call.
  Then `decode` runs the rules that a schema cannot state.
- A tool with `decodeOnly: true` has no `Value.Check`. Its `decode` is the only check,
  and its schema is only what the model sees. 101 of the 121 `jsonSchema` tools in
  `agent-tools` set it.
- `refuseChangedToolArguments` is the `prepareArguments` step of each host tool that
  Pi calls (`hostTool` in `pi-durable-tools.ts`). It runs the argument conversion of
  `@earendil-works/pi-schema` and compares the result with the arguments that the model
  sent. It throws when a number gets another value, such as `2.5` to `2`, or when a
  `null` becomes a value. It accepts a text that becomes the same number, and a `null`
  that the conversion removes.
- `commerce_entity_context` is a decode-only tool. It shows the model a short schema.
  Its `decode` uses the contract parser `parseCommerceGraphQuery`, so the tool refuses
  what the contract refuses.

### The Portal and Rust

- The Portal imports the contract packages. Its validators are TypeScript, and it loads
  no Wasm validator at start.
- `control-api` holds the shapes that the Portal and the control routes exchange. Where
  both sides import a type, a changed shape is a compile error on the side that did not
  change.
- `crates/media-inspect` reads media facts and selects video frames. The executor uses
  it as a Rust library, and the Platform Worker uses its Wasm build
  (`foundation/agent/messages/media-inspect.ts`). `parseMediaMetadata` and
  `parseFrameSamplingOutcome` check its output.
- `generate-executor-wire.mjs` writes `crates/workspace-executor/src/wire.rs` and
  `executor-wire.schema.json` from `executorWireSchemas`. The request and response of
  the executor thus have TypeScript as their source. `wire.rs` takes its identity and
  limit types from `contracts.rs`, which is written by hand.
- `control-api/src/device-gateway.ts` owns the device gateway protocol.
  `crates/shop-gateway` reads and writes its messages with `serde_json` and its own
  types. No script generates them.

## Contracts

This subsystem owns no D1 table, no Actor SQLite table, no route, no event, no
capability and no agent tool. It owns packages. `scripts/layers.json` gives each its
module.

| Package                                                                                         | Module                 | Holds                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contract-schema` (`@purin-labs/contract-schema`)                                      | `foundation/std`       | The schema kit                                                                                                                                               |
| `packages/std`, `packages/type-utils`                                                           | `foundation/std`       | Text rules, SHA-256, canonical JSON; `Variant`, `VariantBy`, `StrictUnion`                                                                                   |
| `packages/contracts` (`@purin-labs/contracts`)                                                  | `foundation/contracts` | Pantry contracts: Sessions, checkpoints, model routes, messages, attachments, access control, goals, Case and Connector records, envelopes, onboarding views |
| `packages/control-api` (`@purin-labs/control-api`)                                              | `foundation/contracts` | The shapes of the control API and the Portal, the device gateway protocol and the surface protocol                                                           |
| `packages/commerce-contracts` (`@purin-labs/commerce-contracts`)                                | `areas/commerce`       | Commerce contracts, record schemas (`src/records/`), state machines, plugins and query logic                                                                 |
| `packages/commerce-client` (`@purin-labs/commerce-client`)                                      | `areas/commerce`       | The typed client of the commerce engine: the admin, storefront and entity-plane APIs                                                                         |
| `packages/commerce-control-api`, `cafe-control-api`, `kitchen-control-api`, `inbox-control-api` | The area               | The control API shapes of one area                                                                                                                           |

Main files of `packages/contracts/src/`:

- `session-schemas.ts`, `session-reducer.ts`, `session-recovery.ts`, `model-route.ts`
  and `digest-encoders.ts`: the Session lifecycle, commands, transitions and
  checkpoints.
- `message.ts`, `message-shape.ts`, `attachment-preparation.ts`, `media-inspect.ts` and
  `workspace-executor.ts`: messages, attachments and the executor wire.
- `access-control.ts`, `organisation-access.ts`, `record-schemas.ts` and `goal.ts`:
  grants, capability definitions, request eligibility, file context and goals.
- `connector-rpc.ts` and `case-rpc.ts`: the RPC inputs and stored records of the
  Connector and Case Actors. The schema checks the shape, and the Actor parser copies
  the named fields.
- `commerce-parts.ts` and `commerce-system.ts`: the commerce parts that Pantry records
  carry. The package names no commerce package. The Platform declares each part.
- `types/`: 267 type files. 27 of them export the type of a schema from another file.
  240 declare a type by hand, such as `CommandEnvelope`, `EventEnvelope` and
  `RequestAuthority`. A hand-written type can name a schema type in a field, such as
  `OrganisationId`.

Other files: `foundation/agent/actor-wasm.ts` calls the Session reducer,
`areas/commerce/server/commerce-wasm.ts` calls the commerce functions, and
`foundation/agent/messages/message-wasm.ts` calls the message and attachment
parsers. The three run TypeScript only.
`foundation/agent/actors/pi-tool-arguments.ts` holds the tool argument check.
`packages/contracts/src/boundary.ts` reads plain request fields.

| Check                                             | Command                                                            | Where it runs                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Types of each package                             | `pnpm check:packages`                                              | CI                                                                           |
| Machines and plugins                              | `pnpm --filter @purin-labs/commerce-contracts commerce-data:check` | CI                                                                           |
| Executor wire files are current                   | `pnpm --filter @purin-labs/contracts executor:check`               | In `media:build`, before the Platform type check, the E2E suite and a deploy |
| Media Wasm build                                  | `pnpm --filter @purin-labs/platform contracts:media`               | The same places                                                              |
| Unicode tables are current and pass the NFKC test | `pnpm --filter @purin-labs/commerce-contracts unicode:check`       | CI (`commerce-components.yml`)                                               |
| Machines against the commerce spec and the alarms | `pnpm lint:commerce-spec`, `pnpm lint:state-machines`              | `pnpm lint`                                                                  |

## Rules and limits

Rules for a contract writer:

- Put a new contract type or lifecycle in its TypeScript package. Do not add a Rust
  contract type.
- Use `StrictObject` for a record that refuses unknown fields. Use `SafeInteger`, or a
  schema that spreads it, for an integer.
- Call the clean and decode passes through `cleanValue`, `decodeValue` and
  `decodeChecked`. Do not call `Value.Clean` or `Value.Decode`.
- Do not use `Compile`. Do not write a second schema for a value that has a contract.
- If a digest covers a record, write an encoder that fixes the field order.
- Do not use `maxLength` as a size limit. Check the size with a `@purin-labs/std`
  helper.

| Limit                                          | Value                                                        | Where                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Depth of objects and arrays in `parseContract` | 127 levels pass; level 128 is `invalid_json`                 | `withinJsonNestingLimit` in `contract-schema/src/schema.ts` (no constant)                |
| Integer range                                  | `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER`       | `SafeInteger`                                                                            |
| Commerce cursor                                | 16 KiB of UTF-8                                              | `MAX_COMMERCE_CURSOR_LENGTH`                                                             |
| Query traversal                                | `maxDepth` 0 to 8, `resultLimit` 1 to 500, 64 seeds, 8 sorts | `query-limits.ts`, `graph-query-schema.ts`                                               |
| Message text, URL, object key                  | 65,536 code points; 2,048 bytes; 1,024 bytes                 | `NON_EMPTY_TEXT_MAX_CHARS`, `HTTP_URL_MAX_CHARS`, `OBJECT_KEY_MAX_CHARS` in `message.ts` |
| Session identity, Session object key           | 256 bytes; 1,024 bytes                                       | `applyTextRule` in `session-reducer.ts` (no constant)                                    |
| Session backend id                             | `picocodex`, `pi` or `codex`                                 | `normalize` in `session-reducer.ts`                                                      |
| Goal counter, goal id, goal text               | `0xffff_ffff`; 256 UTF-16 units; 4,000 UTF-16 units          | `counter`, `identifier` and `text` in `goal.ts` (no constant)                            |
| Commands from one plugin run                   | 5                                                            | `PLUGIN_RUN_COMMANDS`                                                                    |

- **Permissions.** A contract checks the shape of a value. It gives no permission to a
  person or an agent. Roles, capabilities and approvals are in FND-06.
- **Retention.** A contract keeps no record, so it has no retention time.
- **Information flow.** The reason of a `recordParser` refusal is the TypeBox message
  for the rule, and its details hold only the field path. A parser adds no source
  label. FND-07 owns the labels.
- **Layers.** An import may only go down (`pnpm lint:layers`). `contracts` names no
  commerce package, and `control-api` names no area package. Commerce code imports no
  Platform package (`pnpm lint:runtime-boundary`).
- **Out of scope:** `crates/bakery-native`, the fetch containers, the logic of the
  executor and a Rust Worker.

Neighbours:

- **FND-02** owns the Actors that use the envelopes and the RPC schemas. **FND-03** owns
  the Case and Session behavior that the reducer states. **FND-04** owns the Pi harness,
  the model routes, the checkpoint format and the tool argument conversion.
- **FND-05** owns the meaning and the limits of messages and attachments. **FND-06**
  owns access control. **FND-09** owns the tool definitions and their input schemas.
- **COM-01** and **COM-02** own the meaning of the commerce records, the state machines,
  the plugins and the query planner. The commerce API contract is
  `services/commerce/docs/spec.md`.
- Each area spec owns its control API shapes, for example
  **[DEV-01](../areas/devices/01-devices.md)** for `devices.ts` and `device-gateway.ts`.
  **ENG-02** owns the lints and the repository rules.

## Open work

- **Types with no schema.** 240 types in `packages/contracts/src/types/` are written by
  hand and do not come from a schema. In `control-api`, 16 of the 68 top-level source
  files hold a TypeBox schema, and no file of `src/portal/` does. `commerce-client`
  keeps a second type beside most record schemas, and 24 `*.schema.type-fixtures.ts`
  files compare the two types. It takes the types of seven record files from the
  contract package: companies, shop names, the pickup queue, failed payments,
  payments, order times and bank payouts.
- **Parsers with no schema, or with two.** `goal.ts` checks a goal by hand, and no
  parser uses the goal schemas in `record-schemas.ts`. `page-browser-context.ts` has
  no schema. `attachment-preparation.ts` holds two schema sets for one value: the
  exported schemas, and the strict `raw*` schemas that its parser checks.
- **Tool schemas.** In `agent-tools`, 121 tool inputs use `jsonSchema(...)` with a JSON
  Schema written by hand, 12 use a TypeBox object in the tool file and 3 use
  `noArguments()`. A custom connector tool builds its `jsonSchema(...)` input at run
  time (`custom-connectors/catalog-tools.ts`). No tool takes its `input` from a
  contract package.
- **Integers with no upper limit.** 78 integer schemas in `packages/` have a `minimum`
  and no `maximum`, so the schema accepts `2 ** 53`. They are in `kitchen-control-api`
  (32), `control-api` (27), `commerce-contracts` (16), `contracts` (2) and
  `production-simulation` (1). The reducer checks the safe range for the 2 in
  `contracts`. `amountMinor` of a bank payout (`records/api-bank-payouts.ts`) is
  `Type.Integer()` with no `minimum` and no `maximum`.
- **Schema length.** 81 `Type.String` schemas in `packages/` set a `maxLength`, 60 of
  them in `control-api`. TypeBox counts grapheme clusters, so they do not limit the
  size of a text. The tool inputs in `agent-tools` hold 99 more `maxLength` limits.
  TypeBox does not check the input of a decode-only tool, so it does not apply them.
- **Lone surrogates in the access decoders.** `jsonInput` in `access-control.ts` tests
  the JSON text for a lone surrogate. `JSON.stringify` writes a lone surrogate as an
  escape, so the test finds none.
- **Host Unicode tables.** Four places normalize commerce text with
  `String.prototype.normalize("NFKC")`, which uses the tables of the JavaScript engine.
  They are gift card codes (`normalizeGiftCardCode` in `records/api-stored-value.ts`),
  catalog search, Stripe dispute text and `normalizeUntrustedCommerceText` in the Platform
  (`context/untrusted-commerce-text.ts`).
- **Timestamps through `Date`.** The record schemas of checkout profiles, shipment
  operations, food service, plugin outputs and the point of sale write a timestamp
  through `Date`, with milliseconds only.
- **Names from the Wasm boundary.** `actor-wasm.ts`, `commerce-wasm.ts`,
  `message-wasm.ts` and the `commerce_wasm_*` error codes remain.
- **Rust copies.** `crates/workspace-executor/src/contracts.rs` holds Rust copies of
  the identity, digest, attachment id and preparation limit types, written by hand,
  with their parse functions and serde validators. Only `wire.rs` is generated.
  `crates/shop-gateway` holds the Rust side of the device gateway protocol, written by
  hand. `crates/cobot-protocol` holds wire types that only Rust code uses.
- **Tool refusal journey.** No test names `refuseChangedToolArguments` or its error
  text.

## Sources

- [Plan 78](../../history/plan-78-contracts-in-typescript.md). Where it differs from the code,
  this spec follows the code. Its evidence in the archive:
  [the status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-78-foundations.md).
- Plan 78 replaced step 7 of [Plan 77](../../history/plan-77-underclerk-modular-core.md)
  (COM-02). [The layers page](../../layers.md) gives the module of each package.
- E2E journeys in `workers/platform/tests/e2e/`: `checkpoint-restart.test.ts` and
  `checkpoint-atomic-acceptance.test.ts` (Session restore and checkpoints),
  `slack-attachment-journey.test.ts` and `slack-attachment-restore.test.ts` (messages
  and attachments), and the `durable-codemode-*.test.ts` journeys (tool calls).
- Other tests in `workers/platform/tests/`: `workspace-executor-inspection.test.ts`,
  `workspace-executor-envelope.test.ts`, `commerce-query-schema.test.ts` (the Unicode
  fold) and `commerce-wasm-query.test.ts` (the planner and the cursor).
- Journeys in `services/commerce/tests/`: `entity-plane.test.ts`,
  `entity-plane-planned-query.test.ts` and `plugin-journey.test.ts`.
- Scripts: `scripts/plan-50/evaluate-pi-durable.mjs`, and the commerce lab sequence
  `pnpm lab:reset`, `lab:seed`, `lab:scenario` and `lab:verify`.
