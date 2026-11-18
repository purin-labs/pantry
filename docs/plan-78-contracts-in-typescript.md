# Plan 78 — Contracts in TypeScript

Status (2026-10-24): accepted. The owner chose TypeScript as the language of
both contracts packages and accepted the full plan (steps 0–6). On
2026-10-24 the schema library recommendation changed from Zod 4 to TypeBox,
because Pi tools already use TypeBox (see Decisions). This plan replaces
[Plan 77](plan-77-underclerk-modular-core.md) step 7 ("One type source") and
its "Type source" decision.

## Goal

Make TypeScript the one source for every type, parser and validator in
`@underclerk/contracts` and `@satyr/contracts`. Each type is written once as a
schema. Its TypeScript type, its parser and its JSON Schema come from that
schema. The Rust contracts crates, their Wasm modules, the browser validator
builds and the ts-rs bindings are then deleted.

The main reason is one language and one schema system for agents. A coding
agent changes a contract and its callers in one language, and the type check
shows every caller at once. A Pi agent gets tool parameters that come from
the same schemas as the contracts, so a tool refuses exactly what the
contract refuses. An agent that writes a Plan 77 merchant plugin reads and
writes the same schemas at run time.

Operators, customers and agents see no change in behavior. Every request, every stored
record, every refusal code and every digest stays the same. The one visible
change is that the Portal no longer waits for a validator module at start.

Rust stays where it runs as a native binary or does heavy computation:
`crates/bakery-native`, `crates/workspace-executor` and the two fetch
containers. This plan does not change them, except for the executor's
contract types (step 0).

## Findings (2026-10-23)

