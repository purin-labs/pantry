# PRT-01 — The Portal

The Portal is the operator app of Purin Pantry. A person signs in, chooses an
Organisation and a workspace, and runs the shop from one persistent shell. The shell
holds the navigation, the page search, the account menu, the appearance control and the
chat beside the page. The Portal shows typed views from the control API, and the server
decides each permission. Each product area owns its pages and its records. This spec
owns the shell, the page patterns, the design rules and the way that a page reads and
changes data.

## What it does

### Addresses

The Worker serves the Portal build as static assets, with a single-page fallback. The
paths `/v1/*`, `/hook/*`, `/slack/*`, `/health`, `/__scheduled` and
`/cdn-cgi/local/scheduled` go to the Worker first. Without a session, each Portal
address shows the sign-in page. In the table, `W` is
`/portal/:organisationHandle/:workspaceHandle`.

| Address                                             | What opens, with a session                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/`, `/sign-in`, `/portal`                          | The Organisation list                                                                     |
| `/portal/:organisationHandle`                       | Home of the workspace that this browser used last, or of the first workspace              |
| `W`, `W/<segment>`                                  | Home, or the page of that segment                                                         |
| `W/products/:id`, `W/orders/:id`, `W/suppliers/:id` | The detail page of one record                                                             |
| `W/access/capabilities`, `W/access/data-flow`       | The two subviews of Access and data flow                                                  |
| `W/commerce`, `W/content`, `W/operations`           | Home. These pages are retired, and their old links stay valid                             |
| `W/takings`                                         | A replacement redirect to `W/payouts`                                                     |
| Any other address                                   | An in-shell page: "Page not found", "Organisation unavailable" or "Workspace unavailable" |

A handle has at most 63 characters and matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`. A record id
in an address is URL-encoded two times, so an id can hold a slash.

`apps/portal/src/bootstrap.tsx` starts these entries before the Portal code loads:

| Entry                                                                                                   | Purpose                                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/portal/square-pos-return`                                                                             | Returns from the Square Point of Sale app to the Register, with the answer of the app |
| `/workflow-simulator`, `/bakery`, `/floor-plans`, or an address with `?demo=1` other than the one above | The workflow demo, with no sign-in                                                    |
| `/docs/privacy`, `/docs/terms`, `/docs/deletion`, `/docs/contact`                                       | The public policy pages                                                               |
| `/identity/link`                                                                                        | The page that links a Slack account to a Pantry person                                |

The build has three more HTML entries: `tv.html` (a paired menu screen),
`eagle-rehearsal.html` and `linea-rehearsal.html`. It also ships
`public/approval-signed-in.html`, the return page of the approval sign-in popup. The
other HTML files in `apps/portal` are development pages, and the production build leaves
them out.

### Pages and navigation

`WORKSPACE_PAGE_DESCRIPTORS` in `foundation/ui/route.ts` is the one list of pages. It
gives each page its segment, navigation label, title, description, group and optional
detail record. It has 32 page values. The navigation shows 28 of them:

| Group     | Pages, with the segment                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace | Home (none), Inbox `inbox`                                                                                                                                                                                           |
| Commerce  | Orders `orders`, Payments `payments`, Payouts `payouts`, Products `products`, Checkout `checkout`                                                                                                                    |
| Café      | Register `register`, Menus `menus`, Order queue `order-queue`, Counters & payments `terminals`                                                                                                                       |
| Kitchen   | Recipes `recipes`, Costs & margins `costs`, Production `workflow-simulator`, Production requests `production-requests`, Ingredients & supplies `inventory`, Purchasing `suppliers`, Devices `devices`, Bakes `bakes` |
| Agents    | Agents `agents`, Knowledge `knowledge`                                                                                                                                                                               |
| Settings  | Integrations `integrations`, Vault `vault`, API keys `api-keys`, Jev `jev`, Billing `billing`, Access and data flow `access`, Workspace settings `settings`                                                          |

The other four pages have no navigation entry:

- `chat` opens from the **Ask** control.
- `brain` and `tests` redirect to Knowledge, in the view that the old link names.
- `activity` redirects to the Activity view of the Agents page.

`PAGES` in `surfaces/portal/ui/pages.tsx` gives each page value one render function, so the
type check refuses a page without one. Page code loads on demand.

### The workspace shell

- **Rail.** Above 1160 px, the sidebar is a rail of 252 px that collapses to 57 px over
  200 ms. The browser keeps the choice in `pantry:cafeos:sidebar-expanded`.
- **Drawer.** At 1160 px and below, the sidebar is a full-width panel under the top bar.
  It starts closed. A navigation link or the product switcher closes it. The page search
  and the Organisation and workspace switcher do not close it. A click with a modifier
  key stays with the browser. The drawer does not change the stored rail choice.
- **Sidebar head.** It holds the Purin Pantry brand, the Organisation and workspace
  switcher, and the product switcher.
- **Product switcher.** It offers All organisations (the Organisation list), Commerce
  (opens Orders), Café (opens Home) and Kitchen (opens Production). "Home" names only the
  workspace's Home page.
- **Groups.** The sidebar shows Workspace, the active product, Agents and Settings. The
  active product follows the current page. On a page outside the three products, it
  stays the last product that the person used. It starts as Commerce.
- **Counts.** Knowledge shows the Brain items to review. Access and data flow adds the
  held outputs to the permission requests that this person may decide. It counts the
  held outputs also for a person who may not decide requests. A count of zero shows no
  number. The list reads again every 60 s while the tab is visible.
- **Top bar.** It is 48 px high and holds the page search, the appearance control,
  **Ask** and the account menu. In drawer mode it also holds the sidebar toggle. In rail
  mode the toggle is in the sidebar head.
- **Docked and canvas pages.** Above 1160 px, a page can draw the console tools in its
  own top row. The top bar then goes. A canvas page, such as the board editor, also
  hides the rail, but full-screen chat keeps the rail. At 1160 px and below, the shell
  keeps its top bar and its drawer.
- **Account menu.** It shows the name and a usage ring that reads again every 60 s. It
  links to permission requests, the Organisation list and the docs, and it signs out.
- **Focus, title and toasts.** A route change moves focus to the page `h1`, or to the
  main element if the page has no `h1`. While the chat is open, a route change does not
  move focus. Each workspace load moves focus, also on the chat route. A workspace page
  has the title `<page> · <workspace> · Purin Pantry`. The shell mounts one Sonner stack
  at the bottom right. A preference failure toast appears at the top center.
- **Commerce actions.** On each workspace page, a `?commerceAction=<nonce>` link opens
  the action status. An approval can need a step-up sign-in in a popup. If the browser
  blocks the popup, the sign-in uses the full page, and the approval resumes after the
  return. An approval on the action status also executes the action.
- **Onboarding.** When a workspace opens, the shell evaluates readiness if it needs a
  new check. If a `configuring` workspace is ready, the shell starts activation. During
  activation, it reads the projection at intervals from 500 ms up to 3 s. On Home, the
  sidebar footer shows the onboarding steps until the workspace is active or archived.
- **Other views.** An account invitation address replaces the page for a signed-in
  person. On the Organisation list, a `support_admin` gets tools to inspect and archive
  an ownerless older Organisation.
- **Kept views.** `BakeryWorkspaceReveal` keeps the Kitchen workflow scene mounted and
  hidden after its first open. While the chat is open, the scene can replace the current
  page, with a button that returns to it. The shell mounts `VoicePageMark` when the chat
  is open or voice control is on.

### Page search

The search button, `⌘K` and `Ctrl+K` open one modal dialog. It searches the 28 pages of
the navigation by label, title, segment, description and group. An exact label comes
first, then a label that starts with the query. It searches no records and no provider
data. Arrow keys, Home and End move the active option, and Enter opens it. Escape closes
the dialog and returns focus to the search button.

### Chat beside a page

**Ask** opens the `chat` route and keeps the address of the page in the router state
(`chatReturnPath`). The page stays on screen. A page link then moves the page beside the
chat and keeps the chat open. Closing the chat returns to that page. Full-screen chat
starts with the rail collapsed. An expansion there does not change the stored rail
choice. FND-03 and FND-09 own the conversation and the screen context.

### Home

Home is the daily brief. `GET /v1/control/organisations/:id/home` builds it on the
server, and a viewer may read it. The sections appear in this order:

1. **Needs attention**: commerce actions in the ledger that wait for a person or need
   recovery. The list holds the states `proposed`, `approval_requested`, `signed`,
   `failed` and `indeterminate`, with the urgent items first, then the newest.
2. **Commerce today**: five counts from the commerce query layer. They are open customer
   orders, product shortages, supplies to replenish, payment failures and delayed
   shipments. A count that fails shows "Unavailable", not zero.
3. **Workspace status**: blockers from the lifecycle, the readiness check and the action
   ledger. Each blocker gives its reason, its impact and one next action.
4. **Source line**: the state and time of the approval workflow and the readiness check.

| Lifecycle     | What Home shows                                                                            |
| ------------- | ------------------------------------------------------------------------------------------ |
| `configuring` | The setup surface of Integrations, then any attention items                                |
| `activating`  | The setup surface, any attention items, the blockers and the source line                   |
| `active`      | Needs attention (also when empty), the counts, the blockers, the source line and approvals |
| `archived`    | Any attention items, the blockers, the source line and approvals                           |

"Approvals" is the **Approvals and activity** section below the brief. Its heading has
the id `OPERATIONS_SECTION_ID` (`foundation/ui/route.ts`). A Home link to it, such as
**Review change**, **Review recovery** or **Open operations**, moves the section into view
and focuses its heading, also when the address with the hash opens Home. While the
workspace is `configuring` or `activating`, the section is absent, and Home shows no link
to it. The client can show a warning for a `delayed` source on an active workspace. The server sends only
`current` or `unavailable`, so this warning does not appear. During a refresh, Home
keeps the last answer and shows an updating notice.

### Appearance and preferences

- A person chooses the mode (`system`, `light` or `dark`) and the palette
  (`slate-coral`, shown as Slate, `espresso` or `paper`). The default is `system` and
  `slate-coral`.
- Preferences belong to the person and follow the person to another browser. The areas
  are `appearance`, `chat` and `bakeryos` (the Kitchen scene).
- Kitchen pages can have their own light or dark mode. The palette stays the account
  palette.
- A script in `apps/portal/index.html` sets the theme before the first paint, from the
  local copy, on `/`, `/sign-in` and the `/portal` addresses: each address where the
  Portal shows the Organisation list or a workspace.
- If a save fails, the choice stays for the session, and the Portal says that it did
  not sync. After a revision conflict, the Portal applies the edit again one time.

### Page states and feedback

- `PortalState` in `portal-types.ts` is the state of the app: `loading`, `signed_out`,
  `load_failed`, `route_not_found`, `organisation_list` or `workspace_detail`.
- `PageContent<T>` in `page-content.ts` is the state of a page. Its kinds are `loading`,
  `ready`, `empty`, `failed` and `unauthorized`. `ready` has freshness and an updating
  flag, and `failed` has a recovery action.
- `page-components.tsx` holds `PageHeader`, `PageSkeleton`, `EmptyState`,
  `RecoverableError`, `Notice`, `TechnicalDetails`, `StatusChip`, `WorkQueue` and
  `ProviderTile`.
- A failed page read shows a message and a retry beside the part that failed. A failed
  preference read or save shows a toast with **Retry** at the top center. That toast
  stays until the person closes it or the preference syncs. Other toasts give a short
  result, and a failed commerce action also uses one.
- IDs, provider references and receipts go under a disclosure.
- A two-step button (`ConfirmButton`) asks again and returns to its first state after
  5 s. An archive needs the typed Organisation name (`ArchiveConfirm`).
- After `configuration_conflict`, the Portal reads the workspace again and says that
  another session changed it.
- After a release, a tab that asks for an old code file reloads one time for each
  release (`stale-release.ts`).
- A review of a page checks its populated, empty, loading, failed and restricted states
  where they exist. It also checks the keyboard, a narrow width, the dark theme and
  reduced motion.

### Design system

`packages/frontend-theme.css` is the entry point of the tokens. The Portal and the
storefront both import it. `docs/style-guide.md` gives the full colour, type and motion
guidance.

| Token family | Values                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Theme        | `data-pantry-theme` selects the palette, `data-portal-theme` the light or dark appearance                                |
| Theme files  | `slate-coral.css`, `espresso.css`, `paper.css` and `sageberry.css` in `packages/frontend-themes/`                        |
| Radius       | `--pantry-radius-control` 10px, `-notice` 12px, `-card` 16px, `-panel` 20px, `-pill` 9999px                              |
| Spacing      | `--pantry-space-{1,2,3,4,6,8,12}`: 4, 8, 12, 16, 24, 32 and 48 px                                                        |
| Text         | `--pantry-text-caption` 12px, `-label` 14px, `-body` 16px, `-heading` 24px, `-title` 36 to 44px                          |
| Motion       | `--pantry-motion-fast` 150 ms; springs `quick` 210 ms, `smooth` 340 ms, `glide` 390 ms. Reduced motion sets each to 0 ms |

`docs/style-guide.md` sets these rules for design work. No lint enforces them:

- Components use semantic `--pantry-*` roles. A raw shade belongs only in a theme file.
- Coral marks selection, links, focus and small accents. Coral never means an error.
- A status always has a label or an icon. Colour alone never carries the meaning.
- Text uses sentence case, with no exclamation marks and no raw `snake_case` code.

The shell changes between the rail and the drawer at 1160 px. `styles.css` has
`max-width` breakpoints at 360, 420, 520, 560, 680, 720, 760, 900, 1100 and 1160 px. The
most used are 560 and 680 px. Home and Integrations are at most 1040 px wide.

## Contracts

### Component and data rules

These rules come from `AGENTS.md`. [The UI
README](../../../../foundation/ui/README.md) stays beside the components and
describes each one.

| Rule                                                                                                                                                                                                                        | Where                                                                        | Lint                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| Behaviour comes from Base UI (`@base-ui/react`), and style from plain CSS with Portal tokens. Do not add shadcn/ui, Tailwind or a second component library                                                                  | `foundation/ui/`                                                             | None                        |
| Import a prebuilt component from `foundation/ui`. Build a new one there, with its own CSS file                                                                                                                              | `ui/index.ts`                                                                | None                        |
| Each dropdown is the one `Select`, and `Select.Root` has `items`. No native `<select>`, no `<option>` outside a `<datalist>`, no direct `@base-ui/react/select` import, no page CSS for a `select` element or for the caret | `ui/select.tsx`, `ui/select.css`                                             | `pnpm lint:portal-select`   |
| A new button with a label is `Button`, with `primary`, `secondary`, `danger` or `link`                                                                                                                                      | `ui/button.tsx`                                                              | None                        |
| A new drawer is `SideDrawer`. Do not add Vaul or another drawer library                                                                                                                                                     | `ui/side-drawer.tsx`                                                         | None                        |
| A feature reads with `controlRead` and changes with `controlMutation`. No new raw `fetch`                                                                                                                                   | `control-client.ts`                                                          | `pnpm lint:portal-fetch`    |
| A component reads with `useLatestRead` and changes with `useMutation`. The request is a function in the request module of its feature                                                                                       | `ui/use-latest-read.ts`, `ui/use-mutation.ts`, `features/<area>/requests.ts` | `pnpm lint:portal-requests` |
| A source file or style sheet over 3,000 lines may not grow                                                                                                                                                                  | `scripts/check-file-size-ratchet.mjs`                                        | `pnpm lint:file-size`       |
| An import goes only down the layers                                                                                                                                                                                         | `scripts/layers.json`                                                        | `pnpm lint:layers`          |

When a file loses a counted call, run the script of its ratchet with `--update`:
`scripts/check-portal-fetch-ratchet.mjs` or `scripts/check-portal-requests-ratchet.mjs`.
`pnpm lint:source` runs all of these lints.

### The control client

`foundation/control/portal/control-client.ts` is the one client of the control API.

| Function                                        | Use                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `controlRead`                                   | A JSON read. A read without an `AbortSignal` is shared with callers of the same path             |
| `controlReadIfChanged`                          | A read with `if-none-match`, which can answer `unchanged`                                        |
| `controlMutation`, `controlUpload`              | A JSON write with CSRF, idempotency and an optional configuration version, and a multipart write |
| `controlWrite`, `controlSecretMutation`         | A write with a fresh key and no stored copy of the body. The second carries a secret             |
| `controlSend`, `controlSignal`, `controlStream` | A raw body, a POST that changes no record, and an NDJSON stream                                  |

- `controlMutation`, `controlUpload`, `controlWrite` and `controlSecretMutation` send
  the `pantry_csrf` cookie value as `x-pantry-csrf`, and an `idempotency-key`. A
  versioned write also sends `x-pantry-configuration-version`.
- `controlSend` and `controlSignal` send no `idempotency-key`. They send `x-pantry-csrf`
  only when the cookie exists.
- `controlMutation` keeps its key in `sessionStorage` (`pantry:mutation:<intent>`) until
  the request succeeds. A retry of the same body reuses the key.
- `controlMutation`, `controlUpload`, `controlWrite` and `controlSecretMutation` forget
  each shared read when the write starts and when it ends. The last two are
  `controlMutation` with a fresh key.
- `forgetControlReads` clears each kept response. The Portal calls it on a missing
  session, a retry, account setup, a sign-out in this tab and two Costs paths.
- `useLatestRead` drops an answer that arrives out of order. `useMutation` runs one
  write for each key and gives each attempt its own idempotency key.
- `MutationLedger` (`mutation-state.ts`) tracks the Organisation settings writes in the
  state of `ControlPortalApp`. It refuses a second write in the same scope.

`early-reads.ts` starts the session read, the shell reads and the first reads of Home,
Integrations and the Brain pages while the Portal code loads. It uses an Organisation id
that this browser kept. The server authorizes each read as usual.

### Routes

| Route                                      | Role                 | Purpose                                                            |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------ |
| `GET /v1/control/session`                  | Signed in            | The person, the memberships and the support role                   |
| `GET /v1/control/organisations/:id/home`   | Viewer               | The Home view                                                      |
| `GET /v1/control/user/preferences/:area`   | Signed in            | One preference document. The first read stores the defaults        |
| `PATCH /v1/control/user/preferences/:area` | Signed in, with CSRF | One edit. Needs `expectedUserId`, `expectedRevision` and `command` |

A `PATCH` answers `409` with the current document on a revision conflict, and `409`
`preferences_user_changed` when another person holds the session. An edit that changes
no value writes nothing. An unknown area answers `404`.

### Records

- Global D1 `user_preferences`
  (`workers/platform/migrations-global/0001_current_schema.sql`) has `user_id`, `area`,
  `schema_version`, `revision`, `values_json` and `updated_at`, with the key
  `(user_id, area)`. `scripts/layers.json` gives it to `areas/organisation`.
- `packages/control-api/src/user-preferences.ts` holds the preference contract.
  `packages/control-api/src/portal/home.ts` parses the view `pantry.cafeos.home.v1`.
  The Portal adds no Actor SQLite table.

| Browser key                                         | Store            | Holds                                  |
| --------------------------------------------------- | ---------------- | -------------------------------------- |
| `pantry:cafeos:sidebar-expanded`                    | `localStorage`   | The rail choice                        |
| `pantry:portal-appearance`, `pantry:portal-palette` | `localStorage`   | The first-paint copy of the appearance |
| `pantry:preferences:<userId>:<area>`                | `localStorage`   | The last accepted preference document  |
| `pantry:organisation-id:<handle>`                   | `localStorage`   | The id for early reads                 |
| `pantry.portal.last-used-workspace:<handle>`        | `localStorage`   | The last workspace                     |
| `pantry:mutation:<intent>`                          | `sessionStorage` | A write key and its fingerprint        |
| `pantry:stale-release-reload`                       | `sessionStorage` | The release that already reloaded      |

### Main files

| File                                                                                         | Owns                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `foundation/ui/route.ts`, `surfaces/portal/ui/pages.tsx`                                     | The page list, the address parser and the render function of each page                           |
| `surfaces/portal/ui/portal.tsx`                                                              | The router and the `ControlPortalApp` state                                                      |
| `surfaces/portal/ui/shell.tsx`, `foundation/ui/console-sidebar.tsx`                          | `PortalFrame`, `WorkspaceLayout`, the page search, the product switcher, the rail and the drawer |
| `areas/organisation/ui/workspace-switcher.tsx`                                               | The Organisation and workspace switcher                                                          |
| `surfaces/portal/ui/portal-shell.tsx`                                                        | Sign-in, loading, failure and not-found views                                                    |
| `surfaces/portal/ui/pages/home.tsx`, `areas/organisation/server/control/routes/workspace.ts` | The Home page and its server view                                                                |
| `foundation/ui/preferences/`                                                                 | The preference owner and the appearance control                                                  |
| `surfaces/portal/ui/styles.css`, `packages/frontend-theme.css`                               | The Portal styles and the shared tokens                                                          |

In `scripts/layers.json`, `portal.tsx`, `shell.tsx`, `portal-shell.tsx` and the chat are
`surfaces/portal`. `console-sidebar.tsx`, `console-tools.tsx`, `route.ts`,
`foundation/ui/` and `foundation/ui/preferences/` are `foundation/ui`.
`workspace-switcher.tsx` is `areas/organisation`. The feature folders of a product area
are in `areas/<area>/ui/features/`.

## Rules and limits

### Permissions

The navigation does not hide a page by role. A page disables or removes a control by
role, and the server checks each request.

| Action                                                                                          | Viewer | Operator | Admin | Owner |
| ----------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ----- |
| Open a page, read Home, change own preferences                                                  | Yes    | Yes      | Yes   | Yes   |
| Edit recipes and costs, receive stock, operate production requests (`canOperateCommerce`)       | No     | Yes      | Yes   | Yes   |
| Manage settings and integrations, decide a commerce action (`canManageOrganisation`)            | No     | No       | Yes   | Yes   |
| Connect the ChatGPT account, use the owner controls of Jev and Billing, offer a price allowance | No     | No       | No    | Yes   |

An agent does not use the shell. It acts through its tools and page commands, with the
role checks, approvals and receipts of the person who asked (FND-09).

### Time and size limits

| Limit                                  | Value                        | Constant                                               |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------ |
| Needs attention items                  | 5                            | `HOME_ATTENTION_LIMIT`                                 |
| Home blockers                          | 8                            | `HOME_BLOCKER_LIMIT`                                   |
| One preference document                | 8,192 bytes                  | `MAX_PREFERENCE_BYTES`                                 |
| Docked chat width                      | At least 340 px, default 600 | `isDockedChatWidth`, `DEFAULT_CHAT_PREFERENCES`        |
| Full-screen chat sidebar               | 200 to 500 px, default 360   | `isFullscreenSidebarWidth`, `DEFAULT_CHAT_PREFERENCES` |
| Two-step confirmation                  | 5 s                          | No name; `requestSettingsConfirm`                      |
| Usage ring read                        | 60 s                         | No name; `watchCodexUsage`                             |
| An early read waits for its page       | 10 s                         | `EARLY_READ_LIFETIME_MS`                               |
| A taken early read serves other mounts | 2 s                          | `SHARED_MOUNT_MS`                                      |
| A read that the shell offers to a page | 5 s                          | `OFFERED_READ_LIFETIME_MS`                             |
| Last responses kept in the tab         | 64 paths                     | `LAST_READ_LIMIT`                                      |

### Information flow and secrets

- The browser shows what the server view gives. It does not work out a lifecycle or a
  provider outcome.
- A kept response is for display while the page reads again. The server authorizes each
  new read.
- `controlWrite` and `controlSecretMutation` keep no copy of the body in the tab.

### Out of scope and neighbours

The Portal owns no domain lifecycle and no provider effect.

| Neighbour                              | Owns                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| FND-03, FND-06, FND-07                 | The chat conversation; sign-in, roles and approvals; information-flow labels |
| FND-09, FND-10, FND-11                 | Agent tools and screen context; shared drafts; the contract packages         |
| ORG-01, ORG-02, INT-01                 | Onboarding, members and lifecycle; Jev and its billing; connectors           |
| COM-01 to COM-05, Plan 90              | The Commerce pages and their records; the Register                           |
| CAFE-01, KIT-01 to KIT-04              | Menus, boards and the order queue; the Kitchen pages                         |
| INB-01, BRN-01, DEV-01, VOX-01, ENG-02 | The Inbox, Brain, Devices, voice control and repository lints                |

The buyer storefront in `apps/storefront` is a separate app, with `CartDrawer` as its
drawer. It shares the theme tokens.

## Open work

- Plan 21 defers configurable dashboards and analytics, native apps, role-specific route
  trees, end-user layout changes, and navigation entries for scheduling, returns and
  export.
- 44 component files still make 96 direct control calls, under the requests ratchet.
- 1,187 raw `<button>` elements remain outside `dev/`. New code uses `Button`.
- The Device drawer (a raw `<dialog>`), the board element drawer (an `<aside>`) and the
  navigation drawer of the shell (`ConsoleSidebar`) do not use `SideDrawer`.
- If another tab replaces the session, `load()` takes the new identity and does not
  call `forgetControlReads`. The tab keeps the responses of the old person.
- The Organisation settings keep `MutationLedger` and do not use `useMutation`.
- `@radix-ui/react-dropdown-menu` remains in 14 files, among them `ActionMenu`, the
  product switcher and the appearance control.
- Nine browser `confirm` calls remain in five files, against the style guide.
- 205 CSS rules in 53 files outside `dev/` have a font weight above the limit of 500.
- 309 lines in 37 Portal CSS files outside `dev/` hold a hex colour, against the rule
  for raw shades.
- The server sends an empty `today` list. Home items have no assignee.

## Sources

- [Plan 21](../../../history/plan-21-cafeos-ux-foundation.md),
  [the Portal UI inventory](../../../history/portal-ui-inventory.md) and
  [the style guide](../../../style-guide.md). Where they differ from the code, this spec
  follows the code.
- Evidence in the archive:
  [Plan 21 browser acceptance](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-21-browser-acceptance-2026-08-11.md),
  [decision and connection review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-review.md),
  [configuration and approval review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-configuration-review.md),
  [remaining-state ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-closure.md),
  [transaction and product-draft review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-transaction-review.md),
  [purchasing, goal and member-action review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-purchasing-goal-review.md),
  [Chat decisions and shipment review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-chat-decisions-review.md),
  [navigation, questions and table review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-navigation-review.md),
  [file access and Inbox detail review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-file-access-review.md).
- E2E journeys in `workers/platform/tests/e2e/`: `user-preferences.test.ts`,
  `portal-chat-approval-wait.test.ts`, `portal-chat-finalization.test.ts`,
  `portal-order-cancel.test.ts` and `portal-supplier-payout-read.test.ts`.
- Browser journeys in `scripts/`: `plan21/browser-acceptance.mjs`,
  `frontend-foundation/portal-journey.js`, `frontend-foundation/portal-ui-journey.js`,
  `frontend-foundation/portal-pages-journey.js`,
  `frontend-foundation/portal-account-setup-journey.mjs`,
  `frontend-foundation/portal-menu-journey.mjs`,
  `frontend-foundation/chat-trace-journey.js`, `frontend-foundation/trace-journey.js`
  and `permission-toasts/browser-permission-toasts.js`.
