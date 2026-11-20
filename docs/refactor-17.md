# Refactor 17 — Three layers: foundation, product areas, surfaces

Date: 2026-11-20. Revised two times on 2026-11-20: after a review of the first version,
and after a second review with the owner's request to prune
([What the reviews changed](#what-the-reviews-changed)).
Status: accepted in part; step A0 and step S1 are done and on `dev` since 2026-11-20
(see [Steps done](#steps-done) and [Baseline](#baseline)). The owner accepted the two stages, one decision
API for approvals, specs by subsystem, and the prune of dead code, duplicate code and
low-impact tests. The other decisions in [Decisions](#decisions) need the owner.
Owner: the whole repository.
Touches: every folder, every plan document, `AGENTS.md`, the lint scripts, the deploy
scripts and each open branch.

The counts come from `origin/dev` at `e18cecb` (2026-11-20), unless a line says
`main`. The first two versions measured `main` at `18c97fe`, which is 170 commits
behind `origin/dev`. The work started from `origin/dev`.
The counts of the sections before [Steps done](#steps-done) come from name rules, a
first guess. `scripts/layers.json` replaced those rules in step A0.2, and
`node scripts/check-layers.mjs --report` gives the counts of the current tree.

## Goal

1. The code has three layers:
   - **Foundation**: libraries that know no product area and no surface. Other code
     combines them.
   - **Product areas**: one unit for each business domain, with its contract, server
     code, Portal pages and agent tools.
   - **Surfaces**: the ways that a person or a system reaches Pantry.
2. An import can go only down: surface, then area, then foundation. A lint refuses
   each other direction.
3. The eight faults of the review on 2026-11-20 are closed.
4. Each step leaves less code than it found: it removes the dead code, the duplicate
   code and the low-impact tests that it meets ([Prune](#prune-with-each-step)).
5. The plans become specs: one spec for each subsystem, in the folder of its area,
   with an ordinal number. Only work that is not built stays a plan.

## Two stages

- **Stage A: the layers in place.** A list gives each file its layer and its module.
  A lint enforces the direction. Each upward import is removed where the file is
  today. No file leaves its package. Stage A has value with no folder move: the
  direction is real, and each area has an owner and a public entry.
- **Stage B: the folders.** The files move to `foundation/`, `areas/`, `surfaces/`
  and `workers/`. Stage B starts after two conditions: the ratchet of Stage A is near
  zero, and the Plan 93 cutover is done. The owner decides Stage B again at that
  time, with the facts that Stage A measured.

The documents have their own track, [Stage S](#stage-s--plans-become-specs).

## Why

The repository groups code by technology. One product area is in up to seven places.
Kitchen is the clearest example:

| Part of Kitchen (measured on `main`) | Place today                                                                                                                                     |   Lines |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------: |
| Portal pages                         | `apps/portal/src/features/{production-run,workflow-simulator,costs,recipes}`                                                                    | 131,000 |
| Model and engine                     | `packages/{bakery-model,production-simulation,bakery-workflow}`                                                                                 |  84,700 |
| CRDT documents                       | `packages/{workflow-canvas-crdt,costs-sheet-crdt,production-plan-crdt}`                                                                         |   3,100 |
| Server code and agent tools          | `services/platform/src/commerce/bakery`, `actors/bakery-*`, `actors/workflow-*`, `control/routes/bakery*`, `agent-tools/{bakery,kitchen,costs}` |  25,000 |
| Physics                              | `crates/bakery-native`                                                                                                                          |  20,000 |
| Model builders and journeys          | `scripts/{bakery-mujoco,bakery-robots,production-simulation}`                                                                                   | 145,000 |

The measurements of the Platform Worker (`services/platform/src`, 469,000 lines):

- **It mixes the layers.** The rules put about 211,000 lines in the foundation,
  205,000 in product areas and 51,000 in surfaces. `actors/` (152,000 lines) holds the
  actor runtime and also the mail, WhatsApp, menu board, Kitchen and commerce code of
  the actors.
- **588 of 5,683 imports between two modules point upward.** The largest groups: the
  foundation imports `integrations` (88), the Case and Connector code imports Slack
  and Portal code (65), and the tool executor names Kitchen and Commerce tools (55).
- **275 imports go from one area into the inside of another.** Most pairs go both
  ways: `inbox` and `integrations`, `commerce` and `integrations`, `commerce` and
  `cafe`, `commerce` and `kitchen`.
- **184 imports go against a bottom-up order inside the foundation.**
- **The packages point upward too.** `contracts` depends on `commerce-contracts` and
  exports all of it again with `export *`. `OrganisationId` is defined in
  `commerce-contracts`. `control-api` depends on 6 packages of three areas.
  `bakery-model` depends on `commerce-client`. Foundation files import an area
  package 44 times; `define-tool.ts` imports a Kitchen type.
- The counts give about 1,100 imports to remove or to invert.

Other facts:

- **The Portal is closer to the target.** Its features have 234 imports between two
  features, and 112 of them are between `production-run` and `workflow-simulator`.
- **`scripts/` has 514 files.** Many folders serve one plan.
- **The journeys read the inside of the Worker.** 174 of the 237 E2E files import
  from `src/`.
- **Plan 92 already pruned much.** Its phase 2 removed 33,700 lines of unused and
  legacy code, merged copies (jscpd: 885 clones to 491, 1.0 % of the product lines)
  and removed about 32,600 lines of tests. [Prune](#prune-with-each-step) gives what is left.
- **The plans are history, not specs.** `docs/` holds 61 plan files and 4 refactor
  files. Each one mixes the design, a status log and release records.
  Several plans describe one mechanism: Plans 27, 27C and 89 are all information
  flow, and Plans 76, 76A, 77 and 80 are all the commerce engine.
- **Code names the plans.** 903 source files mention a plan number, 1,560 times. 213
  of the mentions name 26 plans that are only in the archive.

The review also found these faults:

| #   | Fault                                                                | Evidence                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | The information-flow exit check is a convention in each tool handler | `executeRegisteredTool` (`agent-tools/catalog/execute.ts:401`) parses, claims and calls the handler. About 7 helpers at 13 sites run the check. The lint checks only the class of a capability. The executor also names 17 error classes of the areas (`execute.ts:319`) |
| F2  | Parallel paths for one concern                                       | The mailbox and WhatsApp tool hosts (`actors/email-harness-tools.ts`, 1,083 lines) use no registry and no capability claim. A person meets 4 approval mechanisms. 5 outboxes exist                                                                                       |
| F3  | Most guards do not run in CI                                         | CI runs 5 of the 15 `lint:*` scripts. No git hook exists                                                                                                                                                                                                                 |
| F4  | Kitchen cannot run on the server                                     | Physics runs only in the browser. `schedule.ts` (4,510 lines) and `engine.ts` are two planners. `dev/workflow-preview.tsx` ships in the production bundle                                                                                                                |
| F5  | The Portal has no server state layer                                 | 107 `controlRead` calls in ad-hoc hooks. `useLatestRead` has 3 users. 1,212 raw `<button>` elements, no `Button`. `styles.css` has 11,106 lines, and the size ratchet skips CSS. Two surface registries                                                                  |
| F6  | Commerce providers have no shared interface                          | 20 files branch on the commerce system kind. The `CommerceSystem` union has 4 copies. The Shopify API version has 4                                                                                                                                                      |
| F7  | The CRDT packages repeat one skeleton                                | 7 packages repeat the encoding wrapper and the document class. `workflow-canvas-crdt` has its own protocol                                                                                                                                                               |
| F8  | The documents drift                                                  | 28 broken links (on `main`). `AGENTS.md` has 689 lines. Plan 14 names a retired harness                                                                                                                                                                                  |

## The three layers

```text
surfaces/     portal · slack · email · whatsapp · webhooks · storefront · shop · voice · docs-site
                 │ imports the public entry of an area, and the foundation
areas/        commerce · cafe · kitchen · inbox · brain · integrations · devices · organisation
                 │ imports the foundation, and the contract of another area
foundation/   std · kernel · contracts · tenancy · actor-runtime · authority · connections
              control · agent-tools · agent · conversation · collaboration · ui · testing
workers/      the deployed Workers. Each one composes the three layers and holds no logic.
```

**Foundation.** A foundation module is a library. It defines a host and its ports: the
actor runtime, the authority chain, the tool executor, the shared draft room. It names
no area and no surface. A closed union of wire values in `contracts` may list each
kind, because it is data. The behavior for each kind is in the area or the surface.

**Product area.** An area owns the records and the rules of one business domain. It
gives the hosts its parts: tools, routes, actor modules, cue sources and Portal pages.
An area reads another area only through that area's `contract`.

**A call between two areas.** The `contract` of an area holds its schemas and also
its service interfaces, for example `CommerceOrders` with `readOrder`. The `server`
of the area implements the interface. The Worker gives the implementation to each
area that asks for it. So `inbox` can read an order with no import of the inside of
`commerce`. The contracts have no cycle: a type that two contracts need goes down to
`contracts`, and `lint:layers` refuses a cycle.

**`connections`.** The foundation imports `integrations` 88 times, and four areas
import it too. Its core is therefore a foundation module: the integration account,
the connection, the credential generation and the provider adapter interface. The
provider adapters themselves, the custom connectors and the onboarding stay in the
area `integrations`. Step A0.2 draws the line by file.

**Surface.** A surface owns a transport and its presentation. Slack, email, WhatsApp
and the Portal chat stream are four channels of one kind. A surface holds no domain
rule.

**Worker.** A Worker holds a Wrangler file, the entry module and the Durable Object
class shells. A shell keeps the deployed class name and its RPC method names, and each
method calls one module. `workers/` is the composition root, not a fourth layer. A
Wrangler file lives only there. No module imports a Worker.

### Import rules

| From                             | May import                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A foundation module              | A foundation module lower in [the order](#foundation-modules)                                               |
| The `contract` of an area        | `std`, `kernel`, `contracts`, and the `contract` of another area                                            |
| The `server` and `ui` of an area | The foundation, its own `contract`, the `contract` of another area (its schemas and its service interfaces) |
| A surface                        | The foundation and the public entry of an area                                                              |
| A Worker                         | All three layers                                                                                            |
| A journey                        | A Worker, and the `testing` entry of a module                                                               |
| The commerce engine              | Only `std`, `type-utils`, its contracts and its client, as today                                            |

One pattern replaces each upward import: **the host defines a port, the area gives a
part, the Worker registers it.** The tool registry already works this way.

### The split of three mixed folders

The review placed these by hand:

| Folder                    | Split                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat/` (18,300 lines)    | The conversation store, access, forks, side Cases, sharing and `turn-access.ts` go to `conversation`: actors, tools and draft code in about 30 files import them. The stream, the prompt, the screen context and the page labels are the Portal surface (about 7,600 lines with the other Portal-only files) |
| Mail and WhatsApp         | The transport is a surface: `mail/`, `whatsapp/`, the Connector's email and WhatsApp code (20,400 lines). The Inbox page, the mailbox agent and the reply drafts are the area `inbox` (29,200 lines)                                                                                                         |
| `case-context-discovery/` | Foundation (`agent`): the Case, the Session and the Organisation actors import it. `case-execution/` stays in `brain`                                                                                                                                                                                        |

### Names

- A folder name is a domain word, not a brand word: `commerce`, `cafe`, `kitchen`,
  `inbox`. A later brand rename then changes no path.
- "Tools" has one meaning: agent tools. The foundation module is `agent-tools`. The
  scripts of an area are in its `scripts/` folder. The repository scripts stay in
  `scripts/`.
- Package names use the scope of Plan 94, `@purin-labs/*`, which is on `origin/dev`.

### Foundation modules

The order is bottom-up. A module imports only modules above it in this table.

| #   | Module                     |                                       Lines today |                      Imports against the order |
| --- | -------------------------- | ------------------------------------------------: | ---------------------------------------------: |
| 1   | `std`, `type-utils`        |                                             1,000 |       — (packages today; the engine uses them) |
| 2   | `kernel`                   |                                             1,200 |                   12, almost all from `env.ts` |
| 3   | `contracts`                |                                            10,700 |     1 package dependency: `commerce-contracts` |
| 4   | `tenancy`                  |                                            15,600 |                                             28 |
| 5   | `actor-runtime`            |                                            14,700 |                                             28 |
| 6   | `authority`                |                                            36,100 |                                             27 |
| 7   | `connections`              |                          not measured (step A0.2) |                                   not measured |
| 8   | `control`                  | 1,900, the Portal client, a part of `control-api` | 5, and 6 package dependencies of `control-api` |
| 9   | `ui`                       |                                            16,500 |        — (it imports only `std` and `control`) |
| 10  | `agent-tools`              |                                            12,000 |                                             41 |
| 11  | `agent`                    |                                            84,400 |                                             41 |
| 12  | `conversation`             |                                            43,300 |                                              2 |
| 13  | `collaboration`            |                                             3,000 |                                              — |
| 14  | `async-control`, `testing` |                                            18,100 |                                              — |

`std` stays apart from `kernel`, so that the commerce engine imports no Platform code.
The shared primitives that `commerce-contracts` defines today, such as
`OrganisationId` and `StrictObject`, go to a package that the engine may import
(step A1.11).

A module has named entries and no root entry. `agent` has seven: Session, harness,
model routes, Code Mode, executor, context, cues and schedules. `conversation` has
four: Case, Connector, native chat, Projects. `authority` has six: grants, policy,
information flow, action ledger, Vault, redaction. A root entry over 88,000 lines can
make an import cycle at the start of the Worker.

## Rules for every step

These rules continue the rules of [Refactor 10](refactor-10.md):

- **Classify first, fix the direction in place, move last.**
- **An inversion is a code change.** Each one lands as a small commit with the E2E
  suite, before any move.
- **Keep the wire values.** Do not change: tool names, capability ids, rerun rules,
  journal and receipt kinds, Durable Object class names, RPC method names, SQLite and
  D1 table names, the actor export envelope, Pi checkpoint fields and CRDT frame
  bytes. The Plan 93 cutover ends this rule.
- **Keep the tool catalog digest.** The digest hashes the ordered list of
  definitions (`agent-tools/catalog/selection.ts:270`). The order of the definitions
  stays as it is today, and each landing compares the digest with the baseline.
- **No stored data changes in Stage A.** A step that needs a D1 patch or an actor
  schema step waits for the cutover.
- **Each landing can ship.** Other sessions release from `dev`, so a landing ships
  with the next release. Each landing passes `wrangler deploy --dry-run` for the six
  Workers. The session that lands a port checks the first release that holds it:
  the health checks and one live Portal chat turn.
- **One landing for each port or module.** Land on `dev` with a fast-forward. Stage
  explicit paths. A file with another session's uncommitted changes waits.
- **Prune in the same step, in its own commit.** [Prune](#prune-with-each-step) gives
  the rules. A landing reports the lines that it removed and added.
- **No new unit tests.** The checks are the lints, the type checks, the E2E suite on
  two databases, the Portal build and the Kitchen journeys.
- **This refactor adds no cron, alarm, poll or queue retry.** The idle tenant journey
  runs after each step that changes an actor constructor.

## Stage A — The layers in place

### A0 — Guards and the map

| Step | Work                                                                                                                                                                                                                                                                                                                                                                                                                           | Closes |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A0.1 | Run every lint in CI. `pnpm lint:source` holds the lints that need only the git tree, with `check:shared-helpers`. `pnpm lint:static` adds the two checks of the physics files. `pnpm lint` adds `lint:d1-patch`, which needs a base revision; CI keeps its own step for it. Add a pre-push hook that runs `lint:source`, for the time that CI has no budget                                                                   | F3     |
| A0.2 | Write `scripts/layers.json`: each source file with its layer and its module, and each D1 table with its owner module. An actor table takes the module of the file that creates it. Start from name rules, then review each file by hand. Cover the Platform, the Portal, the packages, the crates, the scripts and the tests. The measure also reads imports of workspace packages and the dependencies of each `package.json` | —      |
| A0.3 | Add `pnpm lint:layers`. It reads the targets and the imports of the current tree. It refuses a new upward import, a new import of the inside of another area, a new import against the foundation order, and a new file with no target. A ratchet file holds the known crossings (about 1,100), and its count can only go down                                                                                                 | —      |
| A0.4 | Record the baseline: the lints, the type checks, the E2E suite with its run time, the Portal build, the tool catalog digest and the bundle size of each Worker                                                                                                                                                                                                                                                                 | —      |
| A0.5 | Add a link check for `docs/` and `AGENTS.md` to `pnpm lint`                                                                                                                                                                                                                                                                                                                                                                    | F8     |
| A0.6 | List each file that holds a path of another file: the 15 lint scripts, `eslint.config.mjs`, the 4 ratchet files, `journeys.json`, the Vitest configs, the Wrangler files (also `image_build_context: "../.."`), the Dockerfiles, `Cargo.toml`, CI, `repo-binaries.json`, the action registry generator and the deploy scripts. Stage B needs this list                                                                         | —      |
| A0.7 | Add a guard for silent failure: each path that `eslint.config.mjs` or a lint script names must match at least one file. 12 import rules of the information-flow boundary name exact paths today, so a renamed file turns its rule off with no error                                                                                                                                                                            | —      |
| A0.8 | Record the prune baseline: a knip scan and a jscpd scan with their exact commands, and the list of test files with their kind ([Prune](#prune-with-each-step))                                                                                                                                                                                                                                                                 | —      |

### A1 — Ports

Each step defines one port in the foundation and moves the area code behind it. The
files stay in their folders.

| Step  | Port                        | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Closes |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| A1.1  | Typed actor access          | No code outside the Worker entry and `env.ts` imports the class of an Actor. The Actor router and the stub helper are generic: the type of a stub follows the type of the namespace that the caller gives. `env.ts` gives one stub type for each binding, and a caller names that type. Done on 2026-11-20 ([Steps done](#steps-done))                                                                                                                                                                                                                                                                                               | —      |
| A1.2  | Environment parts           | `env.ts` imports no Actor and no area. A binding whose type belongs to a higher module is declared by that module, with a declaration merge of the interface `Env`: each Actor namespace beside its class, each queue beside its message type, each container beside its class. Done on 2026-11-20 ([Steps done](#steps-done))                                                                                                                                                                                                                                                                                                       | —      |
| A1.3  | Tool families               | The executor names no area. One base class, `ToolRequestError`, replaces the 17 error classes. A handler gets a tool context of the foundation (the Session, the lease, the scope) and the services of its own area. This replaces `CatalogToolAuthority`, one object with a callback for each tool of each area. `ToolSelection` names no Kitchen type: a surface command is a string that the area checks. The special cases in `execute.ts` (`commerce_entity_context`, `requestableRead`, the bakery receipt reader) become fields of their tool definitions. The tool families register through one list, in the order of today | F1     |
| A1.4  | Effect in two parts         | A `draft`, `receipt` or `scheduled` tool (27 tools) defines `prepare` and `run`. `prepare` does the live checks and the reads, then returns the sink, the action and `run`. The executor reads the label, runs the exit check and calls `run`. This is the shape of `settleStaffPageEffect` today, for every effect tool. A staff page effect keeps its second check. The step first lists what each `proposal` tool (13) and each `surface` tool (43) does today, and it keeps that. `lint:layers` then refuses an effect tool with no `prepare`                                                                                    | F1     |
| A1.5  | One tool host               | The mailbox and WhatsApp hosts dispatch through the registry, with the selection rules `agent_mailbox` and `whatsapp_support`. Capability claims for them are a separate decision (D6)                                                                                                                                                                                                                                                                                                                                                                                                                                               | F2     |
| A1.6  | Channel adapter             | Slack, email, WhatsApp and the Portal chat stream register as channel adapters. The Case and Connector kernels import no card, no mailbox row and no stream                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —      |
| A1.7  | Session ports               | The Session names no area: integration reads, Inbox reads, commerce proposals and Kitchen effects arrive as ports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —      |
| A1.8  | Authority ports             | The access-control read model gets the integration accounts and the provider catalogue through a port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —      |
| A1.9  | Actor modules               | A Durable Object class composes modules. The class chains end: `ConnectorDO` over `ConnectorEmail`, `ConnectorEvals` and `ConnectorWhatsApp`, and the 6 levels of `SessionDO`. Each class keeps one ordered list of schema steps. A module gives its steps, and the class sets their order, so the stored versions do not change. Each module then declares the RPC interface of its part, for example `ProductionPlanRoomRpc`, and a caller in another module names that interface. Callers use 245 methods of the four Actors at 440 places, so this step is done one module at a time                                             | F2     |
| A1.10 | Area contracts              | Each area marks its public files in the targets: its schemas and its service interfaces. The 275 imports between areas go through them. A call goes through a service interface that the Worker wires. No cycle between two contracts                                                                                                                                                                                                                                                                                                                                                                                                | —      |
| A1.11 | Contracts and `control-api` | `contracts` stops its `export *` of `commerce-contracts`: each of its 40 import sites names what it needs. The shared primitives move below both. `control-api` loses its 6 dependencies on area packages: each area slice of it becomes a part of that area's public files. `bakery-model` reads commerce through the commerce contract                                                                                                                                                                                                                                                                                             | F6     |

### A2 — The faults that need no port

| Step | Work                                                                                                                                                                                                                                                                                                                                                                | Closes |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| A2.1 | One decision API over the four approval stores: one read of the decisions that wait for a person, and one card component in the Portal and one in Slack. The stores stay: the action ledger in `OrganisationDO` SQLite, the Case approval wait in `CaseDO` SQLite, the held output and the permission request in regional D1, the email challenge as a signed value | F2     |
| A2.2 | `useLatestRead` and `useMutation` as the one way to read and change in a Portal component. A ratchet counts the direct `controlRead` calls in a component                                                                                                                                                                                                           | F5     |
| A2.3 | Add `Button` to `ui/`. Put each token in one file. Add CSS to the file-size ratchet. One surface registry (Plan 87, section 5)                                                                                                                                                                                                                                      | F5     |
| A2.4 | `dev/workflow-preview.tsx` becomes a page of Kitchen with no preview fixture, and the two rehearsal pages get the same decision. CI fetches `/workflow-preview.html`, and 19 browser scripts name the file, so the step changes them in the same landing. A lint checks that the Kitchen engine and model import no DOM type, so that a server run stays possible   | F4     |
| A2.5 | One `CommerceProvider` port with two implementations: the built-in engine and Shopify. The 20 branches on the system kind go behind it. One definition of the `CommerceSystem` union and of `BankPayout`. Shopify becomes one module that is easy to delete ([The Shopify module](#the-shopify-module))                                                             | F6     |
| A2.6 | `defineSharedDoc({ schema, validate })` in `collaboration` gives the encoding wrapper, the document class and the protocol. Each CRDT package keeps its schema and its operations. `workflow-canvas-crdt` uses `createSyncProtocol`. The frame bytes stay                                                                                                           | F7     |

#### The Shopify module

The owner decided on 2026-11-20: Shopify stays for now, as a connection, and all its
code goes into one module that can be deleted later.

Today 32 files have "shopify" in their path: 13 in `shopify/`, and the others in
`actors/`, `provider-adapters/`, `provider-workflows/`, `commerce-contracts`, the
tests, the scripts and `integrations/shopify`. 168 other files mention Shopify.

After step A2.5:

- One folder holds the Platform code of Shopify: the connector, the webhooks, the
  action execution, the provider adapter, the connection workflow, the location
  observation and the normalizer. It also holds the one constant of the API version.
- Other code reaches the module in three ways only: the `CommerceProvider` port, the
  provider adapter interface of `connections`, and one registration list in the
  Worker entry.
- `lint:layers` refuses each other import of the module.
- The Shopify tests, the Shopify scripts and the Portal parts that show Shopify are
  listed in one file of the module, `REMOVE.md`. A removal is then: delete the
  module and the listed files, remove the registration lines, and remove `"shopify"`
  from the closed unions of the contracts. The type check then shows each place that
  still names it.
- In Stage B the module is `areas/integrations/shopify`.

Refactor 16 keeps the physics work: its step 10 owns the agent run with no open
browser, and its step 16 owns the model builders. Plan 24 keeps the server run of a
physical bake. This refactor does not remove `schedule.ts`.

### The end of Stage A

- The ratchet of `lint:layers` is near zero. Each remaining crossing has a written
  reason.
- Each area has a list of its files, its tables and its public files.
- No export is public without a user in another module. No test file is left without
  a decision.
- The time of the first three ports is measured, and the estimate for the rest uses
  it.
- The owner decides Stage B.

## Steps done

**20 November 2026. Step A0 and step S1 are done.** The owner agreed to the landing,
and the commits are on `dev` since that day.

| Step | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0.1 | `pnpm lint` is `lint:static` and `lint:d1-patch`. CI runs `pnpm lint:static` in one step, in place of five lint steps and the shared helper step. `.githooks/pre-push` runs `lint:source`. The hook is off: its setting is shared by every worktree of a clone, so the owner decides it                                                                                                                                                                                                                                                           |
| A0.2 | `scripts/layers.json`: 105 folder rules and 621 file lines for the 1,788 source files of `services/platform/src` and `apps/portal/src`, a module for each of the 26 workspace packages, a place in the target layout for each other tracked folder (`placement`), and an owner module for each of the 218 D1 tables (`tables`). The review moved 35 Platform files, among them 9 onboarding files that a name rule had put in `cafe`. `foundation/connections` has no file yet: its files are in `areas/integrations`                             |
| A0.3 | `pnpm lint:layers` (`scripts/check-layers.mjs`) with `scripts/layers-ratchet.json`: 1,350 crossings in 231 pairs. 671 imports go upward, 377 go between areas, 176 go against the foundation order, and 126 SQL writes change a table of another module. A pair cannot grow, and a new pair is refused. The lint also refuses a source file with no module, a tracked folder with no place and a D1 table with no owner. `--tables` prints the writers of each table, and `--misfits` prints each file whose imports are mostly in another module |
| A0.4 | [Baseline](#baseline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A0.5 | `pnpm lint:doc-links`: 833 relative links in 180 pages. `scripts/doc-links-ratchet.json` holds 31 links that were broken before, most of them in the two architecture documents. Step S2 removes them                                                                                                                                                                                                                                                                                                                                             |
| A0.6 | `node scripts/check-lint-paths.mjs --bound` prints each file that holds the path of another file: 472 files with 3,341 paths. 264 are scripts, 91 are test support files, 29 are tsconfig files, 26 are lint and ratchet files and 25 are package manifests. `--bound --list` gives the files for the move script of Stage B                                                                                                                                                                                                                      |
| A0.7 | `pnpm lint:lint-paths`: 953 paths in 27 lint files match a file. No lint path was broken                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A0.8 | `pnpm lint:clones` (jscpd 5.4.3, `.jscpd.json`, `scripts/clones-ratchet.json`) refuses a new copy of product code. The baseline holds the count of the copies for each pair of files; a first form with one fingerprint for each copy changed with each edit near a copy. `pnpm lint:unused` (knip 6.46.1, `knip.json`, `scripts/unused-ratchet.json`) refuses a new unused file and a new unused export. `node scripts/list-tests.mjs` gives the test files with their kind and their module                                                     |
| S1   | `docs/specs/README.md`: the 33 specs with their sources, and a table of 115 old plan and refactor numbers. `pnpm lint:plan-numbers` reads each form of a mention: 105 numbers in code, all in the table. 52 rows point to the archive                                                                                                                                                                                                                                                                                                             |

Each new check was proved with a probe: a new upward import, a write of another
module's table, a new top-level folder, a copied function, a new unused file, a new
unused export and a broken link. Each probe was refused.

What the map shows that the first measure did not:

- 46 of the 218 D1 tables have writers in two or more modules. The largest:
  `vault_secret` (6 modules), `organisation_onboarding`, `integration_account` and
  `provider_connection` (5 each). Step A2 gives each a write function
  in its owner.
- No SQL statement in the Platform source reads or writes 5 tables: `connector`,
  `install`, `thread_binding`, `thread_file_watch`, `tool_call`. The Plan 93 cutover
  can leave them out, after a check of each one.
- The Portal adds 172 crossings. Its features import the shell 71 times (`route.ts`,
  `page-address.ts`, the sidebar), and a feature of one area imports another area 95
  times.
- The class file of `OrganisationDO` and the queue consumer `ingress-queue.ts` hold
  code of four modules each. The map puts them in `workers/platform` with a note, so
  each import of them from a lower module counts as upward.

Open for the owner: the pre-push hook.

**20 November 2026. Step A1.1 is done**, on the branch `refactor-17-a1-1`.

- `actors/actor-stubs.ts` and `actors/actor-router.ts` name no Actor class. Each
  router function is generic, and its result has the type of the namespace that the
  caller gives. The four stub helpers, one for each class, are one helper:
  `actorStub`.
- `env.ts` gives `OrganisationActorStub`, `SessionActorStub`, `CaseActorStub` and
  `ConnectorActorStub` from its bindings. 25 source files and 2 test support files
  name these types, where they named a class or the result type of a router
  function. The change touches 43 source files and 13 test files.
- The commerce code takes its method lists from `OrganisationCommerce`, the part of
  the Actor that the commerce area owns. The activation step has its own interface
  with one method. The admin code keeps its list of 13 methods for an imported
  Session.
- The layer ratchet went from 1,350 crossings to 1,330: 13 fewer upward and 7 fewer
  against the foundation order. The 4 imports of the class files that stay are in
  `env.ts`, and step A1.2 removes them.
- No behavior changed: the change is types, imports and the name of one helper.
  The type checks of the source, the unit tests and the journeys pass. The unit
  suite passes (302 files, 1,732 tests), and the full E2E suite passes with the
  counts of the baseline (234 files, 455 tests, 55 minutes).

**20 November 2026. Step A1.2 is done**, on the branch `refactor-17-a1-2`.

- `env.ts` imports one type, the handle of the global database. It declares the
  bindings whose types come from the platform.
- 13 bindings moved to their owner files as declaration merges of `Env`: the 7 Actor
  namespaces, the 2 queues, the 3 containers and the Code Mode sandbox. A caller
  reads `env.CASE` as before, with the same type.
- The layer ratchet went from 1,330 crossings to 1,317: the 13 imports of `env.ts`
  that pointed upward are gone.
- The two fetch containers had one copied method. It is now one function,
  `eraseIdleContainerState`. The clone baseline holds 936 copies.
- No behavior changed. The type checks pass, the unit suite passes, and the three
  journeys of the erase path pass.

A declaration merge gives each module the full type of an Actor without an import.
The lint does not see that link. It ends in step A1.9, when each module declares
the RPC interface of its part of an Actor.

**20 November 2026. The module `connections` has its files** (the first part of step
A1.8), on the branch `refactor-17-a1-8`. No code changed: the map changed.

- `foundation/connections` holds the records of a connection: the integration
  account, the provider attempt, the authorization state and the provider resource
  (8 files, 6,200 lines). They import no area, apart from the 4 imports below.
- It owns 13 tables, among them `integration_account`, `provider_connection` and
  `provider_credential_generation`.
- It sits below `authority` in the foundation order, because the access model and
  the Vault read these records.
- The map now shows 1,294 crossings, where it showed 1,315. An import of the account
  record from an area or from `authority` goes down now. The table count went up
  from 126 to 144: 5 modules write `integration_account`, and the map shows that
  now.
- What stays for step A1.8: `connections` imports the onboarding support of the
  area `organisation` (1 import, and 12 writes of `organisation_onboarding`), the
  handle type of the Vault (1), and `tenancy` imports the account record (1).

**20 November 2026. The configuration row has one owner of its counters** (the first
table-owner step), on the branch `refactor-17-a1-8`.

- `data/organisation-onboarding-row.ts` belongs to `tenancy`, and it owns the table
  `organisation_onboarding`. Control routes of five modules read it.
- 36 statements in 20 files updated the two counters of that row. 21 of them had one
  of five texts. They now call `prepareProjectionRevisionBump` or
  `prepareConfigurationVersionBump` of the owner, in the same batch as before.
- The 15 other statements have their own conditions, for example a placement fence.
  They stay, and the ratchet lists them: 10 writes from 4 modules.
- The map shows 1,268 crossings, where it showed 1,294. Writes of a table outside
  its owner went from 144 to 124.
- Two copies went with it: one in `credential-lifecycle.ts`, and the wrapper
  `bumpProjectionRevision`. The clone baseline holds 908 copies.
- No behavior changed: each statement has the same text and the same values.

**20 November 2026. Three files of the Worker shell go to their owners**, on the branch
`refactor-17-a1-8`.

- `ingress-queue.ts` held the queue message types of five modules, and 27 files of
  lower modules imported it. Each module now has its own file (`queue-messages.ts`
  in `commerce/`, `shopify/`, `schedules/` and `mail/`, and
  `slack/case-command-message.ts`). The queue file keeps the union and the choice of
  the parser: 127 lines, where it had 1,309.
- `actors/organisation/types.ts` held the types of four modules. The commerce, policy,
  activation and Code Mode types are in a file of their module.
- Three files named `support.ts` were in the wrong module of the map.
- The map shows 1,203 crossings, where it showed 1,241. An import that pointed at the
  shell now points at the real owner, so some pairs between areas went up by one to
  four, and the baseline is written again.
- No behavior changed: each moved line is the same.

**20 November 2026. Shopify is one folder and one module of the map** (the first part
of step A2.5), on the branch `refactor-17-a1-8`.

- The three Shopify files outside `shopify/` moved into it: the provider adapter, the
  connection workflow and the location observation. The folder holds 20 files.
- The map has the module `areas/shopify`. The ratchet lists the 7 imports of the
  folder from another area, and it refuses a new one. An import from a foundation
  module is refused too.
- `shopify/REMOVE.md` lists what a removal deletes: the folder, the 10 files that
  import it, the union values, the tests, the scripts and the deployment values.
- The connection check and the check of a replaced credential were Shopify code in
  two other files. Each is now a file of the folder, and the other file keeps one
  registration line.
- The execution and the reconciliation of a commerce action on Shopify were 224 lines
  inside `commerce/provider-execution.ts`. They are `shopify/commerce-action.ts`, and
  the commerce file keeps two calls.
- What stays for step A2.5: one `CommerceProvider` port for the branches on the
  system kind in the other files (`graph-reader.ts`, the access model, the cue
  engine), and one definition of the `CommerceSystem` union.

**20 November 2026. More files have their true module, and two more tables have one
writer function**, on the branch `refactor-17-a1-8`.

- The map got 14 corrections after a read of each file that foundation modules import
  from an area or a surface. Examples: the commerce system record and the merchant
  binding are connection records; the evaluation client and the file source clients
  belong to the agent module; the Gmail client is a connection client; the stop code
  of a placement move is in the actor runtime.
- `prepareVaultSecretRevocation` replaces 7 copies of one statement, 3 of them outside
  the Vault. `prepareActiveCredentialGeneration` replaces 3 insert statements.
- The map shows 1,097 crossings. It showed 1,350 at the start of the day.

What the day showed about the method:

- A wrong line in the map hides a true crossing or shows a false one. The hub list
  (the files of areas and surfaces that foundation modules import most) finds wrong
  lines faster than the misfit report.
- A statement builder in the owner module removes a table crossing only when the
  caller may import the owner. A caller in a lower module needs a hook instead.
- A baseline with one fingerprint for each copy does not hold. The clone ratchet now
  counts copies for each pair of files.

The step is smaller than its first description. A count with the type checker gave
the reason: callers use 245 methods of the four Actors at 440 places, in about 130
files. An interface for each module is a larger piece of work, and it belongs with the
split of the Actor classes into modules. It is now a part of step A1.9.

**20 November 2026. Step A2.6 is done.**

| Step | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2.6 | `defineSharedDoc` in `packages/collaboration/src/shared-doc.ts` gives a document package its checked encodings, the base of its document class (`state`, `stateVector`, `syncUpdate`, `apply`, and `mutate`, `mutateIfChanged` and `stage` for its operations) and `syncProtocol`. A package names its roots one time, and it keeps its shape check, its reads and its operations. `definePlainTextDoc` gives the whole document of one plain text: the product description and the mail reply were two copies of it. `defineSharedEncoding` gives the encodings and the protocol alone. The two documents of `workflow-canvas-crdt` use it and keep their own classes: the canvas takes its membership from the workflow owner, and the draft needs one Yjs document for its undo history. Their protocol files used `createSyncProtocol` since Refactor 10, step 5 |

The clone count went from 937 to 917, and the copied lines from 17,423 to 17,107. The
packages lost 1,961 lines and got 1,281. One copy stays: `sameBytes` in
`actors/collaboration-room.ts` repeats the function in `yjs-encoding.ts`.

The bytes did not change. A script ran each package through its public API on the old
tree and on the new tree, with fixed client ids: 3,881 records with each state, update,
state vector, sync frame and failure code, and each record was the same. Three wrong
changes proved that the script sees a difference: one outer transaction for each
operation, a staged copy that keeps its own client id, and a failure frame without the
document codes.

`collaboration` no longer exports `createSyncProtocol`, and `everyCode` is gone:
`exhaustiveList` of `std` does the same. The result type of each package is now
`SharedDocResult` with the codes of the package.

**20 November 2026. Steps A2.2 and A2.3 are done in the Portal,** on the branch
`refactor-17-a2-2-portal-hooks`. They are not on `dev` yet. The surface registry
of step A2.3 is open: it changes the Platform too.

| Step | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2.2 | `useLatestRead` gives its read an `AbortSignal`, and it has `retry`, `pauseWhenHidden` and `reloadOn`. `useMutation` has `busy`. `usePeriodRead` is built on `useLatestRead`. The Devices page, the order queue, Payments, Payouts and the order timeline use the hooks, and each has a request module (`requests.ts`). `pnpm lint:portal-requests` (`scripts/check-portal-requests-ratchet.mjs`) counts the direct calls of the control client in component files: 99 in 46 files, from 106 in 50. It shares `scripts/lib/count-ratchet.mjs` with `lint:portal-fetch` |
| A2.3 | `Button` in `ui/` on Base UI Button, with the variants `primary`, `secondary`, `danger` and `link`. The moved pages use it for 38 buttons; 1,291 raw `<button>` elements remain. `pnpm lint:file-size` reads style sheets: `apps/portal/src/styles.css` (11,106 lines) and `apps/storefront/src/styles.css` (3,907 lines) are in the ratchet. The agent colours of the menu canvas have one definition                                                                                                                                                                 |

What the steps show:

- The Organisation settings keep the `MutationLedger` of `mutation-state.ts`. It is
  the state of the `Portal` class, and a Platform test reads it. `useMutation` has
  no scope rule for two different writes of one record.
- 30 custom properties have a definition in two or more style sheets. One group
  was a copy: the three agent colours of the menu canvas, now merged. The others
  differ by intent: 4 radii and 1 shadow of the Kitchen and menu workspaces, the width of
  the sidebar by state, 13 `--navbar-*` values of the site page, 8 Portal aliases
  in two preview pages, and 2 values that a host gives to a component. The design
  tokens are in `packages/frontend-theme.css` and its theme files, and the Portal
  aliases are in the first rule of `styles.css`.
- A page rule for every raw button of a container, such as `.home-recovery button`,
  also matches a `Button`. The rules of `button.css` have more specificity, and a
  page sets a size with `button.pantry-button`.
- The devices preview page had no CSRF cookie, so each write on it failed. It sets
  one now.

**20 November 2026. Step A1.3 is done on the branch
`refactor-17-a1-3-tool-families`.** The branch starts at `origin/dev` `58b7e5e`. It
is not on `dev`.

| Part          | What exists                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors        | `ToolRequestError` in `agent-tools/errors.ts`. The executor tests this one class, and each area error extends it. The base carries the message for the model and the read that a permission request may ask for                                                                                                                                                                                                 |
| Families      | A tool belongs to one of 11 families: `kitchen`, `cafe`, `commerce`, `channels`, `drafts`, `devices`, `jev`, `integrations`, `files`, `messages`, `turn`. The area declares the services type of its family and defines each tool with the definer of the family. The host gives the services by family name. `CatalogToolAuthority` holds the registry, the services and the capability claim, and no callback |
| One list      | `agent-tools/registry.ts` holds `TOOLS` in the order of the model definitions, and `ToolServices`, the type of all services. The catalog takes the list as a `ToolRegistry` value                                                                                                                                                                                                                               |
| Selection     | A surface and its command are strings that the area checks                                                                                                                                                                                                                                                                                                                                                      |
| Special cases | Fields of a tool definition: `result` and `parameters` (`commerce_entity_context`, now a registered tool), `readReceipt`, `succeeded` and `guidance` (the surface tools). A custom connector operation is a turn tool that `custom-connectors/catalog-tools.ts` builds, with its digest pin                                                                                                                     |
| Types         | The types of the area tools moved from `agent-tools/catalog/types.ts` to the services file of each family                                                                                                                                                                                                                                                                                                       |

The measures:

| Measure                                                              | Before | After |
| -------------------------------------------------------------------- | -----: | ----: |
| Imports of area files in `agent-tools/catalog/` and `define-tool.ts` |     48 |     0 |
| Layer crossings, in the tree and the ratchet                         |  1,350 | 1,295 |
| `foundation/agent-tools` to an area                                  |     75 |    29 |
| Unused exports                                                       |    819 |   810 |
| Copies of product code                                               |    937 |   932 |
| Registered tools                                                     |    116 |   117 |

No pair grew. The branch removed 3,454 lines and added 2,783, the ratchet files
included. No test file was deleted: the three unit files that build the tool host
check outcomes of the executor (the capability gate, the screened failure text, the
effect kind), and they pass with the same assertions.

The catalog is the same bytes. The two digests and the name hash of the
[baseline](#baseline) are equal, and also the two definition hashes that this step
added there. A custom connector definition and its pin are equal to the output of
`origin/dev` for a read and for a write operation.

The checks on the branch: `pnpm lint` passes, and the three type checks give 0
errors. The unit suite passes with 302 files and 1,732 tests. The E2E suite gives
the counts of the baseline: 234 files pass and 3 are skipped, 455 tests pass and 6
are skipped, in 59 min 33 s. Each of the seven Workers bundles in a Wrangler dry run.
Not done: the health checks and the live Portal chat turn of the first release.

Open after step A1.3:

- **The handler does not take the turn context as a parameter.** The Session still
  binds it to each handler with `withToolContext`, and it still names each handler
  in `session-harness-turns.ts`, now in one group for each family. Step
  A1.4 gives the context to `prepare` and `run`. Step A1.7 removes the names from
  the Session.
- **`agent-tools/registry.ts` imports each family:** 19 of the 29 crossings that
  stay. It is a part of the Worker. It moves to `workers/platform` when the Worker
  gives the registry to the Session (step A1.7). `session-support.ts` has 8
  (step A1.4), and `files/handlers.ts` has 2.
- **`channels/` and `drafts/` are not split by area.** A family follows its folder.
  A split moves handlers between areas, and each move makes a new import between two
  areas. Step A1.10 gives the contracts that such an import needs. For the same
  reason the order queue tools read their request types from
  `commerce/order-queue-commands.ts`, and the Session's staging methods read theirs
  from `ToolServices`.
- **`bakerySurfaceCommands` keeps its name** in `HarnessCatalogSelection` and in the
  Session, and the digest key `customConnectorPins` keeps its name.
- **A host that gives no service for a tool** (a check or an evaluation script, not
  the Session) fails that call before the capability claim. Before, 14 tools failed
  after the claim. The model sees the same failure text.
- **The temporary catalog check is removed,** as the step ends. Step A1.4 writes it
  again from the values of the baseline.

## Baseline

Step A0.4, measured on 2026-11-20 at `origin/dev` `e18cecb` with the step A0 commits,
on the owner's Mac,
with other sessions at work on the same machine. A step of Stage A compares its
result with these lines.

| Check                      | Result                                                                                                                                                                                                                       | Command                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Every lint                 | passes, 26 s                                                                                                                                                                                                                 | `pnpm lint`                                             |
| Type check, Platform       | passes, 4 s                                                                                                                                                                                                                  | `pnpm --filter @purin-labs/platform check:types`        |
| Type check, Platform tests | passes, 1 s                                                                                                                                                                                                                  | `pnpm --filter @purin-labs/platform check:test-types`   |
| Type check, packages       | passes, 4 s                                                                                                                                                                                                                  | `pnpm check:packages`                                   |
| Type check, engine         | passes, 1 s                                                                                                                                                                                                                  | `pnpm --filter @purin-labs/commerce-worker check:types` |
| Portal build               | passes, 3 s. 280 script files with 7.12 MB, and 0.88 MB of CSS                                                                                                                                                               | `pnpm portal:build`                                     |
| E2E suite of the Platform  | 234 files pass and 3 are skipped; 455 tests pass and 6 are skipped. 54 min 19 s, one file at a time: 29 min of setup and 23 min of tests. The command ends with code 1, because one file logs after its teardown (see below) | `pnpm --filter @purin-labs/platform test:e2e`           |

The E2E suite needs the account Worker of the pinned commit of `purin-labs/monorepo`
(`3a05ce4`, as CI builds it) in `PANTRY_ACCOUNT_WORKER_ARTIFACT`. Without it, almost
each journey fails at its first request. No test failed in the baseline run, but
Vitest reports 11 errors of one kind: `EnvironmentTeardownError: Closing rpc while
"onUserConsoleLog" was pending`, all from `tests/e2e/slack-attachment-restore.test.ts`.
That file writes a log line after its teardown. A step of Stage A compares its count
of passed files and tests, not the exit code, until that file is corrected.

The bundle of each Worker, from `node scripts/worker-bundle-sizes.mjs` (a Wrangler
dry run, no upload):

| Worker              |      Bytes | Gzip bytes |
| ------------------- | ---------: | ---------: |
| `platform`          |  9,658,352 |  2,311,772 |
| `commerce`          |  4,759,826 |    991,214 |
| `vault-onepassword` | 14,555,351 |  4,287,466 |
| `code-mode-sandbox` |    773,725 |    323,060 |
| `slack-ingress`     |    119,476 |     30,543 |
| `chatgpt-exit`      |     55,847 |     13,822 |
| `model-exit`        |      5,227 |      2,015 |

The tool catalog. Steps A1.3 and A1.4 change the tool registry, and the digest must
stay the same:

| Value                                                             | Result                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Registered tools                                                  | 116 before step A1.3 and 117 after it (the permission request tool is in the list now), with 33 capabilities and 47 surface commands |
| Tools in the widest selection                                     | 117                                                                                                                                  |
| SHA-256 of the tool names in order, one name on each line         | `0ad0603b2740725442d8782ab6c05013d7bd39d892fa279f11e3d07229799e47`                                                                   |
| `catalogHarnessToolCatalogDigest` of the widest selection         | `146bbd674420018eb69b2605daf59f6f3bb76eba10a96052fdb6120f6e4971b1`                                                                   |
| `catalogHarnessToolCatalogDigest` with the base capabilities only | `5d3e3158f521246350507cdb4971427149840e2ddbfa97a03eccbee8436db632`                                                                   |

The widest selection has each capability and each surface command of `TOOLS` in
`agent-tools/registry.ts`, in registry order, and each turn flag on (`memoryProposal`,
`followUp`, `sideCaseProposal`, `permissionRequest`). No script computes it: the
functions need the Vitest resolver. A step that changes the registry adds a
temporary test file with these values and removes it before its last commit. The
check takes the definitions from `selectCatalogDefinitions(TOOL_REGISTRY, selection)`
and hashes `JSON.stringify` of them with `sha256Hex`.

Step A1.3 measured two more values on `origin/dev` `58b7e5e`, before its first
change. They cover each byte of the definitions, not only the names:

| Value                                                                                   | Result                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| SHA-256 of the definitions of the widest selection                                      | `aab68b96bb5053b81f9167c56796e949cd265a2cf2f01d78a89496f5ec3e497f` |
| SHA-256 of the definitions of a selection with no capability and `permissionRequest` on | `00942772761126e3c80235cfa5ccd6f460638beab32e93e53c1eb99c008667b8` |

Since step A1.3 the registry holds 117 tools: `commerce_entity_context` is a
registered tool. The widest selection still has 117 definitions and 33 capabilities.

The prune baseline of step A0.8:

| Measure                     | Result                                                                                                                                | Command                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Copies of product code      | 937 copies with 17,423 lines (1.59 %) in 2,715 files. The Platform has 555, the Portal 159, `production-simulation` 73, the engine 64 | `node scripts/check-clones.mjs --report` |
| Unused files                | 1: `services/platform/src/devices/work.ts`, which Plan 24 will call                                                                   | `node scripts/check-unused.mjs --report` |
| Unused exports              | 819: the Platform 473, the Portal 173, the engine 82, `contracts` 44, `commerce-client` 24                                            | the same                                 |
| Journeys                    | 308 files with 161,000 lines: 237 of the Platform and 71 of the engine. 196 import the source                                         | `node scripts/list-tests.mjs`            |
| Other tests                 | 329 files with 148,000 lines. 43 use `vi.mock`                                                                                        | the same                                 |
| Test support and type files | 105 support files (26,000 lines) and 198 type files (15,000 lines)                                                                    | the same                                 |

CI checks the merge of `dev` with `main`. On 2026-11-20 `main` had 4 commits that
`dev` lacked (the Purin mark and its tools), and the first run of the new lints
failed on that merge. Two changes made both trees pass: `apps/portal/src/ui/index.ts`
is an entry file in `knip.json`, as the public file of the component kit, and
`scripts/brand/` has a place in the map before `dev` has the folder. A commit that
goes to `main` and not to `dev` can fail these lints on the next push to `dev`.

jscpd 5 finds more copies than the jscpd 4 scan of Plan 92 (491), with the same
`--min-tokens 70`: it is a different program, and this scan also reads the crates.
The two counts are not comparable. knip reads the entry files in `knip.json`. A file
that only a tool starts must be in that list, or knip reports it as unused.

## Prune with each step

The owner asked on 2026-11-20 for a prune of dead code, duplicate code and low-impact
tests with this refactor. Plan 92 did a sweep of the whole tree on 18 and 19 November
2026, so a second sweep finds little. The ports of Stage A are what makes more code
dead, so the prune belongs to each step.

What Plan 92 left, on `origin/dev`:

| Kind             | State                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unused code      | Plan 92 deleted the unused files that its hand check allowed, and it removed `export` from 3,539 names. 147 type re-exports in `contracts` and 332 re-export lines wait for a decision on the public surface of each package |
| Duplicate code   | jscpd finds 491 clones with 8,010 lines (1.0 %). Kept with a reason: the head of about 100 control routes, some commerce commands with their own replay, three Kitchen engines                                               |
| Old-row adapters | Kept, because their old rows exist or cannot be counted: the actor storage upgrades, the commerce schema chain 66 to 90, some chat and Square readers                                                                        |
| Tests            | 237 journeys (135,000 lines), 302 other Platform test files (123,000 lines, 43 of them with `vi.mock`), 86 commerce test files (51,000 lines)                                                                                |
| Not done         | Batch E: large shrinks of money-path test files                                                                                                                                                                              |

### Dead code

- **A port deletes what it replaces, in the same landing.** Examples: the 17 error
  class imports of the executor, the callbacks of `CatalogToolAuthority`, the base
  classes of a class chain, the dispatch switch of the mailbox tool host.
- **The public files decide what is dead.** When an area marks its public files (step
  A1.10), an export that no other module imports loses its `export`, and a
  declaration with no user is deleted. This closes the re-exports that Plan 92 left.
- **A ratchet keeps it** (D10): the count of unused exports and unused files can only
  go down.
- **A hand check comes first.** Plan 92 measured a false-positive rate of 10 to 15 %
  for knip. A file that a plan, a runbook or a type check names stays.
- **The old-row adapters wait for the Plan 93 cutover.** They are then deleted in one
  step, with no census.

### Duplicate code

- **A port merges the copies that it replaces.** Step A1.5 merges the two tool hosts.
  Step A2.1 merges the approval cards. Step A2.6 merges the 7 CRDT skeletons. The
  control kit of step A2.2 is the place for the route head that about 100 routes
  repeat.
- **A new copy is refused** (D10): the clone count of the jscpd ratchet can only go
  down. `check:shared-helpers` joins `pnpm lint` (step A0.1).
- **A copy with a different behavior stays,** with its reason in the ratchet file.
  Plan 92 lists them.

### Tests

A test file gets a decision when a step changes the file that it tests. The decision
follows the test policy of `AGENTS.md`:

| The test                                                                | Decision                                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| Asserts the calls of a mock, or a result that its own fixture gives     | Delete                                                    |
| Asserts step order, a private state name or the shape of a module       | Delete                                                    |
| Its outcome is in a journey                                             | Delete, and name the journey in the commit                |
| Fails only because the structure moved, and its outcome does not matter | Delete. Do not repair its fixture                         |
| Is the only check of an authorization, money or data outcome            | Keep. Move the check into a journey if the journey exists |
| A fault journey with one case for each internal step                    | Keep one case for each distinct outcome                   |

- **The protected list.** Plan 92 names the tests that it kept against its sweep,
  each as the only check of an outcome. They stay until a journey has the same check.
- **A journey reads the Worker from outside.** 178 of the 237 Platform journeys import
  the source (`node scripts/list-tests.mjs`). A journey acts through HTTP, RPC or the
  `testing` entry of a module. A ratchet counts those imports from the step that
  gives the first `testing` entry: before that step, a new journey has no other way.
- **A test is deleted in its own commit,** not in the commit that changes the code.
  The commit names the outcome and where it is still checked, or says that no check
  is left and why that is accepted.
- **Product code with no test** is listed in the landing report, as Plan 92 did.

### What a landing reports

Each landing reports: the lines removed and added, the count of the layer ratchet, the
unused-export count, the clone count, and the test files deleted with their reasons.

## Stage B — The folders

Stage B waits for the end of Stage A and for the Plan 93 cutover. The cutover builds
a new stack from the Wrangler files, so a move of those files at the same time would
collide. This section gives the target and its open questions, not a schedule.

```text
foundation/
  std/  type-utils/  kernel/  contracts/  tenancy/  actor-runtime/  authority/  control/
  agent-tools/  agent/  conversation/  collaboration/  ui/  testing/  async-control/
areas/
  <area>/
    AGENTS.md        the rules of the area, short
    contract/        schemas, the model and pure logic, for the browser and the Worker
    server/          domain functions, queries, actor modules, routes, agent tools, cue sources
    ui/              Portal pages and components, with their preview pages
    scripts/         the scripts of the area (no `package.json`)
    engine-plugin/   only where the area has a commerce engine plugin
    native/          only where the area has a crate
surfaces/
  portal/            shell, router, page table, chat stream, the preview shell, the screen
                     page (`tv.html` is an input of the Portal build)
  slack/  email/  whatsapp/  webhooks/
  storefront/        the shop and the QR order page (the React app)
  shop/              the gateway binary
  voice/             the Portal voice client, the Platform voice routes, the shop voice service
  docs-site/
workers/
  platform/          satyr-edge: Wrangler file, entry, class shells, D1 baselines and patches,
                     the Vitest configs, journeys/<area>/
  slack-ingress/  model-exit/  chatgpt-exit/  code-mode-sandbox/  vault-onepassword/
  commerce/  storefront/  docs-site/
  executor/  link-fetch/  connector-fetch/     the three containers and their crates
scripts/             lints, deploy scripts, repo binaries, codemods, punter
docs/                specs, plans, history, runbooks
vendor/  patches/    stay at the root
```

Where the areas come from:

| Area           | From the Platform                                                                         | From the Portal                                                                                                                                 | From packages, crates and scripts                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce`     | `commerce/`, `shopify/`, `stripe/`, `payouts/`, commerce routes and actors (58,000 lines) | `commerce`, `ecommerce`, `checkout-profiles`, `orders`, `payments`, `payouts`, `bank-payouts`, `api-keys`, `governed-actions`, `content-studio` | `commerce-contracts`, `commerce-client`, `commerce-query-sqlite`, `product-description-crdt`, `services/commerce`, `integrations/shopify`                     |
| `cafe`         | menu, board, order queue, counter and terminal code (22,000)                              | `menu-boards`, `order-queue`, `terminals`                                                                                                       | `menu-draft-crdt`, `menu-board-crdt`                                                                                                                          |
| `kitchen`      | `commerce/bakery`, recipe, cost and workflow code (25,000)                                | `production-run`, `workflow-simulator`, `costs`, `recipes`                                                                                      | `bakery-model`, `production-simulation`, `bakery-workflow`, 3 CRDT packages, `bakery-native`, `scripts/bakery-*`, `scripts/production-simulation`, `recipes/` |
| `inbox`        | `mail-inbox/`, the mailbox agent, the reply drafts (29,000)                               | `mail-inbox`, `email-review`, `mail-setup`                                                                                                      | `email-draft-crdt`, `mail-reply-crdt`                                                                                                                         |
| `brain`        | `memory/`, `evals/`, `case-execution/` (10,000)                                           | `brain`                                                                                                                                         | —                                                                                                                                                             |
| `integrations` | `provider-*`, `custom-connectors/`, `integrations/`, `jev-features/` (47,000)             | `integrations`, `vault`, `jev-features`                                                                                                         | `custom-connector-fetch`                                                                                                                                      |
| `devices`      | `devices/` (7,000 with the voice routes, which go to `surfaces/voice`)                    | `devices`                                                                                                                                       | `shop-gateway` protocol                                                                                                                                       |
| `organisation` | onboarding, access pages, billing, operators (9,000)                                      | `access`, `billing`, `agent-schedules`, and `pages/` split by owner                                                                             | —                                                                                                                                                             |

`packages/control-api` (34,000 lines) splits by area into each `contract`. The rest
becomes `foundation/control`. `apps/portal/src/dev` (24,000 lines, 35 preview pages)
splits by area into each `ui`. `crates/media-inspect` goes to `foundation/agent`.
`packages/frontend-themes` and `packages/frontend-theme.css` go to `foundation/ui`.
The 76 files of `services/platform/scripts` split: the D1 patches and their waiver
list stay with the Worker, and each other script goes to its owner.
`services/platform/action-registry` and its generator go with the action ledger.
The workspace file lists exact folders: `areas/*/contract`, `areas/*/server`,
`areas/*/ui`.

Stage B must answer these before a file moves:

| Question                       | What decides it                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packages or folders (D1)       | A trial with one foundation module and one area as packages: the `tsrs` time, the Worker start, the Portal build                                                                            |
| Where the journeys import from | 235 journeys import the inside of the Worker. Each module needs a `testing` entry, or the journeys keep an exception in the lint                                                            |
| The move script                | It must rewrite each file of the list of step A0.6. A dry run in a scratch worktree must pass `pnpm lint` with the guard of step A0.7, the type checks, a container build and one E2E shard |
| The other sessions             | A move date for each module, told before. The script runs again on an open branch                                                                                                           |

After the cutover, the storage is new and empty. These steps are then cheap, and each
needs its own decision: one outbox table shape for the 5 outboxes, new names for
classes and tables, and the deletion of each adapter for old rows. Plan 92 lists
those adapters under "Kept, with the reason" and "Product code with no test now".

## Stage S — Plans become specs

- **A spec describes what is built, for one subsystem.** It lives in
  `docs/specs/<layer>/<area>/` and has an ordinal number in its folder:
  `docs/specs/areas/kitchen/03-recipe-workflows.md`.
- **A spec id is the folder code and the number:** `KIT-03`. A number is never used
  again. A new spec takes the next number of its folder.
- **A spec is a new document.** It is written from its source plans, in the present
  tense and with the current names: what the system does, its contracts, its limits
  and its open work. It has no status log and no release record.
- **A plan is not rewritten.** When its spec is accepted, the plan moves unchanged to
  `docs/history/`. This keeps the rule of `AGENTS.md`: plans keep the old names.
- **A plan describes work that is not built.** It lives in `docs/plans/` and keeps its
  number from the current sequences (the next plan is 95, the next refactor is 18).
  When its work is in production, its content goes into a spec, and the plan moves to
  `docs/history/`.
- **Old numbers stay valid.** `docs/specs/README.md` maps each old plan number to its
  spec id, also for the 26 plans that are only in the archive. The 1,560 mentions in
  code keep the old numbers (D4).

| Step | Work                                                                                                                                                                                                                                                                                                                                             | When                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| S1   | Write `docs/specs/README.md`: the layer map, the list of specs with their source plans ([Appendix A](#appendix-a--the-specs-and-their-sources)), and the table of old numbers. A scan builds the table, and it reads each form: "Plan 53", `plan-53` and `plan53`. Extend the link check: a plan number in a source comment must be in the table | Now                                        |
| S2   | Write the specs, one area at a time. A person or a second session checks each spec against the code before its plans move to `docs/history/`                                                                                                                                                                                                     | After the brand names of Plan 94 are final |
| S3   | Move the plan index and the names table out of `AGENTS.md`. `AGENTS.md` keeps the rules and one line for each area. Target: under 250 lines. Each area gets a short `AGENTS.md` in Stage B                                                                                                                                                       | With S2                                    |

| Code   | Folder               | Specs |
| ------ | -------------------- | ----: |
| `FND`  | `foundation`         |    11 |
| `COM`  | `areas/commerce`     |     5 |
| `CAFE` | `areas/cafe`         |     1 |
| `KIT`  | `areas/kitchen`      |     4 |
| `INB`  | `areas/inbox`        |     1 |
| `BRN`  | `areas/brain`        |     1 |
| `INT`  | `areas/integrations` |     1 |
| `DEV`  | `areas/devices`      |     1 |
| `ORG`  | `areas/organisation` |     2 |
| `PRT`  | `surfaces/portal`    |     1 |
| `VOX`  | `surfaces/voice`     |     1 |
| `ENG`  | `engineering`        |     4 |

33 specs replace 59 plan and refactor files and 15 other documents (counted on `main`).
`docs/runbooks/` stays. [The commerce spec](../services/commerce/docs/spec.md) stays
beside the engine code, because `lint:commerce-spec` binds it to that code. `COM-02`
points to it.

## Behavior and risk

Stage A changes code, not paths. These steps have the highest risk:

| Step       | Risk                                                                                                       | Check                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1.1, A1.2 | A wrong stub type or interface hides a method. The type check finds it                                     | The type checks and the E2E suite                                                                                                                                          |
| A1.4       | The executor runs the exit check at a different point than a handler did. A tool can start to ask, or stop | Before the change, record for each of the 27 tools: the checks, their order and their result in one allowed and one refused journey. Compare after. Report each difference |
| A1.5       | A mailbox turn gets a different tool list or a different catalog digest                                    | The mailbox and WhatsApp journeys. The digest of the mailbox host                                                                                                          |
| A1.6, A1.9 | The class chains hold shared state. A module can lose a field that a parent class gave it                  | The actor journeys, the relocation journey and the idle tenant journey                                                                                                     |
| A2.1       | A person sees a decision two times, or not at all                                                          | One journey for each of the four kinds, allowed and refused                                                                                                                |
| A2.6       | A stored draft does not open                                                                               | A stored draft of each of the 8 documents opens after the change                                                                                                           |

General risks:

| Risk                                                                                | What limits it                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The tool catalog digest changes, and running Sessions lose their checkpoint lineage | The order of the definitions stays. Each landing compares the digest. A step that cannot keep it stops for a decision |
| An inversion changes behavior                                                       | Each inversion is one small commit with the E2E suite                                                                 |
| The work stops in the middle                                                        | Each landing leaves a tree that works. The ratchet shows what is left. Stage A alone gives the layers                 |
| A port is the wrong abstraction                                                     | The first use of each port is one area. The other areas follow after it works                                         |
| A spec loses a decision or a limit                                                  | The plans stay unchanged in `docs/history/`. A second reader checks each spec against the code                        |
| A prune deletes the only check of an outcome                                        | The test rules, the protected list of Plan 92, and a delete in its own commit that names the outcome                  |
| A prune deletes code that only a script or a runbook uses                           | The hand check before each delete. Knip had 10 to 15 % false positives in Plan 92                                     |

## Decisions

- **D1. Packages or folders for the server code (Stage B).**
  - Open until the trial of Stage B. The first version chose packages by default.
    The review found two costs that it did not count: the journeys import the inside
    of the Worker, and a large root entry can make an import cycle.
  - Default: no decision now.
- **D2. Order against Plans 93 and 94.**
  - Recommendation: start Stage A and step S1 now, from `origin/dev`. They change no
    stored data and no deployed name. Stage B and each change of stored data wait for
    the cutover. The spec text waits for the brand names.
  - Default: as recommended.
- **D3. The commerce engine: an area or a foundation module.**
  - Recommendation: keep the engine whole in the area `commerce`. Its rule stays: it
    imports no Pantry package.
  - Default: whole in `commerce`.
- **D4. Plan numbers in code comments.**
  - Recommendation: do not rewrite them. The table in `docs/specs/README.md` resolves
    each old number. New comments use spec ids.
  - Cost of a rewrite: 903 files change, and each open branch gets conflicts.
  - Default: no rewrite.
- **D5. Is Shopify still a target?** Decided by the owner on 2026-11-20: keep it for
  now as a connection, and put all its code into one module that is easy to delete.
  Step A2.5 does this.
- **D6. Capability claims for the mailbox and WhatsApp agents.**
  - Today their tool hosts claim no capability. A claim needs new capabilities, a
    policy backfill for each Organisation and new rows on the Access page.
  - Recommendation: step A1.5 only moves the dispatch to the registry. Propose the
    claims as separate work.
  - Default: no claims in this refactor.
- **D7. The Kitchen model builders** (`scripts/bakery-mujoco`, 78,700 lines of Python).
  - Default: they move as they are in Stage B. Refactor 16, step 16, owns their
    structure.
- **D8. Where the old plans go.**
  - Recommendation: `docs/history/` in this repository, so that a plan number in a
    comment resolves to a local file.
  - Other choice: the archive `seams-tech/pantry-history`, as Plan 92 did for the
    closed plans.
  - Default: `docs/history/`.

- **D9. A call between two areas, and the place of `integrations`.**
  - Recommendation: a service interface in the contract of the area that owns the
    data, wired by the Worker. The connection core of `integrations` becomes the
    foundation module `connections`.
  - Cost: one or more service interfaces for each area that another area calls. The
    count is not known before step A0.2.
  - Other choice: `integrations` and `organisation` as a tier between the foundation
    and the areas. It needs a fourth layer rule.
  - Default: as recommended.
- **D10. Scan tools as dependencies.** Accepted on 2026-11-20: add both.
  - Plan 92 ran knip and jscpd by hand. The repository holds no configuration for
    them, so nothing stops new dead code or a new copy.
  - Recommendation: add both as development dependencies, with a ratchet for each:
    the count of unused exports and the count of clones can only go down.
  - Cost: two dependencies and some seconds of lint time. The time is not measured.
  - Default: add both.
- **D11. Batch E of the Plan 92 test sweep** (large shrinks of money-path test files).
  Accepted on 2026-11-20: not in this refactor.
  - Plan 92 did not do it. Those files are the checks of payment and refund outcomes.
  - Recommendation: not in this refactor. A money-path test changes only when its
    module changes, by the rules of [Prune](#prune-with-each-step).
  - Default: not in this refactor.

Accepted on 2026-11-20: the two stages, one decision API over the approval stores,
specs by subsystem ("Yes, revise"), the prune of dead code, duplicate code and
low-impact tests, the valid comments of the second review, D5, D10, D11, and the
start of step A0 and step S1 from `origin/dev` ("Agree with your recommendations").
D1 to D4 and D6 to D9 use their defaults until the owner changes them.

## Cost

No estimate in days is given. The first version said 19 to 28 days, with Refactor 10
as the measure. That measure is wrong: Refactor 10 worked inside one package, and it
moved files more than it inverted imports.

The count of work for Stage A:

| Work                                                 |                                                                   Count |
| ---------------------------------------------------- | ----------------------------------------------------------------------: |
| Imports to remove or invert                          | 1,224 (671 upward, 377 between areas, 176 against the foundation order) |
| Table writes to move to the owner                    |                                    126, in 69 pairs of table and module |
| Ports                                                |                                                                      11 |
| Effect tools to give two parts                       |                                                                      27 |
| Actor methods to put in an RPC interface (step A1.9) |                                               245, called at 440 places |
| Class chains to compose                              |                                                                       3 |
| Landings, each with a full E2E run                   |                                                             at least 25 |
| Test files to judge when their module changes        |                329 test files that are not journeys (43 with `vi.mock`) |
| Journeys that import the inside of the Worker        |                                                                     178 |
| Specs to write                                       |                                                                      33 |

A full run of the E2E suite takes 54 minutes on the owner's Mac
([Baseline](#baseline)), so 25 landings need about 23 hours of suite time. CI runs
the suite in 4 shards. Steps A1.1 to A1.3 give the time for one port. The estimate
for the rest uses those two numbers.

Runtime cost: none. The same Workers run the same code.

## Not in this refactor

- A rewrite from `throw` to `Result` in the tool handlers (545 throws).
- The removal of `schedule.ts` and a server run of Kitchen (Refactor 16, Plan 24).
- A sweep of all tests in one pass. Plan 92 did that sweep on 2026-11-19. This
  refactor judges a test when its module changes.
- One record type for the four approval mechanisms.
- A split of the D1 baselines by area.
- New names for Workers, classes and tables (Plan 93).
- A change of the brand names in code (Plan 94).
- A move of the built-in engine plugins to their areas.
- A second component library or a state library for the Portal.

## Not checked

- The layer sizes in the sections before [Steps done](#steps-done) come from name
  rules. `scripts/layers.json` replaced those rules, and it moved some files: the
  sizes can differ by some percent.
- `scripts/layers.json` is reviewed by name, by the misfit report and by the table
  writers. No person read each of the 1,788 files. A wrong line shows as a crossing
  with no reason, and the step that meets it corrects it.
- The split of `chat/` by file. Only its largest files were read.
- No port was tried. A1.4 was checked against two handlers only:
  `pauseDeviceForEmbeddedHarness` and `settleStaffPageEffect`.
- The imports of the scripts, the crates and the tests are not in `lint:layers`. Each
  of them has a place in the target layout (`placement`), and no more.
- The Kitchen table, the count of broken links and the spec counts come from `main`.
- The size of `connections` and the count of service interfaces.

## What the reviews changed

The first version of 2026-11-20 had one stage with five phases. A review on the same
day found these errors, and the second version corrected them:

1. **The exit check.** The first version ran it before the handler. The check must
   run after the handler's live checks and reads. Step A1.4 uses two parts.
2. **Typed actor access** was missing. Step A1.1 is new.
3. **The journeys** were placed in area packages, which they cannot import from.
   They stay with the Worker.
4. **The approval merge** was one record with one D1 patch. The four mechanisms are
   in three stores. Step A2.1 is one decision API.
5. **"Only paths and imports change"** was false. Each inversion is a code change.
6. **The digest** depends on the order of the tools. The order now stays.
7. **Email and WhatsApp** transport are surfaces, as Slack is.
8. **Portal chat** is mostly conversation code of the foundation.
9. **Actor schema steps** were missing. Step A1.9 keeps one ordered list.
10. **The specs** were one for each plan. They are now one for each subsystem, and
    the plans are not rewritten.
11. **The plan number check** now covers the 26 plans of the archive.
12. **Releases.** Each landing can ship, because other sessions release from `dev`.
13. **Unplaced files** have a place: the preview pages, `integrations/`, `vendor/`,
    `patches/`, `async-control`, `media-inspect`.
14. **The order against Plan 93.** Stage B and each change of stored data wait.
15. **The estimate** is replaced by a count of work and a rule to measure.
16. **Names.** "Tools" has one meaning. A Wrangler file lives only in `workers/`.
17. **Large libraries** have named entries and no root entry.

A second review on the same day (Gemini, on the first version) and the owner's request
gave the third version:

18. **The base.** The plan was measured on `main`, 170 commits behind `origin/dev`.
    The counts now come from `origin/dev`. The structure of the Platform is almost
    the same there: 588 upward imports against 589.
19. **Packages point upward.** `contracts` exports `commerce-contracts` again, and
    `control-api` depends on area packages. Step A1.11 is new, and the measure reads
    package imports.
20. **Calls between areas** had no mechanism. A contract now holds service interfaces
    (D9), and the contracts have no cycle.
21. **`connections`** is a new foundation module: the core of `integrations`.
22. **The tool definition** held area types and the callback object. Step A1.3 names
    them.
23. **A silent lint failure.** Step A0.7 is new: each path of a lint must match a file.
24. **The preview page** is in CI and in 19 scripts. Step A2.4 changes them.
25. **Files with no place:** `product-description-crdt`, the themes, the action
    registry, the Platform scripts, the container build context, `tv.html`.
26. **`lint:d1-patch`** needs a base revision in CI.
27. **The exit field** stays out of the catalog digest: the digest reads only the
    fields that the model sees (`registeredModelDefinitions`).
28. **The prune** is part of each step ([Prune](#prune-with-each-step)).

Two comments of the second review were not used. pnpm takes only a folder with a
`package.json`, so a wide workspace pattern matches no script folder. The plan numbers
29D, 29F and 35B are not in the code.

## Appendix A — The specs and their sources

| Id      | Spec                                                   | Written from                                                                                |
| ------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| FND-01  | `foundation/01-tenancy-and-placement.md`               | `architecture/runtime.md` (data model, placement), Refactor 12, `economics-costs.md`        |
| FND-02  | `foundation/02-actor-runtime.md`                       | Plan 14, `architecture/runtime.md` (platform layout, actors)                                |
| FND-03  | `foundation/03-cases-sessions-and-conversations.md`    | Plan 15, `architecture/runtime.md` (Case coordination, cues), Refactor 9, Plan 42H, Plan 74 |
| FND-04  | `foundation/04-agent-harness-and-model-routes.md`      | `architecture/runtime.md` (harness adapter), Plans 28, 73 and 75                            |
| FND-05  | `foundation/05-messages-attachments-and-context.md`    | Plans 37 and 42G                                                                            |
| FND-06  | `foundation/06-identity-policy-and-approval.md`        | `architecture/security.md`                                                                  |
| FND-07  | `foundation/07-information-flow.md`                    | Plans 27, 27C and 89                                                                        |
| FND-08  | `foundation/08-vault.md`                               | Plans 12 and 79                                                                             |
| FND-09  | `foundation/09-agent-tools-and-screen-context.md`      | Plans 81 and 87                                                                             |
| FND-10  | `foundation/10-shared-drafts.md`                       | Plans 40 and 40C                                                                            |
| FND-11  | `foundation/11-contracts.md`                           | Plan 78                                                                                     |
| COM-01  | `areas/commerce/01-commerce-domain.md`                 | `commerce-domain-architecture.md`, `commerce-monorepo.md`, Plan 22                          |
| COM-02  | `areas/commerce/02-commerce-engine.md`                 | Plans 76, 76A, 77 and 80                                                                    |
| COM-03  | `areas/commerce/03-providers-and-the-read-layer.md`    | Plans 9 and 47, `integrations/shopify.md`                                                   |
| COM-04  | `areas/commerce/04-checkout-and-payments.md`           | Plans 33, 33C and 33D                                                                       |
| COM-05  | `areas/commerce/05-merchant-operations.md`             | Plans 16, 23, 31B and 39                                                                    |
| CAFE-01 | `areas/cafe/01-menus-boards-and-the-order-queue.md`    | Plan 40B                                                                                    |
| KIT-01  | `areas/kitchen/01-orchestration-views.md`              | Plans 42, 42E and 42F                                                                       |
| KIT-02  | `areas/kitchen/02-physics-and-equipment-models.md`     | Plans 42B and 60A, the calibration worksheet                                                |
| KIT-03  | `areas/kitchen/03-recipe-workflows.md`                 | Plans 61A, 61E and 84, `workflow-canvas-design-profile.md`                                  |
| KIT-04  | `areas/kitchen/04-costs-and-margins.md`                | Plan 86                                                                                     |
| INB-01  | `areas/inbox/01-one-inbox.md`                          | Plan 83                                                                                     |
| BRN-01  | `areas/brain/01-brain.md`                              | Plans 42J and 42K                                                                           |
| INT-01  | `areas/integrations/01-integrations-and-connectors.md` | `architecture/integrations.md`, `integrations/google-oauth.md`                              |
| DEV-01  | `areas/devices/01-devices.md`                          | Plan 85                                                                                     |
| ORG-01  | `areas/organisation/01-onboarding-and-lifecycle.md`    | `architecture/onboarding.md`, `organisation-setup-flow.md`                                  |
| ORG-02  | `areas/organisation/02-jev-from-seams.md`              | Plan 88                                                                                     |
| PRT-01  | `surfaces/portal/01-portal.md`                         | Plan 21, `portal-ui-inventory.md`, `style-guide.md`                                         |
| VOX-01  | `surfaces/voice/01-voice-control.md`                   | Plans 82 and 82C, the voice handover                                                        |
| ENG-01  | `engineering/01-decision-log.md`                       | Plan 3                                                                                      |
| ENG-02  | `engineering/02-code-and-repository.md`                | `code-style.md`, Refactor 10, Plan 92                                                       |
| ENG-03  | `engineering/03-names.md`                              | Plan 91, the names table of `AGENTS.md`                                                     |
| ENG-04  | `engineering/04-testing.md`                            | `test-coverage-e2e.md`                                                                      |

A spec keeps an `Open work` section for the built plans that are not complete: Plans
61A, 82, 82C and 92.

Plans that stay plans, in `docs/plans/`, with their numbers:

| Plan                               | State                                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| Plan 24, cobot bakes               | No code                                                        |
| Plan 82B, ambient voice            | Draft                                                          |
| Plan 90, café Register             | In progress on `origin/dev` (phases 2, 3A and 4A have commits) |
| Plan 93, clean cutover             | Draft, step 1 done                                             |
| Plan 94, `purin-labs` organisation | In progress                                                    |
| Refactor 16, Kitchen physics       | Proposed                                                       |
| Refactor 17, three layers          | This document                                                  |
| Blocked and deferred tasks         | Was `blocked-deferred-tasks.md`                                |

Other documents:

| Document                                    | New place                                                         |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `docs/deployment/*.md` (3 files)            | `docs/runbooks/`                                                  |
| `docs/recipes/*.md` and the root `recipes/` | With the Kitchen area in Stage B                                  |
| `docs/reference/hone-engines/`              | `docs/specs/areas/brain/reference/`                               |
| `docs/experiement-1.md`                     | `docs/history/`. Its one link is broken, and no document names it |
| `docs/brand/`, `docs/handoffs/`             | Stay                                                              |

The 26 archive plans that code names in the form "Plan N" (counted on `main`): 13, 19,
25, 25B, 27B, 31, 32, 35, 40D, 41, 48, 50, 50A, 55F, 56, 57, 61B, 61C, 61D, 70, 70B,
70C, 70E, 71, 72 and 74B. Plan 53 has mentions in the form `plan-53`. One mention,
"Plan 409", is a typing error to correct. The scan of step S1 gives the full list.

## Appendix B — Three ports, as examples

The examples are shortened. Field names that exist today stay as they are.

### The executor names no area (A1.3)

Today (`agent-tools/catalog/execute.ts:319`):

```ts
import { OrderRefundRequestError } from "../../commerce/order-refund-action";
import { StockActionRequestError } from "../../commerce/stock-action";
// ... and 15 more

if (
  error instanceof OrderRefundRequestError ||
  error instanceof StockActionRequestError ||
  error instanceof DeviceRequestError // ... and 14 more
) {
  failure = error.message;
}
```

After:

```ts
// agent-tools/errors.ts (foundation)
export class ToolRequestError extends Error {}

// agent-tools/catalog/execute.ts (foundation)
if (error instanceof ToolRequestError) {
  failure = error.message;
}

// commerce/stock-action.ts (area)
export class StockActionRequestError extends ToolRequestError {}
```

### An effect in two parts (A1.4)

Today `pauseDeviceForEmbeddedHarness` does the member check, reads the label, builds
the sink, calls `toolEffectPassesExit` and then runs the command. After:

```ts
export const devicePause = defineTool({
  name: "device_pause",
  effect: "receipt",
  selection: {
    kind: "capability",
    capability: CAPABILITY_KEYS.devicePause,
  },
  prepare: async (context, request) => {
    const member = await liveDeviceMember(
      context.scope.database,
      context.scope.organisationId,
      context.lease,
    );
    if (member === null || !roleMayOperate(member.role)) {
      throw new DeviceRequestError("A pause needs the staff role or higher.");
    }
    return {
      sink: {
        kind: "tool_effect",
        capabilityId: CAPABILITY_KEYS.devicePause,
        resourceScope: `device:${request.deviceId}`,
      },
      action: {
        operation: "device.pause",
        arguments: request,
      },
      run: (operationId) => pauseDevice(context, member, request, operationId),
    };
  },
});
```

The executor then does the same for every effect tool:

```ts
const effect = await tool.prepare(context, request);
const flowLabel = await currentTurnFlowLabel(
  storage,
  execution,
  lease,
  tool.name,
);
const passed = await toolEffectPassesExit(env, execution, lease, {
  flowLabel,
  sink: effect.sink,
  action: effect.action,
});
if (!passed) {
  throw new ToolRequestError(`${tool.name} is not authorized`);
}
return effect.run(operationId);
```

### Typed actor access (A1.1 and A1.2)

Before step A1.1, a caller named the class, and so did the router:

```ts
// actors/actor-router.ts
import type { OrganisationDO } from "./organisation";
export function requireActiveOrganisationActor(input: {
  env: { ORGANISATION: DurableObjectNamespace<OrganisationDO> };
}): Promise<DurableObjectStub<OrganisationDO>>;

// memory/access.ts
type OrganisationStub = Awaited<
  ReturnType<typeof requireActiveOrganisationActorAtPlacement>
>;
```

After step A1.1, the router is generic, and the type comes from the binding:

```ts
// actors/actor-router.ts: no import of a class
export function requireActiveOrganisationActor<
  TActor extends PlacedActorRpc,
>(input: {
  env: { ORGANISATION: DurableObjectNamespace<TActor> };
}): Promise<DurableObjectStub<TActor>>;

// env.ts
export type OrganisationActorStub = ReturnType<Env["ORGANISATION"]["get"]>;

// memory/access.ts
import type { OrganisationActorStub } from "../env";
```

Step A1.2 gives each module its part of the environment. The router does not change:
its result follows the narrower namespace type.

```ts
// memory/rpc.ts (the module declares what it needs of the Actor)
export interface MemoryActorRpc {
  readMemories(input: ReadMemoriesInput): Promise<MemoryPage>;
  commandMemory(input: MemoryCommand): Promise<MemoryCommandResult>;
}
export type MemoryEnv = {
  ORGANISATION: DurableObjectNamespace<
    MemoryActorRpc & Rpc.DurableObjectBranded
  >;
};

// actors/organisation.ts (the class)
export class OrganisationDO
  extends OrganisationCommerce
  implements MemoryActorRpc {}
```