| Area                 | Today                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Underclerk contracts | 37,728 Rust lines in 51 files, of which 5,097 are Rust tests. ts-rs writes 551 binding files. The Wasm module (3.4 MB, 0.9 MB gzip) exports 36 functions: 21 validators, the graph query planner, cursors, Unicode, Shopify and Stripe normalizers, observations, supplier payables and payouts, lab events and cue facts.                                                                                                                       |
| Satyr contracts      | 17,464 Rust lines in 14 files. ts-rs writes 417 binding files. The Wasm module (4.5 MB) also holds the commerce functions that Platform calls. It exports 10 Satyr functions: the session reducer (`restoreSession`, `advanceSessionCommand`), checkpoint validators, message views, stored attachments, attachment preparation, media metadata and video frame sampling.                                                                        |
| Browser validators   | Each package builds a second Rust core (1.36 MB and 1.50 MB Wasm) and a wasm2js JavaScript copy. The Satyr core also holds the commerce validators (`browser-validator-core` feature), and the Portal ships only that one (1.5 MB, 380 KB gzip). `apps/portal/src/bootstrap.tsx` waits for `initializeBrowserValidators()` before the Portal starts.                                                                                             |
| Hand-written parsers | `@underclerk/client` has 447 parsers (24,467 lines) next to the generated types. 200 `V1` types exist only in TypeScript (Plan 77 findings). Platform wraps the Wasm in four files (`actor-wasm.ts`, `message-wasm.ts`, `commerce-wasm.ts`, `contracts-wasm.ts`, about 1,030 lines).                                                                                                                                                             |
| Importers            | 557 files import a contracts package: 384 in Platform, 105 in Underclerk, 38 in the Portal, and the rest in `commerce-query-sqlite`, `control-api`, `production-simulation`, both client packages and scripts. All import from the package root, not from `bindings/`.                                                                                                                                                                           |
| Native Rust use      | Only `workspace-executor` uses the contracts natively: `file_native` (product folder parse and changeset, with `serde_yaml`), `video_frames::plan_h264_decode`, actor IDs, `WorkspaceRevision` and attachment preparation limits. No native program uses the commerce types.                                                                                                                                                                     |
| Strictness           | 155 types use serde `deny_unknown_fields`. Errors carry `kind`, `code` and field paths. The `reason` text is often serde's own message (`error.to_string()`), which TypeScript cannot give word for word.                                                                                                                                                                                                                                        |
| Digests              | Rust computes SHA-256 digests in 8 modules. Some hash `canonical_json`. Others hash `serde_json::to_vec` of a struct, which writes fields in declaration order: model routes, checkpoint IDs (`checkpoint_<sha256>`) and query fingerprints. Stored records and IDs hold these digests. No hashed module has a floating-point field.                                                                                                             |
| Text rules           | Rust `String::len()` counts UTF-8 bytes (49 length checks). `chars().count()` counts code points (8 checks). Rust sorts and `BTreeMap` keys use code-point order (64 sites). JavaScript `.length` counts UTF-16 units and `sort()` uses UTF-16 order, so each rule changes if it is ported directly. The `time` crate parses and formats timestamps (4 sites).                                                                                   |
| Unicode              | `normalizeCommerceUnicodeV1` is NFKC_Casefold without default ignorables, on pinned Unicode 17.0.0 tables (`oxixml-unicode`). JavaScript `normalize()` uses the ICU tables of each engine, which can differ. Platform calls it in `actors/commerce-query-schema.ts`.                                                                                                                                                                             |
| Dead Rust            | The access predicate evaluator (`evaluate_predicate_for_effect`, with `regex`) has only Rust test callers, with `fixtures/predicate-cases.json`.                                                                                                                                                                                                                                                                                                 |
| Rust tests           | 320 `#[test]` cases. They hold inputs that no E2E journey may reach.                                                                                                                                                                                                                                                                                                                                                                             |
| Generators           | `commerce-machines` and `commerce-plugins` Rust binaries write `commerce-machines.ts` and `commerce-plugins.ts`. `pnpm lint:underclerk-spec` reads `commerce-machines.ts`. `commerce-parity-native` and `satyr-file-native` are native test binaries; `scripts/plan-50/evaluate-pi-durable.mjs` builds and runs `satyr-file-native`.                                                                                                             |
| Build and CI         | `satyr.yml` installs the `wasm32-unknown-unknown` target and `wasm-pack`, runs `typegen:check` for both packages and runs two Wasm-named test files. `commerce-components.yml` runs `typegen:check`. Platform `check:types`, `test:e2e`, `deploy` and `deploy:staging` run `contracts:wasm`. Underclerk `test`, `deploy` and `deploy:staging` build the Wasm and the browser validators. The Portal `build` builds both browser validator cores. |
| Agent tool schemas   | Pi tools use TypeBox (`Type` from `@earendil-works/pi-ai`, `typebox` 1.3). Platform source also holds 149 JSON Schema objects written by hand, 133 of them in `actors/harness-tool-catalog.ts`. These schemas are a third copy of contract shapes, next to the Rust types and the hand-written parsers.                                                                                                                                          |
| Work in flight       | Plan 76A and Plan 77 sessions add Rust contract code now (Plan 77 step 4 and Plan 76A step 4B, 2026-10-23). Each Rust addition makes the port larger.                                                                                                                                                                                                                                                                                            |

## Design

### One schema for each type

- Write each type as a strict schema in the contracts package that owns it
  today. Unknown fields are refused, as with `deny_unknown_fields`.
- Keep every exported type name. The 557 importers then need no change.
- Each new type must be equal to its old ts-rs binding: the same optional and
  `null` fields, the same `readonly` marks and the same union tags. A
  type-level equality check (`Equal<Old, New>`) runs in the type check until
  the bindings are deleted. It is a compile check, not a test.
- Export `parseX(value): Result<X, ContractDecodeError>` for each record and
  command.
- Keep the error format: the same `kind`, `code` and field path as the Rust
  parser gives today. The `reason` text can change (see Decisions).
- Refuse a JSON number that is not a safe integer where Rust expects an
  integer, with the code `invalid_json_integer`.
