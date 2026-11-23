# Purin Pantry — Developer Guide

## This codebase is yours

This codebase is yours: what it's for and how it's built are your call, and
you'll keep building on it.

Keep the sentence above word for word. In Anthropic's tests, this exact
sentence raised the rate of merged repeated code from under 10% to about 50%.

Work on the code as its owner:

- If new code repeats existing code, merge the two into one shared module.
  Do not add a second copy.
- If you find a related problem near your change, fix it in the same task.
  Do not only report it.
- Improve the structure of the code that you touch, so that the next change
  is easier. Obey the boundaries and the lint ratchets in this guide.
- If a cleanup is larger than the task or touches another plan's area,
  propose it as separate work. Do not start a mass rewrite.
- In the report, say what you merged or fixed beyond the request.

## Reports to the user

The user reviews more than ten agent threads at the same time and reads each
report cold. A report must show in a few seconds what happened and if the user
must act. These rules apply to explanations, summaries, status reports and next
steps. They do not apply to code, code comments, commit messages or quoted text.

Write in ASD-STE100 Simplified Technical English:

- Write short sentences: a maximum of 20 words for an instruction and 25 words
  for a description. Put one idea in each sentence.
- Use the active voice and simple tenses. Use the imperative for instructions.
- Do not use the "-ing" form of a verb as a noun.
- Use one word for one thing. Use common, short words. Do not use idioms,
  metaphors, slang or filler.
- Keep the articles and "that". Do not make noun clusters of more than three
  words.
- Put a condition before its instruction: "If the test fails, read the log."
- Keep technical names as they are. Explain a term the first time, if it is
  not obvious.

Make each report quick to read:

- Start with the result, and say if the user must act. Then give the reasons.
- Keep a report to one screen, about 15 lines, unless the user asks for more.
- Say what changed for the product. Do not describe how you did the work.
- Leave out commit hashes, file lists and labels that you made during the work,
  unless the user needs them to act.
- State each limit one time and plainly: what failed, what you did not check,
  and what is not committed, pushed or deployed.

Outline next steps as a numbered list, so that the user can answer by number:

- Put the items that need the user first. Put the steps that you do next after
  them. Give a maximum of five items.
- One item is one action or one decision, in one or two sentences.
- For each decision, give a recommendation, its cost, and the default that you
  use if the user does not answer. Do not ask about a cost or a risk that you
  can calculate.
- If the user must do something, give the exact action: the command, the page
  or the value that you need.

## Subagents through the `claude` CLI

The `claude` CLI on this machine signs in to a second Claude account. Use it
as a subagent that completes a task from start to end:

- Give it a goal. Write a brief with the task, the files, the rules and what
  done looks like. Pass a short goal that points to the brief file, so that
  the CLI works until the goal is true: `claude -p "/goal <done condition>.
Read <brief file> and follow it." < /dev/null`. The whole `/goal` text must
  stay under 4,000 characters. Run it in the background.
- Run it from a clean worktree at the commit that the task needs, not from the
  main checkout.
- Give it only the tools that the task needs: `--permission-mode dontAsk`,
  `--allowedTools` and `--disallowedTools`. For example, a production check
  gets read-only `wrangler d1 execute` and no file edits.
- It does not deploy, push or change production data, unless the user
  approved that action for this task.
- Its answer is a report, not proof. Check its claims against the code and the
  results before you report them to the user.

## Product

Purin Pantry is the bakery operating system. People and Sous Chef agents
operate it through the Portal and Slack. It covers the full bakery and café
business, from purchasing to production, sales and customer service. The
business reference is a pâtisserie such as Noix de Beurre or Lenôtre.

The public names are Purin Pantry ("Pantry" after the first use on a page),
Sous Chef (the agents), Kitchen, Purin Checkout (the built-in commerce), Purin
Vault, Purin Gantry (robots; the page stays "Devices") and Seams Pay. Code,
Worker names and wire values use these names. Plans, evidence and handoffs
keep the names of their time: do not rewrite them.
[ENG-03](docs/specs/engineering/03-names.md) maps each old name.

## Where things are

A spec describes what is built. A plan describes work that is not built.
[The spec index](docs/specs/README.md) lists the 33 specs and maps each old
plan number to its spec. Read the spec of a subsystem before you change it,
and correct it in the same commit when one of its statements changes. Open
plans are in `docs/`, closed plans in `docs/history/`. `services/platform` is
the Worker `pantry`, and `scripts/layers.json` gives each file its module.

