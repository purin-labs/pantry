# Satyr Portal: page and component inventory

Date: 2026-10-23. Scope: the Satyr operator app in `apps/portal`.

The app defines **20 workspace pages**, three record-detail routes, and two additional Access routes.
Account, identity, and public pages sit outside the workspace.
The buyer storefront in `apps/storefront` is a separate app.

The route registry is [`route.ts`](../apps/portal/src/route.ts).
The mounted page controller is [`portal.tsx`](../apps/portal/src/portal.tsx).
Both sources matter: a registered route does not prove that a page has content.

In the tables, `W` means `/portal/:organisationHandle/:workspaceHandle`.
Query parameters select some subviews without a separate path.

## Workspace pages

| Page                   | Address                 | Main UI components                                                                                                                                    | Review focus                                                                                                          |
| ---------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Home                   | `W`                     | Connection/setup overview, attention queue, commerce counts, workspace blockers, source freshness                                                     | Lead with actionable work. Use business language for counts. Keep unavailable data distinct from zero.                |
| Chat                   | `W/chat`                | Project and Case navigation, transcript, composer, attachments, model selection, execution activity, permission prompts, artifact drawers, side Cases | Preserve the composer at narrow widths. Keep task output, tool activity, and approval controls distinct.              |
| Inbox                  | `W/inbox`               | Mailbox selector, search, message filters, message list, reading pane, reply editor, attachments, processing and status menus                         | Preserve the list/detail path and reply controls. Check empty search results, unavailable mail, and long subjects.    |
| Checkout               | `W/checkout`            | Buying experience summary, profile selector, draft/published state, settings editor, publish review, storefront activation                            | Keep the configure → publish → activate sequence clear. Provide a retry after a failed read.                          |
| Products               | `W/products`            | Availability metrics, search, location/status filters, product table, stock drawer, lots, movements, reservations                                     | Keep quantities aligned. Distinguish available, reserved, and short stock.                                            |
| Menus                  | `W/menus`               | Shared title, participant presence, sync state, section board, item cards, move controls, review snapshot, leave dialog                               | Make an empty menu useful. Use product language for the review step.                                                  |
| Counters & payments    | `W/terminals`           | Counter list, status, counter sale, payment collection, terminal setup, payment notifications, retire confirmation                                    | Keep current sales separate from setup. Provide a retry after a failed read.                                          |
| Ingredients & supplies | `W/inventory`           | Stock metrics, filters, supply table, stock drawer, lots/expiry, movements, receipt and reconciliation forms                                          | Use the same stock presentation as Products. Keep receive and reconciliation actions distinct.                        |
| Production requests    | `W/production-requests` | Demand requests, status filters, request dialog, schedule/accept controls, confirmed output                                                           | Separate requested quantities from confirmed output. Preserve units and status in narrow layouts.                     |
| Orders                 | `W/orders`              | Search, customer order table, column controls, record counts, order links                                                                             | Avoid a repeated page heading. Use sentence case for fallback status labels. Provide a retry after a failed read.     |
| Purchasing             | `W/suppliers`           | Supplier directory, replenishment collection/board, saved views, supplier payouts, payout exceptions, audit links                                     | Keep purchases and payouts legible as separate sections. Provide a retry for each failed region.                      |
| Production             | `W/workflow-simulator`  | Workflow canvas, resource timeline, floor plan, 3D equipment views, playback, inputs, inspector, scenarios, comparison, import/export                 | Preserve synchronized views and visible playback controls. Review the existing local edits separately from this pass. |
| Agents                 | `W/agents`              | Agent cards, suggested updates, agent editor, instructions, tools, triggers, limits, templates                     | Align controls, selection colors, and card shapes with the shared design system. Reserve success colors for status.   |
| Brain                  | `W/knowledge`, `W/agents?view=activity`               | Overview, Learning, Knowledge, Evals, Activity, Context, review queue, memory detail, evaluation runs, execution inspection                           | Keep decisions accessible beneath the summary. Check all six views, long records, and narrow tab navigation.          |
| Integrations           | `W/integrations`        | Connected apps, setup cards, app catalog, search dialog, connection dialog, account list, custom connector editor, AI connection choices              | Separate setup, connected apps, and catalog. Keep search, connection state, and recovery clear.                       |
| Access and data flow   | `W/access`              | Connected systems, search/filter, grants, access check, decision explanation, AI budget form                                                          | Group budget fields and their help text. Keep the save action beside the current settings.                            |
| Workspace settings     | `W/settings`            | Members, role controls, invitations, invite form, archive/restore controls, confirmation dialog                                                       | Preserve role clarity and destructive-action confirmation. Check long names and invitation links.                     |