- The schemas are JSON Schema (TypeBox). Pi tool parameters, the Plan 77
  plugin settings and the executor (below) use them directly, with no
  conversion.
- A Pi tool whose input is a contract type uses that contract schema as its
  parameters. Do not write a second JSON Schema for it.
- The schema library must work without `eval` or `new Function`, because a
  Worker forbids both. Check this in workerd in step 0.

### TypeBox rules

- All packages use one `typebox` version (1.3.27). The lockfile holds one copy.
  TypeBox marks its schemas with internal symbols, so schemas from two versions
  can fail to work together. Pi has no TypeBox dependency since 1.5.0, so this
  version no longer follows Pi. Pi takes a TypeBox schema as plain JSON Schema
  and does not run `Refine` or `Codec`.
- Check values with `Value.Check`, `Value.Errors` and `Value.Parse`. Do not
  use `Compile`, because it generates code at run time.
- `Value.Clean`, `Value.Decode` and `DecodeUnsafe` sort each union of the
  schema again on every call. In the contracts, call them through
  `cleanValue`, `decodeValue` and `decodeChecked` in
  `packages/underclerk-contracts/src/sorted-unions.ts`, which keep the sorted
  schema. On 2026-10-26 the repeated sort took half of Underclerk's CPU time
  in the inventory journey, which then ran past its 180 s budget.
- Use one shared `SafeInteger` schema (`minimum: -Number.MAX_SAFE_INTEGER`,
  `maximum: Number.MAX_SAFE_INTEGER`) for each value that Rust holds as an
  integer. A bare `Type.Integer()` accepts `2 ** 53`.
- `minLength` and `maxLength` count code points. They match Rust
  `chars().count()`. A Rust `len()` limit counts UTF-8 bytes, so it is a
  separate check with the byte-length helper, after `Value.Check`. For
  example, `maxLength: 1` accepts `"😀"`, which is 4 UTF-8 bytes.
- A rule that JSON Schema cannot express, for example "all refund lines use
  one currency", is a plain function that runs after `Value.Check`. It stays
  next to the schema, so the gap between the tool schema and the parser is
  visible.

### Pi tool arguments

- Pi converts the model's arguments before its own check with pi-schema's
  `parse`: it changes loose values, for example `"5"` to `5` and `"true"` to
  `true`, and it deletes an optional field that is `null`. The tool runs on the
  converted value.
- Pi also makes conversions that change the meaning: `2.5` to `2`, and `null`
  to `"null"`. `refuseChangedToolArguments` in
  `services/platform/src/actors/pi-tool-arguments.ts` refuses such a call, so
  that the model sends it again.
- The contract parser checks the converted value, not the raw model output.
- The contract parser itself never converts. A request body or a stored
  record with `"5"` where the contract has an integer is refused, as today.

### Logic moves with its types

Rust logic that is not a type moves to plain TypeScript modules in the same
package: the graph query planner and query semantics, cursors, observations
and transitions, the Plan 77 state machines and plugin contract, the
normalizers, supplier payouts, lab events, cue facts and the session reducer.
The Plan 77 machine and plugin definitions become TypeScript data, so their
generator binaries go away.

Each limit moves with its rule: size limits, `MAX_*` constants, query depth
and node budgets, and list lengths. A limit that protects against a large or
deep input stays in force from the first TypeScript release.

### Fixed outputs

- **Digests.** Make an inventory of each digest site in step 0, with the
  bytes that it hashes. If Rust hashes `canonical_json`, use the canonical
  JSON of `@lowerarchy/std`, after a check that both give the same bytes. If
  Rust hashes `serde_json::to_vec` of a struct, write an encoder for that type
  that gives the same bytes: the field order, the enum tag form and the
  omitted fields of the Rust type. Never hash `JSON.stringify` of a parsed
  object, because its key order comes from the parser. Each digest must be
  byte-equal to the Rust digest for the same input.