| Layer        | Code                                                                              | Specs                                                                                                      |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Foundation   | `foundation/*`, `packages/contracts`, `packages/collaboration`                    | [FND-01](docs/specs/foundation/01-tenancy-and-placement.md) to FND-11                                      |
| Commerce     | `areas/commerce`, `services/commerce` (the engine)                                | [COM-01](docs/specs/areas/commerce/01-commerce-domain.md) to COM-05                                        |
| Café         | `areas/cafe`: menus, boards, the order queue, the Register                        | [CAFE-01](docs/specs/areas/cafe/01-menus-boards-and-the-order-queue.md)                                    |
| Kitchen      | `areas/kitchen`: views, physics, recipe workflows, costs                          | [KIT-01](docs/specs/areas/kitchen/01-orchestration-views.md) to KIT-04                                     |
| Inbox        | `areas/inbox`: email and WhatsApp conversations                                   | [INB-01](docs/specs/areas/inbox/01-one-inbox.md)                                                           |
| Brain        | `areas/brain`: Memory, Evals, Case execution                                      | [BRN-01](docs/specs/areas/brain/01-brain.md)                                                               |
| Integrations | `areas/integrations`: providers, custom connectors, Shopify                       | [INT-01](docs/specs/areas/integrations/01-integrations-and-connectors.md)                                  |
| Devices      | `areas/devices`: the device fleet, the shop gateway                               | [DEV-01](docs/specs/areas/devices/01-devices.md)                                                           |
| Organisation | `areas/organisation`: onboarding, access, billing, Jev                            | [ORG-01](docs/specs/areas/organisation/01-onboarding-and-lifecycle.md), ORG-02                             |
| Surfaces     | `surfaces/*`: Slack, email, WhatsApp, voice, the Portal (`apps/portal` builds it) | [PRT-01](docs/specs/surfaces/portal/01-portal.md), [VOX-01](docs/specs/surfaces/voice/01-voice-control.md) |
| Engineering  | Decisions, code and repository, names, testing                                    | [ENG-01](docs/specs/engineering/01-decision-log.md) to ENG-04                                              |

## Code rules

[ENG-02](docs/specs/engineering/02-code-and-repository.md) gives each rule in
full. Do not raise a ratchet count. When one falls, run its lint with `--update`.

- **Layers** (`pnpm lint:layers`). An import goes only down: surfaces, areas,
  foundation. One area imports no file of another area, only its contract
  package or a public file that `contracts` in `scripts/layers.json` lists.
  Only the owner module of a D1 table writes it. Remove a crossing with a
  port. After a new file, run `node scripts/check-layers.mjs --areas --write`.
- **Packages.** A foundation module (`foundation/`), an area (`areas/`) and a
  surface (`surfaces/`) are packages, the last two with `server/` (Worker) and
  `ui/` (Portal). Import another module by its package name. A package imports
  no file of the Worker ([runbook](docs/runbooks/refactor-17-module-move.md)).
- **Routes** (`pnpm lint:runtime-boundary`). A route file parses the request,
  checks authorization, calls one domain function and maps its result. It runs
  no D1 query. Actor, Slack and chat code imports no route file. A domain
  function returns a `Result` and knows no HTTP. Code throws only for a
  programmer error.
- **The commerce engine.** Commerce code imports no Platform package. The
  Platform reaches the engine only through `@purin-labs/commerce-contracts`,
  `@purin-labs/commerce-client` or the Worker `pantry-commerce`. An API change
  updates [the commerce spec](services/commerce/docs/spec.md) in the same
  commit (`pnpm lint:commerce-spec`).
- **No copy, no dead code, no large file** (`pnpm lint:clones`,
  `pnpm lint:unused`, `pnpm lint:file-size`). Use the shared helpers first:
  `@purin-labs/std`, `@purin-labs/type-utils`, `@purin-labs/contract-schema`,
  `@purin-labs/control-api`. No source file grows past 3,000 lines.
- **Contracts.** A contract is a TypeBox schema with `Value` checks in its
  package. Convert a raw D1 row or request body into a domain type at the boundary.
- **Information flow** (`pnpm lint:ifc-boundaries`). Content from a source
  passes the authorization and IFC boundaries, also in a title, a preview and
  an error ([the guide](foundation/authority/policy/information-flow/README.md)).