## Record details and routed subviews

| Surface               | Address                 | Main UI components                                                                                                            |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Product detail        | `W/products/:id`        | Product header, attributes, related records, operational details, availability, description draft, price allowances, activity |
| Customer order detail | `W/orders/:id`          | Order status, payment/fulfillment records, cancellation controls, related records, activity and technical evidence            |
| Supplier detail       | `W/suppliers/:id`       | Supplier identity, attributes, related items, purchasing context, activity and technical evidence                             |
| Capabilities          | `W/access/capabilities` | Capability list, policy controls, grants, decision explanations                                                               |
| Data flow             | `W/access/data-flow`    | Source policies, destination permissions, related Cases, policy editor, explanation panel                                     |

The following are substantial subviews, not additional top-level pages:

- Agents: agent detail, instructions, skills, tools/access, triggers, limits, work history, and skill library.
- Brain: six view tabs, memory detail, evaluation detail, run detail, and Case execution detail.
- Integrations: provider/account dialogs, Gmail mailbox detail and limits, Slack channels, WhatsApp setup, custom connectors, and AI account authorization.
- Chat: Case detail, Project settings, permission requests, file/artifact previews, email drafts, product drafts, and side Case proposals.
- Stock: receipt, reconciliation, production request, purchase request, and item detail dialogs.
- Checkout: profile editor, publication review, activation review, and retirement review.
- Counters: active counter sale, collection status, payment/refund details, and terminal setup.
- Production: workflow, inputs, inspector, timeline, scenarios, comparison, floor plan, physics replay, and equipment workspaces.

## Account and public surfaces

| Surface                | Address or entry                           | Main UI components                                                                              |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Sign in                | `/sign-in`, or a signed-out Portal request | Satyr identity, Google sign-in action, product explanation, policy links                        |
| Organisations          | `/portal`                                  | Organisation cards, lifecycle/role labels, workspace links, organisation actions, account setup |
| Organisation           | `/portal/:organisationHandle`              | Selected organisation and its workspace list, create/manage controls                            |
| Account setup          | Set up Satyr                               | Setup dialog, identity/account steps, progress, validation and completion                       |
| Account invitation     | `/portal` with invitation parameters       | Invitation identity, accept state, account-link action, retry/invalid states                    |
| Identity link          | `/identity/link`                           | Invitation facts, identity authentication, action controls, success/failure panels              |
| Missing page           | Unknown Portal address                     | In-shell explanation and navigation back to available work                                      |
| Privacy                | `/docs/privacy`                            | Public header, document navigation, legal article, footer                                       |
| Terms                  | `/docs/terms`                              | Public header, document navigation, legal article, footer                                       |
| Data deletion          | `/docs/deletion`                           | Public header, deletion instructions, contact links, footer                                     |
| Contact                | `/docs/contact`                            | Public header, support/contact content, footer                                                  |
| Ecommerce presentation | `/ecommerce`                               | Separate marketing experience, product sections, media and navigation                           |

The provider authorization popup is a related Worker-rendered surface, outside the React page tree.
Development previews and equipment rehearsal HTML files are review tools, not operator navigation pages.

## Shared components

| Layer                 | Components                                                                                                           | Source                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Shell                 | Global bar, workspace sidebar, system/workspace selectors, account menu, theme control, command palette, chat reveal | `shell.tsx`, `console-sidebar.tsx`, `dashboard-navigation.tsx`, `workspace-header.css` |
| Page patterns         | Header, skeleton, empty state, recovery card, notice, status chip, resource list/row, work queue/item, action bar    | `page-components.tsx`, `styles.css`                                                    |
| Data views            | Table, columns, sort/filter, density, record links, saved views, board                                               | `features/commerce/entity-plane/`, shared table components                             |
| Forms and overlays    | Dialog, drawer, combobox, action menu, confirmation, field errors                                                    | `dialog.tsx`, `combobox.tsx`, `drawer.css`, `ui/`                                      |
| Collaborative editors | Participants, cursors, sync state, conflict/leave handling, review snapshots                                         | `features/content-studio/`, `features/commerce/description-draft/`, `features/chat/`   |
| Visual system         | Slate/coral and sageberry themes, text, spacing, radius, focus, status, motion tokens                                | `packages/frontend-theme.css`, `packages/frontend-themes/`, `docs/style-guide.md`      |