- **Text.** Give `@lowerarchy/std` three helpers and use them for each ported
  rule: the UTF-8 byte length for `String::len()`, the code-point count for
  `chars().count()` and a code-point comparator for Rust sorts and
  `BTreeMap` keys.
- **Timestamps.** Parse and format timestamps as text, with the precision of
  the Rust format. Never pass a timestamp through `Date`, because `Date` keeps
  only milliseconds.
- **Unicode.** Generate TypeScript tables for NFKC, case folding and
  `Default_Ignorable_Code_Point` from the Unicode 17.0.0 data files. A checked
  generator script writes them. Never call `String.prototype.normalize` for
  commerce text.

### The executor

- Move `file_native` (with `serde_yaml`) and the `satyr-file-native` binary
  into `crates/workspace-executor`. Only the executor and its test binary use
  them.
- Move `video_frames` and `media_metadata` into a new crate
  `crates/media-inspect`. The executor uses it natively. The Platform Worker
  uses it through a small Wasm module that has only these two functions. This
  binary parsing stays in Rust (see Decisions).
- Generate the Rust types of the executor's request and response from the
  TypeScript JSON Schema. TypeScript stays the one source for the wire
  format.

### Comparison before removal

Each step moves one area. The Rust path stays next to the new path until
production proof:

1. Comparison mode runs the TypeScript code and the old Wasm function on
   each call. Every exported function is pure, so the second run has no
   effect. Step 0 checks this for each function.
2. The comparison checks the canonical JSON of the two outputs, or the
   `kind`, `code` and field path of the two errors. It does not check the
   `reason` text.
3. A difference writes one `contracts.comparison_mismatch` trace with
   `traceWarn`: the function name, the field path and the two output
   digests. It never writes the input or the output, so no source data leaves
   its information-flow boundary.
4. The E2E suites run with TypeScript as the result and comparison on. The
   run writes a report: for each function, the number of inputs and the
   number of differences.
5. The first production release keeps the Rust result as the result and
   runs TypeScript beside it. A TypeScript fault therefore cannot write a
   wrong record or digest. When real traffic has passed through each
   function of the area with no difference, the next release makes
   TypeScript the only path and deletes the area's Rust code and Wasm
   exports.

This follows the rule that an old runtime path stays until real production
traffic passes on the new path.

Before an area's Rust tests are deleted, a capture hook records each input
that the Rust tests give to the exported functions. These inputs run one time
through the comparison. They do not become TypeScript tests.

E2E tests that exist only to check the Wasm boundary are deleted with it,
for example `tests/actor-reducer-wasm.test.ts`. A test that checks an
outcome stays and runs on the TypeScript path.

## Coordination

- When the owner accepts this plan, tell the Plan 76A and Plan 77 sessions
  about the rule in step 0: a new type or lifecycle goes into a TypeScript
  schema, not into Rust.
- Each step owns the Rust files of its area. If another session must change
  a Rust file of an area that is in comparison, it changes the TypeScript
  module as well, in the same commit.
- An Underclerk release and a Platform release can go out apart. No step
  changes the wire format, so their order does not matter.

## Steps

### Step 0 — Foundations

Work:

- Choose and add the schema library (see Decisions). Write the shared
  `ContractDecodeError` mapper and the `Equal<Old, New>` type checks.
- Write the digest inventory and the encoders that it needs.
- Add the text helpers to `@lowerarchy/std`. Write the Unicode table
  generator.
- Build comparison mode, its E2E report and the Rust test capture hook.
- Move `file_native` into the executor and `video_frames` and
  `media_metadata` into `crates/media-inspect`. Generate the executor's wire
  types from JSON Schema. Release the executor container image.
- Measure the baseline: the parse time of one checkout, one catalog read and
  one session restore through Wasm, the cold-start compile time of each Wasm
  module in workerd, and the Portal bundle size.
- From this step on, a new type or lifecycle goes into a TypeScript schema.

Proof:

