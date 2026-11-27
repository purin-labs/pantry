# Refactor 17 — Three layers: foundation, product areas, surfaces

Date: 2026-11-20. Revised two times on 2026-11-20: after a review of the first version,
and after a second review with the owner's request to prune
([What the reviews changed](#what-the-reviews-changed)).
Status: Stage A is done and on `dev` since 2026-11-21 (`6373495d`), with step S1. Step
S2 started on 2026-11-22 with the pilot spec `DEV-01`, after the brand names became
final; each of the 33 specs is written since 2026-11-23. The Plan 93
cutover ended on 2026-11-22, so Stage B is open: decision D1 is a mix, and since
2026-11-23 each foundation module is a package in `foundation/` and each product area
is a package in `areas/`. On 2026-11-22 the owner asked to finish the
tail: the A2.1 decisions are made and built, and two sessions finish Plan 91 phase 4
and Plan 93, so that Stage S and Stage B can start. [What is left](#what-is-left)
lists the open work. The owner accepted the two stages, one decision API for approvals, specs by
subsystem, and the prune of dead code, duplicate code and low-impact tests. The other
decisions in [Decisions](#decisions) use their defaults.
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
              control · agent-tools · agent · conversation · tool-handlers
              collaboration · ui · testing
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

| From                             | May import                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A foundation module              | A foundation module lower in [the order](#foundation-modules)                                                                                                                                                                                                              |
| The `contract` of an area        | The foundation, outside packages, and the `contract` of another area. Never the `server` or `ui` of an area, a surface or a Worker (decision of the owner, 2026-11-24). A call at run time to a foundation module above `contracts` is the counted debt `contract-runtime` |
| The `server` and `ui` of an area | The foundation, its own `contract`, the `contract` of another area (its schemas and its service interfaces)                                                                                                                                                                |
| A surface                        | The foundation and the public entry of an area                                                                                                                                                                                                                             |
| A Worker                         | All three layers                                                                                                                                                                                                                                                           |
| A journey                        | A Worker, and the `testing` entry of a module                                                                                                                                                                                                                              |
| The commerce engine              | Only `std`, `type-utils`, its contracts and its client, as today                                                                                                                                                                                                           |

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

These rules continue the rules of [Refactor 10](history/refactor-10.md):

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

## What is left

State on 2026-11-23, after the surfaces group and the rename of the Worker folder.
The three stages have their main result. CI is green: the Pantry run on `0ff7a2c4`
(run 45135878873) passed the E2E job and the Kitchen job. `main` is at `0ff7a2c4`
since 2026-11-23, and that commit is in production since 10:29 UTC of that day
(`pantry` `2573c620`).

- Stage A: the layers are in place, and `pnpm lint:layers` finds 0 crossings.
- Stage S: the 33 specs are written, 56 plans are in `docs/history/`, and `AGENTS.md`
  has 249 lines.
- Stage B: each foundation module is a package in `foundation/`. Each product area
  is a package in `areas/<area>/` and each surface is a package in
  `surfaces/<surface>/`, with `server/` and `ui/`.
  The Platform Worker is the folder `workers/platform`; `apps/portal` stays the
  Portal build (decision of the owner, 2026-11-23).

The open work, each item with its own decision:

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Cost                                                                                                                                                                                                                                                                                                                                                                                                         | Default                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Done 2026-11-24: a `contract` package for each area                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Each area has `@purin-labs/area-<area>-contract` in `areas/<area>/contract/`, with the 100 public files that another area imports; 17 other public files stay public in their area. `pnpm` reports no cycle between the areas; the 2 cycles between the surfaces need a port each. The [runbook record](runbooks/refactor-17-module-move.md#the-contract-group-of-2026-11-24) gives the plans and the checks | A new public file that another area imports goes into the contract |
| The kinds of layer debt that `pnpm lint:layer-debts` counts. State on 2026-11-27: 4 of 10 kinds are closed (`shopify-rule`, `portal-default`, `worker-logic`, `area-package`) and `env-merge` has 0 methods. Open: `surface-nonpublic` 14 (13 area components that use `foundation/ui` at run time and 1 router import), `table-read` 40 (each one side of a statement with a JOIN or a subquery), `foundation-misfit` 9 links and 33 names, `interpolated-table` 9 (general helpers), `env-merge` 16 merges (the design), `contract-runtime` 94 (the owner allows it)  | Each kind is its own change; the list below gives each step                                                                                                                                                                                                                                                                                                                                                  | The counts may not grow                                            |
| Done 2026-11-24: the code faults that the second read of the specs confirmed                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Each of the 231 entries is corrected on `dev` (207), not a fault (17), or kept by a decision of the owner (7). The high-severity corrections are in production since 2026-11-23; the others go with the next release                                                                                                                                                                                         | A new fault gets its own change, with a journey                    |
| One outbox table shape for the 5 outboxes, new names for classes and tables, the deletion of each old-row adapter                                                                                                                                                                                                                                                                                                                                                                                                                      | Not now (decision of the owner, 2026-11-27). Three of the tables are in the SQLite store of live Session, Case and Commerce Actors, so each needs an Actor schema step on production data, and one needs a D1 patch                                                                                                                                                                                                                                                                                                                                                                | Nothing changes                                                    |
| Plan 91 moves to `docs/history/`; the 15 other source documents of the specs                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Done on 2026-11-24: Plan 91 and 3 of the 17 source documents (the 15, the calibration worksheet and the voice handover) moved. The other 14 are live guidance                                                                                                                                                                                                                                                | They stay in `docs/`                                               |
| Done 2026-11-27: a short `AGENTS.md` for each area                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `areas/<area>/AGENTS.md`, 8 files of about 30 lines: the specs, the packages, the tool families, the Portal features, the layer rules and what is particular to the area. The root guide names them                                                                                                                                                                                                          |
| Done 2026-11-24: each journey that runs a Durable Object alarm checks that it ran                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `durable-object-alarm-support.ts` holds the two helpers. 13 calls stay direct: each checks its result, or a comment says why it can find no alarm                                                                                                                                                                                                                                                            | New journeys use the helpers                                       |

The layer debts, one line for each step that lowers a count:

- 2026-11-27, `area-package`: 75 to 3. `contracts` now lists five more packages:
  `commerce-client`, `commerce-control-api`, `kitchen-control-api`,
  `cafe-control-api` and `production-plan-crdt`. Each one holds a client, API shapes
  or a shared document. Its dependencies are `std`, contract packages,
  `collaboration` and document packages, so it holds no implementation of its area.
  The 3 that stay need a port or a move: `bakery-workflow` in the configuration
  draft of the Organisation (2) and `bakery-model` in the Café board chat (1).

- 2026-11-27, `portal-default`: 2 files to 0, and the kind is closed. The map has no
  rule for the whole folder `apps/portal/src/` now: `bootstrap.tsx` has its own line
  and `tv/` has its own rule. `pnpm lint:layers` refuses a new file directly in that
  folder until the map names its module.

- 2026-11-27, `interpolated-table`: 17 to 10, and `table-read`: 91 to 85. The
  commerce index writes and the WhatsApp erasure name their tables. The Inbox gives
  the purge rewrite of its two Google account tables through the purge port, and
  Integrations gives the erase of its mail classification table, which a template
  name hid. The regional copy reads its four parent predicates from the purge
  catalogue. The operations destination read is a tenancy port that the
  Organisation area implements. The purge runs the same 185 statements. What stays:
  10 writes of general helpers (the purge erase, the regional copy, the export, the
  transitions, the Pi checkpoint), and reads that are one statement with a JOIN. The
  next step for the purge: each table owner gives its own erase entries.

- 2026-11-27, `shopify-rule`: 10 to 0, and the kind is closed. `worker-logic`: 10
  files to 7 (3,687 lines to 3,353). The webhook surface reads a Shopify queue
  message through `queueMessages` of the provider module, the gateway calls the
  routes of `shopify/gateway-routes.ts`, and the Organisation actor opens
  `shopify/organisation-part.ts`. The helpers of the Organisation actor moved to
  their owners: commerce (board presence), collaboration (socket sweep),
  actor-runtime (command admission, the meta row) and agent (the alarm steps). What
  stays in the Worker: `bake-run-ports.ts` and `organisation/bake-kitchen.ts`, which
  join Kitchen, Devices, the commerce projection and Slack; their move needs three
  ports.

- 2026-11-27, `surface-nonpublic`: 244 to 175. The email and WhatsApp surfaces import
  no Inbox file that is not public. The email and WhatsApp parts of `ConnectorDO`
  hold the mailbox and WhatsApp agent state, so they moved to
  `areas/inbox/server/actors/`, with the WhatsApp control route, the watch
  reconciliation and the reply target. The surfaces keep transport: the Gmail push
  route, the Meta webhook route, the queue messages and the relocation receipt
  route. New ports: `channelIngress` and `whatsAppOperatorNotices` (Inbox contract),
  `connectorEvalStore` (Brain contract). What stays: the Portal (144), Slack (19),
  the webhooks (9) and voice (3).

- 2026-11-27, `surface-nonpublic`: 175 to 144. The Slack, webhook and voice surfaces
  import no area file that is not public; only the Portal (144) stays. Pure types
  and functions moved into the contracts: the bake proposal, the email review, the
  WhatsApp pause reason, the supplier payout row, the commerce provider receipt
  parser, the café shop, `previewCode` and the name of the custom connector fetch
  Actor. The generic account capability resolver moved to `foundation/authority`,
  and `menuPriceChangeKind` has one copy in `control-api` (it had a second in the
  Commerce UI). The calls go through ports: new `commerceActionApprovals`,
  `supplierPayoutReads` (Commerce), `bakeProposalRecords` (Kitchen),
  `whatsAppOperatorNoticeRecords` (Inbox) and `deviceReads` (Devices); more methods
  on `commerceDeliveryIntake`, `commerceGraphReads`, `inboxServices`,
  `organisationServices` and `cafeServices`; Slack uses `actionLedgerCommerce` for
  the Slack approval rule. No query, write or call order changed.

- 2026-11-27, `table-read`: 85 to 50. An area reads a table of another area through
  the contract of the owner (7 reads). A foundation module reads a table of a higher
  module through a port that the owner implements with the same SQL: the subject
  reads of the request authority (`inboxSubjectReads`, `workflowSubjectReads`), the
  Vault reads of integration tables, the connection reads of Organisation tables,
  the installation pins, the Slack identity links, the fork history and the Slack
  channels of collaboration. No SQL statement changed. What stays in this scope: 17
  reads, each one side of one statement over tables of several owners (the two
  `UNION ALL` reads of the access subjects, four writes with a `SELECT`, two JOINs).

- 2026-11-27, `worker-logic`: 7 files to 3 (3,353 lines to 812). The control router
  is one table of 49 route families in the old order
  (`foundation/control/worker/route-table.ts`); each family pairs the matcher and
  the handler of its owner. The pending decision readers, the agent routes, the
  commerce routes and the scheduled reconciliation moved to their owners (control,
  conversation, agent, the Inbox, commerce, Kitchen, the Organisation area, the
  Slack surface). The Worker keeps the lists. What stays: `bake-run-ports.ts`,
  `organisation/bake-kitchen.ts` and the WhatsApp routes (`control/routes/whatsapp.ts`,
  171 lines), which can move to the Inbox now.

- 2026-11-27, `worker-logic`: 3 files to 0, and `area-package`: 3 to 0. Both kinds
  are closed. The WhatsApp control routes are an Inbox family
  (`areas/inbox/server/control/routes/whatsapp.ts`) in the same place of the route
  table. The bake code of the Worker is Kitchen's (`bakes/run-ports.ts`,
  `bakes/organisation-part.ts`): Kitchen reads the Devices records, the counter stock
  of the commerce projection and the Slack cards through the new port `bakeParts`,
  and sends a device command through `deviceCommands` of the Devices contract. The
  Worker keeps the classes `BakeRunActor` and `OrganisationDO`, with their RPC
  methods; `BakeRunRpc` of Kitchen types the stub. The Organisation draft parses a
  recipe change through `workflowChanges` of the Kitchen contract, and the Café board
  names `PageBrowserContext` of the contracts.

- 2026-11-27, `foundation-misfit`: 14 links to 12, and 44 names to 42. The Google
  Pub/Sub push check is a part of the email surface, the operational mail builder a
  part of the Inbox, and the Airtable and Notion client a part of Integrations
  (`foundation/control` lists the Airtable bases through the port
  `externalRecordsDiscovery`). The link click check of the sidebar is a page address
  helper. What stays in `foundation/connections` has a reason: a file owns its
  tables, or two areas and a foundation module use it. The three Gmail adapter files
  can move to the Inbox when the `mail` part of the provider adapter catalogue, which
  no run-time code reads, is removed.

- 2026-11-27, `foundation-misfit`: 12 links to 10, and 42 names to 34. The `mail` part
  of the provider adapter catalogue is gone, and the three Gmail adapter files are in
  `areas/inbox/server/mail/`. The transient mail turn is the Inbox's, the card-only
  reply the Slack surface's, and the Slack channel baseline grant and the Jev paid
  use are Integrations'. The outside-text normalizer is `context/untrusted-text.ts`,
  because Devices and the foundation call it too. The TypeSafe client is
  `foundation/agent/typesafe/`: the foundation calls it, so it stays, and the word
  names the service. Each file that stays is a port that an area implements, the
  owner of its tables, or a part that two areas and the foundation use. Open:
  `person-authz.ts` (Slack reads only its strict person id parse) and the Slack
  thread control of `packages/collaboration`, whose two requests need the request
  module of the commerce description draft before it can move there.

- 2026-11-27, `foundation-misfit`: 10 links to 9, and 34 names to 33. The strict person
  id parse (`person_` and a generated suffix) is `parseStrictPersonId` of
  `@purin-labs/kernel/ids`, beside `parsePersonId`, with the same pattern; the Slack
  surface, the person role route and `person-authz.ts` read it there. The Slack
  thread control is a part of the product description draft, its only user
  (`areas/commerce/ui/features/commerce/description-draft/`), and its two requests are
  in the request module of that feature. What stays has a reason: the server half
  `collaboration-slack-thread.ts` serves the drafts of Commerce, the Inbox and
  Kitchen; `voice-assistant-card.tsx` is a control of the agent UI kit that no surface
  uses.

- 2026-11-27, `surface-nonpublic`: 16 to 15. The workspace switcher is a control of the
  sidebar with typed props and no read, so it is `foundation/ui/workspace-switcher.tsx`,
  beside `console-sidebar.tsx`. A move to `surfaces/portal` puts `foundation/ui/route.ts`
  over the share of the links rule (22 of 36 links).

- 2026-11-27, `surface-nonpublic`: 15 to 14. `PortalLoading` of the shell has a slot for
  the loading frame of the Organisations page, and the router (`portal.tsx`), which
  renders that page, fills it. `WorkspaceSupportTools` is a type of the Organisation
  contract. What stays: the import of the page by the router. A lazy load from the page
  table gives the build 285 scripts in place of 282 and a Suspense frame before the list,
  and the page parts in the type-only contract raise `contract-runtime`.

- 2026-11-27, `env-merge`: 75 methods to 0; the 16 merges stay. Each module that
  calls an Actor declares the RPC interface that it calls, with exact types, and
  gets its stub with that interface (`OrganisationBrainRpc`, `OrganisationInboxRpc`,
  `OrganisationKitchenRpc`, `SlackConnectorRpc`, `CaseGoalRpc` and the others). The
  Actor class lists each interface in `implements`, so a rename breaks the build. No
  RPC method name changed. The 16 merges are the design: the Worker gives each
  Durable Object binding to `Env`.

- 2026-11-27, `surface-nonpublic`: 144 to 60, by a rule of the owner ("Allow as
  wiring"). `wiring` in `scripts/layers.json` names the page table of the Portal
  (`surfaces/portal/ui/page-code.ts`) and the preview folder (`apps/portal/src/dev/`).
  A lazy `import()` of an area page by the page table (28) and an import by a preview
  page (56) are wiring and do not count; a static import by the page table still
  counts. The check refuses a product file that imports a preview file. One load has
  a written reason: `bootstrap.tsx` loads the chat preview data inside
  `if (import.meta.env.DEV)`, and the built Portal holds none of it. What stays: 60
  imports of the Portal shell, the chat page and the transports.

- 2026-11-27, `interpolated-table`: 10 to 9, and `table-read`: 50 to 40. Each table
  owner gives its purge entries from a `purge-entries.ts` file of its own, with the
  literal DELETE of each erase. The Worker joins the lists in
  `workers/platform/src/purge-catalogue.ts` by the `order` number of each entry and
  gives the catalogue to tenancy through the lifecycle port. The join refuses a
  repeated number or table, and a type refuses an erase statement of another table.
  Tenancy keeps the entry type, the order rule, the erase statement and its own
  entries. Connections reads the accounts and the connections that the purge
  rewrites. A new port of the Actor runtime, `providerWorkReads`, gives the two
  provider work reads of a relocation, and Integrations implements it. A probe gave
  the same purge batch and the same regional copy tables, byte for byte. What stays
  in this scope: reads that are one part of one statement (a subquery or a JOIN),
  and the read of `workspace_revision` in the regional copy (`foundation/agent`).

- 2026-11-27, `surface-nonpublic`: 60 to 18. The server code of the Portal chat
  imports no private area file: it reads Kitchen through `bakerySurfaceReads`,
  Integrations through `customConnectorChat`, and the Inbox, the Organisation area
  and Brain through their service ports. Types and pure code moved into the
  contracts, and two transports that only the Portal uses moved to the surface. The
  built Portal has the same pages and the same 282 script files. What stays: 13 area
  components that use `foundation/ui` at run time (a contract would raise
  `contract-runtime`), 3 shell imports of the Organisation list and the workspace
  switcher, the Google Drive picker (its path is in a check script) and one read of
  the home page (a direct import changes the script count).

- 2026-11-27, `surface-nonpublic`: 18 to 16. The Google Drive picker and its
  boundary file are transport code that only the Portal uses, so they are in
  `surfaces/portal/ui/google-drive/`. The home page imports its commerce read from
  the Commerce contract; the built Portal then has one shared chunk less.

The handoff
[`docs/handoffs/2026-11-21-refactor-17.md`](handoffs/2026-11-21-refactor-17.md) gives
the state of Stage A. Its branches are gone; the work is on `dev`.

### The end of Stage A: the state of the exit list

| Item                                                    | State                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ratchet of `lint:layers` is near zero, with reasons | Done: 0 crossings. A new crossing needs a reason and a fix in `reasons` of `scripts/layers-ratchet.json`                                                                                                                                                                                                                                                      |
| Each area has a list of its files, tables, public files | Done: `node scripts/check-layers.mjs --areas` and [`docs/layers.md`](layers.md)                                                                                                                                                                                                                                                                               |
| No public export without a user in another module       | Partly done: 16 unused exports stay, each with a reason (the dead code entry of [Steps done](#steps-done)). knip does not judge the exports of an entry file; `pnpm lint:entry-exports` does, with a count for each package. On 2026-11-27 it found 3,029 such exports with no importer. The prune left 133, and a second step on the same day left 8: an entry file that forwarded a dead name with `export *` now has an explicit export list, and the other names lost the `export` keyword. A third step left 0: the floor plan group of `bakery-surface.ts` and the vitrine types of `schedule.ts` moved to sibling modules, and the smaller files now forward an explicit export list. The kept groups stay, each with a reason in `scripts/entry-exports-ratchet.json` (`node scripts/check-entry-exports.mjs --report`) |
| No test file without a decision                         | Done: [`refactor-17-test-decisions.md`](refactor-17-test-decisions.md), 318 files                                                                                                                                                                                                                                                                             |
| The time of the first three ports is measured           | Done: [Cost](#cost)                                                                                                                                                                                                                                                                                                                                           |
| The owner decides Stage B                               | Decided on 2026-11-21: Stage B waits for the Plan 93 cutover ([D2](#decisions))                                                                                                                                                                                                                                                                               |

### Stage A: the tail

1. **The last 10 crossings are gone: the layer count is 0.** The fixes: a chat port of
   the Café prompt edit, the Stripe part of the integrations page through the Portal
   wiring, an opaque page state of the chat record with a surface registry for the
   Kitchen, an activation module of `OrganisationDO`, and the shared ids
   (`OrganisationId`, `IntegrationAccountId`) in `@purin-labs/contract-schema`, below
   both contract packages. `packages/contracts` names no commerce package now.
2. **Done: the decisions of step A2.1** (2026-11-22; the owner: "finish them off").
   Each kind of decision has one look, and a custom connector write has a refusal.
   See [the entry](#a21-the-decisions-2026-11-22).
3. **Done: the preview pages of `apps/portal/src/dev/` hold no copy of product code.**
   The clone check finds 4 pairs that touch `dev/`, and each pair joins two preview
   pages. Production serves none of the pages. The appliance viewer
   (`appliances-preview.tsx`, 1,545 lines) has no product user, so it stays a preview
   page. Stage B puts each preview page beside the `ui` folder of its area. See
   [the entry in Steps done](#the-preview-pages-and-the-browser-check-of-the-decision-buttons-2026-11-21).
4. **Decided: the deleted product code stays deleted** (2026-11-22). No file used
   it: two floor plan station helpers, a workspace run save helper,
   `verifyRevokedVaultSecret`, three Code Mode workspace allocation wrappers and 14
   commerce client resource parsers. A later change that needs one takes it from
   the history. `openCounterSale` and `manualCashRefundCounterSale` stay, because
   Plan 90 names them.
5. **Decided: the two test follow-ups stay** (2026-11-22). No journey runs a lab
   scenario two times with the same key, so only
   `commerce-lab/scenario-catalog.test.ts` proves that a replay gives the same run
   and event ids. The commerce lab journey does not read the cue log, so only the
   third case of `commerce-lab/queue-projection-recovery.test.ts` proves that a
   commerce cue names no provider account.
6. **Checks.** CI runs again since the repository became public on 2026-11-21. Its
   first run found six faults, and the fixes are on `dev` since 2026-11-22; the CI file
   fetch also needs the read-only CI key to read the new bucket of Plan 93. Not run:
   a real Portal chat turn, mailbox turn and WhatsApp turn against the deployed
   Worker, and a browser check of the status band of a governed action, which needs
   a running Worker (the band uses the same refusal as the chat card).
7. **Outside this refactor.** `counter-receipt-printer.test.ts` fails under the load of
   the machine: the device fleet waits 8 seconds for the printer (`PRINTER_ANSWER_MS`).
   It belongs to Plan 90. Decision D6 (capability claims of the mailbox and WhatsApp
   agents) stays with its default.

### Stage S: started 2026-11-22

State on 2026-11-23: each of the 33 specs is written, each with a second reader and a
correction. The first 13 are `DEV-01`, `FND-01` to `FND-11` and `COM-01`: the second
readers found 3 to 8 false statements in each first version. For the other 20 specs
(about 7,900 lines), the second readers found 143 false statements, 105 statements
that the code cannot prove and 119 omissions. The writers corrected 354 of these
findings and refused 18, each with its reason. Each spec lists the places where its
source plans differ from the code: 291 places in the 20 specs. The writers of the 33
specs also reported 229 possible code faults. On 2026-11-23 a second reader read the
code for each one, and ran no code: the code confirms 216 (89 of behavior, of which 8
are of high and 29 of medium severity; 62 of text; 51 of dead or duplicate code; 14 of
tests), 12 are not faults and 1 is fixed. No fault is corrected yet. The list is with
the owner and not in this repository: the repository is public, and some of the faults
concern authorization and erasure. A source plan moves to
`docs/history/` when each spec that it feeds is written: 56 plan and refactor files are
there since 2026-11-23. Plan 91 stays in `docs/` until its phase 6 ends, and the 15
other source documents stay where they are.

Step S3 is done on 2026-11-23: `AGENTS.md` has 249 lines (749 before). It keeps the
owner's rules for the work, for reports and for subagents word for word, the code
rules with the name of each lint, and one line for each layer and area with its
specs. The plan index is in `docs/specs/README.md`, the names table is in `ENG-03`,
and the long form of each rule is in `ENG-02`, `ENG-04`, `PRT-01` and the foundation
specs. The short `AGENTS.md` of each area comes with the area folders of Stage B.

The condition of step S2 was final brand names (D2: "The spec text waits for the
brand names"). The Purin names are on `dev` since Plan 91 phase 4A, so S2 started on
2026-11-22 with one pilot spec, `DEV-01` (Devices, from Plan 85):

- A writer made the spec from Plan 85 and the code: 250 lines, about 400,000 tokens
  and 19 minutes. It found 13 places where the code differs from the plan.
- A second reader checked each statement against the code: about 300,000 tokens and
  7 minutes. It found 9 false statements, 3 that the code cannot prove and 5
  omissions. The writer corrected each one.
- `scripts/move-plan-to-history.mjs` moved Plan 85 to `docs/history/` and corrected
  the 12 links to and from it.
- The read found two code faults in the area. A comment in `devices/store.ts` said
  that the text cleaner removes link marks; it does not, and it need not, because the
  Slack card shows plain text. The comment is correct now. The other fault is open: a
  fleet Actor that knows only revoked gateways still writes its daily upkeep row.

The other 32 specs cost about 22 million tokens at the pilot rate. The session
"Plan 91 phase 4" still finishes the provider consoles and the callbacks. Step S1 is
done. Steps S2 (the 33 specs, one area at a time, each checked against the
code before its plans move to `docs/history/`) and S3 (`AGENTS.md` under 250 lines, the
plan index and the names table move out) start when Plan 91 phase 4 (the domain and
the provider consoles) is done. The owner decided this on 2026-11-21.

### The layer check: what it does not count

A review on 2026-11-22 (four readers, each finding confirmed in the code) found that
"0 crossings" is true for what `scripts/check-layers.mjs` counts: the imports between
files of the two covered folders, the `package.json` dependencies and the D1 writes
with a literal table name. These kinds of crossing exist today, and the check does not
count them. Stage B moves files by this map, so each kind needs a decision first: a
new count with a ratchet, or a written reason to accept it.

| Kind                                                                                      | Today                                                                          | Example                                                                  | Count in `lint:layer-debts`                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| A `declare module` merge puts a Worker class into `Env`, and lower code calls its methods | 16 merges; 171 methods of `OrganisationDO` and `ConnectorDO` called from below | `actors/harness-follow-up.ts` (foundation) calls `scheduleSlackFollowUp` | `env-merge`: 16 merges; 83 methods, counted by name                            |
| Area or surface code in a foundation module, because it imports nothing above             | About 40 files                                                                 | `mail/gmail-adapter.ts` in `foundation/connections`                      | `foundation-misfit`: 14 files by their links, 45 files by a word of their path |
| A read of a D1 table of another module (only writes have a rule)                          | 91 reads                                                                       | `access-control/decision-explanation.ts` reads `mailbox_ingress_policy`  | `table-read`: 91 reads                                                         |
| A surface imports an area file that is not public                                         | 250 of 294 imports                                                             | `actors/connector/email-work.ts` imports `mail-inbox/execution.ts`       | `surface-nonpublic`: 249 imports                                               |
| Each area package passes as a contract; `contracts` lists one                             | 78 of 124 imports                                                              | `commerce-client` from `areas/kitchen`                                   | `area-package`: 78 imports                                                     |
| Logic in the Worker module                                                                | 24 files, 9,800 lines                                                          | `readBakeBoard` in `actors/organisation/bake-kitchen.ts`                 | `worker-logic`: 10 files, 3,778 lines                                          |
| The Shopify rule of step A2.5 has no check                                                | 5 of 7 importers                                                               | `integration-gateway.ts`                                                 | `shopify-rule`: 10 imports in 6 files                                          |
| A table name in a template string, and each Actor SQLite table                            | 6 writes                                                                       | `data/organisation-purge.ts`                                             | `interpolated-table`: 17 writes (8 to D1, 9 to Actor SQLite)                   |
| A new Portal file gets `surfaces/portal` by the folder rule and is never refused          | —                                                                              | —                                                                        | `portal-default`: 26 files                                                     |
| A contract calls a foundation module above `contracts` at run time (added 2026-11-24)     | 94 imports in 42 public files                                                  | `mail-source-authorization.ts` calls `authority`, `tenancy`              | `contract-runtime`: 94 imports                                                 |

`pnpm lint:layer-debts` (`scripts/check-layer-debts.mjs`, a part of `pnpm lint:source`)
holds each kind since 2026-11-22: a count in `scripts/layer-debts-ratchet.json` may not
grow, and the file gives the reason and the fix of each kind. The check fixes no
crossing. How the last column counts:

- `env-merge`: the check reads no types, so a method counts by its name. It counts
  when one class file declares it, no other file declares a member with that name,
  and a module that may not import the class calls it. A method with an RPC interface
  in its own module is therefore not in the 83.
- `worker-logic`: a file of the Worker module that is not the entry (a default
  export), not a class shell (a class) and not wiring (no `if`, `for`, `while` or
  `switch`).
- `shopify-rule`: each import of the module from outside it, apart from the two
  registration lines of the Worker.
- `interpolated-table`: no rule tells a D1 write from an Actor SQLite write, so the
  count holds both.
- Each count is by module or by module pair, and the check reads the files only
  through `scripts/layers.json`. A move of files into a root folder or a workspace
  package therefore keeps each count.

### Stage B: open since the Plan 93 cutover (2026-11-22)

[Plan 93](plan-93-clean-cutover.md) is done: `pantry.purin.io` serves production and
the old stack is deleted. Stage B starts with step 1. In this order:

1. Done: the trial of D1 ([report](evidence/refactor-17-d1-trial.md)) and its
   decision, a mix ([D1](#decisions)). Done with it: the four Actor stub types left
   `env.ts` for `actors/actor-stubs.ts`, so the kernel reads no key that an Actor
   file merges into `Env`. Done on 2026-11-23: the kernel is the package
   `@purin-labs/kernel` in `foundation/kernel/` (`82d52faa`, tags
   `refactor-17-kernel-before` and `refactor-17-kernel-after`). One run of
   `scripts/refactor-17/move-module.mjs` changed 1,247 files in a freeze of `dev` of
   about 7 minutes. The Worker bundle has the same bytes before and after. The
   [runbook](runbooks/refactor-17-module-move.md) gives the steps of the day and of an
   open branch. Done on 2026-11-23, as one group in one freeze: `tenancy`,
   `actor-runtime`, `connections` and `authority` are the packages
   `@purin-labs/tenancy`, `@purin-labs/actor-runtime`, `@purin-labs/connections` and
   `@purin-labs/authority` (tags `refactor-17-foundation-1-before` and
   `refactor-17-foundation-1-after`). 169 files moved and 1,231 files changed. The
   Worker bundle differs only in the `owner` paths of two state machine files. The four
   packages have no type check of their own, because each reads a binding that another
   module merges into `Env`; the type check of the Worker checks their files. Two
   decisions made the group possible: the type `InstallModel` is in
   `@purin-labs/contracts`, and the entry of the 1Password store Worker belongs to
   `workers/platform`. Done on 2026-11-23, as the second group: `agent-tools`,
   `control`, `agent`, `conversation`, `tool-handlers` and `ui` are packages in
   `foundation/`, the file `boundary.ts` joined `@purin-labs/contracts`, and the
   Durable Object files and the React files of `collaboration` joined
   `@purin-labs/collaboration` (tags `refactor-17-foundation-2-before` and
   `refactor-17-foundation-2-after`). 461 files moved. Each foundation module is now a
   package.
2. Done on 2026-11-23, as one group in one freeze: the code of each product area is
   one package in `areas/<area>/`, with `server/` for the Worker files and `ui/` for
   the Portal files (`@purin-labs/area-devices`, `-brain`, `-organisation`, `-cafe`,
   `-inbox`, `-integrations`, `-commerce` and `-kitchen`; tags
   `refactor-17-areas-1-before` and `refactor-17-areas-1-after`). 1,137 files moved:
   546 to `server/` and 591 to `ui/`. Each foundation module that an area imports was
   a package by then, so D1 lets an area be a package. A Worker file loses its first
   folder when that folder is the name of the area or `commerce/`
   (`src/devices/store.ts` is `areas/devices/server/store.ts`). The Worker bundle
   differs only in the `owner` paths of five state machine files, and the Portal build
   has the same 5 pages and 563 files. 203 TypeScript files stayed in
   `services/platform/src` (the Worker module and the surfaces Slack, chat, voice and
   Shopify), and 166 files stayed in `apps/portal/src`, until the surfaces group.
   Done on 2026-11-23, as the fourth group in one freeze: each surface is one package
   in `surfaces/<surface>/` (`@purin-labs/surface-slack`, `-email`, `-whatsapp`,
   `-webhooks`, `-voice` and `-portal`), and the Shopify module is the folder
   `areas/integrations/shopify/` of `@purin-labs/area-integrations`, one folder that a
   person can delete (tags `refactor-17-surfaces-1-before` and
   `refactor-17-surfaces-1-after`). 267 files moved. The Worker bundle has the same
   bytes before and after, and the Portal build has the same 5 pages and 563 files.
   `apps/portal` stays the Vite application: its HTML pages, its config, `public/`
   and 70 entry and preview files. Its shell, router, page table and chat feature are
   in `surfaces/portal/ui/`. 31 files stay in `services/platform/src`, all of the
   Worker module: the Worker entries, the Actor class files and the wiring.
3. The journeys stay in `services/platform/tests` and import a module by its package
   name. No module needed a `testing` entry.
4. Not done, each with its own decision:
   - Done on 2026-11-23: the folder of the Platform Worker is `workers/platform`
     (it was `services/platform`), by one run of
     `scripts/refactor-17/rename-folder.mjs`. 890 files moved. No deployed name
     changed, and the bundle of each Worker has the same bytes, so the rename
     needed no release. The side Workers stay as Wrangler files of that folder.
     The owner decided that `apps/portal` stays the folder of the Portal build,
     and the other folders of `services/` stay too.
   - The surface packages import each other in two circles (`email`, `whatsapp`,
     `slack` and `webhooks`; `portal` and `voice`). A port for each removes it.
   - Done on 2026-11-24: the public files that
     another area imports are the `contract` package of their area
     (`areas/<area>/contract`), and `pnpm` reports no cycle between the area
     packages. A contract imports the foundation, outside packages and the
     contract of another area (decision of the owner).
   - The area packages of `packages/` (the CRDT packages, the control API packages,
     `bakery-model`), the crates and the area scripts stay where they are.
   - Done 2026-11-27: a short `AGENTS.md` for each area (`areas/<area>/AGENTS.md`).
5. After the cutover, with its own decision each: one outbox table shape for the 5
   outboxes, new names for classes and tables, and the deletion of each old-row adapter.

## Steps done

**The state on `dev`, 21 November 2026.** Each entry below that names a branch is on
`dev` now, up to and with the last 10 crossings. The owner agreed to each push. The full E2E suite passed on each merge
before its push: 236 files and 457 or 458 tests, with 3 files skipped (they need a
real model). The last run had the MuJoCo SDK, so the cobot journeys of Plan 24 ran
too: 247 files and 478 tests pass. In two of those runs `counter-receipt-printer.test.ts` failed under the
load of the machine and passed alone three times. The layer count on `dev` is 0
(1,350 at the start of the refactor). An entry that says "the full E2E suite did not
run on the branch" is about the worker branch; the merge ran it.

**20 November 2026. Step A0 and step S1 are done.** The owner agreed to the landing,
and the commits are on `dev` since that day.

| Step | What exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A0.1 | `pnpm lint` is `lint:static` and `lint:d1-patch`. CI runs `pnpm lint:static` in one step, in place of five lint steps and the shared helper step. `.githooks/pre-push` runs `lint:source`. The hook is off: its setting is shared by every worktree of a clone, so the owner decides it                                                                                                                                                                                                                                                                                                                                                                                         |
| A0.2 | `scripts/layers.json`: 105 folder rules and 621 file lines for the 1,788 source files of `services/platform/src` and `apps/portal/src`, a module for each of the 26 workspace packages, a place in the target layout for each other tracked folder (`placement`), and an owner module for each of the 218 D1 tables (`tables`). The review moved 35 Platform files, among them 9 onboarding files that a name rule had put in `cafe`. `foundation/connections` has no file yet: its files are in `areas/integrations`                                                                                                                                                           |
| A0.3 | `pnpm lint:layers` (`scripts/check-layers.mjs`) with `scripts/layers-ratchet.json`: 1,350 crossings in 231 pairs. 671 imports go upward, 377 go between areas, 176 go against the foundation order, and 126 SQL writes change a table of another module. A pair cannot grow, and a new pair is refused. The lint also refuses a source file with no module, a tracked folder with no place and a D1 table with no owner. `--tables` prints the writers of each table, and `--misfits` prints each file whose imports are mostly in another module                                                                                                                               |
| A0.4 | [Baseline](#baseline)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A0.5 | `pnpm lint:doc-links`: 833 relative links in 180 pages. `scripts/doc-links-ratchet.json` holds 31 links that were broken before, most of them in the two architecture documents. Step S2 removes them                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A0.6 | `node scripts/check-lint-paths.mjs --bound` prints each file that holds the path of another file: 472 files with 3,341 paths. 264 are scripts, 91 are test support files, 29 are tsconfig files, 26 are lint and ratchet files and 25 are package manifests. `--bound --list` gives the files for the move script of Stage B                                                                                                                                                                                                                                                                                                                                                    |
| A0.7 | `pnpm lint:lint-paths`: 953 paths in 27 lint files match a file. No lint path was broken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A0.8 | `pnpm lint:clones` (jscpd 5.4.3, `.jscpd.json`, `scripts/clones-ratchet.json`) refuses a new copy of product code. The baseline holds the count of the copies and, since 2026-11-22, of the copied lines for each pair of files; a first form with one fingerprint for each copy changed with each edit near a copy. `pnpm lint:unused` (knip 6.46.1, `knip.json`, `scripts/unused-ratchet.json`) refuses a new unused file and a new unused export, and from 2026-11-22 to 2026-11-27 a higher count of package entry exports with no importer, which `pnpm lint:entry-exports` now holds. `node scripts/list-tests.mjs` gives the test files with their kind and their module |
| S1   | `docs/specs/README.md`: the 33 specs with their sources, and a table of 115 old plan and refactor numbers. `pnpm lint:plan-numbers` reads each form of a mention: 105 numbers in code, all in the table. 52 rows point to the archive                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

The lint now allows an import of a workspace package of another area: the package is
the contract of that area, as step A1.10 describes. An import of a file of another
area stays a crossing. With this rule and with step A1.3 merged, the map shows 914
crossings.

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

**20 November 2026. Step A1.3 is done and on `dev`.**

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

**20 November 2026. Steps A2.2 and A2.3 are done in the Portal,** and the commits
are on `dev` since that day. The surface registry of step A2.3 is open: it changes
the Platform too.

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

**20 November 2026. Step A1.11, part 1, a part of step A1.8, and structure changes.**

| Step                            | What exists                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1.11, part 1                   | `@purin-labs/contracts` no longer re-exports `@purin-labs/commerce-contracts`. A file imports a commerce name from the commerce package. A codemod moved 604 names in 176 files and 32 inline type references. `bakery-model` and `production-simulation` declare the dependency that the re-export hid                                                           |
| Tool files by area              | `agent-tools/channels/` and `agent-tools/drafts/` held tools of several areas. Each tool, its handler and its types are now in a file of its own area: Kitchen (production plan, workflow canvas), commerce (product description draft), inbox (marketing email draft), Slack (`agent-tools/slack/`, new family) and Café (menu draft, menu boards). Same digests |
| Portal chat router              | `control/routes/chat/router.ts` matches and dispatches the 13 routes of the Portal chat. They were in the route file of the custom connectors. `control/path-match.ts` holds the two path helpers                                                                                                                                                                 |
| Access feature                  | `permission-requests-summary.ts` is in `features/access/` of the Portal, so the feature no longer imports the shell                                                                                                                                                                                                                                               |
| Map: Portal page list           | `apps/portal/src/route.ts` is foundation UI code. It imports no area. Its union names the pages of every area until the Portal has a page registry (step A1.10)                                                                                                                                                                                                   |
| Gmail mail adapter              | The mail calls of Gmail (reads, watch, drafts, send) are in `mail/gmail-mail-adapter.ts`, below the inbox code. 17 inbox files read `GMAIL_MAILBOX` and no longer import the provider catalogue. The catalogue holds the same adapter value                                                                                                                       |
| Gateway request helpers         | `gateway/request-helpers.ts` holds the 15 route helpers (path segments, admin bearer, body fields, error answers). A route file of an area no longer imports `gateway/support.ts`, which holds queue handlers of several areas                                                                                                                                    |
| Commerce delivery ids           | `actors/case/commerce-delivery-ids.ts` makes and reads the delivery ids of the approval notice and the outcome of a commerce action. The Slack card file held them                                                                                                                                                                                                |
| Map: side Case start            | `chat/side-case-start.ts` and its route are Portal code: they start a new Portal chat                                                                                                                                                                                                                                                                             |
| Map: sidebar, default workspace | `console-sidebar.tsx` is foundation UI code. `data/organisation-workspace.ts` and its two tables are agent foundation code, with the workspace revision store                                                                                                                                                                                                     |
| A1.8: provider directory        | `data/integration-provider-directory.ts` holds the names of the active providers, their parser and their data classes, as data only. The read model of integration discovery reads it and no longer imports the provider catalogue. The catalogue takes the data classes from the directory                                                                       |
| Session schema version          | `CANONICAL_SESSION_SCHEMA_VERSION` is in `actors/actor-schema-versions.ts` with the three other Actor versions. The Actor router no longer imports the Session schema file                                                                                                                                                                                        |
| Map: room list, menu actions    | `actors/organisation-collaboration-rooms.ts` is a part of the Worker: only the class `OrganisationDO` imports it. `commerce/cafe-menu-action.ts` and `commerce/menu-price-action.ts` are commerce code: they are two variants of the commerce action                                                                                                              |

The layer count is 821 (upward 352, between areas 217, order 134, tables 118). The
re-export hid 15 imports of the commerce package from foundation files; the count
shows them now.

What part 1 found for part 2: foundation source files import 18 commerce names at 29
places, and each name is commerce-specific (`CommerceGraphQuery`,
`CommerceAuthorityScope`, `CommerceEntityTypeId` and others). No shared primitive is
among them. So part 2 is not a move of names below both packages. It is the work of
steps A1.7 and A1.8: the Session and the authority code read commerce through a port.

What stays open in step A1.8: `access-control/decision-explanation.ts` reads the custom
connector accounts, `credential-vault/webhook-resolution.ts` reads the Discord install,
and `actors/organisation/organisation-policy.ts` reads four Jev feature files.

One placement waits for step A1.7: `agent-tools/registry.ts` is a part of the Worker
(21 crossings), but three Session files import it. The Worker must give the registry to
the Session first.

**20 November 2026. Step A1.4 is done and on `dev`.**

- **Two parts.** Each of the 27 `draft`, `receipt` and `scheduled` tools defines
  `prepare` in place of `handler`. `prepare` does the live checks and the reads, and
  it returns the effect with its exit checks.
- **One place.** `settleToolEffect` in `agent-tools/session-support.ts` reads the
  label, runs the checks and calls `run`. The executor gives it each effect. No
  handler calls the exit check: `toolEffectPassesExit` is private to that file.
- **The record.** [Appendix C](#appendix-c--what-each-effect-tool-did-before-step-a14)
  gives the checks of each tool before the port, the eight patterns, what the
  `proposal` and `surface` tools do, and the two differences that the comparison
  found. Both are in a log only.
- **The lint.** `pnpm lint:tool-effects`, in `lint:source`, refuses an effect tool
  with no `prepare`. `defineToolFamily` refuses one when the Worker loads.
- **Not changed:** the 13 `proposal` tools, the 47 `surface` tools, the tool order
  and the model definitions. The catalog digests are equal to the baseline.
- **Three effect tools have no exit check, as before:** `menu_board_archive`,
  `whatsapp_support_reply_send` and `schedule_follow_up`. Their `prepare` returns an
  effect with no check, and `run` is the old handler. A check there is a behavior
  change and needs its own decision.
- **Measures.** Layer crossings: 821, no change. Copies of product code: 895 to 892.
  Unused exports: 809, no change. Lines: 1,616 removed and 1,794 added.
- **Checks.** The static lints, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (302 files) pass. 92 journey files ran: 90
  pass and 1 is skipped. `counter-receipt-printer.test.ts` failed one time in the
  group run and passed alone; it tests the receipt printer and reads no agent tool.
  The full E2E suite passed on the merge with `dev`: 236 files, 457 tests.
- **Still open:** a handler takes the turn context from the Session
  (`withToolContext`), not from the executor. Step A1.7 owns it.

**20 November 2026. Step A1.5 is done and on `dev`.**

- **One executor.** The mailbox agent host and the WhatsApp agent host call
  `executeCatalogTool`. Their two chains of name tests are deleted. Their 14 tools
  are `defineTool` values in `agent-tools/channels/mailbox-agent.ts` and
  `whatsapp-agent.ts`, with the selection rule `{ kind: "host", host }`.
- **Two registries beside `TOOLS`.** A host has its own registry, and no tool of it
  is in `TOOLS`. So a Portal chat or Slack turn never sees one, and the mailbox
  `propose_memory` does not meet the Portal tool of the same name.
- **A host profile.** A host with its own result format gives the executor its
  result envelope and its refusal of an unknown name.
- **The record.** [Appendix D](#appendix-d--the-two-agent-hosts-before-step-a15)
  gives the tool lists, the hashes and the checks of each tool before the port. The
  comparison shows no difference: the definitions, the host digests and the results
  are the same bytes for one WhatsApp turn and five kinds of mailbox turn.
- **Not changed:** no capability, no policy row and no check was added (decision D6).
  The catalog digests of the Portal chat host are equal to the baseline.
- **Measures.** Layer crossings: 821, no change. Copies: 892, no change. Unused
  exports: 809, no change. Lines: 557 removed and 868 added; the 14 definitions are
  longer as `defineTool` values.
- **Checks.** The static lints, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (302 files) pass. The 32 journey files of
  the brief pass, in three groups. The full E2E suite passed on the merge with
  `dev`: 236 files, 457 tests.
- **Still open:** each host keeps its services, its state and its result format in
  its own file. `actors/embedded-harness-tool-host.ts` did not change: the three
  hosts share the executor, not one host object.

The same landing has one change of step A1.8: the credential Vault defines the four
fields that it reads of a Discord installation, so it imports no Discord file. The
layer count is 820.

**20 November 2026. Step A1.11, the rest: `control-api` names one area package.**

| Part                      | What exists                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema kit                | `@purin-labs/contract-schema` (`foundation/std`) holds `schema.ts`, `record-values.ts` and `sorted-unions.ts` of Plan 78. They were in `commerce-contracts`. Each importer names the new package. The package is neutral for `lint:runtime-boundary`, so the commerce engine may import it                                                                                                           |
| Area slices               | Four packages hold the shapes of one area each: `commerce-control-api` (entity plane, commerce actions and operations, agent operations, checkout profiles, the description room), `kitchen-control-api` (recipes, inventory receipts and production), `cafe-control-api` (menu boards, the Content Studio menu) and `inbox-control-api` (the reply draft)                                           |
| Foundation shapes         | `memory.ts` holds the entity of a `commerce_entity` scope as a plain reference; the parser that the caller gives checks its shape. `access-models.ts` takes the entity type of a grant selection from `CommerceReadGrantScope` of `contracts`                                                                                                                                                        |
| What the foundation reads | The foundation reads some commerce shapes, so they stay in `control-api` and name no commerce package: `commerce-receipts.ts` (the provider receipt), `commerce-exceptions.ts` (the exception inbox) and `agent-operation-commands.ts` (`AgentOperationCommandOf<Scope>`; the commerce package gives the scope type)                                                                                 |
| Costs                     | `costs.ts`, `costs-actuals.ts`, `costs-forecast.ts` and `costs-formulas.ts` stay in `control-api`, so `control-api` still depends on `commerce-contracts` (the recipe records of `CostsOverview`). The Session file `actors/agent-session-costs.ts` calls the cost calculations. In the Kitchen package, that import is a new crossing, and the ratchet refuses it. The port of step A1.7 moves them |
| `text-collaboration`      | The type is in `@purin-labs/collaboration`. `control-api` no longer depends on it                                                                                                                                                                                                                                                                                                                    |
| Layer lint                | `contracts` in `scripts/layers.json` lists the contract packages of the areas (now `commerce-contracts`). A package of another area may depend on one, as a file of an area may import it                                                                                                                                                                                                            |

`control-api` now depends on `contracts`, `commerce-contracts`, `contract-schema`,
`std`, `type-utils` and `console-shared`. Codemods moved each import of a moved name.
No shape, parser or error text changed.

- **Measures.** Layer crossings: 821 to 813, and no pair went up. The package pairs of
  `control-api` to `collaboration`, `commerce-client` and the four CRDT packages are
  gone, and so are the pairs of `bakery-model` and `production-simulation` to
  `commerce-contracts`. Copies of product code: 892, no change. Unused exports: 809, no
  change.
- **Checks.** The static lints, the three type checks, `pnpm check:packages`,
  `pnpm portal:build`, `pnpm underclerk:check` and the unit suite (302 files) pass.
  The full E2E suite passes: 236 files and 457 tests, 3 files skipped (live model
  journeys).
- **Still open:** the costs files (above). `OrganisationId` is still in
  `commerce-contracts`, and `contracts` still depends on `commerce-contracts`.
  `control-api` keeps area files that name no area package, for example
  `menu-board-reviews.ts`, `order-queue.ts`, `mail-*.ts`, `evals.ts` and
  `case-execution.ts`.

**20 November 2026. Step A1.6 is done for the Connector, and it is on `dev`.**

- **The port.** `actors/connector/channel-adapter.ts` defines `ChannelAdapter`:
  the tables of a channel, the due times of its alarm work, its work before
  the Case work drain starts and its alarm steps. `CaseWorkChannel` runs,
  tells and steers the Case work. `DeliveryChannel` sends a Case output.
  `ConnectorChannelHost` is what the kernel gives to a channel. `ConnectorDO`
  gives the three channels to the kernel, in the order Slack, email,
  WhatsApp.
- **Slack.** The Case work queue holds an opaque command. A `CaseWorkCodec`
  reads its event, its provider message and its stable form.
  `connector-slack-case-work.ts` holds the codec, the follow-ups and the
  parked permissions and side Cases. `connector/slack-channel.ts` holds the
  Slack turn, the exhausted notice, the steer rule, the live turns, the side
  Case starts, the stream and the delivery.
- **Email.** The mailbox work of the alarm is in `ConnectorEmail`, and the eval
  work is in `ConnectorEvals`. The eval step runs as a step of the email
  channel, in its old place, so the order of the steps did not change.
- **WhatsApp.** The turns, the notices and the automatic send are in
  `ConnectorWhatsApp`. The delivery row parser is a kernel parser.
- **The alarm.** `armConnectorAlarm` takes the due times of the channels. A
  class layer calls `this.armAlarm()`. A WhatsApp send and an operational
  email command get the call from their caller.
- **Measures.** The kernel files (`connector-actor-base.ts`, `case-work-drain.ts`,
  `delivery.ts`, `support.ts`, `types.ts`, `alarm.ts`, `connector-case-work.ts`,
  `connector-alarm.ts`) import no file of `surfaces/slack`, `surfaces/email`,
  `surfaces/whatsapp`, `areas/inbox`, `areas/brain` or `workers/platform`.
  Layer crossings: 821 to 778. The pairs `foundation/conversation ->
surfaces/email` and `-> surfaces/whatsapp` are gone. Copies of product code:
  892, no change. Unused exports: 809, no change. `connector-actor-base.ts`
  went from 1,466 lines to 396.
- **Not changed:** the stored values, the schema steps, the delivery ids, the
  alarm times and each Slack, Gmail and WhatsApp request. The class chain
  stays (step A1.9).
- **Still open:** 7 imports of Slack files from `actors/case*.ts` and `chat/`,
  and the Inbox and email imports of `actors/case*.ts`. They are the Case
  kernel, not the Connector. The Portal chat stream is not a channel adapter
  yet.

**21 November 2026. Step A1.7 is done in part,** on the branch `refactor-17-a1-7`:
the tool list, the handlers, and the ports of commerce, integrations and Kitchen.
The Inbox ports and the Slack imports stay open.

- **The Worker gives the tools.** `actors/agent-session.ts` holds only the class
  `SessionDO`, a shell of the Worker. The Session actor is the abstract class
  `SessionActor` in `actors/session/session-actor.ts`. `SessionDO` gives it one value,
  `SessionToolWiring` (`actors/session/tool-wiring.ts`): the tool registry, the tools
  that a turn adds, the services of each family that an area owns, the page effects
  and the observer of tool arguments. It is a method, not a field, because the
  constructor of the Session reads the registry for the Pi recovery.
- **No Session file imports the registry.** `agent-tools/registry.ts` and the new
  `agent-tools/session-wiring.ts` are `workers/platform` in the map. The replay rule
  of a tool is an input of the harness runtime (`toolReplay`), and the Pi recovery
  takes the registry as an argument.
- **Each family gives its services.** Each area has a `turn-services.ts` file with one
  function that builds the services of its families for a turn. The Session names no
  handler of an area. It builds the turn context (`ToolTurnContext`) once and gives
  the services of the three foundation families itself: files, messages and turn
  (`actors/session/own-tool-services.ts`).
- **Proposal staging left the class chain.** The class `SessionProposalStaging` is
  deleted. Each area owns its staging function: campaign brief and configuration
  (commerce), recipe workflow (Kitchen), device, Jev switch and custom connector
  write (integrations). The shared identity check is
  `actors/session/proposal-staging.ts`. The Organisation area writes a configuration
  draft (`agent-tools/organisation/configuration-draft.ts`) and gets two parts as
  ports: the price reference of an allowance from commerce, and the words of a
  command from Slack.
- **Commerce.** The Kitchen costs tools moved from `actors/agent-session-costs.ts` to
  `agent-tools/kitchen/costs-handlers.ts`. They get the commerce reads and the
  Underclerk clients as a port (`CostsCommerce`), so the move adds no import from
  Kitchen to commerce.
- **Integrations.** The Session no longer compiles the custom connector catalog. The
  wiring gives `turnTools`, and the Session carries `TurnTool` values of the executor.
- **Kitchen.** The wiring gives `pageEffects`: the page commands that an authority
  may use, the check of the page state of a message, the settlement and the repair
  of a page effect, and the rebind of the receipt collection after a recovery. The
  RPC method `settleBakerySurfaceEffect` and the alarm step `bakery_surface_effects`
  keep their names.
- **Not changed:** no tool, check, order, stored value, journal entry, error text or
  replay result. The catalog digests of "Baseline" are equal. The tool definitions
  did not change, so the host digests of Appendix D did not change.
- **Measures.** Layer crossings: 820 to 754. `foundation/agent` to commerce: 30 to 22.
  To Inbox: 29 to 27. To Kitchen: 21 to 4. To integrations: 6 to 1. To Slack: 9 to 7.
  To organisation: 5 to 4. To Café and to devices: 2 to 0 each. `foundation/agent-tools` to an area or a surface: 35 to 11.
  Copies: 892 to 890. Unused exports: 809, no change.
  Lines: 2,754 removed and 3,226 added. About 1,500 of each are the move of the
  Session class to `session-actor.ts`.
- **Checks.** The static lints, the D1 patch check, the three type checks,
  `pnpm check:packages`, `pnpm portal:build` and the unit suite (302 files) pass. The
  98 journey files of the brief ran in five groups: 96 pass and 2 are skipped. The
  full E2E suite did not run on the branch.
- **Still open, in Session files.** Each line is an import that stays.
  - Inbox, 16 imports: `actors/session/session-transient-turns.ts` (7),
    `transient-turns.ts` (2), `turn-completion.ts` (1) and `types.ts` (6). The mailbox,
    mail assistant and WhatsApp turns are methods of the Session class, and their RPC
    types name Inbox types that the Connector files use. They leave with the actor
    modules of step A1.9.
  - Kitchen, 4 imports: `actors/session/tool-wiring.ts` names the wire types of a
    page (2), and `actors/agent-session-continuation.ts` parses the stored page
    context (1). Both import the package `@purin-labs/bakery-model`: the wire types
    must move to `contracts` first. `actors/pi-durable-tools.ts` asks if a tool is a
    Kitchen surface tool (1).
  - Commerce, 1 import: `actors/pi-durable-tools.ts` names the result type of
    `commerce_entity_context`. Both imports of that file need a field of the harness
    tool definition.
  - Slack, 6 imports: `actors/harness-follow-up.ts` (3),
    `actors/harness-side-case-proposal.ts` (1), `actors/session/harness-source.ts` (1)
    and `session-harness-turns.ts` (1). They are the Slack side Case and the Slack
    notices: the channel adapter of step A1.6 owns them.
  - Brain, 1 import: `actors/harness-memory-proposal.ts`.

**21 November 2026. Step A2.4 is done,** on the branch `refactor-17-a2-4`.

| Page                                             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The workflow demo                                | Production serves it with no sign-in at `/workflow-simulator`, `/bakery`, `/floor-plans` and `?demo=1`. Its frame (the sample Portal frame, the chat pane and the Kitchen page) is now `apps/portal/src/workflow-demo.tsx`, a surface module. It cannot go into the Kitchen folder, because an area imports no shell and no chat. `bootstrap.tsx` imports no file of `dev/` in a production build. `UNAVAILABLE_ACCESS` is in `features/access/` |
| `/workflow-preview.html`                         | It stays a development fixture, because CI and 33 browser journeys of the index open it with no sign-in. `dev/workflow-preview.tsx` holds only the chat preview data and the mount call. CI and the journeys keep the address. Two journeys load the moved style sheet, and one reads the import addresses of both modules                                                                                                                       |
| `/eagle-rehearsal.html`, `/linea-rehearsal.html` | No change. They are already Kitchen pages: `features/production-run/linea/espresso-rehearsal.ts`, with real reads through `controlRead` for `?organisation=<id>`. Production serves them, the Kitchen workspace opens them in a new window, and a journey opens them with no sign-in                                                                                                                                                             |

`pnpm lint:kitchen-dom` (`scripts/check-kitchen-dom.mjs`) is in `pnpm lint`. It parses
each source file of `bakery-model`, `bakery-workflow` and `production-simulation`, and
fails on `window`, `document` or a global that `lib.dom.d.ts` declares and
`lib.webworker.d.ts` does not. No file fails, so the check has no ratchet.

Other preview pages in `dev/` still hold their own code. Production serves none of
them. `appliances-preview.tsx` (1,545 lines) is an appliance viewer with its own
Three.js loader, and `kitchen-chat-preview.tsx` builds the same frame as the workflow
demo for a real Organisation. They are separate work.

**21 November 2026. Step A2.5 is done in part,** on the branch `refactor-17-a2-5`: the
`CommerceProvider` port and its two implementations.

- **The port.** `commerce/commerce-provider.ts` defines `CommerceProvider`. It has five
  methods, each from a branch on the system kind: `resolveActionCredential` (the
  effect gate), `executeAction`, `reconcileAction`, `graphSource` (the sources of a
  graph read) and `wire` (the control API shape). The permit and the result types of
  an action moved there from `provider-execution.ts`.
- **Two implementations and one list.** `builtInCommerceProvider` is in
  `commerce/built-in-commerce-provider.ts`, and the engine paths of
  `provider-execution.ts` are its execution and its reconciliation.
  `shopifyCommerceProvider` is in `shopify/commerce-provider.ts`, the old
  `commerce-action.ts`. `commerce/commerce-providers.ts` holds the one list, and
  `commerceProvider(kind)` gives the provider of a system.
- **The callers.** The effect gate, the execution and the reconciliation ask the
  provider. `createCommerceGraphReader` replaces three copies of the reader set-up
  (the control graph read, the cue delivery and the supplier context). The graph
  reader reads the blotter source when the provider gave one; it does not read the
  system kind. The Shopify location checks of the Organisation actor are functions
  of `shopify/location-observation.ts`.
- **One union.** `CommerceSystemKind` and the record source of each kind are in
  `packages/contracts/src/commerce-system.ts`, as a closed union of wire values. Six
  copies of the kind union, two schema copies and `CapabilityCommerceSystem` are
  gone. The Portal and `control-api` have one view type of the selected system.
  `BankPayout` already had one hand-written type; it stays.
- **Not changed:** no route, scope, event kind, stored value or error text. The
  provider list is a function, so the import cycle between the execution module and
  the list reads nothing at module load.
- **Measures.** The grep of the brief: 75 lines to 60; 55 to 36 outside `shopify/`
  and the Portal. Layer crossings: 703 to 702; the Shopify pairs are equal (24).
  Copies: 890 to 888 (`commerceProjectionRevision` had two). Unused exports: 809.
- **What stays.** `agent-tools/commerce/handlers.ts` builds its reader by hand (another
  worker owns the file); after it calls `createCommerceGraphReader`, the reader option
  `commerceSystem` goes. The access model (`decision-explanation.ts`,
  `integration-discovery.ts`) is a foundation module, so it needs the port of step
  A1.8. `data/organisation-commerce-system.ts` parses and writes the stored row of
  each kind. The onboarding readiness rule (`data/onboarding.ts`) has its own SQL.
  The Portal shows each kind. The other matches of the grep are provider ids or cue
  sources, not the system kind.

**21 November 2026. The leftovers of steps A1.11 and A1.7, and the first Session
module of step A1.9,** on the branch `refactor-17-a1-9-session`. This entry replaces
the "Costs" row and the open points of the two entries above where it names them.

- **A1.11: `control-api` names no area package.** `costs.ts`, `costs-actuals.ts`,
  `costs-forecast.ts` and `costs-formulas.ts` moved to
  `@purin-labs/kitchen-control-api`. A codemod rewrote the import lines of 20 files.
  `@purin-labs/control-api` no longer depends on `@purin-labs/commerce-contracts`.
- **A1.7: the browser context is a contract.** `PageBrowserContext`, its binding and
  the two parsers are in `@purin-labs/contracts`: they name no Kitchen concept, and a
  turn of the Session carries them. `@purin-labs/bakery-model` keeps its names as
  aliases, so its other users did not change.
- **A1.7: the page state and the effect receipt are opaque.** They name Kitchen
  concepts, so the Session holds them as `unknown`. Kitchen parses them where it
  did before: `settleBakerySurfaceEffect` takes the receipt as the page sent it.
- **A1.7: two fields of a tool definition.** `modelOnly`: a Code Mode script does not
  get the tool. `structuredOutput`: the schema of the value that a script receives.
  The 38 Kitchen surface tools set the first, and `commerce_entity_context` sets the
  second. The Pi tools read them through `toolRules`, an input of the harness
  runtime, and `actors/pi-durable-tools.ts` names no tool. A result with a typed
  value is a `StructuredToolResult` (`agent-tools/structured-result.ts`). The model
  definitions do not hold the fields, so the catalog digests are equal.
- **A1.7: the Slack side Case is a port.** The wiring gives `slackThreadSideCase`:
  the instruction text and the admission of a side Case that a Slack thread
  started. No file of `actors/session/` imports a Slack file.
- **A1.9: the Inbox turns are a module.** The mailbox turn, the eval turn, the mail
  assistant turn and the WhatsApp turn were methods of the class layer
  `SessionTransientTurns`. They are functions of `actors/inbox-turns/` (area
  `inbox`). Each one takes a `SessionTransientHost`
  (`actors/session/transient-host.ts`). `actors/inbox-turns/rpc.ts` declares
  `SessionInboxTurnsRpc` with the request and reply types. The class `SessionDO`
  implements it: each RPC method calls one function of the module. The class layer
  is deleted, so the chain has 5 levels and not 6. The RPC method names, the
  argument shapes and the results did not change.
- **The schema steps.** `agent-session-schema.ts` already holds one ordered list:
  `createSessionExecutionSchema` calls the schema function of each part in a fixed
  order. This step did not change it, and no stored version changed.
- **Measures.** Layer crossings: 703 to 679. `foundation/agent` to Inbox: 27 to 11,
  and no Session file is among the 11. To Kitchen: 4 to 0. To commerce: 22 to 21. To
  Slack: 7 to 5. Copies: 890 to 889. Unused exports: 809, no change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (302 files) pass. 88 journey files ran in
  five groups: 87 pass and 1 is skipped. The full E2E suite did not run on the
  branch.
- **Still open: the rest of the class chain.** `SessionActorBase`,
  `SessionCheckpoints`, `SessionHarnessTurns`, `SessionTurnRecovery` and
  `SessionActor` are still one chain of 5,159 lines. They are all `foundation/agent`
  and import no area, so the layer count does not need the split. They share 9
  fields of the base (`canonicalTurn`, `checkpointPublication`,
  `startedCheckpointPayload`, `activeEmbeddedHarnessTurn`,
  `activeMessagePreparation`, `transientExecutions`, `liveGoalRuns` and the two
  Portal chat cleanup promises) and call each other through `this`. Each one needs
  its own landing with the actor journeys, the relocation journey and the idle
  tenant journey. Done on 2026-11-21: see "A1.9 — The class chains are
  modules".
- **Still open: 4 Slack imports and 1 Brain import.** `actors/harness-follow-up.ts`
  (3) posts the Slack card of a permission request and of a held effect through the
  Connector. It is Slack code with a foundation label: the exit check in
  `agent-tools/session-support.ts` calls it. `actors/harness-side-case-proposal.ts`
  (1) stores the Slack side Case proposal. `actors/harness-memory-proposal.ts` (1)
  calls `memory/access.ts`. Each needs a port through the tool effect and the turn
  tools.

**21 November 2026. The agent foundation: four changes and the measures for the
rest,** on the branch `refactor-17-agent-foundation`. This is a part of the work,
not the end of it.

- **A route matcher is a part of the Worker.** `control/routes/agents.ts` matches the
  paths under an agent and calls the route handler of each owner. It holds no rule,
  and only `control-router.ts` calls it. The map counts it as `workers/platform`.
- **Brain.** `actors/harness-memory-proposal.ts` defines `MemoryProposalPort`. The
  wiring gives the function of `memory/access.ts`.
- **Slack.** The Slack half of the side Case proposal is in
  `agent-tools/slack/side-case-proposal.ts`. The port `slackThreadSideCase` has
  `propose`.
- **Two helpers at their owner.** `emailAttachmentForHarness` is in the Inbox
  handlers. `context/untrusted-commerce-text.ts` is `foundation/agent-tools`: it has
  no import, and the tool files use it.
- **Measures.** Layer crossings: 674 to 658. `foundation/agent` to Inbox: 11 to 5. To
  commerce: 21 to 19. To Slack: 5 to 3. To Brain and to WhatsApp: 1 to 0 each.
  `foundation/agent-tools` to Inbox: 1 to 0. `foundation/agent-tools` to
  `foundation/agent`: 23 to 21.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite pass. The catalog digests are equal. 81
  journey files ran in five groups: 80 pass and 1 is skipped. The full E2E suite did
  not run on the branch.

**The order inside the foundation: measures for a decision.** Each line is one
choice, measured with `node scripts/check-layers.mjs --report` on a changed copy of
the map. The base is 660. No line is applied.

| Choice                                                              | Total | Effect                                                                               |
| ------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------ |
| `packages/control-api` is `foundation/contracts`                    |   642 | Order 126 to 108. One pair is renamed, so the lint needs `--init` for it             |
| The tool handlers are a module above `agent`                        |   652 | Order 126 to 118. `session-support.ts`, `context.ts`, `files/`, `messages/`, `turn/` |
| `actors/case-conversation-sink.ts` is `foundation/agent`            |   658 | Order 126 to 124. No pair grows                                                      |
| `chat/turn-access.ts` is `foundation/agent`                         |   658 | Order 126 to 122, table 117 to 119. `authority -> agent` grows                       |
| `conversation` goes below `agent` in the order                      |   678 | `conversation -> agent` has 48 imports, and `agent -> conversation` has 28           |
| `control` goes below `authority` in the order                       |   686 | Worse by 26                                                                          |
| `case-context-discovery/` is `foundation/authority`                 |   669 | Worse by 9                                                                           |
| `context/files/persistence.ts` is `foundation/authority`            |   686 | Table 117 to 143                                                                     |
| `actors/session-execution-admission.ts` is `foundation/agent-tools` |   661 | Worse by 1                                                                           |

The first two lines are the proposal. Together they give 658 to 633. The package `@purin-labs/control-api` imports
only `contracts`, `contract-schema`, `std` and `type-utils`: it is a contract, and 12
of the 18 order crossings that it gives are `authority` reading its shapes. The tool
files have two concerns: the executor (`catalog/`, `define-tool.ts`, `errors.ts`,
`tool-effect.ts`) is below the Session, and the handlers with their Session support
are above it.

- **Still open in part 1, with the reason.**
  - `agent-tools/session-support.ts`, 10 imports of commerce and Café. Kitchen and
    commerce handlers share its commerce helpers. A move to commerce gives Kitchen
    4 new imports of commerce. It needs the service interfaces of the commerce
    contract.
  - `actors/harness-follow-up.ts`, 3 imports of Slack texts. The exit check of a tool
    effect calls it 4 levels down, so the port needs a new argument in about 8 functions
    of `session-support.ts` and in 2 Plan 50 workers.
  - `context/assembly/commerce.ts` (5), `data/agent-operations*` and its routes (9),
    `cues/engine.ts` (2): commerce reads of the agent. As commerce files they give
    more crossings (660 to 665 or 668), because foundation files import them.
  - `actors/action-ledger.ts` (3) and the access grant files (4): the same result,
    660 to 665.
  - `access-control/decision-explanation.ts` (1) and `organisation-policy.ts` (4 Jev
    files, 3 files of the `OrganisationDO` class chain): step A1.8 and step A1.9 for
    the Organisation actor.
  - The route files of `control/` that call Slack, Brain, commerce and integrations
    (13). A route file with rules is not a part of the Worker, so no map change.

**21 November 2026. Step A1.9 for the Organisation actor, three parts, and the
custom connector read of step A1.8,** on the branch `refactor-17-a1-9-organisation`.
The Case context collection and the class chain stay open.

- **Rooms.** `actors/organisation-collaboration-rooms.ts` is deleted, and its `mixed`
  note is gone. `actors/collaboration-room-dispatch.ts` is the kernel of the room
  dispatch: the admission of the room, the placement check, the Organisation record,
  then the room. Each area gives its routes and its socket rooms from its own file:
  `actors/kitchen-`, `cafe-`, `commerce-` and `inbox-collaboration-rooms.ts`. The
  class `OrganisationDO` joins them and keeps the old order of the routes.
- **Jev settings.** `jev-features/organisation-settings.ts` holds the three Jev
  commands as functions that take an `OrganisationJevHost`, and it declares
  `OrganisationJevRpc`. `OrganisationDO` implements the interface. The policy file
  defines `PolicyJevPort` for the two Jev calls that stay inside policy commands:
  the repin of mail classification and the paid hold. The paid hold reads the clock
  one time and not two times.
- **A1.8.** `access-control/decision-explanation.ts` defines
  `CustomConnectorAccountRead`. The Worker router gives the read to the access
  control route (`AccessControlParts`), and the route gives it to the explanation.
- **Not changed:** no path, check, status code, error text, RPC method name,
  argument shape or stored value. No constructor changed.
- **Measures.** Layer crossings: 640 to 635. `foundation/authority` to integrations:
  5 to 0. Copies: 887 to 881. Unused exports: 808, no change. `organisation-policy.ts`:
  1,483 lines to 1,226.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite pass. 56 journey files ran in four groups,
  with the idle tenant journey: 55 pass and 1 is skipped. The full E2E suite did not
  run on the branch.
- **Still open: the Case context collection (5 imports of the Inbox).**
  `actors/organisation/case-context-collection.ts` and
  `case-context-discovery/source.ts` are the Gmail source of a collection: the
  mailbox binding, the contact verification and the message receipt. As Inbox files
  they give 635 to 631, but the policy class then imports them (2 new imports from
  `foundation/authority` to the Inbox), and one imports a helper of the Worker. The
  eight collection commands of `OrganisationPolicy` read the verified contact and its
  supplier target, so they are Inbox rules. They must leave the policy class as an
  Inbox module, as the Jev commands did: about 570 lines and 8 RPC methods.
- **Still open: the class chain.** `OrganisationActorBase`, `OrganisationPolicy`,
  `OrganisationCommerce` and `OrganisationDO` are still one chain. `OrganisationPolicy`
  still holds rules, so no level only composes yet. The schema steps are in
  `actors/organisation/schema.ts`: this step did not change them.

**21 November 2026. Step A1.10 for the commerce area: one area contract,** on the
branch `refactor-17-commerce-contract`.

- **The lint knows the public files.** `contracts` in `scripts/layers.json` lists
  the contract packages and now also public source files and folders. An import of
  a public file from another area is not a crossing. A public file must be honest:
  `lint:layers` refuses a value import of a file of its own area that is not
  public. `import type` is allowed. `--report` prints the imports between areas
  that go through a contract (181: 59 to public files, 122 to area packages).
- **The commerce contract.** `services/platform/src/commerce/contract/` holds the
  client factory of the commerce engine (`createCommerceClient`,
  `createCommerceEntityPlaneClient`, `pantryCommerceAccess`), the queue messages,
  the provider port with `commerceProjectionRevision`, the merchant control check,
  the Square and Stripe links, the merchant closure, the system readiness, the
  offer price allowance, the resource ids, the list entry commands, the sensitivity
  guard and `types.ts`. Each file needs only the foundation, the commerce packages
  and other public files, so its code is the entry point. Four Portal modules are
  public in place: the commerce graph requests (`entity-plane/api.ts`), the stock
  rule, the operations types and the action labels. Importers changed import lines
  only. Test mocks of the client factory follow it to `contract/client.ts`.
- **A wrong line in the map.** `apps/portal/src/features/content-studio/` is the
  Café Menus page: it uses the menu draft document and the Café control API. It is
  now in the area `cafe`.
- **Measures.** Layer crossings: 674 to 613. Between areas: 214 to 153. The six
  pairs into commerce: Kitchen 25 to 3, Café 13 to 1, integrations 12 to 1,
  organisation 8 to 0, Shopify 8 to 4, Inbox 7 to 5. Copies: 887, no change.
  Unused exports: 808, no change.
- **What stays, and why.** Each import needs the inside of commerce, so each needs
  a service interface that the Worker wires. No caller changed its function body.
  - Shopify (4): the delivery normalizers of `commerce-wasm.ts` and
    `applyCommerceDelivery` of the projection. Shopify is the second provider; the
    provider port needs a delivery entry that the commerce server gives.
  - Inbox (2 Platform): `mailbox-sender-links.ts` opens the commerce graph through
    `control/commerce-graph.ts`, and `supplier-context.ts` builds a graph reader.
    Both need a graph read service.
  - Kitchen (3): `production-plan-handlers.ts` parses a graph query and prepares a
    commerce read (a Kitchen tool service, A1.7), and
    `stock-shortage-report.ts` uses the report definitions of commerce.
  - Portal (4): the draft presence component of commerce is shared by the Café
    menu editor and the Inbox reply draft. It belongs in
    `features/collaboration/` with its styles. The integrations page shows the
    Stripe setup part of commerce.
- **Commerce imports back.** Commerce imports organisation (12), Kitchen (10),
  Café (7), Shopify (1), Inbox (1) and integrations (1). The contract imports no
  area, so the contracts have no cycle. The imports back are in the inside: the
  access prompts of the Portal, the activation steps of the Organisation actor, the
  stock and menu actions of the action model, the inventory check of the product
  routes and the provider list.

**21 November 2026. Steps A1.6 and A1.9 for the Case,** on the branch
`refactor-17-case-ports`. The Case actor, the chat records and the Projects name
fewer areas and surfaces.

- **The Worker shell.** `actors/case.ts` holds only the class `CaseDO`, and the map
  gives it to `workers/platform`. The Case actor is the abstract class `CaseActor`
  in `actors/case/case-actor.ts`. The Case modules and the area files name
  `CaseActor`, not `CaseDO`.
- **The parts.** `actors/case/parts.ts` defines `CaseParts`: the checks of the
  commerce values (`CaseCommercePart`), the Connector of a mailbox or a WhatsApp
  trigger (`CaseInboxPart`) and the resume of a Portal chat turn. `CaseDO` gives
  the parts. `CaseActor` gives them to the Case modules in its constructor, before
  it reads a stored value. Only the Case actor runs the parsers that read them.
- **Commerce.** The Case stores a commerce proposal and reads its envelope.
  `commerce/case-proposals.ts` checks the action, the authority and the source
  record, and it names the precise types of the body. The parser of a source
  record moved to `actors/case/source-provenance.ts`: only the Case imports it,
  and it parses a field of the Case content contract.
- **Inbox.** The email reply proposals and the mail work of a thread are functions
  of `actors/case-inbox/` (area `inbox`). `CaseInboxRpc` declares the RPC methods,
  and `CaseDO` implements them. `readConversationEmailReviews` moved to
  `mail-inbox/conversation-email-reviews.ts`.
- **Kitchen.** The Case forwards the page state as `TurnPageState`, as the Session
  holds it. The browser context is `PageBrowserContext` of `@purin-labs/contracts`.
- **Slack and the Worker.** The Case walk names `CaseConnectorRpc`, not the class
  `ConnectorDO`. The map gives `control/routes/chat-configuration-drafts.ts` to
  `surfaces/portal`: it is a Portal chat route, and only the Portal chat routes
  import it.
- **Portal.** `chat/input-admission.ts` is `foundation/conversation` in the map: it
  imports no Portal file, and only the Case imports it. The read of a canvas chat
  panel moved to `chat/workspace-canvas-read.ts` (`surfaces/portal`): it returns
  the Portal shape of the chat. `surfaceObservationField` moved to
  `chat/timeline.ts`.
- **Brain and integrations.** `readExecutionRecords` and `readExecutionContent`
  moved to `CaseDO`. The chat record names the shape of its documents
  (`ConversationDocument`).
- **Not changed:** the stored JSON, the key order of a proposal, the schema steps,
  the table names, the delivery ids, the RPC method names, the argument shapes and
  the error codes.
- **Measures.** Layer crossings: 674 to 634. `foundation/conversation` to commerce:
  12 to 1. To Inbox: 11 to 0. To Kitchen: 10 to 4. To Slack: 7 to 5. To Portal: 7
  to 2. To Brain: 2 to 1. To `workers/platform`: 2 to 0. To integrations and to
  organisation: 1 to 0 each. Copies: 887 to 886 (one copy in the Case actor is
  now one method). Unused exports: 808 to 807.
- **Still open.** Each line is an import that stays.
  - `actors/case-walking-path.ts` (Slack, 2): the Slack thread turn builds the
    stream input and its release. The port goes through
    `OngoingCaseWalkingConnector`, and its caller is
    `actors/connector/slack-channel.ts`.
  - `actors/case-conversation-sink.ts` (Slack, 1): the exit check asks if a Slack
    channel reaches people outside. The Session, the Connector and the Slack side
    Cases call it, so the port changes their calls.
  - `actors/case-output-hold.ts` (Slack, 1): it holds a Slack output and posts the
    Slack notice text. The Connector side of the walk and the commerce delivery
    call it.
  - `chat/side-case-origin.ts` (Slack, 1): it parses the Slack row of
    `side_case_proposal`. Its callers are Session files.
  - `chat/conversation.ts` and `chat/timeline.ts` (Kitchen 2, Portal 2): the chat
    record parser checks the Kitchen view of a message (an old tab attachment and
    the screen observation). The chat record has no actor that gives a part, and
    the parser runs in the routes, the store, the Case and 4 unit test files. A
    surface registry for the state check of each surface is the host.
  - `projects/references.ts` (Kitchen 1, commerce 1): the observation of a saved
    Kitchen run and of a commerce record. Six callers in the routes, the Project
    commands, the membership, the context and the chat directory need a registry
    of reference kinds that the Worker gives.
  - `actors/chat-signal-sockets.ts` (Kitchen 1): a chat signal reaches the
    workflow canvas pages. The port changes the call in `OrganisationDO`.
  - `actors/case-direct-processing.ts` (Brain 1): the empty Memory reader
    (`turnMemoryReaderWithoutSubjects`). It is a value of the port
    `TurnMemoryReader` in `context/assembly`, so it can move there.

**21 November 2026. Step A1.9 for the Organisation actor, the second part,** on the
branch `refactor-17-a1-9-organisation-2`. This entry replaces the two "Still open"
points of the entry above where it names them.

- **The Case context collection is an Inbox module.**
  `actors/organisation/case-context-collection-commands.ts` (area `inbox`) holds the
  eight collection commands as functions that take an `OrganisationCollectionHost`,
  and declares `OrganisationCaseContextCollectionRpc`. `case-context-collection.ts`
  and `case-context-discovery/source.ts` are the Gmail source of a collection, and
  the map counts them as `areas/inbox`. The discovery commands of the policy read
  the source through `PolicyCaseContextSourcePort`.
- **The policy level is a module.** The class `OrganisationPolicy` is gone.
  `organisation-policy.ts` holds the seven policy commands as functions that take
  an `OrganisationPolicyHost`, and declares `OrganisationPolicyRpc`. The chain has
  three levels: `OrganisationActorBase`, `OrganisationCommerce`, `OrganisationDO`.
  `OrganisationDO` implements three RPC interfaces: policy, Jev and collection.
- **The helper file.** `actors/organisation/support.ts` lost the helpers of other
  modules. `organisation-record.ts` (`foundation/tenancy`) holds the Organisation
  record read, its check and the placement conflict answer. Three copies of that
  answer are one.
- **A1.8, the access control routes.** `AccessControlParts` holds three reads of the
  integrations area: the custom connector account, the custom connector revision
  and the Airtable token. `control/access-control-parts.ts`, a Worker file, gives
  the value.
- **Not changed:** no RPC method name, argument shape, result, schema step, stored
  value or constructor.
- **Measures.** Layer crossings: 635 to 621. `foundation/agent` to Inbox: 5 to 1.
  `foundation/control` to integrations: 3 to 0. `foundation/authority` to the Worker:
  3 to 0. `foundation/authority` to `foundation/agent`: 14 to 11. Copies: 881, no
  change. Unused exports: 808, no change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages` and the
  unit suite pass. 64 journey files ran in four groups, with the idle tenant
  journey and the onboarding journeys: 63 pass and 1 is skipped. The full E2E suite
  did not run on the branch.
- **Still open: the commerce level and the base of the chain.**
  `OrganisationCommerce` has 2,048 lines and 50 RPC methods. 27 of them have the
  one form `this.command(...)` that a script can move. 23 have their own form.
  `OrganisationActorBase` (742 lines) holds the commands of Memory, Evals, screen
  relevance and the Shopify location, and `OrganisationDO` holds 2,302 lines. The
  class is not yet a list of modules. The schema steps are one ordered list in
  `actors/organisation/schema.ts`, and this step did not change it.
- **Still open: the commerce imports of the access control routes (5).** The access
  grant model of the foundation names types of the commerce contract. A port for
  the routes needs those types in `contracts` first.
- **Still open: 1 Inbox import.** `case-context-discovery/metadata.ts` reads the
  verification of a selection for a conversation.

**21 November 2026. The tool handlers are a module, and the handler support names
no commerce file,** on the branch `refactor-17-foundation-2`.

- **A new foundation module, `tool-handlers`.** The module `agent-tools` held two
  concerns. The executor is below the Session. The handlers and their support read
  the Session and the conversation, so `tool-handlers` is after `conversation` in
  `foundationOrder`. Its files: `agent-tools/session-support.ts`,
  `agent-tools/files/handlers.ts`, `actors/session/own-tool-services.ts` and the
  three `actors/harness-*` files of a follow-up, a Memory proposal and a side Case.
  `--init` ran one time for the pairs that the new name renames. No pair without
  the new name grew.
- **The Session imports no handler file.** `actors/session/turn-tool-offers.ts`
  holds the rules that say if a turn offers a tool by its origin. The wiring gives
  `ownServices`, `settleEffect`, `mayRequestPermission` and `requestPermission`.
- **A service interface of the commerce contract.**
  `commerce/contract/tool-reads.ts` declares `CommerceToolReads` with `import type`
  only. The commerce helpers left `session-support.ts` for
  `agent-tools/commerce/read-support.ts`. Commerce implements the interface, the
  Worker wiring gives it to Kitchen, and a Kitchen handler reads commerce through
  `context.commerce`. The `staff_page` effect of the foundation knows only the
  member of the page.
- **Two files at the module that they serve.** `organisation-policy.ts` and
  `actors/message-tools.ts` are `foundation/agent` in the map.
- **Measures.** Layer crossings: 520 to 477. Order crossings: 103 to 72.
  `foundation/agent-tools -> foundation/agent`: 21 to 3. `foundation/agent ->
foundation/conversation`: 28 to 22. `foundation/authority -> foundation/agent`: 11
  to 5. The handler support to commerce: 9 to 0. Kitchen to commerce: 3 to 1.
  Copies: 880 to 878. Unused exports: 807, no change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite pass. The catalog was not changed. 36
  journey files of the changed paths pass, in two groups. The full E2E suite did
  not run on the branch.
- **Still open: 32 imports of commerce from the foundation.**
  - `context/assembly/commerce.ts` (5) builds the commerce context of a turn from
    the graph. Commerce, Kitchen and the handler support import it. It is commerce
    code. It can go behind `CommerceToolReads`, with its error class in the
    foundation.
  - `data/agent-operations*` with its runner and routes (10) and `cues/engine.ts`
    (2) are the operations and the cues of the merchant agent. They write eight
    agent tables that the foundation owns. As commerce files they give more crossings: 16 more for the
    operations and 8 more for the cues, measured.
  - `actors/action-ledger.ts` (3), the access grant files (4) and the two access
    control routes (5): the access grant model names the entity types and the graph
    query of the commerce contract. Those types must go to `contracts`, or the
    grant target must hold an opaque commerce part.
  - `control/routes/sessions.ts` (1), `control/agent-operation-activity.ts` (1) and
    `control/routes/agents/operations.ts` (1).
- **Still open: the order pairs.** `foundation/agent -> foundation/conversation`
  (22): `chat/turn-access.ts` (the access of a Session turn) is read by 4 agent
  files, and the Case context discovery reads the chat store. `foundation/tool-handlers
-> surfaces/slack` (3): the Slack notices of a permission request and of a held
  effect.

**21 November 2026. Step A1.10 for the other areas: area contracts,** on the
branch `refactor-17-area-contracts-2`. Each area got a contract, one at a time.

- **Integrations.** `services/platform/src/integrations/contract/` holds the
  provider adapter interface, the provider lifecycle types, the provisioning and
  credential cutover steps, the provider revocation, the credential rotation
  lifecycle, the Jev draft command, the provider ingress origin, the observation
  evidence and the Google token revocation. Eight Portal modules are public in
  place: the provider catalogue, the provider onboarding, the Jev requests and
  paid use, the custom connector requests and three dialogs.
- **Inbox.** `services/platform/src/mail-inbox/contract/` holds the Gmail
  Connector ids, the mail source authorization, the two inference eligibility
  checks and the control authority of a member request. Five Portal modules are
  public: the mailbox, WhatsApp and email review requests, the email review panel
  and the mailbox setup folder.
- **Organisation.** `services/platform/src/organisation/contract/` holds the
  activation types, the activation acceptance fault and the provider support
  references. Seven Portal modules are public: the access requests, the
  permission parts, the agent console parts and the account invitation link.
- **Kitchen.** `services/platform/src/kitchen/contract/` holds the stock action
  of Plan 81 (its record, plan and run), the inventory overview and the
  inventory request checks. The services type of the Kitchen tools and the
  Portal bakery browser context are public in place.
- **Café.** `services/platform/src/cafe/contract/` holds the menu publication,
  the board media library, the order queue commands and the two menu request
  errors.
- **Brain and devices.** `memory/contract/turn-memory.ts` holds the empty turn
  Memory reader and the shown revision type. `devices/contract/fleet-stub.ts`
  holds the stub helpers of the device fleet. The Brain and Case execution
  requests and the Brain address are public in the Portal.
- **Wrong lines in the map.** The onboarding reconciliation runner is a Worker
  file. The Portal WhatsApp setup is an integrations page. The stock shortage
  report is a commerce report. The mailbox turn Memory reader is an Inbox file,
  and it moved to `mail-inbox/`.
- **The rule for a public file.** Each public file imports only the foundation,
  the contract packages and other public files. A function moved out of an
  inside file with its body unchanged. A file that needs the inside of its area
  stayed inside: `memory/access.ts` restores the branded revisions of the store,
  so it is not public.
- **Measures.** Layer crossings: 520 to 422. Between areas: 153 to 58.
  Integrations to Inbox 25 to 5. Organisation to integrations 14 to 2. Commerce
  to organisation 12 to 3. Inbox to Brain 10 to 7. Brain to Inbox 10 to 6.
  Commerce to Kitchen 10 to 0. Shopify to integrations 9 to 0. Inbox to
  integrations 7 to 0. Commerce to Café 7 to 1. Copies: 880, no change. Unused
  exports: 807 to 805.
- **Still open.** Each import below needs the inside of the other area, so it
  needs a service interface that the Worker wires, or a later step.
  - Inbox and Brain (13): the Inbox reads and proposes Memory and Evals through
    `memory/access.ts` and `evals/access.ts`. The Eval run of an email case
    (`eval-task-processing.ts`) runs the Inbox email case processing. Evals
    read the verified contacts.
  - Integrations to Inbox (5): the Gmail and WhatsApp connection workflows
    register the mailbox and the phone number in the Inbox stores, and two
    routes tear down the mailbox agent. A registration port in the integrations
    contract is the host.
  - Shopify (9): the provider catalogue lists the Shopify adapter (4), Shopify
    reads the commerce projection (4), and commerce lists the Shopify provider
    (1). This is step A2.5.
  - Organisation (14): the commerce level of the Organisation actor runs the
    activation steps (2), and the commerce actions route builds the onboarding
    projection (1). The account removal, the archive cleanup and the operators
    route erase or read Inbox and device records (5). The configuration draft runs
    device commands and Kitchen workflow changes, and the Kitchen route
    confirms the draft (3). The onboarding route and the account removal use
    the provider catalogue, and the integrations route calls the account
    removal (3). The account removal belongs to integrations by its content,
    but a move adds its table writes to the integrations pairs.
  - Devices and Café (4): the device fleet actor composes the Café terminal
    collection module (step A1.9), and the devices route reads the menu screens.
  - Into commerce (Inbox 5, Kitchen 2, Café 1, integrations 1) and from
    commerce to Café (1): the draft presence component, the commerce graph
    reads, the production plan reads, the Stripe setup part and the counter
    register.
  - Kitchen to Inbox (1) and Café to Kitchen (1): the supplier creation
    registers the supplier email contact, and the Register view tool reads the
    bakery surface receipt.
  - The package `bakery-model` depends on `commerce-client` (1). Step A1.11
    owns it.

**21 November 2026. Only the owner of a table writes it: 92 of 117 writes moved,** on
the branch `refactor-17-table-owners`.

- **The method.** A writer in a higher module calls a statement builder of the owner
  and puts the statement into its own batch, at the same place. 19 owner files hold
  the builders. 6 of them are new: `integration-account-writes.ts`,
  `provider-connection-writes.ts`, `surface-installation-writes.ts`,
  `onboarding-reconciliation-run.ts`, `agent-operations/export-coordinator-rows.ts`
  and `cues/cue-log.ts`.
- **The proof of the SQL.** A script compared each SQL write text of the Platform and
  the Portal before and after the change: 1,334 texts, each one the same. Each bind
  list keeps its order.
- **A lower writer with an import that exists.** Four lower files already imported a
  file of the owner: the Slack install of `data/organisation.ts` (tenancy) imports
  `data/integration-account.ts`, the grant code of `authority` imports
  `context/files/persistence.ts`, the membership revocation imports
  `projects/case-project.ts`, and the archive reconciliation imports
  `voice/store.ts`. Their statements moved into that file, so no import was added.
  The import crossing stays in the ratchet, and the port of that crossing removes it.
- **One wrong owner in the map.** Only the Slack revocation webhook writes
  `slack_installation_lifecycle_event`, and no code reads it. Its owner is
  `surfaces/slack`, beside `slack_installation`.
- **Cleanup.** Seven local helpers that held one statement are gone, and a re-export of
  `ACTIVE_PLACEMENT` with no other user.
- **What stays (25), and why.**
  - The purge (8): `data/organisation-purge.ts` pseudonymizes the account, the
    connection and the credential generation rows, and erases two Slack rows. The
    purge catalogue is the hook: tenancy erases or rewrites each regional table by
    design, and `pnpm lint:purge-catalogue` checks each entry.
  - The archive (4): `data/organisation-lifecycle.ts` disables the accounts, the
    connections and the webhooks, and removes the Project members, in its fenced
    batch. Tenancy imports no file of `connections` or `conversation` there. The
    hook is an archive part that the Worker gives, and 3 source files and 12 test
    files call the archive directly. It belongs with the port of the Organisation
    lifecycle.
  - Other lower writers with no import of the owner (11): `control-plane.ts` writes
    the workspace rows of `agent` (2) and the readiness of `organisation` (2);
    `service-membership.ts` writes an invitation role of `organisation`; the Slack
    credential of the Vault writes `slack_installation` (2); and
    `integration-account.ts` and `provider-attempt.ts` (`connections`) write
    `credential_ref`, the communication destination and the support reference.
    Each needs a hook, or the file is in the wrong module.
  - Between two areas (2): the account removal of `organisation` writes the cleanup
    row of `integrations` and the contact verification of `inbox`. A call needs a
    public file of that area, and this step changed no contract.
  - A false match (1): the lint reads the Portal error text "Could not update
    project access." as a write of `project`. The text stays.
- **Measures.** Layer crossings: 520 to 428. Table writes: 117 to 25. Upward, between
  areas and against the order: no change (147, 153, 103). Copies: 880, no change.
  Unused exports: 807, no change. Lines: 1,531 removed and 2,966 added; a builder
  names each of its values.
- **Not changed:** no SQL text, no bind order, no batch order, no D1 baseline, no
  wire value.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files) pass. The 28 journey files of
  the brief pass in four groups, with the idle tenant journey: 76 tests. 7 more
  journey files for the side Cases, the member removal, the custom connector, the
  voice Macs and the cue claim pass: 11 tests. `wrangler deploy --dry-run` passes
  for the six Workers. The full E2E suite did not run on the branch.

### A2.1 — One decision API (2026-11-21)

The six parts of the step are done. Three items stay open for the owner or for a later
step; they are at the end of this entry.

- **The record.** [Appendix E](#appendix-e--the-decisions-that-wait-for-a-person-before-step-a21)
  gives each kind: its store, who reads it, who decides, what happens, and what a
  person sees in the Portal and in Slack.
- **The one read.** `GET /v1/control/organisations/{id}/decisions` gives the
  decisions that wait for the reader. `PendingDecision` in
  `@purin-labs/control-api` is the union: `governed_action`, `held_output`,
  `permission_request` and `email_review`. `listPendingDecisions`
  (`control/pending-decisions.ts`) reads each store one time with the read of its
  page, copies no record and writes nothing. A Case approval wait is the Case's view
  of a ledger action, so that action is one entry. No route changed its answer.
- **The one decide call.** `decidePendingDecision`
  (`control/decide-pending-decision.ts`) takes a `PendingDecisionCall`: the kind,
  the id of the entry in the one read, and the answer `allow` or `refuse`. It gives
  the call to the store that owns the decision. The nine decide routes call it: the
  held output, the permission request, the approval and the rejection of a commerce
  action, the approval of a custom connector write, and the approve and reject
  actions of a Gmail reply and of an operational email.
- **Each store keeps its checks.** The code of each store did not change: the role,
  the step-up grant, the mutation boundary, the challenge of an email proposal, the
  receipt and the effect. Each route answers with the same status and body, and it
  makes its checks in the same order.
- **The proof is the request.** The call carries the request as the proof of the
  person, because the step-up grant, the mutation boundary and the challenge are in
  it. The stores still answer with a `Response`.
- **The one Portal component.** `DecisionButtons` (`apps/portal/src/ui/decision-buttons.tsx`)
  shows allow and refuse, and owns the second question of a refusal. Six places use
  it: the chat card and the status band of a governed action, the review of a custom
  connector write, the two email reviews of the mailbox page and the Inbox
  conversation. Each place gives its labels and classes as props, so each place
  keeps its look. A temporary check rendered the old and the new markup of the six
  places: they are equal. The held output and the permission request stay on
  `PermissionRequestDialog`, and the chat email draft stays on `DraftMessageCard`.
  Each of the two was one shared component before the step.
- **The one Slack card builder.** `decisionCardBlocks` (`slack/decision-card.ts`)
  builds the section and the actions block from a list of buttons: a link to the
  Portal, or an answer with an optional confirm. The commerce approval card, the
  permission request card and the notice card use it. A temporary check serialised
  14 cards before and after: the 7,905 bytes are equal. The check is deleted. The
  email review notice is plain text and did not change.
- **The journey of a refused Gmail reply.** `mail-reply-shared-draft.test.ts` has a
  third journey: a viewer may not reject, a rejection with a reason is refused, an
  administrator rejects, Gmail loses the draft, the shared draft ends, a late
  approval sends nothing, and the reply leaves the one read.
- **Layers and ratchets.** `control/pending-decisions.ts` and
  `control/decide-pending-decision.ts` are `foundation/control` and name no area.
  The Worker file `control/pending-decision-parts.ts` gives the readers and the
  stores. Layer crossings: 477, no change. Copies: 878 to 877. Unused exports: 807,
  no change.
- **Decided on 2026-11-22: two looks of one kind** and **a custom connector write
  has no refusal.** See [the decisions](#a21-the-decisions-2026-11-22).
- **Open for a later step: Slack and a `Result` for each store.** The Deny of a
  permission request (`slack/permission-request-deny.ts`) and the buttons of a
  commerce action (`slack/commerce-approval.ts`) prove the person through a verified
  Slack link, not through a Portal session, and they call the stores directly. To
  send them through the one call, each store must first return a `Result` and take
  the proof as a value. That change moves the checks of four route files, so it is
  not a change with no risk for behavior. It is not done.
- **Found, not changed.** An approval of a Gmail reply after its rejection answers
  with status 502 and `email_reply_edit_unavailable`. Nothing is sent. A status 409
  fits better, but the step changes no answer.

### A2.1: the decisions (2026-11-22)

The owner asked to finish the tail ("proceed and finish them off"), so these
decisions use the recommendations of the proposal. Each kind of decision has one
look in every place.

1. **Reject a governed action.** The chat card, the status band of a page and the
   review of a custom connector write show "Reject", then "Reject change" or "Keep
   proposal". The second question waits for the person: the 5-second reset of the
   status band is gone, and so is the `resetAfterMs` option.
   `governedActionRefusal` and `GOVERNED_ACTION_ALLOW` hold the labels, in the
   public file `features/governed-actions/decision-labels.ts` of the commerce area.
   The custom connector review of the integrations area imports that file.
2. **Approve a custom connector write.** It approves as a commerce action does:
   "Approve and apply" opens the step-up sign-in in a small window, approves and
   runs the write in one click. A browser that blocks the window signs in on the
   page, and the page applies the write when it comes back. A signed write shows
   "Apply change". Before, the sign-in took the whole page, and "Run approved action"
   was a second click.
3. **Refuse a custom connector write.** `POST …/custom-connectors/{c}/actions/{nonce}/rejection`
   with `{ "reason": "merchant_declined" }` goes through the one decide call
   (`answer: "refuse"`) to the reject of the action ledger, as for a commerce action.
   An owner or admin refuses, with no step-up sign-in, because a refusal changes
   nothing outside Pantry. A viewer gets 404 `organisation_role_insufficient`. The
   journey is in `remote-mcp.test.ts`: the write leaves the one read of the
   decisions, a later run gets 409, and the remote service never sees the write.
   The agent gets no tool for it: the agent proposed the write, and the person
   decides on it.
4. **A permission request in a chat.** Both prompts say "Sous Chef would like to …"
   and "This will allow Sous Chef to:". The rename of Plan 91 made the two texts
   one; a stored request lists its grants, and a missing capability lists the
   capabilities.
5. **An email reply.** The mailbox page, the Inbox conversation and the chat draft
   card show "Approve and send", "Edit" and "Reject"
   (`EMAIL_REPLY_DECISION` in the public file `features/email-review/decision-labels.ts`
   of the inbox area). The chat card said "Send" and
   "Discard". `DraftMessageCard` puts Edit between the send and the discard for
   every draft, as `DecisionButtons` does. The mailbox page has no editor of its
   own: there the draft is in Gmail, and "Open in Gmail" edits it.
6. **Slack.** Slack keeps its rule: a Slack button decides only where the verified
   Slack link proves the person. A commerce action that moves no money has Approve
   and Decline, a permission request has Deny, and the others link to the Portal.

Checks: the refusal journey and the 21 other journeys of `remote-mcp`,
`slack-commerce-approval` and `mail-reply-shared-draft` pass. A browser check on
the preview pages showed the custom connector review ("Approve and apply", "Reject",
then the confirm; the reject request and the order sign-in, then approval), the
chat drafts and the commerce chat card (the confirm still waits after 6 seconds).
`scripts/plan21/browser-acceptance.mjs` selects "Reject", then "Reject change".

The labels first lived in `ui/decision-buttons.tsx`, so the foundation held the
words of two areas. Each set of labels now lives in the area that owns the
decision, as a public file of that area, and `DecisionButtons` knows no label.
A public file may import a public file of its own area, so the mailbox page
(`email-review/review.tsx`, public) can import the email labels.

A review of this work (2026-11-22) found these faults, and they are corrected:

- **The one read of the decisions showed a viewer every waiting write of a custom
  connector,** with its nonce and Case, also for the Case of another member. Each entry
  now follows the rule of its own read: a commerce action shows as on the Operations
  page, and a custom connector write shows only to an owner or an admin, who decide it.
- **The commerce approval, rejection and execution routes took the nonce of a custom
  connector write.** A rejection moved the write to `rejected` and then failed; an
  approval signed it with no check of its definition or preview. The commerce routes
  now read the ledger through one check that answers 404 `commerce_action_not_found`
  for any entry that is not a commerce action, before any write. The journey of
  `remote-mcp.test.ts` proves both faults: a viewer's list has no write, an admin's
  list has it, the three routes answer 404, and the write still waits.
- **A ledger that did not answer gave an empty list,** so it looked as if nothing
  waited. The read now answers 503 `pending_decisions_unavailable`, as the Operations
  read does.
- **The review of a custom connector write:** "Approve and apply" is busy before the
  sign-in window opens, so a second click starts no second flow. A write with no
  preview disables only the allow button, so "Reject" works. The approval that waits
  for a sign-in on the page holds its time and is ignored after 10 minutes, the limit
  of a commerce approval, so a later page load does not approve and apply it.

**21 November 2026. The crossings that start in an area: 124 to 62,** on the branch
`refactor-17-areas-rest`. The work list was each pair whose source is an area, a
surface or a package.

- **Placements with evidence.** A file moved in the map only when its imports and
  its importers showed its module:
  - `actors/connector-email.ts`, `actors/connector-email-proposal.ts` and
    `actors/connector-whatsapp.ts` hold the agent state of a mailbox and a WhatsApp
    number: drafts, reply turns, budgets and handoff. They import no surface
    file, so they are `areas/inbox`. `actors/eval-task-processing.ts` is a mailbox
    reply turn by its own comment, and it is `areas/inbox` too.
  - `actors/actor-relocation-mail.ts` reads mail receipts, and only the email level
    of the Connector and the relocation admin route import it: `surfaces/email`.
    `actors/whatsapp-operator-notice.ts` posts to a Slack channel, and only the
    WhatsApp RPC file imports it: `surfaces/slack`.
  - The WhatsApp identifiers, the application configuration and the Graph client
    import nothing above the kernel: `foundation/connections`.
  - `slack/card-only-reply.ts` imports nothing: `foundation/tool-handlers`.
  - In the Portal, the console tools context and the reasoning effort labels are
    `foundation/ui`, and the approval sign-in window is `foundation/control`.
    `features/integrations/settings-transport.ts` holds the route transports that
    the Portal wiring gives two pages: `surfaces/portal`.
- **Public files.** `mail/gmail-oauth.ts` (integrations) and `evals/scorer.ts`
  (Brain) import only the foundation and packages. New public files:
  `evals/contract/eval-task.ts`, `commerce/contract/observation-identity.ts`,
  `integrations/contract/admin-integration.ts`,
  `integrations/contract/provider-account-cleanup.ts`,
  `mail-inbox/contract/account-erasure.ts` and `devices/contract/alert-delivery.ts`.
  Each function moved with its body. The SQL texts and the bind order are the same.
- **Ports.**
  - The Connector class chain is `ConnectorDO`, `ConnectorEmail`,
    `ConnectorWhatsApp`, `ConnectorEvals`, `ConnectorActorBase`. The Eval level asks
    the mailbox level two abstract methods: if the agent is active, and to run one
    task. It passes the Brain services of the task (`EvalTaskServices`). The email
    schema gets the Eval schema step as an argument, in the same place.
  - `ArchiveCleanupParts` gives the archive cleanup and the purge of an
    Organisation the steps of the voice Macs, Slack, the devices and the WhatsApp
    Connectors. The Worker file `archive-cleanup-parts.ts` gives them, and each
    part names its function when it runs.
  - The store of the running chat request is in `features/collaboration`: the
    chat sets it, and the Café board reads it.
- **Moves and merges.** The draft presence component and its styles are in
  `features/collaboration/`, with the pointer names of
  `@purin-labs/collaboration`. The WhatsApp and the mailbox Connector handles are
  one helper. The strict read of the Organisation environment uses the read of
  `control/organisation-runtime.ts`, so the gateway copy of that query is gone.
  The workspace switcher owns the types of its choices.
- **Not changed:** no stored value, SQL text, route, message text, delivery id,
  RPC method name, schema step or schedule.
- **Measures.** In scope: 124 to 62. Layer crossings: 287 to 222 (upward 134 to
  84, between areas 56 to 44, order 72 to 71, table writes 25 to 23). Three
  foundation pairs went down as a result:
  `foundation/tool-handlers -> surfaces/slack` 3 to 2,
  `foundation/actor-runtime -> surfaces/email` 2 to 1 and
  `foundation/actor-runtime -> foundation/connections` 1 to 0. Copies: 878 to 877.
  Unused exports: 805, no change. Plain D1 handles: 66 to 62.
- **What stays (62), and what removes it.**
  - Inbox to Brain (7): the Inbox reads and proposes Memory and Evals through
    `memory/access.ts` and `evals/access.ts`, which restore branded revisions. A
    Memory service interface in `memory/contract/` that the Worker gives the
    Connector and the Inbox routes removes them.
  - Integrations to Inbox (5): the Gmail and WhatsApp connection workflows register
    the mailbox, the sender and the phone number, and two routes tear down the
    mailbox agent. A registration port of the integrations contract, given to the
    integrations router and the provider workflows, removes them.
  - Shopify (9): step A2.5 owns them.
  - Devices to Café (4): the device fleet actor composes the Café terminal module
    (step A1.9), and the devices route reads the terminal operations and the menu
    screens (a Café read interface).
  - Integrations to Slack (4) and Organisation to Slack (1): the Slack routes, the
    Slack connection workflow and the account removal use the Slack installation
    store. The store needs one owner below them, with a port for its Vault calls.
  - Commerce to Slack (3): the commerce action builds the text of its Slack card,
    and the commerce actions route binds a Slack setup channel. The action can give
    typed facts, and the Slack surface can build the text.
  - Commerce to organisation (3) and to the Worker (1): the commerce level of the
    Organisation actor runs the activation steps and extends
    `OrganisationActorBase` (step A1.9). The commerce actions route builds the
    onboarding projection.
  - Inbox to commerce (3): the sender links and the supplier context read the
    commerce graph. A graph read service of the commerce contract removes them.
  - Portal (5): the Café prompt edit reads and sends the Portal chat (a chat port
    that the shell gives), two Organisation pages render in `PortalFrame`, and the
    integrations page shows the Stripe setup part.
  - Devices to voice (2): the shop Mac devices read the voice Mac store.
  - Organisation to integrations (2): the onboarding route reconciles provider
    observations, and the account removal reads the provider cleanup context. The
    route can give that reader as an input; six unit test calls change with it.
  - One each: Brain to Inbox (the verified contacts of an Eval), Brain to Slack (the
    members of a Slack channel for a Memory reader), Inbox to WhatsApp (the send
    ladder store), commerce to Café (the counter sale view), Café to Kitchen (the
    bakery surface receipt), Kitchen to Inbox (the supplier email contact), Kitchen
    to organisation (the configuration draft), integrations to organisation (the
    account removal), organisation to Inbox (the Gmail pilot budget), organisation
    to devices and to Kitchen (the configuration draft runs a device command and a
    workflow change).
  - Packages (2): step A1.11 owns them.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files, 1,730 tests) pass. The 106
  journey files whose names hold a word of the brief ran in nine groups: 105 pass
  and 1 is skipped (208 tests pass, 3 are skipped). `wrangler deploy --dry-run` and
  the full E2E suite did not run on the branch.

**21 November 2026. The foundation crossings: ports, hooks and true modules,** on
the branch `refactor-17-foundation-rest`. The work list was each pair whose source
is a foundation module.

- **The Session reads the conversation through a port.** The wiring gives
  `conversation` (`actors/session/conversation-port.ts`): the fork history, the
  side Case and the flow checks of the conversation. `chat/session-conversation.ts`
  implements it. A side Case is a value with its instruction and its admission.
  Slack gives the parser of its own proposals, so `chat/` imports no Slack file for
  it. The access check of a Session turn is a hook that the Session class
  registers (`actors/session-turn-access.ts`), because the Code Mode and
  admission functions outside the class call it. The sink refusal type and
  `sinkRefusalAsksPerson` are in `policy/information-flow/sinks.ts`.
- **The census list is a part of the Worker.** `actors/actor-machines.ts` holds the
  list of the machines in the order of before. The census takes it as an argument,
  and the Case and the Session ask the Worker's class for it.
- **Routes get parts from the router.** The Case context route gets the Inbox
  check of a selection and the Portal screen observation route. The session
  routes get the support role read of the Organisation area.
- **Types and values at their owner.** The ids of the two Actor moves and the
  policy placement check are in `data/organisation-placement.ts`. The Vault handle
  is in `ids.ts`. `TypeSafeAuthority` is in the flow label types. The Code Mode
  host types and the file tool result types are in `agent-tools/catalog/types.ts`.
  The empty Memory reader is in `context/assembly`. The model route error map is in
  `models/route.ts`. The action nonce check is in `approval-authentication.ts`.
  The label of a native chat source gets the access checks of the conversation
  with its input. A re-export keeps each old import.
- **Two splits.** The mail receipt of a frozen relocation moved into
  `actors/actor-relocation-mail.ts`, which is `surfaces/email`. The commerce
  receipt of a frozen Organisation is `actors/organisation-relocation-receipt.ts`
  (`areas/commerce`).
- **True modules, with evidence.** Each file below imports nothing of its old
  module that the new one cannot import, and its users are at or above the new
  module. `case-goals.ts`, `fork-history.ts`, `execution-billing.ts`,
  `organisation-runtime.ts`, `organisation-inference-selection.ts` and
  `jev-features/paid-use.ts` are `foundation/agent`. `attachment-collection.ts`,
  the Case command route, the Case context route and its metadata read, and
  `action-mutation-execution.ts` are `foundation/conversation`.
  `organisation-archive-cleanup.ts` and `organisation-regional-copy.ts` are
  `foundation/actor-runtime`. `case-operations.ts` is `foundation/authority`.
  `database-handles.ts` is `foundation/kernel`, and `boundary.ts` is
  `foundation/contracts`. `account-platform/onboarding.ts` is
  `areas/organisation`. `data/identity-link.ts` is `surfaces/slack`. Five tables
  follow their only writer.
- **Not changed:** no path, status code, error text, RPC method name, argument
  shape, stored value, SQL text, schema step, tool definition or digest. The
  `foundationOrder` did not change.
- **Measures.** Layer crossings: 287 to 218. From the foundation: upward 68 to 51,
  against the order 72 to 20, table writes 22 (no change). Copies: 878, no change.
  Unused exports: 805, no change. Plain D1 handles: 63, no change; one count moved
  with the policy placement check.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files) pass. The 79 journey files of
  the brief ran in four groups: 78 pass and 1 is skipped (144 tests pass, 2 are
  skipped). `wrangler deploy --dry-run` passes for the six Workers. The full E2E
  suite did not run on the branch.
- **Still open, with what removes it.**
  - Commerce (31). The agent operations (`data/agent-operations*`, the runner, the
    operations route and activity, 12) and the cue engine (2) name commerce kinds
    in the responsibility scope and the cue events. The scope needs an opaque
    commerce part that a commerce parser checks at the input and the row read.
    `context/assembly/commerce.ts` (5) is commerce code that Kitchen and the Inbox
    import; it goes behind `CommerceToolReads`. The action ledger (3), the grant
    compiler, the grants store and the entity type reads (4) and the two access
    control routes (5) need an opaque commerce part of the grant target.
  - The tenancy lifecycle (8 imports, 22 table writes). The Organisation creation,
    the membership, the archive and the purge write rows of `connections`,
    `authority`, `agent`, `conversation`, `organisation` and Slack in their own
    batch. One lifecycle port with the statement builders of each owner removes
    them. Its callers are the routes, the reconciliation and the unit and journey
    files that call these functions, so it needs its own landing.
  - The Case and the chat record (Slack 4, Kitchen 4, Portal 2, commerce 1): the
    Case walk builds the Slack stream input, the output hold posts the Slack
    notice, the sink asks Slack if a channel reaches outside, the chat parser checks
    the Kitchen view of a message, and the Project references read a saved run.
    Each needs a registry of the surface or the reference kind.
  - The tool handlers to Slack (3): the follow-up posts the Slack card of a
    permission request and a held effect.
  - The routes of the approvals (Slack 2, Brain 1, conversation 1): step A2.1 owns
    `agent-permission-requests.ts` and `held-output-requests.ts`.
  - Single imports: the file grant statements of the grant code (2), the commerce
    grant read of the entity type reads in `context/assembly`, the Case snapshot
    type of `case-operations.ts`, the native chat audience of the context assembly,
    the agent operation runner (2), the operations snapshot of the activity and the
    files module of the access control mutations (2), the onboarding projection of a
    configuration answer, the support references of the integration account, the
    default agent id of the room presence, the collaboration ping of the socket
    host and `UserId` of `control-api` in `ids.ts`.

**21 November 2026. The lifecycle port of an Organisation: table writes 23 to 4,**
on the branch `refactor-17-lifecycle-port`.

- **The port.** `data/organisation-lifecycle-port.ts` (tenancy) has one part type
  for each lifecycle step: creation, membership, archive and purge. A part gives
  the prepared statements of the owner's tables for one place in one batch.
  Tenancy puts them at that place, so each batch keeps the same statements in
  the same order, with the same bind values. One D1 batch stays one D1 batch.
- **The Worker gives the parts.** `organisation-lifecycle-parts.ts` (Worker) maps
  each part to a builder in the owner module. `integration-gateway.ts` gives them
  when the Worker loads, before a request or an Actor runs. A read before that
  throws. Each part names its function when it runs, as the archive cleanup parts
  do, so a test that mocks an owner module still loads. The E2E setup and the unit
  files that call a lifecycle function import
  `tests/provide-organisation-lifecycle-parts.ts`. A global unit setup file broke
  four mocked test files, so the import is in each file.
- **Creation.** The bootstrap and the surface install get the workspace rows
  (agent), the base Project (conversation), the access defaults and the replaced
  token revocation (authority) and the connection rows (connections). The surface
  provider helpers moved to `data/integration-account.ts`.
- **Membership.** The role change, the member removal and the invitation
  acceptance get the Project rows (conversation), the readiness deletion and the
  invitation acceptance (organisation). One builder in `data/onboarding.ts`
  replaces three equal readiness deletions.
- **Archive.** The archive gets the disable of the accounts, the connections and
  the webhooks (connections). The delete of an archived Organisation gets the
  removal of the Project members (conversation). The restore writes only tenancy
  tables.
- **Purge.** The purge gets the rewrites of the three pseudonymized connection
  tables (connections) and the directory's Slack records (Slack). The release of
  the shared Slack bot token gets the revoke and the move of the installation
  (Slack). The purge context and its guarded statement are in the port. The
  catalogue order still sets the batch order, and `pnpm lint:purge-catalogue`
  passes.
- **Not changed:** no SQL text at run time, bind order, batch order, table, D1
  baseline, route, status code or error text. A scan of each write literal found
  two changes in source text only: the three equal readiness deletions are one,
  and four archive statements read the guard as `${input.guard.sql}`, which is the
  accepted mutation check of before.
- **Measures.** Layer crossings: 155 to 128. Table writes 23 to 4, against the
  order 20 to 12, upward 68 and between areas 44 (no change). Ratchet pairs: 69
  to 54. Copies: 876, no change. Unused exports: 805, no change.
- **What stays (4).** Three writes are in connection flows, not in a lifecycle
  batch: `data/integration-account.ts` writes `credential_ref` (authority) in a
  reconnect and `organisation_communication_destination` (organisation) in a
  default account change, and `data/provider-attempt.ts` writes
  `onboarding_support_reference` (organisation). `connections` is below both
  owners, so each needs a port of the connection flows. The fourth is the false
  match of an error text in `apps/portal/src/features/chat/project-sharing.tsx`.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files) pass. The journey files of
  the brief ran in groups after each step and on the final tree. The full E2E
  suite did not run on the branch.

**21 November 2026. The last ports: layer crossings 155 to 74,** on the branch
`refactor-17-ports-rest`. This entry replaces the "Still open" lists of the two
entries above where it names a crossing.

- **One port pattern.** `port.ts` (`foundation/kernel`) defines `definePort`: a
  lower module defines a port and reads it at the call, and `worker-ports.ts`
  (`workers/platform`) registers each implementation once, when the Worker entry
  loads. A read before the registration throws, because it is a programmer error.
  The Session turn access check, the one registration of this kind before, uses
  it. The E2E setup loads the registration. A unit test file that reaches a port
  loads it too (17 files); a global setup file would load the modules before the
  mocks of a test.
- **Commerce in the foundation (33 to 0).** The commerce context read is commerce
  code (`commerce/entity-plane/context-read.ts`), and its error class is in the
  commerce contract. The commerce parts of the grant compiler and the parsers of
  the commerce parts of a grant target are commerce files. The foundation asks
  commerce through ports: the grant selection, the grant targets, the access
  targets of the access-control routes, the action ledger rules, the
  responsibility scope parts of the agent operations and the commerce exceptions
  of the activity read, and the observation parser of the cue engine. The id of
  Sous Chef's agent definition is `data/merchant-agent-ids.ts`
  (`foundation/agent`). `commerce-type-parts.ts` (`foundation/kernel`) holds the
  interface `CommerceTypeParts`: the commerce types that foundation records carry
  (the ledger effect, the scope references and query, the cue selectors and
  observation, the published evidence). Commerce declares each member with a
  declaration merge in `commerce/contract/types.ts`, as a module declares its
  binding of `Env` (step A1.2).
- **Memory.** `memory/contract/memory-service.ts` is the Memory service of Brain.
  The Inbox reads Memory views, the standing of shown Memory and the mailbox turn
  reader, and it proposes a Memory and an Eval, through it. `memory/access.ts`
  stays private. The Eval reads verified contacts through the Inbox contract.
- **Integrations and the Inbox.** `integrations/contract/connection-parts.ts` is a
  registration port: the Inbox gives the mailbox part of a Gmail connection and the
  WhatsApp part. `integrations/contract/provider-services.ts` gives the onboarding
  route and the account removal the provider services.
- **The Slack installation store.** `slack/installation-store.ts`
  (`foundation/authority`) owns the installations, the Organisation connections,
  the channel defaults and their audit rows, beside the Slack credential of the
  Vault. The thread routes and the DM choice stay in `slack/organisation-routing.ts`,
  because the purge and the side Case write those two tables. The store gets the
  DM part through `slackDmSelection`. `slack/surface-parts.ts` is the port of the
  other Slack parts: the card texts, the reply after a card, the conversation
  facts, the reach check and the hand-over of a decision.
- **Shopify.** The Worker registers the Shopify module in two lines: its commerce
  provider and its provider module (the catalogue entry and the credential check).
  The Shopify delivery normalizers are in `shopify/delivery-normalizers.ts`, and
  they give their normalizer to the delivery intake of commerce. The commerce tool
  reader uses `createCommerceGraphReader`, and the unread reader option
  `commerceSystem` is gone. `shopify/REMOVE.md` names the new lines.
- **Smaller pairs.** The onboarding projection of a configuration answer and the
  saved runs of a Project reference are ports. Three agent operation files take the
  module that they serve.
- **Not changed:** no route, status code, error text, stored value, SQL text, bind
  order, batch order, RPC shape, journal entry, delivery id, tool definition or
  tool order. The catalog digest of the default selection and the hash of all
  model definitions are the same as on the base (a temporary check, not
  committed).
- **Measures.** Layer crossings: 155 to 74. Upward 68 to 20, between areas 44 to
  17, against the order 20 to 16, table writes 23 to 21 (the Slack installation row
  of the Vault now has its owner). Copies: 876 to 875 (the check of a selected
  grant is one helper). Unused exports: 805 to 797.
- **What stays (74), with what removes it.**
  - Table writes (21) and the tenancy order crossings (8): the lifecycle port,
    which another worker builds.
  - The chat record and the Kitchen (5): the chat record stores the Kitchen view of
    a message, and the chat signal sockets reach the workflow canvas rooms.
    Remove: the surface registry of Plan 87 for the state check, and a port in the
    call of the Organisation actor.
  - The Case walk to Slack (2): it builds the Slack stream input. Remove: the port
    through `OngoingCaseWalkingConnector`.
  - Single foundation imports (2 upward): the Memory member view of the held
    output route and the support references of the integration account.
  - Order crossings outside tenancy (8): the file grant statements (2) and the
    files module (1) of the grant code, the Case snapshot type, the native chat
    audience, the chat flow of the held output route, the collaboration ping of the
    socket host, and `UserId` of `control-api` in `ids.ts`.
  - Area pairs (17) and area to a surface or the Worker (10): the device fleet composes the Café terminal module (step
    A1.9); the commerce level of the Organisation actor (A1.9, the class chain that
    another session changes); the commerce approval card text (the action gives
    typed facts, and Slack builds the text); the Portal pages in the shell frame
    and the Café prompt edit; the voice Mac devices; the WhatsApp send ladder; the
    configuration draft; and the Stripe setup part, the counter sale view, the
    Register receipt, the supplier contact and the Gmail pilot budget. Each needs a
    service interface of the other area, wired by the Worker. The package
    `bakery-model` is one of the 17.
  - The package `contracts` depends on `commerce-contracts` (1). Step A1.11 owns
    it.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files, 1,730 tests) pass. The 114
  journey files whose names hold a word of the brief, or project, onboarding,
  held, permission, provider, inbox, eval, removal, grant, ledger or idle, ran in
  ten groups: 113 pass and 1 is skipped (227 tests pass, 3 are skipped). After the
  last port, the 23 cue, commerce, operation and ledger journey files ran again:
  all pass (41 tests).
  `wrangler deploy --dry-run` passes for the six Workers. The full E2E suite did
  not run on the branch.

### A1.9 — The class chains are modules (2026-11-21)

The three Actor class chains are gone. Each Actor class holds its parts as modules. A
module is a class with a constructor. It gets the state that it needs as one explicit
value, and it reads no field of the Actor class.

- **The Session.** The chain was `SessionActorBase`, `SessionCheckpoints`,
  `SessionHarnessTurns`, `SessionTurnRecovery` and `SessionActor`. It is now
  `SessionActor` over `PlacedActor`, with four modules: `checkpoints`,
  `harnessTurns`, `recovery` and `chatCleanup`. `SessionShared`
  (`actors/session/session-shared.ts`) holds the state that the modules share: the
  nine fields of the old base, the persistence, the two harness sinks and two
  helpers. `SessionActorBase` is removed. `SessionDO` stays the class of the Worker:
  it gives the tools.
- **The Connector.** The chain was `ConnectorActorBase`, `ConnectorWhatsApp`,
  `ConnectorEvals`, `ConnectorEmail` and `ConnectorDO`. It is now `ConnectorDO` over
  `ConnectorActorBase`, with three modules: `evals`, `whatsApp` and `email`, beside
  the Slack channel of step A1.6. `ConnectorModuleHost` is what a module gets: the
  state, the bindings, `admitExecution`, `armAlarm` and `trackExecution`.
- **The Organisation.** The chain was `OrganisationActorBase`,
  `OrganisationCommerce` and `OrganisationDO`. It is now `OrganisationDO` over
  `OrganisationActorBase`, with the module `commerce`. `OrganisationModuleHost` is
  what a module gets: the state, the bindings, `command` and `rearm`. The onboarding
  activation gave the Actor itself to two steps; the module now gets the two methods
  (`ensureOrganisation` and `activatePolicy`) as an explicit value.
- **The state and the bindings are read at each use.** A shared value or a host has a
  getter for `ctx` and for `env`. A module then sees the same bindings as a method of
  the Actor class. The fault journeys depend on this: they replace `env` of an Actor
  instance.
- **RPC.** Each module declares the type of its RPC methods: `SessionCheckpointsRpc`
  (3 methods), `SessionHarnessTurnsRpc` (2), `ConnectorEvalsRpc` (4),
  `ConnectorWhatsAppRpc` (16), `ConnectorEmailRpc` (35) and
  `OrganisationCommerceRpc` (50). The Actor class implements each type with one
  method for each name. A method takes the arguments of the module method and calls
  it. No RPC method name and no argument shape changed.
- **Schema.** No module has schema steps of its own. The Session keeps
  `initializeAgentSessionPersistence`, the Connector keeps `createSchema` with the
  ordered list of its channels, and the Organisation keeps its schema file. No schema
  version, stored value, alarm time or journal entry changed. A module constructor
  writes nothing.
- **No hook is hidden.** No method of a module has the name of a method of
  `PlacedActor` or of a base class. A script compared the names.
- **Two shared admissions.** `admitNamedConnector` (`actors/connector/module-admission.ts`)
  replaces 29 copies of one preamble in the WhatsApp and email modules: admit the work
  at the placement, then check the stored identity. `admitCommerceLab` replaces 3
  copies in the commerce module. The steps and their order are the same.
- **The fault hooks of five journeys.** Five journeys patched a method of the Actor
  instance or of `SessionDO.prototype` as a fault hook. The method is now in a module,
  so the hook is on the module: `checkpoint-restart`, `checkpoint-atomic-acceptance`,
  `session-turn-completion` and `session-alarm-steps`. `slack-answer-before-archive`
  wraps the archive of each Session at `sessionTools`, which the constructor calls. No
  assertion changed. Before the repair, `session-turn-completion` passed with no
  fault: its journey does not prove that the fault ran.
- **Measures.** Layer crossings: 287 to 285. Copies: 877 to 844. Unused exports: 805,
  no change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages` and the unit
  suite pass on the last commit. After each module, the journeys of its Actor ran: 17
  files for the Session, 17 for the Connector and `mail-inbox.test.ts`, 18 for the
  Organisation. Each group has the recovery, relocation and placement journeys and
  the idle tenant journey. The full E2E suite did not run on the branch.
- **Still open.** `ConnectorActorBase` and `OrganisationActorBase` stay as the one
  base of their Actor class: the state, the alarm, the admission and the hosts. The
  policy, Jev, Memory and Evals parts of the Organisation were modules before this
  step.

### The end of Stage A — Dead code after the ports (2026-11-21)

No export is public without a user in another module, apart from the 15 that a
reason keeps. A hand check came before each deletion.

- **Unused exports: 797 to 15.** A name that only its own file uses lost `export`.
  A declaration with no user is deleted, with what only it used. A re-export that
  no file imports is gone from its barrel: the Vault, the access grants, the
  context files and assembly, information flow, the Portal commerce barrel and the
  commerce engine. A name that a doc or a plan names only in prose keeps its
  declaration; it lost `export` or the barrel line.
- **Two rules for knip.** `knip.json` ignores `services/platform/src/generated/`:
  `scripts/generate-actions.ts` writes it and decides its exports (44 names). An
  export that a reader outside the import graph needs has a `@public` tag with the
  reader: `PIE_STATIONS` and `buildLiveRoomRoute` (two browser check scripts),
  `INSIDE_CAPABILITIES` (`scripts/check-ifc-destinations.mjs` reads the source
  text) and `outsideWrittenFlowLabel` (the IFC integration guide). The header of
  `scripts/check-unused.mjs` gives both rules.
- **What stays, with the reason.** `devices/work.ts` and `readKitchenDeviceView`:
  Plan 24 calls them. Seven Vault names of `credential-vault/index.ts`: the Vault
  API page of `apps/docs` gives them as the public API. `caseContributionSourceSchema`
  of `packages/contracts/src/case-output.ts`: Plan 77 names it in that file; the
  live parser is the one of `case-rpc.ts`. The six exports of
  `tests/e2e/full-worker.ts`: a Worker harness of Plan 55 that no config starts, in
  the test folder that another worker decides.
- **`packages/contracts`.** 25 type re-exports had no user outside the package;
  only its own type fixtures read them through the barrel. The fixtures now import
  the source files, and the barrel drops the 25. The other 203 names of the barrel
  have a user in another package.
- **Copies: 842 to 825.** Merged: the admin cue route head of Shopify and Stripe
  (`readCueChannelRequest` in `gateway/request-helpers.ts`), the rotation gizmo of
  the two Kitchen floor scenes (`spatial/rotation-gizmo.ts`), the commerce action
  path (derived from the request; a type check proved the two unions equal), the
  chat list and search read, the end of the provider connection workflows
  (`provider-managed-connection.ts`, `finalizeProviderConnection` and one
  `scopesAreComplete`), the head of the two acceptance fault routes, and the entity
  type parser of the commerce engine (it imports the client parser).
- **Copies that stay.** The pour-over and siphon scenes: the gripper jaws have a
  different geometry. `browser-physics-asset.ts`: `build-browser.mjs` writes its pin
  data. The two Rust fetch crates: no shared crate exists, and one changes two
  container builds. The refund and cancellation resolution of
  `after-sale-cancellation.ts`, the recipe models, the Code Mode budget and governor
  row parsers: each copy has its own types, errors or replay. The two CRDT draft
  actors wait for step A2.6.
- **Measures.** Layer crossings: 50, no change. Copies: 842 to 825. Unused
  exports: 797 to 15, unused files: 1.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build`, `pnpm underclerk:check` and the unit suite (301 files, 1,730
  tests) pass on the last code commit. No test file is deleted, and no old-row
  adapter is deleted.

### The end of Stage A: the last crossings and the area lists (2026-11-21)

On the branch `refactor-17-last-crossings`. Layer crossings: 50 to 10, in 6 pairs.
Each pair that stays has a written reason.

- **Ports that `worker-ports.ts` registers.** The context assembly reads the native
  chat audience (`context/assembly/native-chat-audience.ts`). The grant code reads
  the file grant statements and the file target check (`file-grant-parts.ts`).
  A connection flow gets the statements of the support references, the
  communication destination and the credential reference from their owners
  (`data/connection-flow-parts.ts`). Commerce gets the texts of its Slack approval
  card (`commerce/contract/approval-card-texts.ts`), and devices get the shop Macs
  (`devices/contract/shop-mac-devices.ts`). Each area contract has a service port:
  `cafeServices`, `inboxServices`, `organisationServices`, `workflowChanges` and
  `deviceCommands`. 12 unit test files that reach a port import `worker-ports.ts`.
- **Moves with evidence.** `memberMaySee` is `chat/member-view.ts`
  (`foundation/conversation`), and the held output route and the permission request
  route are `foundation/conversation`. The device fleet terminal module is
  `areas/devices`. The Organisation pages of the Portal get the shell frame as a
  prop.
- **Values and types at their owner.** The socket ping, pong and expiry are in
  `@purin-labs/std`. `UserId` comes from `@purin-labs/control-api/ids`, so `ids.ts`
  names no contracts module. The stream types and the turn ids of an ongoing Case
  turn are `actors/case-turn-stream.ts`. The directory Slack record builders are in
  `slack/organisation-routing.ts`. The WhatsApp proposal invalidation is in
  `actors/connector-whatsapp.ts`. The Kitchen surface tool results are a public
  file, `agent-tools/bakery/surface-result.ts`. `bakery-model` reads the graph query
  parser of `commerce-contracts`, and `decodeRecord` is in `contract-schema`.
- **The table scan.** A write is an upper-case SQL keyword, as in each SQL text of
  the repository. The error text of the Portal is no longer a write. A probe write
  in the Portal is still found.
- **Written reasons.** `reasons` in `scripts/layers-ratchet.json` gives the reason
  and the fix of each pair. `pnpm lint:layers` refuses a pair with no reason or no
  fix, and a reason of a pair that is gone. The pairs that stay: the Café prompt
  edit and the Portal chat (2), the activation steps in the commerce module of the
  Organisation actor (2), the Kitchen view of the chat record (4), the Stripe part
  of the integrations page (1) and the package `contracts` (1).
- **The mixed notes.** `agent-tools/session-support.ts` imports no area, so its note
  is gone. The other five notes name what each file joins today.
- **The area lists.** `node scripts/check-layers.mjs --areas [module]` prints the
  files by folder, the packages, the tables and the public files of each module.
  [`docs/layers.md`](layers.md) holds the list. `pnpm lint:layers-page` fails when
  the page is older than the map or the files.
- **Not changed:** no SQL text, bind order, route, status code, error text, RPC
  method name, stored value, tool definition or tool order.
- **Measures.** Layer crossings 50 to 10: upward 19 to 7, between areas 17 to 3,
  against the order 8 to 0, table writes 6 to 0. Copies 842 and unused exports 797,
  no change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files, 1,730 tests) pass. The 87
  journey files whose names hold a word of the change ran in four groups: 86 pass
  and 1 is skipped. `counter-receipt-printer` failed once in the first group (the
  drawer task was `sent`, not yet `done`, while a lint ran beside it), and it
  passed twice alone. `wrangler deploy --dry-run` and the full E2E suite did not
  run on the branch.

### The decision for each test file (2026-11-21)

Each test file in scope has a decision: the 300 Platform unit test files, and the 17
commerce test files that import a source file that Refactor 17 changed.
[The table](refactor-17-test-decisions.md) has one row for each file, with the outcome
that it checks.

- **Result.** 316 files stay as they are. One file loses one case. No file is deleted.
- **The one delete,** in its own commit: "sets the band when the price is the one that
  was shown" in `offer-price-allowance.test.ts`. It asserted a call to a mock of the
  test. The journey `e2e/pi-commerce-actions.test.ts` applies a price allowance through
  the real route and the real commerce engine.
- **Why so few.** Plan 92 removed the weak tests of this suite three days before. This
  pass found no test that asserts the shape of a module, and no test whose only
  assertion is a call to a mock that the test controls, other than the one above.
- **The limit.** "Keep: the only check" does not prove that no journey has the outcome.
  The search for a journey ran for the files with mock signals, not for each case.
- **The protected list of Plan 92** did not change.
- **Counts.** The Platform unit suite: 301 files and 1,730 tests before, 301 files and
  1,729 tests after.

### The activation module and the shared contract primitives (2026-11-21)

On the branch `refactor-17-last10-actor`. Layer crossings: 10 to 7. Two pairs and
their reasons are gone.

- **The onboarding activation is a module (A1.9).** `OrganisationActivation`
  (`actors/organisation/activation.ts`, area `organisation`) holds the activation
  steps and the acceptance fault of the activation. It declares
  `OrganisationActivationRpc` with four methods: `activateOnboarding` and the arm,
  inspect and clear of the fault. `OrganisationDO` implements it beside
  `OrganisationCommerceRpc`, which has 45 methods now. The module gets the two
  methods `ensureOrganisation` and `activatePolicy` as an explicit value, as the
  commerce module did. The commerce module imports no file of the organisation area.
- **The schema step of the Actor.** `advanceActivationSchema` is a schema step of the
  relocation, not a commerce command. It is a method of `OrganisationDO`, beside
  `acceptsActivation`, as in `ConnectorDO`.
- **Helpers at their user.** The key and the parser of the Café commerce acceptance
  fault and the cutover cue check are private to the commerce module. The lease step
  of the alarm, `expireOrganisationLeases`, is in `actors/organisation/support.ts`.
- **The shared primitives (A1.11, part 2).** `@purin-labs/contract-schema` holds
  `OrganisationId` and `IntegrationAccountId` (plain strings, as before) and the
  integer replacer of the JSON boundary, `jsonSafeInteger`. Both contract packages
  name them from there. The replacer had three copies.
- **Opaque commerce parts.** The commerce parts of the records of `contracts` are
  `ContractCommerceParts` (`packages/contracts/src/commerce-parts.ts`): the scope and
  the target of a commerce grant, the commerce proposal and the source provenance of
  a Case. The Platform declares them with a declaration merge in
  `commerce/contract/types.ts`, as it does for `CommerceTypeParts`. A program without
  the merge sees an opaque part. The type fixture of the grant selectors moved to
  `services/platform/tests/`, where the merge holds; its `@ts-expect-error` lines
  prove the merge.
- **The browser validators.** The browser validators of `contracts` no longer
  re-export the commerce validators. The Portal bootstrap imports them from
  `commerce-contracts`. `decodeAccessGrantTarget` and `decodeGrantSubject` had no
  caller. They are deleted with their commerce shapes. `packages/contracts/package.json`
  names no commerce package.
- **Not changed:** no RPC method name, argument, result, stored value, schema step,
  constructor write, wire shape or parser result of a caller.
- **Measures.** Layer crossings 10 to 7: between areas 3 to 1, upward 7 to 6. Copies
  825 to 824. Unused exports: 17, no change. `organisation-commerce.ts`: 2,143 lines
  to 1,955.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm underclerk:check`, `pnpm portal:build` and the unit suite (301 files, 1,729
  tests) pass. The 41 journey files whose names hold `onboarding`, `activation`,
  `organisation`, `commerce`, `access`, `placement` or `idle-tenant` ran in five
  groups on the second commit: all pass (87 tests). After the move of
  `advanceActivationSchema`, six Actor journeys ran again, with the idle tenant
  journey: all pass. The full E2E suite did not run on the branch.

### The last crossings of the Portal and of the chat record (2026-11-21)

On the branch `refactor-17-last10-portal`. Layer crossings: 10 to 3, in 2 pairs. This
entry closes the Portal, Stripe and chat record pairs of the lists above.

- **The Café board asks through a chat port.** The prompt edit of the menu board
  reads and sends the chat through `features/menu-boards/board-chat.ts`. `portal.tsx`
  and the two menu previews register the Portal chat with
  `portal-board-chat.ts`, which loads the chat code at the first call. The read model
  of the chat page, `ChatPageData`, is in `@purin-labs/control-api/portal/chat`, with
  one type for a chat list entry in place of four copies.
- **The integrations page gets the Stripe part.** The integrations route transport
  carries the Stripe setup part, and `portal-transports.ts` gives it. The integrations
  preview gives it too.
- **The surface registry of the chat record.** The record keeps the page state of a
  message as `ChatSurfaceState`, which shows only its digest. It reads the state check
  through `chat/surface-registry.ts` (Plan 87, section 5), a port that
  `worker-ports.ts` registers with the Kitchen entry `KITCHEN_CHAT_SURFACES` of
  `chat/kitchen-observation.ts`. The registry also reads the old forms: the stored
  `surface` part and the `surfaceContext` key of a tab from before Plan 87 phase 2.
  The record reads the registry only for an observation with a state or for an old
  form. The Portal code that needs the Kitchen form reads it with `kitchenState`.
  `tests/portal-chat.test.ts` loads `worker-ports.ts`.
- **Not changed:** no stored JSON, sent command, route, status code, error text or
  visible Portal text.
- **Measures.** Layer crossings 10 to 3: upward 7 to 1, between areas 3 to 2. Copies
  825 and unused exports 17, no change.
- **What stays (3).** The activation steps in the commerce module of the Organisation
  actor (2) and the package `contracts` (1). Their reasons did not change.
- **Checks.** `pnpm lint`, the three type checks, `pnpm check:packages`,
  `pnpm portal:build` and the unit suite (301 files, 1,729 tests) pass. The 58
  journey files whose names hold a word of the brief ran in eight groups: 57 pass and
  1 live journey is skipped (75 tests pass, 2 are skipped).
  `wrangler deploy --dry-run` and the full E2E suite did not run on the branch.

### The preview pages and the browser check of the decision buttons (2026-11-21)

On the branch `refactor-17-m`, after the full E2E run. No code changed.

- **The preview pages.** The goal was a preview page with only fixture data and the
  mount call. The clone check finds no copy of product code in `dev/`: its 4 pairs
  that touch `dev/` each join two preview pages. A worker moved the appliance viewer
  (1,545 lines) to `features/workflow-simulator/appliances/`. The move merged no code,
  and no product page used the viewer, so the move was dropped. The viewer shows one
  appliance model at a time with its joint controls. Three Kitchen files load GLB
  models with their own `GLTFLoader` (`bakery-assets.ts`, `spatial/physics-asset-loader.ts`
  and the viewer); one shared loader is separate work, because the physics loader
  checks the bytes of each file and the other two do not. Stage B places each preview
  page beside the `ui` folder of its area.
- **The decision buttons in the browser**, on the Vite server of the branch:
  - The chat card of a governed action (`chat-preview.html?scenario=commerce-action`):
    "Reject" asks "Reject change" or "Keep proposal". "Keep proposal" goes back.
    "Reject change" sends one rejection, the card says "Rejected", and no button
    stays. "Approve and apply" sends the approval, then the execute call, and no
    button stays.
  - The review of a custom connector write (`integrations-preview.html`): one button,
    "Verify and approve with Google", and no refusal, as Appendix E records.
  - The Inbox conversation (the fixture of `scripts/mail-inbox/mount-browser-fixture.js`):
    "Approve and send", "Edit" and "Reject". "Reject" refuses with one click and opens
    the next email, as Appendix E records.
  - Not checked in a browser: the status band of a governed action and the mailbox
    page. Both need a running Worker.
- **The moved Portal parts.** The Stripe part shows on the integrations preview. The
  journeys `scripts/plan-40b/browser-board-chat.js` (9 checks) and
  `browser-board-agent.js` (102 checks) pass against a local Worker; they drive the
  chat beside the board through the board chat port.

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
- **A copy with a different behavior stays.** The ratchet file holds only the count of
  copies and copied lines of each file pair; Plan 92 lists the reasons.

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
- **A journey reads the Worker from outside.** 188 of the 251 Platform journeys import
  the source (`node scripts/list-tests.mjs --list`, 2026-11-22). A journey acts through HTTP, RPC or the
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
  - Decided by the owner on 2026-11-22, after the trial
    ([report](evidence/refactor-17-d1-trial.md)): a mix. A foundation module becomes
    a workspace package, from the bottom of the foundation order, the kernel first.
    The server code of an area stays a folder with relative imports until each module
    that it imports is a package. The times did not decide: each variant was inside
    1 second of the baseline. The obstacles decided: an area package imports Worker
    files (45 for `devices`), so the package and the Worker depend on each other, and
    three lints fail.
- **D2. Order against Plans 93 and 94.**
  - Recommendation: start Stage A and step S1 now, from `origin/dev`. They change no
    stored data and no deployed name. Stage B and each change of stored data wait for
    the cutover. The spec text waits for the brand names.
  - Default: as recommended.
  - Decided by the owner on 2026-11-21, after Stage A: Stage S (steps S2 and S3) waits
    for Plan 91 phase 4, and Stage B waits for the Plan 93 cutover. The trial of D1 also
    waits.
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

**Measured, 20 and 21 November 2026.** The times come from the commit log.

| Work                                   | Time                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| Step A1.1 (typed actor access)         | about 2 hours of code, then about 1 hour of checks and the E2E run  |
| Step A1.2 (environment parts)          | about 1 hour, in the same branch as the connections module          |
| Step A1.3 (the executor names no area) | about 1.5 hours in a parallel session                               |
| The rest of Stage A                    | about 17 hours of wall time, 20 November 17:00 to 21 November 10:00 |
| Full E2E runs                          | 13 runs of 48 to 66 minutes; a run under machine load is slower     |

Stage A ran as parallel work: one coordinator session, one long session and two to
four CLI workers at a time, each in its own worktree. The coordinator merged their
branches, ran one full E2E run on each merge, and pushed only with the agreement of
the owner. The estimate of 25 landings was close: seven pushes carried 23 steps, and
each push had its own full run.

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

## Appendix C — What each effect tool did before step A1.4

Step A1.4 started with this list. It was read from the code on 2026-11-20, after
the split of the channel and draft tools by area and before the port. "Exit check"
means `toolEffectPassesExit` in `agent-tools/session-support.ts`. Before the port
the executor in `agent-tools/catalog/execute.ts` ran no exit check: it checked
`directOnly`, the handler, the arguments and the capability claim, and then it
called the handler, which ran the check itself.

### Eight patterns

| #   | Pattern                                                                                                                                                                                                                                                           | Tools                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Content check of a shared draft (`passSharedDraftExit`): the turn label, a sink of the member with `readByEveryMember`, no action. A menu board scope sets `repeatInRequest`                                                                                      | `menu_draft_edit`, `menu_board_edit`, `menu_board_comment`, `menu_board_history`, `menu_board_stack`, `menu_board_create`, `costs_sheet_edit`       |
| 2   | Pattern 1 behind `authorizeSharedDraftEdit`: if a role cannot read the label, a read of the shared thread or chat comes first, and it can refuse with its own text                                                                                                | `product_description_draft_edit`, `production_plan_edit`, `email_draft_edit`                                                                        |
| 3   | A copy of pattern 1 in the handler, with a warning trace on refusal                                                                                                                                                                                               | `move_object`                                                                                                                                       |
| 4   | Staff page (`settleStaffPageEffect`): the effect check in mode `check`, then the ask, then the receipt replay, then the content check with `writerRule: "asked"` (5 of the 7 tools), then the effect check again. The turn label, the lease sink, with the action | `order_queue_advance`, `sold_out_mark` (no content check); `recipe_save`, `supplier_create`, `supply_cost_save`, `lot_cost_save`, `costs_plan_save` |
| 5   | One check: the turn label, the lease sink, with the action                                                                                                                                                                                                        | `device_pause`                                                                                                                                      |
| 6   | One check: the work label of the Session, the lease sink, with the action                                                                                                                                                                                         | `airtable_api_write`                                                                                                                                |
| 7   | One check (`authorizeToolEffectInformationFlow`): the work label of the Session, the lease sink, no action                                                                                                                                                        | `slack_message_propose`, `email_reply_propose`, `email_operational_propose`, `email_reply_draft_edit`                                               |
| 8   | No exit check                                                                                                                                                                                                                                                     | `menu_board_archive`, `whatsapp_support_reply_send`, `schedule_follow_up`, the 13 `proposal` tools, the 47 `surface` tools                          |

Only pattern 5 is the shape of the example in Appendix B.

### What does not fit one check before `run`

- **Two labels.** Patterns 1 to 5 read the label of the turn (`currentTurnFlowLabel`).
  Patterns 6 and 7 read the work label of the Session (`readSessionInformationFlow`).
  The executor must take the label source from `prepare`, not choose one.
- **Three checks and a replay between them** (pattern 4). A repeated call returns its
  first receipt after the first check and before the content check. `prepare` must
  give the executor the replay read, the optional content check and the effect check,
  in this order.
- **Work after the check and before the effect.** `email_reply_draft_edit` checks the
  member, the role and the chat, and it writes the edit provenance in the Connector.
  `email_operational_propose` writes a self-test row. `slack_message_propose` and
  `email_reply_propose` do reads that can refuse with a text for the agent.
  `airtable_api_write` checks its authority again and claims the write in Session
  storage: a second write in the turn is refused there. All of this goes into `run`,
  in the same order.
- **Commits before the check.** `product_description_draft_edit`, `production_plan_edit`
  and `move_object` admit the observation of their read before the check. This stays
  in `prepare`.
- **A check with no ask.** The preview of `menu_board_edit`
  (`drafts/board-draft-preview.ts`) runs the content check in mode `check` while the
  model writes the arguments. It is not a tool call, so it stays outside the executor
  and uses the same sink builder.
- **A refusal with its own class or text.** `production_plan_edit` turns a refusal of
  the shared chat into `ProductionPlanRequestError`. Each tool has its own text for
  "not authorized". `prepare` gives the text.
- **Effect tools with no check today:** `menu_board_archive` (owner or admin only),
  `whatsapp_support_reply_send` (the body must be in the person's own words) and
  `schedule_follow_up`. The step keeps this. A new check here is a behavior change
  and needs its own decision.

### The `proposal` tools (13)

No `proposal` tool runs an exit check. Each one checks the lease, the person and the
role, reads what the card shows, and stores a proposal that a person confirms.

| Tools                                                                                                                                                                             | What a call does                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commerce_propose_action`, `commerce_propose_plugin`, `commerce_propose_menu_publication`, `commerce_propose_refund`, `commerce_propose_stock_action`, `menu_board_propose_price` | Checks that the targets were read in this Session and that their revisions are current. `recordCommerceProposal` then claims `commerce.action.propose`, stores the turn label with the proposal in the Case and the Organisation, and shows the approval card. An owner or admin approves |
| `configuration_propose`, `recipe_workflow_propose`, `device_propose`, `jev_features_manage`                                                                                       | Staging in `actors/session/session-proposal-staging.ts`: the lease, a live member with the role for the change, then an operator draft with a time limit. The person confirms on the card, or in Slack with a reply code                                                                  |
| `commerce_propose_campaign_brief`                                                                                                                                                 | The same staging. Each target must be read in the Session. It stores a brief for review                                                                                                                                                                                                   |
| `propose_memory`                                                                                                                                                                  | A Portal chat turn with a live authority. It gives the turn label to the Memory proposal. A person accepts it in Brain                                                                                                                                                                    |
| `propose_side_case`                                                                                                                                                               | Portal: stores the proposal with the turn label and signals the chat. Slack: checks the thread as a sink (`decideCaseConversationSink`); a refusal answers "not proposed" and asks nobody. A person presses Start                                                                         |

### The `surface` tools (47)

No `surface` tool reads a label or runs an exit check. The page runs the command as
the person's own click does.

- **The 38 `bakery_surface_*` tools** (`executeBakerySurfaceForHarness`): a control
  authority and an attached browser; a live owner or admin; a repeated call sends the
  stored command of its outbox row again; else the surface is prepared (a cached
  surface, or a `prepare_context` effect) and must support the command; the live
  check again; the dispatch; the live check a third time. `inspect_surface` also reads
  the last run save and scenario save.
- **The 9 view tools** (`costs_view_*`, `pastry_bench_*`, `register_*`, through
  `executeCostsViewForHarness`): the last message of the person must carry the page
  and list the command; a live owner or admin, and an operator for Register only; the
  dispatch. There is no repeat step and no prepare step.
- **The receipt** of both: `dispatchBakerySurfaceEffect` writes an outbox row in
  Session storage, with an id from the Session, the turn and the call, and it waits
  for the receipt of the browser. A repeat with the same id returns the stored
  receipt.

### The record of each effect tool

The record is from before the port. "Refused" is the case where the exit check does
not pass. In each refused case the effect does not run. Where the turn has a person,
the first refusal asks that person and the model reads `ExitApprovalRequestedError`
("Seams Pantry stopped this step, because…"). Where it has none, the model reads the
generic failure text, and the error below goes to the log.

| Tool                                                                                     | Checks, in order                                                                                                                                                                              | Allowed                                                                                                           | Refused (the log)                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `device_pause`                                                                           | lease; a live member with the staff role; the turn label; one check with the action `device.pause`                                                                                            | The device command runs with a key from the call. A receipt                                                       | `Device pause is not authorized: <decision>`                                                                    |
| `airtable_api_write`                                                                     | Airtable authority and grants; the credential; the work label; one check with the action `airtable.write`                                                                                     | Authority again, the claim of the write, the request, the observation                                             | `Airtable write requires policy resolution: <decision>`                                                         |
| `email_reply_propose`, `email_operational_propose`                                       | lease; the mail capability and its grant; the work label; one check, no action                                                                                                                | The provenance read (reply) or the self-test row (operational); a draft proposal in the Case                      | `The proposal requires policy resolution: <decision>`                                                           |
| `slack_message_propose`                                                                  | lease; the Slack capability and its grant; the work label; one check, no action                                                                                                               | The channel read, which can refuse an unknown channel; a draft on a card                                          | `The proposal requires policy resolution: <decision>`                                                           |
| `email_reply_draft_edit`                                                                 | lease; the reply is in the mailbox; the mailbox read; the reply capability; the work label; one check, no action                                                                              | Member, owner or admin, the chat covers the reply, the provenance write, the edit, the observation                | `The proposal requires policy resolution: <decision>`                                                           |
| `menu_draft_edit`                                                                        | deadline; a live person authority; a member who may edit; the turn label; the content check                                                                                                   | Lease checks, then the edit in the Organisation                                                                   | `Menu draft disclosure is not authorized`                                                                       |
| `menu_board_edit`, `menu_board_comment`, `menu_board_history`, `menu_board_stack`        | the same; for `add_image` the image must be in the library first; the scope `menu-board:<id>` lets one Allow cover the later edits of the request                                             | Lease checks, then the board edit                                                                                 | `Menu board disclosure is not authorized`                                                                       |
| `menu_board_create`                                                                      | the same, with the scope `menu-board:new`                                                                                                                                                     | Lease checks, then the new board                                                                                  | `Menu board disclosure is not authorized`                                                                       |
| `costs_sheet_edit`                                                                       | deadline; lease; a member who may edit; the turn label; the content check                                                                                                                     | Lease checks, then the sheet edit                                                                                 | `Costs sheet disclosure is not authorized`                                                                      |
| `product_description_draft_edit`                                                         | deadline; the commerce read of the product, with its observation; the draft read; a member who may edit; the turn label; the shared thread if a role cannot read the label; the content check | Lease checks, the edit, the observation                                                                           | `Description draft disclosure is not authorized`; not shared: the text "Connect this Slack thread…"             |
| `production_plan_edit`                                                                   | deadline; the plan reads, with their observation; the request is in the plan; a member who may edit; the turn label; the shared thread or chat if needed; the content check                   | Lease checks, then the plan edit                                                                                  | `Production plan disclosure is not authorized`; not shared: `ProductionPlanRequestError`, which the model reads |
| `email_draft_edit`                                                                       | deadline; lease; the Slack thread is shared with the draft; the turn label; the shared thread; the content check                                                                              | The edit in the Organisation                                                                                      | `Email draft disclosure is not authorized`                                                                      |
| `move_object`                                                                            | deadline; the canvas read with its observation; a member who may edit; the turn label; the content check                                                                                      | Lease checks, the move, the observation                                                                           | `Workflow canvas disclosure is not authorized`, with a warning trace                                            |
| `order_queue_advance`, `sold_out_mark`                                                   | lease; a live member with the staff role; the read of the page; the turn label; the effect check with no ask; the ask; the receipt replay; the effect check                                   | The command with the receipt key; the receipt; the shop screens signal. A repeated call returns its first receipt | `Staff page effect is not authorized: <decision>`                                                               |
| `recipe_save`, `supplier_create`, `supply_cost_save`, `lot_cost_save`, `costs_plan_save` | the same; between the replay and the last effect check, the content check with the writer question asked by the effect check. `supplier_create` checks the name first                         | The same. A refusal of the command stores no receipt                                                              | `Staff page effect is not authorized: <decision>`, or `<draft> disclosure is not authorized`                    |
| `menu_board_archive`                                                                     | a live person authority; a member who may edit; owner or admin. No exit check                                                                                                                 | The board is archived or restored                                                                                 | No exit refusal. Another role reads `MenuBoardRequestError`                                                     |
| `whatsapp_support_reply_send`                                                            | lease; the body is in the person's own words; a live owner, admin or operator; an active conversation window; the capability. No exit check                                                   | The Connector sends the reply                                                                                     | No exit refusal                                                                                                 |
| `schedule_follow_up`                                                                     | lease; a Slack thread turn; a live authority. No exit check                                                                                                                                   | The Connector schedules the turn. A repeat returns the same result                                                | No exit refusal                                                                                                 |

### What the port did

`prepare` returns one of four kinds of effect (`ToolEffect` in
`agent-tools/session-support.ts`), and `settleToolEffect` runs them:

- `effect`: one check with the turn's authority as the sink. The effect names its
  label source, the turn or the work label of the Session (patterns 5, 6 and 7).
- `shared_draft`: the content check, with the lookup of the shared conversation
  where the tool had it (patterns 1, 2 and 3).
- `staff_page`: the staff page step with its replay and its checks (pattern 4).
- `none`: no check (the three effect tools of pattern 8).

Each step that a tool did after its check is the first step of `run`.

The comparison with the record shows two differences. No person and no model sees
them:

- `supplier_create` read the turn label before it built its commerce client. It now
  reads it after. If both fail, the log names the other error.
- `move_object` had its own copy of the content check. It now uses the shared check
  and keeps its warning trace. The decisions, the texts and the membership read are
  the same.

The proposal and surface tools did not change.

## Appendix D — The two agent hosts before step A1.5

The record is from `origin/dev` `ce959eb`, before the port. The full name,
description and schema of each tool are in `agent-tools/channels/mailbox-agent.ts`
and `agent-tools/channels/whatsapp-agent.ts`; the hashes below cover each byte of
them. "Definitions" is the SHA-256 of `JSON.stringify` of the list that the model
gets. "Digest" is the host's catalog digest for the fixed input of the check: one
message `m1`, the account `ia_1`, the Case `case_1`.

### The WhatsApp agent host

| Value       | Result                                                                     |
| ----------- | -------------------------------------------------------------------------- |
| Tools       | `whatsapp_case_read`, `whatsapp_reply_propose`, `whatsapp_handoff_request` |
| Definitions | `830a2fe7e084315d13dc9f7d4267748b20d38f9510f967d681650beb4cee1145`         |
| Digest      | `d9b2c7f16dd583306fcbc5d4b65c8ac367695ab2bcb84873aa492ce1bb0fb660`         |

Each call checks first that the turn has not expired ("This Case turn has
expired."). Then:

| Tool                       | Checks, in order                                                                                                  | Result                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `whatsapp_case_read`       | None. It does not read its input                                                                                  | The admitted messages, oldest first                                     |
| `whatsapp_reply_propose`   | The turn has no outcome; the input has a text `body`; the body has 1 to `maxReplyChars` characters after the trim | The host records the proposal. A person approves it before a send       |
| `whatsapp_handoff_request` | The turn has no outcome; the input has a text `reason`                                                            | The host records the handoff, with at most 200 characters of the reason |
| Another name               | —                                                                                                                 | "Unknown tool: <name>"                                                  |

### The mailbox agent host

The response policy of the turn gives the tool list, and the evidence of the turn
adds to it:

| Turn                                      | Tools, in order                                                                                                                       | Definitions | Digest      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------- |
| `cue_routed`                              | `read_email_case`, `read_email_attachment`, `email_reply_now`, `email_reply_for_approval`, `email_no_reply`, `read_order`             | `2300a57d…` | `78bcdb88…` |
| `cue_routed`, with selected evidence      | the first five, then `read_case_context_collection_evidence`                                                                          | `ca2c5b70…` | `935e0d61…` |
| `draft_only`                              | `read_email_case`, `read_email_attachment`, `email_reply_for_approval`, `email_no_reply`, `read_supplier_delay_context`, `read_order` | `073ded73…` | `62c6ab85…` |
| `draft_only`, an eval turn with a fixture | the same with no `read_order`                                                                                                         | `87efebc0…` | `d5d5cfff…` |
| `correction_learning`                     | `read_email_case`, `propose_memory`, `no_memory`                                                                                      | `a72b25c8…` | `c260dcc3…` |

`email_reply_for_approval` has a second description in a `draft_only` turn.
`propose_memory` has the name of a Portal chat tool and is another tool.

A name that the turn's list does not hold gives "Unknown tool: <name>". Then:

| Tool                                    | Checks, in order                                                                                                                                   | Result                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `read_email_case`                       | For each message: it is in the manifest, the turn has not expired, the body and the attachments are within the size policy                         | The messages. The host notes if the whole Case was read          |
| `read_case_context_collection_evidence` | The same, for the messages that a person selected. A message that Gmail lost is erased from the selection                                          | The selected messages                                            |
| `read_email_attachment`                 | Not an eval turn; the input names a message and an attachment; the message is admitted; the attachment is in it, within the size limit and textual | The attachment as text                                           |
| `read_supplier_delay_context`           | The whole Case was read with no size breach; a triggering message exists and is readable                                                           | The purchasing facts, or the error code of the read              |
| `read_order`                            | The whole Case was read with no size breach                                                                                                        | The order, or the error code of the read                         |
| `email_reply_now`                       | The turn read no order; then as `email_reply_for_approval`                                                                                         | The outcome `reply_now`                                          |
| `email_reply_for_approval`              | The whole Case was read; the turn has no outcome; the input has a body; the commerce evidence did not change                                       | The outcome `approval_required`, with the citations of the model |
| `propose_memory`, `no_memory`           | The whole Case was read; the turn has no outcome; for `propose_memory` the statement is valid                                                      | The outcome `memory_candidate` or `ignore`                       |
| `email_no_reply`                        | The whole Case was read; the turn has no outcome                                                                                                   | The outcome `ignore`                                             |

After a result that did not fail, a turn with selected evidence observes the result
digest. If the evidence is no longer authorized, the model reads "The selected
evidence is no longer authorized. Stop this turn."

No tool of the two hosts claims a capability, reads a label or runs an exit check.
A tool records an outcome in the host; the completion of the turn, not a tool,
drafts or sends. Each result is plain text with the host's own digest.

### What the port did

- Each tool is a `defineTool` value with the selection rule
  `{ kind: "host", host }`. The WhatsApp host has one registry. The mailbox host
  builds the registry of the turn from the list of its response policy.
- Each host calls `executeCatalogTool` with a profile: its result format and its
  refusal of an unknown name. With a profile the executor gives a tool the input text
  as it is, asks for no call id, writes no log and lets an unexpected error through,
  as the hosts did.
- A service of the host holds the body of each old branch. The comparison with the
  record shows no difference: the definitions, the digests and the results are the
  same bytes.
- One branch was not reachable and is still not: `email_reply_now` in a `draft_only`
  turn ("This turn permits review drafts only."). The list of that turn does not
  hold the tool, so the model reads "Unknown tool".

## Appendix E — The decisions that wait for a person, before step A2.1

This record was written on 21 November 2026, before any change of step A2.1. It names
each kind of decision that waits for a person, where it is stored, who reads and
decides it, and what a person sees. The texts are the texts of the code on that day.

### The four stores of the plan

| Kind                 | Store                                                                                                                                                                                              | States                                                                                                                 | Life                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Governed action      | `action_ledger` in `OrganisationDO` SQLite (`actors/action-ledger.ts`). A commerce action or a custom connector write                                                                              | `proposed`, `approval_requested`, `signed`, `executing`, `indeterminate`, `confirmed`, `failed`, `rejected`, `expired` | 15 minutes, set by the proposer. The ledger expires an entry when a call reads it     |
| Case approval wait   | `case_commerce_approval` in `CaseDO` SQLite (`actors/case/proposals.ts`). It is a copy: the Case never decides, it reads the ledger                                                                | `waiting`, `decided`, `lapsed`                                                                                         | The Case alarm reads the ledger each minute for 10 minutes, then each 15 minutes      |
| Held output          | `held_output_request` in regional D1 (`data/held-output-request.ts`). An answer or a step that an exit check stopped                                                                               | `pending`, `allowed`, `denied`, `expired`                                                                              | 7 days. The 15-minute reconciliation cron sets `expired`                              |
| Permission request   | `agent_permission_request` in regional D1 (`data/agent-permission-request.ts`). A capability or a record read that a turn lacks                                                                    | `pending`, `allowed`, `denied`                                                                                         | 7 days, checked when a person reads or decides. No stored `expired`                   |
| Email reply proposal | The Case holds the lifecycle (`case_email_proposal`); `email_reply_proposal` in regional D1 is the projection. The approval challenge is a signed value (`mail-inbox/email-approval-challenge.ts`) | `awaiting_approval`, `approved`, and the end states                                                                    | 72 hours. The challenge has no life: it goes stale with a new version or another user |

### Who reads and who decides

| Kind               | Read                                                                                                                                                                                                 | Decide                                                                                                                                                                                                                                       | Who may decide                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governed action    | `GET …/commerce/actions/{nonce}`; `GET …/operations` (all states, 50 newest); `GET …/custom-connectors/{c}/actions/{nonce}`. RPC `readActionActivity`, `getAction`. No read of only the waiting ones | `POST …/commerce/actions/{nonce}/approval`, `/rejection`, `/execute`; `POST …/custom-connectors/{c}/actions/{nonce}/approval`. RPC `requestActionApproval`, `signAction`, `rejectAction`. Slack buttons through `slack/commerce-approval.ts` | Owner or admin. Approval in the Portal needs a session of 10 minutes or less and a Google approval grant for this action. In Slack: owner or admin with a linked Slack account, and no action that moves money |
| Case approval wait | `CaseDO.inspect()` (`commerceApprovals`), for the activity and execution views                                                                                                                       | Nobody. `syncCommerceApprovalWait` copies the answer of the ledger                                                                                                                                                                           | Not applicable                                                                                                                                                                                                 |
| Held output        | `GET …/access-control/held-outputs/{id}`; the list is a part of `GET …/access-control/permission-requests`                                                                                           | `POST …/access-control/held-outputs/{id}/decision` with `allow` or `deny`                                                                                                                                                                    | A member who may see the content. `outside_written`: only the person who asked. `outside_organisation`: owner, admin or the person who asked                                                                   |
| Permission request | `GET …/access-control/permission-requests` (a member below admin sees only their own); `GET …/permission-requests/{id}`                                                                              | `POST …/permission-requests/{id}/decision`. Slack Deny button through `slack/permission-request-deny.ts`. A Portal chat then resumes with `POST …/chat/conversations/{id}/permission`                                                        | Owner or admin. Allow needs that the access is already there: the Portal enables the capabilities and adds the grants first                                                                                    |
| Email reply        | `GET …/email-reviews` (replies and operational emails); `GET …/email-replies/{id}` gives the preview with the challenge                                                                              | `POST …/email-replies/{id}/approve` with the version, the digest and the challenge; `/reject`; the same for `…/email-operational/{id}`                                                                                                       | Owner or admin. Approve needs the challenge of this user for this version. Reject needs no challenge                                                                                                           |

### What happens

| Kind               | Approve                                                                                                                                                                   | Refuse                                                                                           | Expiry                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Governed action    | The entry is `signed`; the Case wait is synced; a mutation receipt is stored. The Portal then calls `/execute`. The Slack button approves and executes at once            | The entry is `rejected`; the Case wait is synced; the Case gets the outcome; a receipt is stored | The entry is `expired` at the next ledger call. The Case wait lapses and the Case opens again   |
| Held output        | Answer: the Connector sends it and the Case takes the delivery receipt. Step in Slack: the parked turn continues. Step in a Portal chat: the pass is used at the next ask | Answer: the Case drops it with a fixed note. Step: the Case notes the refused effect             | The cron sets `expired` and ends it as a refusal                                                |
| Permission request | Slack: the Connector queues the parked turn again and updates the card. Portal chat: the paused run continues when the person selects Continue                            | Slack: the card shows the refusal. Portal chat: the person stops the response                    | The request leaves the list. A decision gets status 409. A paused chat run fails after 24 hours |
| Email reply        | The Connector sends the mail through Gmail; the lifecycle moves; a receipt is stored                                                                                      | The Connector disposes the proposal; the lifecycle is `rejected`; a receipt is stored            | Found at preview or dispatch, then synced as `expired`                                          |

### What a person sees in the Portal

| Kind               | Component                                                                                                     | Where                                                                                   | Buttons, in order                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Governed action    | `ChatCommerceActionCard` (`features/governed-actions/chat-commerce-action-card.tsx`)                          | A chat, one card for each `?commerceAction=` link of an answer                          | "Approve and apply", "Reject" (then "Reject change", "Keep proposal"). Signed: "Apply change"                                                |
| Governed action    | `CommerceActionStatus` (`features/governed-actions/commerce-action-status.tsx`)                               | The status band of a page, from Operations › Approvals or a link                        | "Approve and apply", "Reject change" (then "Reject change", "Keep proposal", which resets after 5 seconds). Also "Reconcile approved change" |
| Governed action    | `CustomConnectorWriteReview` (`features/integrations/custom-connectors.tsx`)                                  | Integrations, from a `?customConnector=&customAction=` link                             | "Verify and approve with Google". Signed: "Run approved action". No button refuses a write                                                   |
| Held output        | `HeldOutputPrompt` (`features/access/held-output-prompt.tsx`), on `PermissionRequestDialog`                   | Access page link, the Permission requests drawer, and by itself in the chat of the step | Answer: "Do not send", "Send". Step: "Deny", "Allow"                                                                                         |
| Permission request | `AgentPermissionRequestPrompt` (`features/access/agent-permission-request.tsx`), on `PermissionRequestDialog` | Access page link, the drawer, and the chat that waits                                   | "Deny", "Allow". In a chat after the decision: "Stop response", "Continue"                                                                   |
| Permission request | `ChatCapabilityPermissionPrompt` (`features/chat/permission-prompt.tsx`), on `PermissionRequestDialog`        | A chat whose turn lacks a capability and stored no request of an agent                  | "Deny", "Allow". A member who cannot decide: "Stop response", "Check again"                                                                  |
| Email reply        | `EmailReviewSurface` (`features/email-review/review.tsx`)                                                     | Integrations › mailbox                                                                  | "Approve and send", "Reject", "Open in Gmail", "Close"                                                                                       |
| Email reply        | `ChatEmailDraftCard` (`features/chat/draft-cards.tsx`), on `DraftMessageCard`                                 | A chat                                                                                  | "Send", "Discard", and an edit button                                                                                                        |
| Email reply        | `MailConversation` (`features/mail-inbox/conversation.tsx`)                                                   | The Inbox                                                                               | "Approve and send", "Edit", "Reject"                                                                                                         |

The list of the waiting ones is `PermissionRequestQueue` on the Access page and
`PermissionRequestsDrawer` in the account menu. Both show permission requests and held
outputs from one read, each with a "Review" button. Operations › Approvals lists the
governed actions. The mailbox page and the Inbox list the email replies.

### What a person sees in Slack

| Kind               | Builder                                                                 | Blocks                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Governed action    | `commerceCardBlocks` (`slack/commerce-approval-card.ts`)                | A section, then actions: "Approve" (`commerce_action_approve`, primary, with a confirm), "Decline" (`commerce_action_decline`, with a confirm), and a link "Details" or "Review in Portal". An action that moves money has only the link |
| Held output        | `heldCardBlocks` (`slack/held-output-notice.ts`), on `noticeCardBlocks` | A section and one link button "Review in Portal" (`held_request_review`). No decision in Slack                                                                                                                                           |
| Permission request | `permissionCardBlocks` (`slack/permission-request-notice.ts`)           | A section, then actions: the link "Review and allow" (`permission_request_review`, primary) and "Deny" (`permission_request_deny`, with a confirm). Allow is only in the Portal                                                          |
| Email reply        | `buildSlackEmailReviewNotice` (`slack/email-review-notice.ts`)          | Plain text with a link "Review in Portal". No blocks and no decision in Slack                                                                                                                                                            |

### Other decisions that wait for a person

Each one has its own store, route and card. Step A2.1 does not join them, because the
plan names four stores. They are here so that the next step can decide.

| Kind                     | Store                                                          | Decide                                                                                                             | Card                                                                                        |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Configuration draft      | `operator_configuration_draft` in regional D1, 1 hour          | Only the person who asked: a card in a Portal chat (confirm, cancel), or a reply in Slack with the action and code | `ChatConfigurationDraftCard`: the action label, "Discard". Slack: a typed reply, no buttons |
| Recipe workflow proposal | The same draft table                                           | Owner or admin who asked: `…/bakery/workflows/{id}/proposals/{draft}/(approve\|decline)`                           | The Workflow page of the recipe, and the chat card                                          |
| Campaign brief           | `campaign_brief` in regional D1, 1 hour                        | Owner or admin: accept or dismiss. A review record only                                                            | No Portal card was found                                                                    |
| Side Case proposal       | `side_case_proposal` in regional D1, 7 days                    | Start, or do it here. No plain refusal                                                                             | `ChatSideCaseCard`. Slack: "Start thread" (`satyr_side_case_start`)                         |
| Memory candidate         | `memory_revision` in `OrganisationDO` SQLite, no expiry        | Owner or admin: accept, reject, revoke                                                                             | Brain › Knowledge: "Accept", "Edit first", "Decline"                                        |
| Eval candidate           | The Evals store of the Organisation actor                      | Owner or admin: accept, reject, revoke                                                                             | Brain › Evals                                                                               |
| Slack message draft      | `slack_message_proposal` in regional D1, 24 hours              | Owner or admin: send, discard, edit                                                                                | A draft card in the chat                                                                    |
| WhatsApp reply proposal  | `connector_whatsapp_proposal` in `ConnectorDO` SQLite, 4 hours | Approve, reject, edit, resolve                                                                                     | The Inbox conversation                                                                      |
| Supplier destination     | `supplier_destination_revision` in regional D1                 | A second owner or admin activates it. The proposer cannot                                                          | The supplier payouts page                                                                   |
| Kitchen agent save       | The scenario save store of Kitchen, 15 minutes                 | The person approves the save                                                                                       | The Kitchen workspace                                                                       |

### Two looks of one kind, as found

- **Governed action, reject.** The chat card says "Reject" first. The page card says
  "Reject change" first, and its confirm resets after 5 seconds.
- **Governed action, approve.** A commerce action approves in a popup and then applies in
  one click. A custom connector write approves on a full page of Google and then needs
  a second click, "Run approved action".
- **Custom connector write.** No route and no button refuses one. It can only expire.
- **Permission request in a chat.** A request that an agent stored shows "Pantry agent
  would like to …" with the grants. A capability that a turn lacks with no stored
  request shows "… would like to {action}" with no grants.
- **Email reply.** Three places with three button sets: "Approve and send" and "Reject"
  on the mailbox page; "Send" and "Discard" in a chat; "Approve and send", "Edit" and
  "Reject" in the Inbox.
- **Held output in Slack** has no decision button, and a permission request has only
  Deny. A commerce action has both buttons.

### The journeys that prove each kind today

| Kind                   | Allowed                                                                                    | Refused                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Governed action        | `slack-commerce-approval.test.ts`, `pi-commerce-actions.test.ts`                           | `slack-commerce-approval.test.ts` (decline in Slack and in the Portal), `slack-offer-price-change.test.ts`                                      |
| Case approval wait     | `portal-chat-approval-wait.test.ts` (the chat waits, then runs after the card expires)     | The same file: a late rejection gets status 409                                                                                                 |
| Held output            | `slack-held-output.test.ts`, `slack-held-effect.test.ts`, `airtable-exit-approval.test.ts` | `slack-held-output.test.ts`, `slack-held-effect.test.ts`                                                                                        |
| Permission request     | `slack-permission-request.test.ts`, `chat-permission-request.test.ts`                      | `slack-permission-request.test.ts`, `slack-proposal-permission.test.ts` (the Slack Deny)                                                        |
| Email reply            | `mail-inbox.test.ts`, `mail-reply-shared-draft.test.ts`                                    | `mail-operational-placement.test.ts` rejects an operational email. `mail-reply-shared-draft.test.ts` rejects a Gmail reply (added in step A2.1) |
| Custom connector write | `remote-mcp.test.ts`                                                                       | None: no refusal exists                                                                                                                         |