## Review method and evidence

The review follows `docs/style-guide.md` and the repository instructions.
The app uses React, plain CSS, semantic theme tokens, Lucide icons, Base UI, Radix, and Sonner.

Each page needs populated, empty, loading, failed, and restricted states where those states exist.
Each interactive page also needs keyboard, narrow-width, dark-theme, and reduced-motion checks.
Source inspection and a failed-load screenshot do not establish populated-state visual acceptance.

Initial screenshots are in `output/playwright/ui-inventory/`.
The first route sweep uses the existing Plan 21 browser fixture.
That fixture supplies the shell but several current page APIs exceed its coverage.
Those failures establish error presentation only.
Existing dedicated previews supply populated Agents, Brain, Access, Integrations, and Orders.
The initial Checkout preview failed its response parser because its data used retired configuration fields.
This pass updates that preview to the current contract and adds a one-read outage scenario.
The Supplier preview now waits for its collection and also supplies payout data. The original empty capture occurred before the requests finished.

## Implemented findings

The table consolidates the first two review passes. Paths start at `apps/portal/src/`.
The [decision and connection review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-review.md) records the next pass and its implemented findings.
The [configuration and approval review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-configuration-review.md) records the later Agents, Counters, and Operations findings.
The [remaining-state ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-closure.md) records the full local follow-up, fixture repairs, and additional shared UI fixes.
The [transaction and product-draft review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-transaction-review.md) adds sale receipts, refunds, price allowances, payout states, and collaborative product review.

| Severity | Domain        | Location                                                                                                                                                      | Before                                                                                                    | After                                                                                                     | Why                                                              |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| HIGH     | Accessibility | `features/content-studio/route.tsx:263`                                                                                                                       | Menu name and description fields had no accessible names                                                  | Each field names its item; Remove also names its target                                                   | Assistive tools can identify the fields and actions              |
| HIGH     | Accessibility | `features/content-studio/route.tsx:301`                                                                                                                       | Menu items moved between sections only by drag                                                            | A section selector sends the same document edit                                                           | Keyboard and single-pointer users can move an item               |
| HIGH     | Layout        | `styles.css:2260`                                                                                                                                             | Member email addresses ended in an ellipsis without a full-value path                                     | Addresses wrap inside the row                                                                             | Administrators can identify the complete address at 320px        |
| HIGH     | Layout        | `ui/crm-table.css:28`                                                                                                                                         | Horizontal scrollbars appeared only during hover, focus, or scroll                                        | Horizontal scrollbars remain visible when the table overflows                                             | A visible cue exposes additional columns                         |
| MEDIUM   | Layout        | `portal.tsx:3273`                                                                                                                                             | Active-workspace Home displayed the entire integrations catalog before daily work                         | Active Home leads with the daily brief; incomplete setup retains its setup surface                        | Operators reach current work first                               |
| MEDIUM   | Layout        | `features/content-studio/route.tsx:83`, `features/content-studio/styles.css:292`                                                                              | Menus inherited a two-column description-editor layout; the review button stretched vertically            | The menu uses its own existing block layout and a normal-height review action                             | Sections, sync status, and review follow a clear order           |
| MEDIUM   | Layout        | `styles.css:8081`, `features/commerce/entity-plane/product-detail.css:95`                                                                                     | Nested titles and descriptions inherited fact columns; long product prose used half a card                | Shared titles use available width; long product text spans the fact grid                                  | Text stays readable without wasted columns                       |
| MEDIUM   | Accessibility | `features/commerce/entity-plane/route.tsx:847`, `features/checkout-profiles/route.tsx:58`, `features/terminals/route.tsx:64`, `features/payouts/route.tsx:79` | Failed reads displayed text without a local retry control                                                 | Shared recovery cards expose retry actions                                                                | Users can recover without a full page reload                     |
| MEDIUM   | Layout        | `styles.css:9912`, `features/access/ai-budget.tsx:24`                                                                                                         | A sharing button compressed vertically; short budget fields occupied separate full-width rows             | The notice wraps; related fields and help text share a responsive card                                    | Actions stay readable and related settings stay together         |
| MEDIUM   | Color / UI    | `styles.css:8612`, `features/terminals/styles.css:95`, `features/payouts/styles.css:32`, `features/commerce/inventory-production.tsx:1056`                    | Actions borrowed success colors; counters and production requests used separate card styles               | Actions, status chips, radii, and text use shared tokens; request evidence stays under a disclosure       | Operators can distinguish status, action, and technical evidence |
| MEDIUM   | Typography    | `features/checkout-profiles/styles.css:400`, `features/terminals/styles.css`                                                                                  | Labels crowded narrow columns; some controls used decorative boundaries or translucent focus rings        | Fields receive more width, visible boundaries, and the opaque focus token                                 | Labels and controls remain legible                               |
| MEDIUM   | Layout        | `features/brain/styles.css:159`, `styles.css:5993`                                                                                                            | Brain stacked four summaries on phones; Home placed four counts in three desktop columns                  | Brain uses two compact columns; commerce counts fit the available width                                   | Summaries use space consistently and shorten the path to work    |
| LOW      | Typography    | `styles.css:1672`, `pages/automation.tsx:600`, `features/commerce/entity-plane/route.tsx:2849`                                                                | Products started at the toolbar edge; Operations and Orders repeated visible titles                       | Listing headers share the normal inset; repeated section titles remain available to assistive tools       | The page hierarchy stays consistent                              |
| LOW      | Writing       | `pages/home.tsx:416`, `features/content-studio/route.tsx:140`, `features/commerce/entity-plane/presentation.ts:169`                                           | Home exposed graph terminology; menu review used implementation language; fallback labels used title case | Business language explains counts and review; empty sections give a next action; labels use sentence case | Operators can understand the next action                         |