- The schema library parses a sample of each kind of contract in workerd
  with no `eval`.
- `pnpm why typebox` shows one version.
- The Unicode module gives the same output as Rust for every line of the
  Unicode `NormalizationTest.txt` and for every string that the E2E suites
  normalize.
- Each encoder in the digest inventory gives the Rust bytes for every value
  that the E2E suites hash.
- The workspace executor journey passes with the moved crates and the
  generated wire types.

Cost: about 1.5 weeks.

The [status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-78-foundations.md) records the local work.
Step 0 remains open until its release gates pass: the executor image release
and the cold-start p95 check in production.

### Step 1 — Underclerk entity plane

Work:

- Move the entity plane: attributes, entities, identity, authority,
  commands, lists, views, schemas, relationships, observations, receipts,
  queries, query semantics, the graph query planner, cursors and Unicode.
- Update `services/underclerk/src/entity-plane/lexicon.ts`, the
  `@underclerk/commerce-query-sqlite` compiler, the five entity-plane files
  of `@underclerk/client` and `actors/commerce-query-schema.ts` in Platform.
- Delete the Underclerk browser validator build, and remove the commerce
  validators from the Satyr browser core.

Proof: comparison mode reports no difference in the Underclerk and Platform
E2E suites and in production. Query fingerprints and cursors are byte-equal.
Every refusal in the entity-plane journeys has the same error.

Cost: about 1.5 weeks.

Status (2026-10-25): both suites pass with TypeScript as the result and show
no difference. `UNDERCLERK_CONTRACT_AUTHORITY` selects the result in
Underclerk; Platform's entity-plane checks select it in code. Since
2026-10-25 10:03 UTC, TypeScript is the result in production, with Rust
compared beside it. The removal work of this step is Step 6.

### Step 2 — Underclerk records and commands

Work:

- This is the old Plan 77 step 7, in TypeScript. Write a schema for every
  record and command type, area by area: payments and checkout first, then
  orders, catalog, customers and the rest. Include the 200 types that exist
  only in TypeScript.
- Each area deletes its hand-written parsers in `@underclerk/client`.
- The Plan 77 state machines and plugin contract become TypeScript data.
  `commerce-machines.ts` becomes a source file, and
  `pnpm lint:underclerk-spec` keeps reading it.
- The plugin host validates the output of each QuickJS plugin function
  (Plan 77 step 4) with the new schemas.
- Each Pi tool whose input is a commerce contract type takes its parameters
  from the new schema. Delete the hand-written JSON Schema of that tool.

Proof: every request body and stored record that the suites write parses to
the same value with the old and the new parser. Every refusal in the
journeys gets the same error. `pnpm lint:underclerk-spec` passes with no
spec change.

Cost: about 3 weeks, in parts.

Status (2026-10-25): every client reader that a response or a stored record
goes through has a schema, and both suites show no difference in either mode.
Since 2026-10-25 10:03 UTC the schemas decide in production, and the hand
readers are compared beside them until Step 6 deletes them.

### Step 3 — Underclerk normalizers and the commerce lab

Work: move the Shopify and Stripe normalizers, `applyCommerceObservation`,
supplier payables and payouts, lab events, cue facts and food service. This
removes the commerce functions from Satyr's Wasm module and deletes
`commerce-wasm.ts` in Platform. The `commerce-parity-native` binary goes away.

Proof: `pnpm --filter satyr-edge test:commerce-lab` and the lab sequence
(`lab:reset`, `lab:seed`, `lab:scenario`, `lab:verify`) pass with comparison
mode on and no difference. Payout plan digests are byte-equal.

Cost: about 1.5 weeks.

### Step 4 — Satyr messages and access control

Work:

- Move access control (the Satyr browser validators), messages and message
  views, stored attachments, attachment preparation, goals, Portal chat
  delivery and file context.