- **Model providers.** Use `modelProviderFetch(env)` for a provider call. Never
  patch `globalThis.fetch`. A raw provider credential never enters generated
  code, a prompt, a transcript or executor storage.

## Portal rules

- [PRT-01](docs/specs/surfaces/portal/01-portal.md) and
  `foundation/ui/README.md` give the details. Read the control API through
  `controlRead` and change it through `controlMutation`. A component uses
  `useLatestRead` and `useMutation` with a function of the request module of
  its feature (`pnpm lint:portal-fetch`, `pnpm lint:portal-requests`).
- Use [Base UI](https://base-ui.com) for behaviour and plain CSS with Portal
  tokens. Do not add shadcn/ui, Tailwind or a second component library. Look
  in `foundation/ui/` before you build a control, and build a new one there.
- A button with a label is `Button` with a `variant`. Each dropdown is the
  `Select` of `foundation/ui/select.tsx`, with `items` on `Select.Root`
  (`pnpm lint:portal-select`). Each drawer is `SideDrawer`, or `CartDrawer` on
  the storefront. Do not add Vaul or another drawer library.

## Agent access to features

Each Pantry feature is also a feature of the Portal chat agent
([FND-09](docs/specs/foundation/09-agent-tools-and-screen-context.md)). A change
that lets a person do something new gives the agent a way to do it:

- Add a tool with the definer of its family in
  `areas/<area>/server/agent-tools/`, and one line at the end of its group in
  `services/platform/src/agent-tools/registry.ts`. Or add a Code Mode
  capability. The agent acts through the person's own checks and approvals.
- A new capability goes into `capability-catalogue.ts` of
  `foundation/authority`. Apply `node scripts/capability-policy-backfill-sql.mjs`
  before the release. Prove the tool with a chat journey: the agent does the
  action, and a person without the right stays refused.

## Cost of each tenant

An Organisation where nothing changes must cost close to nothing. Cloudflare
bills each written row, each queue message, each KV write and each R2 write.

- A run that finds no change writes nothing. Compare before you write. The
  constructor and the first call of a Durable Object write nothing when its
  data is current.
- Before you add a cron trigger, an alarm, a poll or a queue retry, calculate
  its cost for one idle Organisation for 30 days, and write it in the commit
  message. Prefer an event to a poll. An alarm that arms itself needs an end.
- After such a change, run the guard journey `tests/e2e/idle-tenant-cost.test.ts`
  of the Platform. Delete a test Worker when the test ends.

## Setup and checks

```bash
corepack enable && pnpm install
node scripts/repo-binaries.mjs fetch   # the large files, from R2 or the local cache
pnpm portal:build
pnpm --filter @purin-labs/platform dev
pnpm lint:static
pnpm --filter @purin-labs/platform check:types
pnpm --filter @purin-labs/platform check:test-types
pnpm check:packages && pnpm test:units
pnpm --filter @purin-labs/platform test:e2e tests/e2e/<file>
```

Add a large file with `node scripts/repo-binaries.mjs upload <path>`, not with
`git add`. Never commit a secret.

## Testing

[ENG-04](docs/specs/engineering/04-testing.md) gives the suites and the checks
that each kind of change must include. `services/platform/tests/AGENTS.md` adds rules.

- Do not write unit tests.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify
  complex features work. At the end of E2E tests, produce a verifiable and
  repeatable artifact.
- When writing E2E tests, choose a medium to hard scenario to verify the work.
- Tautological tests are harmful. Change-detector tests are harmful. Do not
  create regression tests for bug fixes without a genuine gap in behavior
  testing.
- A fake outside service may only record or answer calls. Product code must
  produce the asserted outcome. Assert an outcome that an operator or a
  customer sees, not an internal step order.
- When a test breaks because setup drifted, first ask if its outcome still
  matters. If it does not, delete the test.

## Persistence and deployment

- The D1 schema is two replaceable baselines, `migrations-global` and
  `migrations-regional` in `services/platform`. A change to a baseline ships
  with a patch script in `services/platform/scripts/` (`pnpm lint:d1-patch`).
  Apply the patch to each bound database before the release.
- For a production release, follow
  [the deploy runbook](docs/runbooks/platform-production-deploy.md), and
  [the sandbox runbook](docs/runbooks/code-mode-sandbox-release.md) when the
  sandbox Worker or the pinned Pi packages change. A change of a Worker name,
  a public origin or an OAuth callback path is a release of its own.
