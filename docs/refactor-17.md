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
  tenant journey.
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
  voice Macs and the cue claim pass: 11 tests. The full E2E suite did not run on the
  branch.

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