- `message-wasm.ts` keeps only the calls to `crates/media-inspect`.
- Delete the Satyr browser validator build. The Portal starts without
  `initializeBrowserValidators()`, so remove that wait from
  `bootstrap.tsx` and `dev/commerce-preview.tsx`.
- Delete the Rust predicate evaluator and `fixtures/predicate-cases.json`.
  They have no product caller, so they are not ported.
- Delete Platform parsers written by hand that a new schema replaces.
- Each remaining tool in `actors/harness-tool-catalog.ts` and the other
  harness tool files whose input is a contract type takes its parameters
  from the contract schema. A tool input that is not a contract type stays
  as it is.

Proof also: a Pi tool call with an input that the contract refuses gets the
same refusal from the tool schema and from the contract parser. The proof
uses the arguments after Pi's conversion, not the raw model output.

Proof: the Slack and Portal message journeys, the attachment journeys and an
allowed and denied access journey pass with comparison mode on and no
difference. Message and attachment digests are byte-equal. The Portal
build and the Plan 40 and mail-inbox browser fixtures run on the TypeScript
validators.

Cost: about 1 week.

### Step 5 — Satyr session reducer

Work: move `restoreSession`, `advanceSessionCommand`, the model route
digest, checkpoint IDs and the checkpoint validators (`actor.rs`,
`actor/serialized.rs`). Delete `actor-wasm.ts`.

Proof:

- Every journal that the E2E suites write restores to the same state with
  both reducers, and every command gives the same next state or refusal.
- Checkpoint IDs and model route digests are byte-equal.
- The eviction, relocation and fork journeys of Plan 71 and the Plan 50
  durable execution evaluation pass.
- In production, sessions restore and advance with no difference before the
  Rust reducer is deleted.

Cost: about 2 weeks.

### Step 6 — Removal

Work:

- Code: delete both contracts crates, `wasm-pkg`, `generated/`, `bindings/`,
  `wasm.d.ts`, the browser validator files and scripts, the `typegen`,
  `wasm:*` and `browser-validators:*` scripts and `contracts:wasm`. Remove
  `binaryen`, `esbuild` and ts-rs where only the contracts used them.
- Cargo: remove both crates from the workspace members, and remove the
  workspace dependencies that only they used (ts-rs, `wasm-bindgen`,
  `oxixml-unicode`, `regex`, `unicode-normalization`). Update `Cargo.lock`.
- Package scripts: Platform `check:types`, `test:e2e`, `deploy` and
  `deploy:staging`; Underclerk `test`, `deploy`, `deploy:staging` and
  `contracts:browser-validators`; Portal `build`.
- Build config: the `lexicon-validator-wasm` condition and alias in
  `apps/portal/vite.config.ts`, and the Wasm aliases in
  `services/platform/vitest.config.ts` and `services/underclerk/vitest.config.ts`.
- Test helpers: `services/platform/tests/commerce-wasm-module.ts` and the
  browser validator check in `tests/underclerk-fixture-worker.ts`.
- CI: in `satyr.yml`, the `wasm-pack` installs, the typegen check, the
  `contracts:wasm` runs and the two Wasm test steps. In
  `commerce-components.yml`, the typegen check. Keep the Rust toolchain for
  `bakery-native`, the executor, `media-inspect` and the fetch containers.
- Scripts: `scripts/plan-50/evaluate-pi-durable.mjs` and
  `canvas-acceptance.mjs` (Wasm path and the moved `satyr-file-native`),
  `scripts/benchmark-optimization-1.mjs`, `scripts/plan40/fixture/main.tsx`,
  `scripts/plan40/protocol-peer.mjs`, `scripts/mail-inbox/mount-browser-fixture.js`
  and `scripts/production-simulation/verify-oven-authoring-browser.js`.