## Domain coverage

| Domain        | Evidence inspected                                                                                                                         | Result                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Accessibility | Route recovery, native links, table scroll, agent dialog, budget fields, menu names and section move; browser journeys                     | Changed paths pass the recorded checks; screen-reader speech remains unverified                             |
| Layout        | Route/component inventory; wide and 320px screenshots; populated Agents, Orders, Access, Brain, Integrations, Checkout, and Content studio | Corrected shared rows, field grids, scroll cues, and compressed actions                                     |
| Writing       | Route descriptions, Home counts, menu review, Content studio, budget limits, commerce fallback labels                                      | Corrected the listed wording; server-generated messages outside fixtures remain unverified                  |
| Typography    | Existing style guide, shared row text, Agents heading, budget labels, Checkout labels, Brain summary                                       | Corrected the listed hierarchy and wrapping issues                                                          |
| Color         | Existing semantic tokens; settled light/dark appearances for Agents and Access                                                             | Primary text contrast: 9.12:1 light, 11.67:1 dark. Action-link contrast on cards: 5.90:1 light, 5.33:1 dark |
| UI polish     | Existing radii, control shapes, shared recovery cards, narrow scrollbars, Brain summaries                                                  | Changes reuse the existing system; no new motion was added                                                  |

The contrast values use the current slate-coral OKLCH pairs converted to linear sRGB luminance.
The dark pair values were also read from the rendered controls after their color transitions settled.
This is a check of the changed action pairs, not every color combination in the app.

## Verification

Passed:

- `pnpm portal:build`: contract validators, Portal types, production bundle, and asset-size check.
- `pnpm --filter @seams/portal exec tsrs --noEmit`: final type check.
- `pnpm --filter @seams/portal exec vite build` and the asset-size script: final bundle after the visual corrections.
- `git diff --check`.
- `scripts/frontend-foundation/portal-ui-journey.js`: failed Checkout read → keyboard retry → draft editor, budget reset, narrow table keyboard scroll, agent dialog focus, and narrow Brain navigation.
- Browser screenshots for all six Brain views and light/dark checks for the reviewed forms and controls.

Repeat the browser journeys with a Portal Vite server and a named Playwright CLI session:

```sh
pnpm portal
bash "$HOME/.codex/skills/playwright/scripts/playwright_cli.sh" --session portal-ui open http://127.0.0.1:3103/agents-preview.html
mkdir -p output/playwright/ui-inventory
bash "$HOME/.codex/skills/playwright/scripts/playwright_cli.sh" --session portal-ui --json run-code --filename scripts/plan21/browser-acceptance-fixture.js
bash "$HOME/.codex/skills/playwright/scripts/playwright_cli.sh" --session portal-ui --json run-code --filename scripts/frontend-foundation/portal-ui-journey.js > output/playwright/ui-inventory/journey-result.json
```

Run the browser commands in a second terminal while the server runs.
The final two JSON files must contain `status: passed` inside their result payload.
The same directory contains before/after screenshots.
These journeys use local data and do not change production records.

## Full review coverage

All 20 workspace pages now have rendered evidence across the recorded passes.
The second pass uses `output/playwright/ui-full-review/`.
The first pass uses `output/playwright/ui-inventory/`.
The [decision and connection review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-review.md) adds deeper Checkout, Brain, stock, and Integrations checks.
Its evidence is in `output/playwright/ui-state-review/` and `output/playwright/portal-access/`.
The [configuration and approval review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-configuration-review.md) adds agent history, skills, counter retirement/setup, and catalog decisions.
Its evidence is in `output/playwright/ui-remaining-review/`.
The [remaining-state ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-state-closure.md) closes the recorded local gaps across all page groups and names the live-only limits.
Its evidence is in `output/playwright/ui-state-closure/`.
A screenshot of one state does not certify every possible state or every dialog.
The [purchasing, goal, and member-action review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-purchasing-goal-review.md) adds supplier recovery, purchase edits, cancellation, Chat goals, attachments, and account mutation failures.
Its evidence is in `output/playwright/ui-purchasing-review/`.
The [Chat decisions and shipment review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-chat-decisions-review.md) adds draft cards, side Cases, partial local failures, and shipment batch recovery.
Its evidence is in `output/playwright/ui-chat-decisions/`.
The [navigation, questions, and table review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-navigation-review.md) adds workspace search, workspace menus, clarification recovery, response actions, and shared-table controls.
Its evidence is in `output/playwright/ui-navigation-review/`.
The [file access and Inbox detail review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/portal-ui-file-access-review.md) adds account-switch races, picker recovery, supplier-link failures, and current shared-reply behavior.
Its evidence is in `output/playwright/ui-file-access-review/`.

| Workspace page         | Rendered states and interactions                                                                         | Evidence                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Home                   | Active daily brief, populated counts, compact dark layout                                                | `home-wide-after.png`, `home-dark-compact.png`                                |
| Chat                   | Empty composer, populated conversation, tool activity, approvals, receipts, sources, access loss, mobile | `chat-layout.json`, `chat-trace-journey.json`                                 |
| Inbox                  | Needs-you list, message drawer, classification, three draft decisions, mobile                            | `inbox-journey.json`, `inbox-drawer-journey.json`                             |
| Checkout               | Published and draft profiles, settings editor, failed read and keyboard recovery                         | First-pass `journey-result.json`                                              |
| Products               | Tracked and untracked products, availability, stock table, product detail                                | `products-wide-after.png`, `product-detail-wide-after.png`                    |
| Menus                  | Populated shared document, named fields, section move, title edit, saved review snapshot, narrow layout  | `menu-journey.json`, `menus-wide-after.png`                                   |
| Counters & payments    | Ready and retired counters, sale fields, setup disclosure, narrow and dark layouts                       | `terminals-wide-after.png`, `terminals-dark-compact.png`                      |
| Ingredients & supplies | Stock search, item detail, incoming purchase, return with search preserved                               | `pages-journey.json`, `stock-detail-narrow.png`                               |
| Production requests    | Requested, accepted, and scheduled requests; status, action, and technical details                       | `production-requests-wide-after.png`                                          |
| Orders                 | Populated table, keyboard horizontal scroll, record detail                                               | First-pass journey; `order-detail-wide-after.png`                             |
| Purchasing             | Populated supplier board and directory, supplier detail, payout requiring bank action                    | `supplier-board-wide-after.png`, `final-polish.json`                          |
| Production             | Populated 3D scene, play/pause, floor-plan dock, narrow return to 3D                                     | `production-review.json`, `production-floor-plan.png`                         |
| Agents                 | Populated roster, creation dialog, keyboard open/close and focus restoration                             | First-pass `journey-result.json`                                              |
| Brain                  | All six views; review summaries, knowledge, evaluations, activity, context; narrow navigation            | First-pass Brain screenshots and journey                                      |
| Integrations           | Connected apps, catalog, setup cards, narrow layout                                                      | First-pass integration screenshots                                            |
| Access and data flow   | Connected systems, budget edit/reset, Capabilities, Data flow, narrow layouts                            | Both page journeys; `capabilities-wide-after.png`, `data-flow-wide-after.png` |
| Workspace settings     | Members, long email, pending invitation, invite form, archive control, narrow and dark layouts           | `settings-narrow-after.png`, `settings-dark-compact.png`                      |