- Delete comparison mode and the `Equal<Old, New>` checks.
- Docs: `AGENTS.md` (active runtime and repository boundaries),
  `README.md`, `docs/commerce-monorepo.md`, `services/underclerk/docs/spec.md`
  (three places that name Rust), `services/platform/tests/commerce-lab/AGENTS.md`
  (it names Rust as the lifecycle source), the public docs in `apps/docs`
  (`concepts/architecture.md`, `operate/index.md`, `reference/contracts.md`,
  `reference/service-map.md`) and Plan 77.

Proof: a clean checkout runs `pnpm install`, the Platform and Underclerk
type checks, the E2E suites, `pnpm lint:runtime-boundary`,
`pnpm lint:underclerk-spec` and `pnpm portal:build` with no Rust contracts
code. `cargo check --workspace` passes for the remaining crates. The
measurements of step 0 are repeated and recorded.

Cost: about 4 days.

Status (2026-10-26): done and released on 2026-10-25 16:35 UTC (Underclerk
`6d4aa10a`, Platform `3fa3f20c`). No Rust contracts code remains, and
TypeScript is the only contract path. The clean-checkout proof passed. The
Platform E2E suite fails the same 63 tests as before Step 6; see the
[status ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-78-foundations.md).

## Decisions

| Decision                | Recommendation                                                                                                                                                                                                                                                                                                                                                       | Cost                                                                                                    | Default if no answer |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------- |
| Schema library          | TypeBox (`typebox` 1.x). A TypeBox schema is JSON Schema, and Pi tools already use it, so contracts, Pi tools and plugins share one schema system and add no dependency. Use `Value` checks, not the `Compile` path, unless step 0 shows that `Compile` works in workerd with no `eval`. Zod 4 was the first recommendation; it needs a conversion for each Pi tool. | `Value` checks are slower than compiled checks; measured in step 0 against the performance budget.      | TypeBox              |
| Error reason text       | Keep `kind`, `code` and the field path. Let the `reason` text change where it is serde's message today.                                                                                                                                                                                                                                                              | An agent or a log reader sees new wording for some refusals. No code or path changes.                   | Reason may change    |
| Media parsing           | Keep `video_frames` and `media_metadata` in Rust (`crates/media-inspect`). The executor needs them natively, and one implementation avoids two copies of the same binary parser.                                                                                                                                                                                     | The Platform Worker keeps one small Wasm module.                                                        | Rust                 |
| Executor wire types     | Generate the Rust types from the TypeScript JSON Schema.                                                                                                                                                                                                                                                                                                             | One generator step in the executor build.                                                               | Generate             |
| Production comparison   | Rust stays the result in the first production release of each area, with TypeScript beside it. The next release makes TypeScript the only path.                                                                                                                                                                                                                      | Two releases for each area. Until then, the old Wasm stays in the bundles and each call runs two times. | Rust first           |
| Performance budget      | TypeScript must not be slower than Wasm at p95 on the measured paths, with the cold start included. If one path is slower, stop and report before the area is released.                                                                                                                                                                                              | None, unless a path is slower.                                                                          | Stop if slower       |
| Order                   | Underclerk first (steps 1–3), then Satyr (steps 4–5), with the session reducer last because its fault costs the most.                                                                                                                                                                                                                                                | Satyr's Wasm module stays until step 5.                                                                 | Underclerk first     |
| Pi tool schema size     | A Pi tool takes its parameters from the contract schema only when that schema is small. A large one keeps a short tool schema, and the tool parses its input with the contract parser, so it refuses what the contract refuses. `commerce_entity_context` is the one case today: its contract schema is 237,871 bytes.                                               | None. Sending the contract schema would add about 60,000 tokens to every turn.                          | Short tool schema    |
| New Rust contract types | Stop now: after step 0, a new type goes into TypeScript.                                                                                                                                                                                                                                                                                                             | Open Plan 76A and Plan 77 steps write TypeScript schemas instead of Rust.                               | Stop                 |

## Out of scope

- `crates/bakery-native`, the fetch containers and the executor's own logic.
- A Rust Worker.
- Any change to an API, a stored record format, a digest or an error code.