Account setup, setup recovery, organisation startup, partial and total outages,
invitation-link recovery, and saved appearance pass the existing account journey.
Sign-in, identity link, missing routes, all four public documents, and ecommerce
also have wide and 320px captures.

### Fixture repairs

- The Inbox fixture imports the versioned React modules already loaded by Vite.
- The account journey sets its own viewport before it expects desktop navigation.
- The existing Portal fixture now supplies current preferences, members, invitations, stock, receipts, production demand, counters, identity-link data, and commerce counts.
- The commerce preview now opens product, order, and supplier details through real preview URLs. It also supplies the overview, activity empty state, and payout panel.
- The menu journey uses the actual document and protocol libraries. The fixture receives edits from the real UI and returns the resulting review snapshot.
- Captures wait for page-specific content. Responsive captures also wait for layout transitions to finish.

### Additional verification

- `portal-pages-journey.js`: **22 routes and subviews passed** at 1440px and 320px. Seven workspace layouts also passed compact dark captures.
- `portal-menu-journey.mjs`: title edit, section move, room update, and review snapshot passed.
- Existing Inbox classified-view and drawer-review journeys passed. The drawer journey checked send/reject receipts and the next decision.
- Existing Chat trace journey passed tool inputs/results, out-of-order updates, approvals, uncertain receipts, sources, queued input, access loss, and mobile layout.
- Existing account setup journey passed recovery, membership visibility, saved appearance, startup, outage recovery, and invitation retry.
- `pnpm --filter @seams/platform test:onboarding-closure`: **10 files, 52 checks passed**. The first sandboxed attempt could not install its Wasm helper; the permitted retry passed.
- `pnpm portal:build`, final Portal type check, final Vite bundle, asset-size check, and `git diff --check` passed.

Run `portal-pages-journey.js` after the existing Plan 21 fixture, using the same CLI commands as the first-pass journeys.
The menu module follows the existing account-journey bundle pattern:

```sh
pnpm --filter @seams/platform exec esbuild "$PWD/scripts/frontend-foundation/portal-menu-journey.mjs" --bundle --platform=browser --format=iife --global-name=SatyrMenuJourney --outfile="$PWD/output/playwright/ui-full-review/menu.bundle.js"
python3 - <<'PYMENU'
from pathlib import Path
root = Path("output/playwright/ui-full-review")
bundle = (root / "menu.bundle.js").read_text()
(root / "menu-run.js").write_text(
    "async function reviewMenu(page) {\nawait page.unrouteAll();\n"
    + bundle
    + '\nreturn SatyrMenuJourney.runMenuJourney(page, {portalUrl: new URL(page.url()).origin, artifactDir: "output/playwright/ui-full-review"});\n}'
)
PYMENU
bash "$HOME/.codex/skills/playwright/scripts/playwright_cli.sh" --session portal-ui --json run-code --filename output/playwright/ui-full-review/menu-run.js > output/playwright/ui-full-review/menu-journey.json
```

### Limits

- These are local visual and browser checks with sample data. They do not certify live OAuth, mail delivery, payments, or physical equipment.
- Screen-reader speech, physical touch hardware, other browser engines, and every alternate-theme pair remain unverified.
- Compact dark captures use a 720px viewport. They do not claim an actual 200% browser-zoom check.
- Production's existing scene edits remain intact. This review checks their visible layout and playback controls, not physical calibration or simulation accuracy.
- The build retains warnings about the native physics Wasm URL, an externalized module, and large chunks.

## Verdict

**Approve the UI changes within this recorded visual scope.** The stale-fixture gaps from the first pass are closed.
The inventory covers every registered page, and all 20 workspace pages have rendered evidence.
The changes remain local, uncommitted, unpushed, and undeployed.
