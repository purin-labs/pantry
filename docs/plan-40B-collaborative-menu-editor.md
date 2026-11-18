# Plan 40B — Collaborative Menu Editor

Status: phases 0–7 live in production. Phase 5 is released (2026-11-06); phase 7
is released (satyr-edge `3b998e9f`, 2026-11-08), with follow-ups in `23b8e8b9`
(2026-11-11) · Owners: Satyr
platform, CafeOS Portal and Underclerk · Mocks: the design canvas
[Café Menu Boards](https://claude.ai/artifact/97kTAx69i3hZwFaNxf15zB)
(private to the owner)

This plan replaces the earlier Plan 40B, "Collaborative Storefront and
Café-Menu Builder", which the owner retired on 2026-10-29. Satyr no longer
builds merchant websites. Operators build their own sites with Claude or
Codex, and Underclerk serves those sites as a headless backend. Satyr builds
the café's menu: one live menu that people and agents edit together, shown on
every screen in the shop and on the QR order page.

Builds on [Plan 40](./plan-40-product-description-drafting.md) and the
[Plan 40C multiplayer module](./plan-40C-multiplayer-module.md). Related:
[Plan 80](./plan-80-underclerk-multi-tenant-backend.md) (Underclerk as a
multi-tenant headless backend) and
[Plan 33C](./plan-33C-POS-systems.md) (POS).

## Owner decisions (2026-10-29)

1. Replace the storefront builder. People deploy their own sites with Claude
   or Codex. Underclerk can serve those sites as a backend through an MCP
   server, so that the operator's own coding agent builds against it.
2. One menu, many screens. A board fits each screen: a landscape counter TV,
   a portrait pastry case TV, a pickup board and a phone.
3. Link the boards to orders. This is what other menu-board apps cannot do.
4. Give fixed layouts and also a free canvas. Copy as many Lovable and Figma
   features as is practical: direct manipulation of elements while a person
   also gives an agent commands.
5. Keep price changes safe. A price lives in Underclerk, and a new price or a
   deal needs the owner's approval.
6. The hosted shop page becomes only the QR order page. Each shop gets its own
   subdomain, for example `shopname.menu.<domain>`.
7. Use the existing CRDT multiplayer module, so that people and agents edit a
   menu and its boards at the same time.
8. The hosted shop page leaves the Underclerk Worker. It becomes a standalone
   demo ecommerce site at `shop.seams.tokyo`, with Underclerk as its backend
   and the Satyr MCP server for other Satyr features: email, queries, product
   listings and orders.

## What exists (facts from the code, 2026-10-29)

- **Menu draft.** `@satyr/menu-draft-crdt` holds a structured menu: a title,
  sections, and items that name a product, with a display name, a description
  and a placement. It uses the Plan 40C room in `OrganisationActor`, with
  presence and frozen snapshots. Agent edits go through the governed proposal
  path of Plan 40C and Plan 40D.
- **Menus page.** `apps/portal/src/features/content-studio/route.tsx` edits
  the shared draft, publishes it and shows an "Open shop" link.
  `services/platform/src/control/routes/commerce-menu-publication.ts`
  publishes the draft to Underclerk as menu `menu_cafe_main` of storefront
  `storefront_cafe`, and returns `shopUrl`.
- **Underclerk food service** (`services/underclerk/docs/spec.md`): menus
  with sections and entries, replaced by revision; menu validity `always` or
  one `window`; a location scope; modifier groups; consumption plans and
  stock, with a sold-out refusal at checkout; preparation tickets; pickup
  fulfillment `requested` → `ready_for_pickup` → `completed` with pickup codes
  such as F-62, and the "ready for pickup" email. Satyr reads Underclerk
  events through its feed consumers.
- **Hosted page.** `apps/storefront` serves `/shops/<merchantId>` from the
  Underclerk Worker as a single-page application. Its large title and header
  line are fixed demo copy that every shop shows.
- **Merchant agent.** Urk (`services/platform/src/data/urk-skills.ts`).
- **Canvas CRDT precedent.** `@satyr/workflow-canvas-crdt` keeps the Plan 42
  workflow canvas in the same module family.

## Product shape

### Surfaces

| Surface       | Shows                                                       | Plays on                |
| ------------- | ----------------------------------------------------------- | ----------------------- |
| Menu board    | Sections, items, prices, sold-out marks, a featured item    | TV or tablet, any shape |
| Pickup board  | Order codes in "Preparing" and "Ready"                      | TV near the counter     |
| QR order page | The same menu, with a cart, checkout, receipt, order status | The customer's phone    |
| Print and QR  | A table card with the shop's QR code (later)                | Paper                   |

One board can play on several screens. A board layout adapts to the screen's
shape and size. The same published menu feeds every surface.

### The board document

A board is one shared Yjs document in the Plan 40C room. It holds the layout,
the elements, the style tokens, the featured item, and bindings to menu
sections and items. It never holds a price, a tax, stock, availability or
order state. A bound element names a menu entry, and the screen reads the
live facts for it from Underclerk.

Keep these rules from the earlier Plan 40B:

- Each element is a stable nested map. Each property is a separate key, so
  that two people who change two properties do not overwrite each other.
- Placement is one atomic value: the parent frame and an ordering key, or a
  frame rectangle on the free canvas. A simultaneous move converges to one
  placement; show it and let the person move it again.
- Ordering keys may repeat, with the element ID as the tie-breaker. Do not
  renumber the whole board during a drag.
- An element whose parent was deleted at the same time goes to a recovery
  area. The board cannot be published until it is resolved.
- Authenticate each update, bound its size, validate the result, and persist
  it before acknowledgement or broadcast (Plan 40).

### Fixed layouts and the free canvas

A board starts from a layout: three columns, two columns with a featured
item, a portrait list, or a pickup board. A layout is a tree of frames with
auto layout. A person can then switch the board to the free canvas and change
anything.

Features to copy from Figma and Lovable:

- Select, move and resize, with snapping, smart guides and keyboard nudges.
- Auto layout: stacks and grids with gap and padding.
- Constraints, so that a board resizes for another screen shape.
- Components with variants: one item-row component repeats for every item in
  a section.
- Style tokens for colours and the type scale, and a layers panel.
- Multi-select, align and distribute.
- Undo and redo for each person (`Y.UndoManager` scoped to that person).
- Live cursors and selections, comments pinned to an element, and version
  history with restore.
- Prompt to edit: select an element and tell the agent what to change. The
  agent edits the draft, and the person sees the change and can undo it.

Bound elements make the canvas a menu editor, not a drawing tool: an item
row, a section list, a price, a sold-out badge, a stock count, a featured
card, a QR code, and the pickup code lists.

Outside this plan: arbitrary code components, a vector pen tool, and
prototyping. No generated code runs on a screen. A sandboxed custom block is
a possible later addition with its own security design.

### Linked to orders

A screen receives two things: the published board release, and live facts.
The live facts are availability, prices from the published offers, stock
counts, and the pickup queue. They come from Underclerk events. Proposed
target: a sold-out mark shows on every screen within 5 seconds.

- A sold-out item changes on every board, and the QR page refuses it at
  checkout.
- A low stock count shows on the board, for example "3 left".
- A pickup code moves from "Preparing" to "Ready" when staff mark the order
  ready, and leaves the board when the order is completed.
- A drink with no stock count has a "sold out today" mark in Underclerk, so that
  checkout also refuses it.
- A morning or afternoon menu has repeating time slots: Underclerk menu validity
  is `always`, one `window` or a `schedule`.

### Safe price changes

| Change                              | Who           | Approval                  |
| ----------------------------------- | ------------- | ------------------------- |
| Layout, copy, images, featured item | Staff, agents | None; publish is separate |
| Sold out today, hide an item        | Staff, agents | None                      |
| New price or deal                   | Staff, agents | The owner approves        |
| New product, offer or modifier      | Owner, admin  | Existing commerce path    |

A board never edits a price. A price or deal change is an Underclerk command
through the existing policy, approval, receipt and replay path.

### Publication

A board release is an immutable snapshot of the layout and bindings, with its
digest. An authorized member publishes it. Later draft edits stay in the
draft. Screens play the newest release, with the live facts on top. Rollback
publishes an earlier release again through the same path. Publication never
freezes stock or makes an old quote valid.

### Screens

- **Pairing.** A screen opens the `/tv` page in its browser and shows a
  six-letter code. A member enters the code in Portal and picks a board.
- **Player.** `/tv` is an installable web page. It keeps the last complete
  release and the last facts. When it is offline, it shows the saved copy and
  marks old prices and stock as not verified.
- **Status.** Each screen sends a heartbeat. Portal shows it as up to date,
  or offline with the time.
- **Hardware.** Any TV stick, TV or tablet with a current browser, in kiosk
  mode.

### The QR order page and subdomains

`apps/storefront` becomes only the QR order page: the shop name, the menu,
the cart, checkout, the receipt and order status. The fixed demo copy goes.
The page reads its copy from the published menu and the board.

Each shop gets a short name, served at `shopname.menu.<domain>`: a wildcard
DNS record and a Workers route `*.menu.<domain>/*`. A short-name registry
maps each name to one merchant and refuses reserved names. A shop's own
domain comes later, through Cloudflare for SaaS custom hostnames.

The storefront app leaves the Underclerk Worker. It runs as its own Worker
that calls Underclerk's buyer API, like any operator's own site. Its first
deployment is the demo site `shop.seams.tokyo` for the owner's café
(decision 8). Underclerk then has no storefront of its own, as Plan 80 says.

### Underclerk for operators' own sites

An Underclerk MCP server lets an operator's coding agent build a site
against Underclerk: read the catalog and the menu, create a checkout and read
an order's status. It authenticates with the merchant's own scoped API keys
(Plan 80). The typed client `@underclerk/client` and the spec stay the
contract.

The demo site `shop.seams.tokyo` is the reference: a standalone ecommerce
site on Underclerk that uses the Satyr MCP server for email, queries,
product listings and orders.

### Agents

Urk gets board tools: read a board, propose a board change as a changeset,
mark an item sold out, and propose a price or a deal for approval. People and
agents edit the same board in the same room; an agent shows as a participant
with its own presence.

Keep these rules from the earlier Plan 40B for agent changes:

- An agent works on a completed checkpoint, not on the live document.
- Each changeset carries a stable operation ID and a content digest. A lost
  acknowledgement returns the original receipt; the changeset never applies
  twice.
- At admission, check the grant, the assignment and the touched values
  again. Revocation stops later changesets.
- An agent edit has no commerce effect. Publication and price changes keep
  their own authorization.

## Phases

| Phase | Scope                                                                                                                                                           | Estimate       | Status                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------- |
| 0     | The storefront app leaves the Underclerk Worker and runs as the demo site `shop.seams.tokyo`                                                                    | 1 day          | Live                                               |
| 1     | One drinks board from fixed layouts; Portal Menu › Boards; board releases; `/tv` with pairing; live sold-out marks from stock; offline saved copy; Screens list | 1.5 weeks      | Live                                               |
| 2     | The QR order page only; shop short names and `*.menu.<domain>`; the fixed demo copy removed                                                                     | 1 week         | Live; the order page domain is not chosen          |
| 3     | Pickup board; stock counts; "sold out today" and repeating time slots in Underclerk (spec in the same commit)                                                   | 1 week         | Live; no stock counts on a board                   |
| 4     | Urk board tools; the change card with before and after; price and deal approval                                                                                 | 1 week         | Live; the approval click in production is open     |
| 5     | The free canvas with the features above; layouts for each screen shape                                                                                          | 3 to 4 weeks   | Released (2026-11-06)                              |
| 6     | The Underclerk MCP server for operators' own sites                                                                                                              | 1 to 1.5 weeks | Live                                               |
| 7     | Agents on the canvas: agent colours, cursors and actions; ghost boxes; real typing; rulers and spacing numbers; a presence bar                                  | 4 to 4.5 weeks | Released (2026-11-08); follow-ups 2026-11-11       |
| Later | Shop domains through Cloudflare for SaaS; print table cards; offline editing                                                                                    |                |                                                    |

The estimates are rough. Each phase ends with its journey.

### Phase 1 status (2026-10-29)

Merged to `dev` and released to production on 2026-10-29 at 09:39 UTC
(satyr-edge `fdcf41a1`, source `dc2fd9c73`), after the global D1 patch
`plan-40b-screen-pairing-d1-patch.sql`. Evidence:
[plan-40b-phase-1.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-1.md).

- The board is a new Plan 40C document, `@satyr/menu-board-crdt`, in its own
  room in `OrganisationActor`. A board starts from three fixed layouts
  (three columns, two columns, portrait list) filled from the menu draft.
  Elements: heading, menu section, featured item, order QR code and text.
- Portal Menus has three tabs: Items, Boards and Screens. Staff (`operator`)
  and above make, edit and publish boards, and pair and remove screens.
- A release freezes the layout, the elements and the menu copy that they
  name, with a digest. A repeated publish answers the same release; a stale
  one is refused.
- `/tv` is a page of the Portal build with a service worker. Pairing codes
  wait in the global database; a release needs
  `services/platform/scripts/plan-40b-screen-pairing-d1-patch.sql` on the
  global database first.
- One address holds at most 50 open codes (an IPv6 /64 counts as one
  address); all shops together hold at most 5,000. The next code from that
  address is refused with 429 `menu_screen_pairing_limit`, and the TV says
  so and tries again after a minute. The limit runs in production since
  2026-10-29 13:21 UTC (satyr-edge `1ba5fbf7`), after
  `plan-40b-screen-pairing-client-d1-patch.sql` on the global database.
- Live facts come from the same guest catalog read as the order page. A
  sold-out mark in phase 1 comes from stock: staff count the last ingredient,
  or the last item sells.
- Measured in two runs: the screen's signal arrives 0.2 to 0.6 s after a
  stock count; the sold-out mark showed after 5.0 to 5.4 s, because
  Underclerk's catalog snapshot lived 5 s. The snapshot now lives 2 s, and
  the mark shows after 2.1 s. Released on 2026-10-30 at 16:14 UTC
  (Underclerk `a0a5e318`, satyr-edge `c9d707b8`, source `89c1a22a0`).
- Proof: the E2E journey "Live board" (Worker, Underclerk, account Worker);
  a browser run of `/tv` with its service worker, offline and after a
  restart; and a browser run of Menus › Boards and Screens on a local Worker.
- Not done in phase 1: no real TV.

### Phase 2 status (2026-10-30)

Released 2026-10-30 04:36–04:38 UTC from dev `67fed3ac5`: Underclerk
`afba0215` (adds `UnderclerkShopNameDO`) and seams-shop `36fb2d9c`. The
Platform part was already live in satyr-edge `9df01d15` (another session's
dev upload, 04:07 UTC), with no `SHOP_ORDER_PAGE_ORIGIN`. Evidence:
[plan-40b-phase-2.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-2.md).

- Underclerk keeps shop names: one `UnderclerkShopNameDO` for each name, so
  one name has one storefront. `PUT` and `GET
/v1/admin/merchants/:merchantId/storefronts/:storefrontId/shop-name` set
  and read a storefront's name; `GET /v1/public/shop-names/:name` answers a
  shop site. A refused name (`invalid`, `reserved`, `taken`, `limit`) is an
  answer, not an error. A name never leaves its storefront: an earlier name
  opens the same shop and points to the current one, so a printed QR code
  never opens another shop. A storefront holds at most five names.
- The shop Worker (`seams-shop`) serves `<shop name>.menu.seams.tokyo`. It
  answers 404 for a name that no shop holds, moves an earlier name to the
  current one with 301, adds the storefront to the page as a meta tag, and
  passes on only that storefront's buyer routes.
- The order page shows the shop's published menu in its own sections, with
  each listing's title, description and first image, and no demo copy. The
  Nuki demo and the pâtisserie site at shop.seams.tokyo keep their own look.
- Menus › Items shows the order page address; an owner or an admin sets the
  shop name. The shop's screens put the address in their QR code.
  `pnpm --filter @underclerk/worker set:shop-name` sets a name from a
  terminal.
- The order page domain is not chosen yet (owner, 2026-10-30). Production
  sets no `SHOP_ORDER_PAGE_ORIGIN` and seams-shop has no order page route, so
  QR codes keep `shop.seams.tokyo/shops/<merchant>` and the Menus page shows
  no address form. Names can be set with `set:shop-name`. To turn the
  addresses on: choose the domain, add a proxied wildcard DNS record and a
  certificate for it (Universal SSL covers only one level below the zone, so
  `*.menu.seams.tokyo` needs Advanced Certificate Manager), add the seams-shop
  route, and set `MENU_HOST_SUFFIX` and `SHOP_ORDER_PAGE_ORIGIN`.

### Agent tools for phase 3 (2026-11-02)

Plan 81 slice 7 gives the Portal chat agent the staff order queue and "sold out
today". It is live since 2026-11-02. Phase 4 adds the board tools (see "Phase 4
status").

### Phase 3 status (2026-10-31)

The staff order queue, the pickup board and "sold out today" are live in
production since 2026-11-01 (Underclerk `e7534148`, schema 83; seams-shop
`9e173d72`; satyr-edge `0be36650`). Evidence:
[plan-40b-phase-3.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-3.md).

- Underclerk reads the open pickups by state (`GET
…/food-service/pickup-queue`), so that a board's read stays small. It names
  no buyer. `underclerkPickupCode` gives each surface the same code. The code
  has three digits now, such as F-062, because 2,600 codes collide too often
  among open orders.
- Portal CafeOS › Order queue is one list for a tablet. Each order has one
  main action: Ready or Hand over. Start is optional. Ready completes the
  preparation ticket first, so staff do not walk a ticket by hand. The list
  reads again every 5 seconds. Staff (`operator`) and above use it.
- A pickup board is a new fixed layout with a new element, `pickup_codes`. A
  player reads `GET /v1/screens/pickup` only for a board that has one, so a
  menu board pays nothing. It does not keep the codes across a restart.
- A shop with no Slack channel no longer holds its events after a paid order.
- Staff mark an item as sold out on the Order queue page. The mark holds on
  every menu of the shop, checkout refuses the item, and it ends at the shop's
  next midnight. A paired screen shows it within 5 seconds. The time zone is the
  device's. Underclerk has no shop time zone yet.
- An owner gives the menu serving hours when they publish it: slots of days and
  times, or all day. Outside them the QR order page has no menu, checkout
  refuses its lines, and a board says "Not serving now" within a minute. A
  publish with no hours keeps the menu's hours. The Portal edits one menu, so a
  shop that wants a morning and an afternoon menu uses Underclerk's API for the
  second one.
- Not done in phase 3: stock counts on a board.
- A menu, a checkout and an order edit no longer count an expired lot as stock
  (`expired-lot-journey.test.ts`). An item shows as sold out when its lots pass
  their date, and returns when staff receive a fresh delivery, with no
  republish. A lot that expires after a customer paid still holds that order
  until fresh stock arrives. Staff see a refusal in the queue.

### Phase 4 status (2026-11-04)

On `dev` since 2026-11-04 (`e63903e8c`). `satyr-edge` runs it since the
Refactor 10 release of 2026-11-04 (`e8a90b9c`). The Underclerk change (the
compare-at price on a menu entry) is live since 2026-11-05 07:34 UTC
(Underclerk `759eb825`, see "Release of 2026-11-05" below).
Evidence: [plan-40b-phase-4.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-4.md).

- Urk has three board tools. `menu_board_read` reads the boards (layout,
  elements, release, screen count) and each menu item's live price, deal and
  availability. `menu_board_edit` changes a board's draft in the room that
  people edit: the board's title, an element's text, the featured item, a new
  text element, a move or a removal. Its result shows the element before and
  after. `menu_board_propose_price` proposes a new price or a deal for one
  item. "Sold out today" stays `sold_out_mark` (phase 3).
- A board edit has no approval, as the table above says, and it reaches the
  screens only when a person publishes the board. At admission the tool
  checks the touched value again: a text edit names the text that the agent
  read, and a different text now is refused with the current text. A
  repeated edit changes nothing twice.
- A price or a deal is the new governed action `change_menu_price` (verb
  `commerce.menu.change_price`). Its path freezes the offer revision and the
  price before and after, so the change card shows both and the approval
  signs that change. On approval Platform calls Underclerk `update_offer` with
  the price and the compare-at price. Underclerk refuses a stale offer
  revision. Every board, screen and the QR order page reads the new price
  live, with no new board release.
- A deal is the new price with the earlier price kept as the offer's
  compare-at price. A board shows the earlier price struck through. A deal
  price must be lower than the earlier price. `deal: false` ends a deal.
- Underclerk: a buyer's menu entry now carries `compareAtPrice` (spec,
  section 21, food service). Screen facts carry it only when an item has a
  deal, so a TV player from before phase 4 still reads every other item.
- Agent instructions: the "Pricing and promotions" skill names the tools.

Decisions taken in phase 4 (the plan left them open; each is the default
that the owner can change):

1. A deal is a compare-at price on the offer, not an Underclerk discount
   rule. A discount applies at checkout, and a board could not show it.
2. A price change goes through `update_offer` with the approval, not
   `adjust_offer_price`, which needs a price policy band that café offers do
   not have.
3. An owner or an admin approves, with the step-up sign-in in the Portal or
   from the Slack card, as for every other commerce change. The owner's rule
   of 2026-10-28 already lets a price change be approved from Slack.
4. Board edits use the existing capability `commerce.menu_draft.edit`, so
   the release needs no capability policy backfill. Board reads use
   `commerce.menu_draft.read`, and a price proposal `commerce.action.propose`.
5. Urk does not publish a board. Publication stays with a person.

Not done in phase 4: a real model, real Slack, a real TV and production;
the Portal chat card click; and two people with Urk on one board at the same
moment (acceptance journey 4 needs the phase 5 canvas).

### Phase 5 status (2026-11-06)

Phase 5 is released (2026-11-06). Slices 1–9 and the workspace work went
out with the whole-dev releases of the day (satyr-edge `7389127d` from dev
`c8952becc` holds them, with the start screen, chat and top bar fixes). The
image element, the canvas-only Menus page and the side drawer sheets went
out last, in two narrow uploads at 08:28 UTC:

- Underclerk `0a510fd5` (before: `759eb825`, source `90b49e7ee`): only
  `read_media_content`, ported onto the route structure before Refactor 14.
  Ref `refs/backup/released-2026-11-06-image-element-underclerk`.
- satyr-edge `cce0597c` (before: `7389127d`; ingress `35ce177a`
  unchanged): live source `c8952becc` plus the three Plan 40B commits. Ref
  `refs/backup/released-2026-11-06-image-element`.

Production check, signed in as the owner: a new blank board "Image check"
(no screens) got an uploaded image, which the editor loaded under the
owner's session. The public screen route answered 404 for it before the
publish, and 200 with the same bytes after Published revision 1; another
image stayed 404. The release needed no D1 patch and no capability policy
backfill.

Cleanup after the check: no delete exists for a board or a library image, so
the image was taken off the board and the board was published again as
revision 2 with one text element. The image then answered 404 at the screen
route again. The "Image check" board and the private library image remain.
The ¥330 → ¥320 price check from the chat was not finished: the owner chose
to skip it, because `pi-menu-board-price` proves the same path.

Two findings from the production check, fixed after the release (not yet
deployed):

- The chat agent did not ask for `commerce.menu_draft.read` before a board
  read, because the permission tool did not say that the board tools need it.
  The tool now names `commerce.menu_draft.read` for board and menu reads and
  `commerce.menu_draft.edit` for board edits and price proposals. A real
  model has not run this text yet.
- After a publish, an edit in the same editor left Publish off until a
  reload. The editor learned the draft revision only when it synced, so an
  edit looked like the published revision. The editor now marks the board as
  changed after each edit, its own or a collaborator's, until the next sync.
  `scripts/plan-40b/browser-board-images.js` checks it, and fails without
  the fix.

Both fixes were released on 7 November 2026, 07:03 UTC: satyr-edge
`fa0b485f` from `63741cd45` (live `0b4f3cc45` plus the fix commit, ref
`refs/backup/released-2026-11-07-board-publish-fix`). The ingress Worker and
Underclerk did not change; the schema gate matched. Rollback target:
satyr-edge `8e4951e6`. Production check in the owner's Chrome: on the
"Image check" board, Publish was off at revision 2 and turned on after one
text edit, with "changes not published" and no reload; the edit was then
undone. The chat agent read the saved "Morning menu" board with
`menu_board_read` and changed nothing. Read access was already allowed, so
the new permission text did not run in production.

**Remaining gaps closed (2026-11-07), released the same day:**

- Board removal. An owner or admin archives a board from the board list and
  restores it from the Archived list (`POST …/menu-boards/:boardId/archive`,
  admin). A board that a screen shows cannot be archived. An archived board
  leaves the board list, the editor and the screen picker, and the image of
  its release stops being public; a restore brings back the draft, the
  versions, the comments and the release. Nothing is deleted, so an archive
  never loses work. Urk does the same with `menu_board_archive`, only for an
  owner or admin, and `menu_board_read` lists the archived boards. The
  Organisation Actor adds the `archived_at` columns to `menu_board` itself.
- Image delete. An owner or admin deletes a library image in the Images
  panel, after a second click (`POST …/commerce/media/delete`). A board that
  shows the image in its draft or its newest release keeps it, also an
  archived board, and the answer names the board; Underclerk keeps an image
  that a product shows. A deleted image cannot be restored. Urk does not
  delete images: the deletion cannot be undone and the library is shared
  with the product catalog, so a person makes that choice on the page.
- Journeys: `pi-menu-board-archive` (Urk refused while a screen shows the
  board, staff and viewers refused, image kept while a board or an archived
  board shows it, archive, restore, delete of an unused image) and
  `scripts/plan-40b/browser-board-archive.js` (archive, restore, all boards
  archived, image delete refusal). Evidence:
  `evidence/plan-40b-phase-5/menu-board-archive.json`.
- The permission text with a real model.
  `chat-menu-board-permission-live` runs Satyr's production model
  (`moonshotai/kimi-k3` on OpenRouter) in a Portal chat with no page on
  screen. The owner has no board access and asks about a saved board. The
  model asked for `commerce.menu_draft.read` in one request (with the offer
  and product reads), and after Allow it read the board and named it.
  Evidence: `evidence/plan-40b-phase-5/menu-board-permission-live.json`. The
  same run without the new text also reached the board, after two requests
  and more searches, so this model does not need the text. The production
  failure was on the Claude account route, which this journey does not run.

**Approvals in the chat (2026-11-07).** In the production price check, Urk
answered with a link to the Operations card, and the card needed Approve and
then Apply. The owner: "the approval prompts should either be in the LLM
chat, 1 click to confirm. OR, a modal prompt. Not a link". Now an answer
that names a commerce action shows that action as a card under the answer,
with the same before and after and one **Approve and apply** button; the
link leaves the answer. The step-up sign-in returns to the chat and applies
the change with no second click. On the Operations card, Approve also
applies the change. A person who may not approve sees who can. Check:
`scripts/plan-40b/browser-chat-price-card.js` on the chat preview
(`?scenario=commerce-action`), evidence
`evidence/plan-40b-phase-5/chat-price-card-browser.json`.
The step-up sign-in opens in a small window, and the chat page stays (the
owner: "Can it be a popup? not a page change"). Google returns the window
to `approval-signed-in.html`, which reports on this origin and closes; the
card then approves and applies. A browser that blocks the window falls back
to the sign-in on the page. An agent's proposal lapses after 15 minutes;
the full-page sign-in took longer than that in the production check.

Releases and production checks (7 November 2026, satyr-edge only; ingress
and Underclerk unchanged; the schema gate matched each time):

- 10:29 UTC, satyr-edge `cfeb2874` (board archive and image delete). In the
  owner's Chrome, "Image check" was archived from the board list; it was
  restored for a moment to reach its Images panel, its test image was
  deleted there after the second click, and the board was archived again.
  The image answers 404 at the screen route; the library is empty.
- 12:04 UTC, satyr-edge `392915c9` (the chat card). Another session's
  release (`02a5d2a6`, Plan 87 empty page view) replaced it 22 seconds
  later: its guard read the live id before this upload.
- 12:29 UTC, satyr-edge `e3c53efd` from `3a4d3ec7b` (that session's source
  plus the chat card, the focus fix and the popup sign-in). Rollback
  target: `02a5d2a6`.
- Price check: Urk proposed ¥300 → ¥280 in the chat beside Menus; the owner
  clicked Approve and apply on the card, and the QR order page and the
  screens showed ¥280. The reset to ¥300 is open: its proposal lapsed, and
  then the Console's eligibility calls failed from 12:49 UTC (a Console
  fault outside this work), so the workspace answered 503.
- Not released yet: the proposal instruction that keeps the link for the
  card and stops "open this link" (dev `ec396b11c`), and a card that stays
  with "Try again" when Satyr cannot read the action (the owner's click
  during the Console fault made the card vanish).
Evidence: [plan-40b-phase-5.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-5.md), with
acceptance journey 4 ("Together").

- A board can use a free canvas for each screen shape: "Free canvas ·
  landscape TV", "· portrait TV" and "· tablet". Each element then has a
  rect and constraints. New fixed layouts give every shape one: "Two
  columns · tablet" and "Pickup board · portrait TV".
- A person selects, moves and resizes elements. Edges and centres snap to
  the other elements and the board, with guide lines; with no guide near,
  they snap to an 8-unit grid. Alt turns snapping off; Shift keeps the
  ratio of a resize. The arrow keys nudge by 1, or by 10 with Shift.
  Shift-click selects more; Align (left, centre, right, top, middle,
  bottom) and Space across or down act on the selection. The layers list
  shows the stacking order and brings a selection forward or back. Cmd+D
  duplicates, Delete removes, Cmd+Z and Shift+Cmd+Z undo and redo.
- Other people's cursors and selections show on the canvas and in the
  layers list.
- "Show on" previews the board on the other screen shapes. A screen of
  another shape keeps the board's height, takes its own width, and places
  each element by its constraints.
- Urk moves and resizes an element with `menu_board_edit` kind
  `place_on_canvas`, and adds text at a rect. `menu_board_read` now lists
  every item on the published menu, also when the shop has no board or the
  draft lacks the item. This fixes the production failure of 2026-11-05,
  where Urk could not find an item ID on a shop with no board.

Decisions taken in slice 1 (each is the default that the owner can change):

1. A free canvas is a layout of its own for each shape, not a switch on a
   fixed layout. The board document keeps two keys, and a screen reads the
   shape from the layout.
2. A canvas placement is one atomic value with the rect, the stacking order
   and the constraints. Two moves of one element converge to one of them.
   A constraint change and a move of the same element at the same moment
   also keep only one of them.
3. On a screen of another shape, a resolved rect stays inside the screen
   when it fits, so a TV never cuts an element off at its edge.
4. Undo belongs to each person: the Portal keeps the inverse of each own
   edit (100 steps; typing in one field joins one step within one second)
   and applies it as a new edit. It never undoes another person's change,
   and it skips an element that another person removed. `Y.UndoManager` does
   not fit, because the board document replaces its Yjs document at each
   checked edit.
5. A drag writes the board once, on release. Other people see the person's
   cursor and selection during the drag, not the element in motion.
6. A move from a fixed layout to the canvas starts from the boxes that the
   browser drew. A move back puts each element in the column under its
   centre.
7. A TV player from before phase 5 cannot read a canvas release. It keeps
   its saved board until it loads the new Portal build.
8. `menu_board_edit` takes four new fields (`x`, `y`, `width`, `height`),
   null when an edit does not use them. No capability changes, so the
   release needs no policy backfill and no D1 patch.

Slice 2, style tokens and a type scale, is built on the same branch. Each
board has optional tokens: four colours (background, cards, text, accent),
the fonts of headings and text (serif, sans serif, rounded or monospace), the
text size (12 to 32) and the scale ratio (1.125 to 1.5). Four presets set
them all: Espresso, Paper, Matcha and Night market. The editor's side panel
shows them when no element is selected, with the type scale and a warning
below a 4.5 : 1 contrast. Urk changes a token with `menu_board_edit` kind
`set_style`. Evidence: the "Style" journey in the evidence file.

Decisions taken in slice 2:

1. A board with no token keeps today's look exactly: every colour and size
   in the board CSS falls back to its earlier value.
2. Each token is one key of a third Yjs map, so two people who change two
   tokens both keep their change, and two writes of one token keep one.
3. A release carries `style` only when a token is set, so a TV player from
   before phase 5 still reads a board in the default look.
4. Muted text, rules and badges derive from the text, background and accent
   colours, so a person sets four colours, not eleven.
5. The contrast warning advises and does not block: a person may still
   publish a low-contrast board.
6. Fonts are families with fallback stacks, not uploaded files. A TV without
   the first font shows the next one in the stack.

Slice 3, the item-row component, is built on the same branch. Every item of
a section repeats one item row, in one of five variants: name and price on
one line, dot leaders to the price, the description under the name, the
price first, or tiles. The board sets the default in its Style panel, and a
section can choose another in its drawer. Urk sets a section's row with
`menu_board_edit` kind `set_row`, and the default with the `itemRow` token.
Evidence: the "Rows" journey in the evidence file.

Decisions taken in slice 3:

1. The item row is one built-in component with five variants, not a
   component that people draw. Every variant shows the same live facts, so
   no variant can hide a price or a sold-out mark.
2. The board's default is the style token `itemRow`; a section's own row is
   an optional prop `row` of its element. A section with no row has no key,
   so it reads as before phase 5.
3. A TV player from before phase 5 cannot read an element with a `row` key.
   It keeps its saved board until it loads the new Portal build.

Slice 4, the marquee select, is built on the same branch. A drag on the
empty canvas draws a marquee; on release it selects each element that it
touches, and Shift adds them to the selection. During the drag the touched
elements show a blue outline. Undo and Redo moved from the canvas toolbar to
the board toolbar, so that they also work in a fixed layout: a move to the
canvas and back is one step each way. Evidence: the "Canvas together"
browser journey in the evidence file, with two real browsers on one board.

Decisions taken in slice 4:

1. A marquee selects an element that it only crosses, as in Figma, not only
   an element inside it.
2. The selection changes once, on release, so that a marquee sends one
   presence update and not one for each pointer move.
3. Urk has no marquee. A selection is a person's view of the board; Urk
   names elements by their IDs, and `menu_board_read` gives every element
   with its rect. No board data changes, so no tool is needed.

Slice 5, a drag that other people see while it moves, is built on the same
branch. During a move or a resize, the person's presence carries the drag:
the moving elements with their offset, or the one element's new rect. Other
people see the elements move with the person's name on them, at most 15
times a second. The board still changes once, on release. Evidence: the
"Live drag" browser journey in the evidence file.

Decisions taken in slice 5:

1. A drag in progress is presence, not a board edit. It reaches nobody who
   opens the board later, and it never reaches a screen. This keeps
   decision 5 of slice 1: a drag writes the board once, on release.
2. A move sends one offset for all its elements, with the corner where the
   drag began. A viewer adds the offset only while the elements are still
   there, so the release does not show the move twice.
3. A drag shows at most 12 elements in motion, and its presence is at most
   900 bytes, because a socket keeps its presence in a 2 KiB attachment. A
   larger selection still moves; the others see it on release.
4. A Portal tab from before this slice cannot read a drag's presence. It
   asks the person to reload when another person drags. No screen is
   affected.
5. Urk has no drag. An agent places an element in one edit with
   `menu_board_edit` kind `place_on_canvas`, and people see the result at
   once, so there is no motion to show.

Slice 6, comments pinned to an element, is built on the same branch. A
thread starts on one element, and replies follow it. A pin with the number
of open threads shows on the element in a fixed layout and on the canvas.
The element's drawer shows its threads, with Reply, Resolve, Reopen and a
Delete for the person's own comments; with no element selected, the side
column lists every open thread. Every member reads comments; staff and
above write them. Urk reads the threads in `menu_board_read` and replies,
comments, resolves or reopens with the new tool `menu_board_comment`.
Evidence: the "Comments" journey and the "Comments in two browsers" browser
journey in the evidence file.

Decisions taken in slice 6:

1. Comments live in the Organisation Actor's storage beside the board, not
   in the board's Yjs document. The Actor writes the author and the time,
   so no person can write a comment in another person's name, and a
   release never carries a comment.
2. Other people's comments reach an open board within 5 seconds: the
   Portal reads the comments again every 5 seconds. Edits, cursors and
   drags stay live in the room.
3. A thread stays when its element is removed, marked "Not on the board
   now", so that a person can still read and resolve it. A version restore
   (slice 7) that brings the element back pins it again.
4. Only the author deletes a comment; a deleted first comment takes its
   thread. Urk's comments have no person as author, so a person resolves
   them and does not delete them. A reply opens a resolved thread again.
5. A board holds at most 300 comments of at most 1000 characters each.
6. `menu_board_comment` runs through the same agent path as
   `menu_board_edit`: the edit capability `commerce.menu_draft.edit`, the
   person's own role check and the shared-draft exit check. The comment
   takes its ID from the operation, so a repeated call adds one comment.
   No capability changes, so the release needs no policy backfill and no
   D1 patch: the comment table lives in the Organisation Actor.

Slice 7, version history with restore, is built on the same branch. A
board keeps a version when it is made, when a person names one, when it is
published, before each restore, and before the first edit after ten quiet
minutes. The editor's History panel lists them, newest first, names the
board as it is, and restores a version. A restore is one edit of the shared
draft, so every open editor follows at once with no reload; it first saves
the draft as "Before a restore", and restoring that version undoes it. Urk
reads the versions in `menu_board_read` and saves or restores one with the
new tool `menu_board_history`. Evidence: the "History" journey and the
"History in two browsers" browser journey in the evidence file.

Decisions taken in slice 7:

1. A version is a frozen copy of the board's Yjs document in the
   Organisation Actor's storage. A restore writes only the titles, tokens,
   props and placements that differ, and removes and adds back elements,
   so a concurrent edit of another value survives the restore.
2. A restore changes the draft only. Screens keep their release until a
   person publishes, as for every other board edit.
3. A restore is undone by restoring its "Before a restore" version, not by
   the person's Undo, because it is one edit of the room that other people
   saw. The person's own Undo still holds their own earlier edits.
4. A board keeps at most 40 versions. The oldest automatic versions go
   first, then the oldest others; the newest named version always stays.
5. A restore brings back a removed element with its ID, so its comment
   threads are pinned to it again.
6. Staff and above save and restore versions; every member reads the list.
   `menu_board_history` uses the edit capability and the board edit path,
   like `menu_board_comment`. No capability changes, so the release needs
   no policy backfill and no D1 patch: the version table lives in the
   Organisation Actor.

Slice 8, auto-layout stacks on the canvas, is built on the same branch. A
stack is a new element kind on the free canvas. It shows nothing itself and
places its elements one after another, down or across, with a gap between
them and padding inside its rect; across its direction it aligns them to
the start, the centre or the end, or makes them fill it. Each element keeps
its own size along the stack, so a taller element moves the next one down
with no edit of its own. In the editor, "Stack down" and "Stack across" put
the selected elements in a new stack; a drag of an element in a stack moves
the whole stack; the drawer sets the gap, the padding and the alignment,
reorders an element, takes it out, or unstacks all of them; the layers list
shows each stack's elements under it. Urk uses the new tool
`menu_board_stack`, and `menu_board_read` now gives `canvasRects`, where each
element of a free canvas shows. Evidence: the "Stacks" journey and the
"Stacks in two browsers" browser journey in the evidence file.

Decisions taken in slice 8:

1. An element in a stack has a placement of its own kind: the stack, an
   ordering key and its size. It is one atomic value, as every placement
   is, so two moves of one element converge to one of them.
2. A stack's direction, gap, padding and alignment are separate props, so
   two people who change two of them both keep their change.
3. A stack has a fixed rect, as a fixed-size frame in Figma. Elements that
   do not fit run past its end; the board does not grow a stack to hug its
   elements.
4. One level only: a stack does not sit in a stack. An element whose stack
   is gone goes to the recovery area, and the board cannot be published
   until a person places it. The Portal's own Remove and the move to a
   fixed layout unstack first, so they leave no element without a place.
5. On a screen of another shape, the stack follows its constraints and
   then places its elements inside, so they stay in order.
6. A TV player from before this slice cannot read a release with a stack.
   It keeps its saved board until it loads the new Portal build.
7. `menu_board_stack` runs through the board edit path with the edit
   capability. A new stack takes its ID from the operation, so a repeated
   call makes one stack. No capability changes and no D1 patch.

Slice 9, prompt to edit from a selected element, is built on the same
branch. With elements selected, the drawer (or the side column for several)
has "Ask Urk to change this element". The words go to a new Portal chat, and
the message carries the Boards page: the board, and each selected element
with its ID, kind, text and place, so "this" names the selection. Urk
changes the draft with its own board tools; the board shows the change at
once, and the panel shows Urk's reply, names the elements that changed and
offers "Undo Urk's change", which puts them back as the person's own edit
("Bring the change back" takes that back). The first time, the platform
holds the step, because the words of a private chat would reach the shared
board; the panel offers "Allow and ask again". Evidence: the "Prompt to
edit" journey and the "Prompt to edit in a browser" browser journey in the
evidence file.

Decisions taken in slice 9:

1. The agent needs no new tool: the Boards page sends the selection in the
   Plan 81 page view, and Urk uses `menu_board_edit`, `menu_board_stack`
   and the other board tools with the person's own checks.
2. Each request starts a new chat, so a request about one element does not
   carry the history of another. The panel links to the chat.
3. The undo restores only the elements that were selected when the person
   asked, as they were then, and only those that changed. It is the
   person's own edit, so it never touches another element, and the
   person's Undo takes it back. When a person changed one of them
   meanwhile, the undo takes that change back too; the panel says
   "Changed since you asked" when the agent's label did not show.
4. The platform's flow check holds the first edit from a private chat:
   allowing it is the person's decision on the existing held-output
   prompt, and the panel asks again with the same words after the person
   allows it. The page view grants nothing.
5. A shared chat gets no page view (Plan 81 slice 10), so prompt to edit
   always starts a private chat.

Not done in phase 5: a real model, real Slack and a real TV; the browser
journey of prompt to edit runs no agent turn, because the Plan 74 harness
Worker has no model exit binding (the E2E journey runs the agent half); an
automatic version after ten quiet minutes; and the Plan 87 composer chip,
which will show which page a message carries.

Not done in slice 1: a real model, real Slack and a real TV. The Portal's
own client in a browser (undo, redo and the layout moves) and two real
browsers on one board ran in the slice 4 journey "Canvas together".

Workspace layout (2026-11-06). The owner asked for the canvas to fill the
page, with the tools floating over it, as in Figma or the Claude design
canvas. Boards is now one workspace below the Portal's top bar:

1. The canvas fills the pane on a dotted ground. The board sits on it at a
   zoom that fits the space between the panels, with its name above it. The
   wheel pans; Ctrl or Cmd and the wheel, or a pinch, zooms at the pointer;
   a drag on the empty ground, Space and a drag, or the middle button pans.
   Shift 1 fits, Shift 0 is 100%, Ctrl + and − zoom. The board fits again
   when the board, its layout or the "Show on" shape changes, until the
   person zooms or pans.
2. A left panel holds the Menus tabs as a segmented control, the board list
   with "New board", and the layers list. A toolbar floats at the top with
   Layout, Add, Undo and Redo; the align, distribute and stack tools join it
   as icons when two or more elements are selected. A right panel holds the
   people on the board, the save state, History and Publish, and below them
   the inspector: Style, the selected element, or the version history. Zoom
   and "Show on" float at the bottom left; notices float at the bottom.
3. A pane narrower than 761 px (a phone, or a narrow window with the chat)
   keeps the panels in the page flow above and below a fixed-height canvas.
   A pane up to 1,180 px wide, as with the chat open, gets narrower panels.
   The rules are container queries on the workspace, so the chat's width
   counts. Items and Screens keep their page layout.
4. Every control keeps its name, so the browser journeys and the agent's
   page view are unchanged; no element, tool or route changed.

Evidence: the nine Portal board journeys of `scripts/plan-40b` pass on the
new layout (the TV player journey does not use the editor). A check in the
real Portal frame with the chat open, in dark mode and at 760 px is local
only. Not done: a collapsible left panel; with the chat open, the canvas
between the panels is narrow.

The canvas is the Menus page (2026-11-06). The owner asked that Menus open
straight on the canvas, with no Items or Screens page. The Items, Boards and
Screens tabs are gone:

1. Menus opens the board canvas. Two buttons at the top of the left panel,
   "Menu items" and "Screens", open a sheet in the Portal's `SideDrawer`
   (owner, 2026-11-06), wider than the default for the menu editor; Close,
   Escape or a click beside it go back to the canvas. A shop with no board shows the same two buttons on
   the start screen.
2. The Menu items sheet is the menu draft editor of before, with the
   shop's publication, serving hours and shop name; the Screens sheet is
   the screen list and pairing. Nothing that the two pages did is lost.
3. The address names an open sheet as `?tab=items` or `?tab=screens`, so
   older links open that sheet over the canvas. The canvas stays mounted
   under a sheet, and it reads the menu, the facts and the boards again
   when the sheet closes.

Beside the chat (2026-11-06). The Menus page reads its sheet from the address
of the page beside the chat (`pageAddress`), and a tab link with the chat
open keeps the chat route (`pageLink`), as the Agents page does. Before
this, the Ask link moved the address to the chat route, the page fell back
to Items, and the canvas went away until the chat closed. Now the Boards
tab and the same canvas stay, and the canvas fits the narrower pane. The
browser journey `browser-board-chat.js` makes the Ask link's move on the
preview's router, checks the same canvas node and its width with the chat
open and closed, and fails on the old code.

Start screen (2026-11-06). The owner approved a mock (Design canvas "Satyr
Kitchen menu builder"): a new board starts on a sheet over the canvas, and
the canvas then gets screen guides and a Products panel. The start screen
is built:

1. A shop with no board opens Boards on the start screen, with the Menus
   tabs and no Cancel; "New board" opens it with Cancel. The person picks
   a start and names the board. The owner removed the screen step
   (2026-11-06): one board fits every screen through its constraints and
   the screen guides, so every start is a landscape board, and the
   toolbar's Layout changes the layout later. Urk's `menu_board_create`
   still takes any layout.
2. The starts: Blank (an empty free canvas), Free canvas (the canvas
   template with the menu's sections), the landscape fixed layouts (Three
   columns, Featured item, Pickup board), and four designed menus: Espresso bar, Bakery counter, Matcha and Night
   market. A design is a free canvas with a style preset and an item row
   (`MENU_BOARD_DESIGNS` in `@satyr/menu-board-crdt`); Night market shows
   the order codes and the QR code, not the menu.
3. The server makes the board: `POST …/menu-boards` takes an optional
   `start` (`template` by default, so older clients keep their behavior),
   and a start other than `template` needs a `canvas_*` layout, else 422
   `menu_board_invalid`. The seed fills a design from the menu draft, as the
   template does, so a design shows the shop's own sections.
4. Urk makes the same boards with the new tool `menu_board_create` (title,
   layout, start), under the person's check to edit menu boards and the
   exit check for a shared draft (resource `menu-board:new`). A design on a
   fixed layout comes back in words that the model can act on. Before this,
   an agent could not make a board at all.
5. The design pictures on the start screen draw lines in the design's
   colours, not product names: the names come from the menu only on the
   board itself.

Evidence: `pi-menu-board-create.test.ts` (two identical runs, artifact
`evidence/plan-40b-phase-5/menu-board-create.json`): a viewer is refused,
a design on a fixed layout is refused, a blank canvas has no element, Night
market has its codes and QR code on the canvas, and Urk's Matcha board for a
portrait TV has the Matcha style, tiles and the template's elements. The
browser journey `browser-start-board.js` sees no screen step, makes a
Matcha board and a blank canvas from the start screen and cancels a third.

Screen guides (2026-11-06). A free canvas board shows a dashed band for
each other screen shape, in that shape's colour and with its name: a screen
draws a free canvas at the board's height and its own width, so the band is
that width, centred (within the 0.4 to 3 aspect limits of the player). An
element outside a band moves by its constraints on that screen; "Show on"
still draws the exact result. The guide buttons beside the zoom turn each
band on or off; they are local to the person and never reach the board.

Products panel (2026-11-06). The left panel has Layers and Products tabs (a
fixed layout has Products only):

1. Products lists the menu draft's items by section, each with its live
   price, "sold out today" or "Not on the published menu yet", and then the
   shop's products that are not on the menu. A search box filters both.
2. A person drags a product onto the canvas, or presses its +. The board
   gets a product at the drop point (at the centre for +; at the end of the
   first column of a fixed layout). A product that is not on the menu goes
   into the menu draft first, in its first section (a "Menu" section when
   it has none), through the draft's own room, which connects only then.
   It shows a price after a person publishes the menu.
3. A product is the featured element with a new optional prop `look`: card
   (the featured card of before, and the default), row (one item row with
   dot leaders), tile (one tile of the item-row component) or price (the
   name and a big price). Each look shows the live price, the deal and the
   sold-out mark. The inspector shows Card, Row, Tile and Big price; the
   element's name in the editor is now "Product".
4. Urk adds one with `menu_board_edit` kind `add_item` (frameId, itemId,
   the look as text, and a rect on a free canvas) and changes it with
   `set_look`. An unknown look comes back in words that it can act on; a
   product that is not on the menu needs `menu_draft_edit` first.
5. Release note: a TV player from before this change cannot read a release
   with a `look`, as with a stack; it keeps its saved board until it loads
   the new Portal build. A board with no `look` reads as before.

Evidence: `pi-menu-board-products.test.ts` (two identical runs, artifact
`evidence/plan-40b-phase-5/menu-board-products.json`): a viewer's product is
refused, Urk's unknown look is refused, its tile becomes a big price, and
the release carries the look to the TV with the live price. The browser
journey `browser-board-products.js` drags a product that is not on the menu
onto the canvas, sees it in the menu draft, changes its look in two
browsers, and adds it again with +. Its browser answers the shop's product
list read, because the harness Worker has no shop.

Product photos (2026-11-06). A product on a board shows its first photo
from the Products page, with no new board element:

1. The screen facts carry an optional `image` (`url`, `altText`) on each
   entry: the first image of the entry's listing in the café shop's
   catalog. As with `compareAtPrice`, the key goes only with a photo. The
   photo is a live shop fact like the price, so a new or reordered photo
   reaches every TV on its next feed read, with no new release.
2. The card look shows the photo above the name and the price, and the
   tile look and the "tiles" item row show it at the top of the tile. In a
   product's own frame the photo takes the room that the copy leaves. The
   row and big-price looks show no photo. A sold-out product's photo goes
   grey. A photo with no alt text takes the item's name.
3. The Products panel shows each product's first photo in place of its
   letter. The products list of `GET .../commerce/menu-publication` gives
   `image` from the shop's media library, at the café storefront's address,
   as the inventory page builds it.
4. Urk needs no new tool: a person or Urk adds the photo on the product,
   and the board shows it.
5. The shop names photos only on an HTTPS Underclerk address. Production
   and staging use HTTPS. The local `dev` Worker and the E2E suite name
   Underclerk by HTTP, so a board there shows no photo; the E2E journey
   names it by HTTPS for its photo steps.
6. Release note: a TV player from before this change reads screen entries
   with exact keys, so a shop with a photo makes its facts unreadable to
   that player. It then keeps its saved facts as not verified until it
   loads the new Portal build.

Evidence: `pi-menu-board-products.test.ts` now also adds a photo through
the Products page route; the TV feed, the editor's facts and the Products
panel's list name the same HTTPS photo (two identical runs). The browser
journey `browser-board-products.js` sees the photo in the Products panel
and, on a paired TV, on the card and not on the big price; its browser
answers the photo bytes and the feed's shop facts.

Not done in this pass: several products in one drag and a drop into a
fixed layout's frame under the pointer.

The image element (2026-11-06). A free canvas board shows any image of the
shop's media library, not only a product's photo:

1. A board element `image` holds `mediaId`, `altText` and `fit` (cover or
   contain), in a rect on a free canvas.
2. The left panel's Images tab lists the shop's library (`GET
   …/commerce/media`) and uploads a new image to it (`POST
   …/commerce/media/add`, admins and owners, under the same receipts as a
   product photo). A person drags an image onto the canvas or presses its
   +; the inspector sets Fill or Fit inside and the text that a screen
   reader reads.
3. The shop serves an image publicly only while a listed product shows it,
   so that draft and archived products stay private. The owner chose
   (2026-11-06) that publishing a board makes its images public:
   - Underclerk gives the merchant's own app an image's bytes with
     `read_media_content` (`catalog:read`, never cached).
   - The board editor reads an image under the person's session
     (`…/commerce/media/content/:mediaId`).
   - A release with an image names `mediaBase`, the Platform's screen
     route `/v1/screens/media/:organisationId/`. That route serves an image
     only while the newest release of a board of that Organisation names
     it, with a 5-minute public cache; any other image answers 404.
4. Urk reads the library in `menu_board_read` (`images`), places an image
   with `menu_board_edit` `add_image` (the mediaId as itemId, the alt text
   as text, and a rect) and changes the fit with `set_fit`. An image that
   is not in the library comes back in words that it can act on.
5. Release note: this needs the Underclerk release with
   `read_media_content`. A TV player from before this change cannot read a
   release with an image or a `mediaBase`, as with a stack; it keeps its
   saved board until it loads the new Portal build.

Evidence: `pi-menu-board-image.test.ts` (two identical runs, artifact
`evidence/plan-40b-phase-5/menu-board-image.json`): a viewer's upload is
refused, the owner's upload is listed, Urk's unknown image is refused, its
image fits inside, the editor reads the bytes, the screen route answers 404
before the publish and 200 with the same bytes after it, and another image
stays 404. The browser journey `browser-board-images.js` uploads an image,
drags it onto the canvas, sets its fit and text in two browsers, and sees a
paired TV load it from the release's address; its browser answers the
shop's reads, because the harness Worker has no shop.

#### Canvas page layout (released 2026-11-06)

On a window of 1161 px or more, the Menus page is a canvas page: the board
fills the window, and the Portal draws no rail and no top bar. A page asks for
this layout with `useCanvasChrome()` (`apps/portal/src/console-tools.tsx`);
the shell then sets `data-canvas-page` and hides the rail. The board editor
draws one top row of floating containers
(`features/menu-boards/canvas-chrome.tsx`):

- At the top left, "Menus ▾" and the board name. The menu holds Back to home,
  Search workspace (⌘ K) and New board.
- In the middle, the board toolbar and the zoom bar.
- At the top right, the console tools (search, appearance, Ask and the
  account) in their own container.

The panels start below this row. A scroll on a fitted board does not move
the board; after a zoom or a drag, a scroll pans it. On a narrower window the
normal rail and top bar come back, and the toolbar scrolls sideways when it
has no room. A full-screen chat keeps the rail.

Released in satyr-edge `3e185b42` (dev `c35b026c1`). Production check in the
owner's Chrome: the layout at full width, at 1180 px, at 1000 px and with
the side chat open; the Menus menu; and a still board after a scroll down and
a scroll right. No console error.

### Phase 6 status (2026-11-05)

On `dev` since 2026-11-05 (`80f07db53`). Live since 2026-11-05 07:34 UTC
(Underclerk `759eb825`).
Evidence: [plan-40b-phase-6.md](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-6.md). Operator
guide: [the Underclerk MCP server](../services/underclerk/docs/mcp.md).

- The Underclerk Worker answers MCP at
  `POST /v1/admin/merchants/:merchantId/mcp`, in each merchant's own object.
  An operator's coding agent connects with the shop's API key from the
  Portal's API keys page (Plan 80 step 3).
- Four tools, each behind one scope of the key: `list_storefronts`
  (`settings:read`), `read_catalog` (`catalog:read`: listings, menus, live
  prices and deals, or a search), `create_checkout` (`orders:write`: a guest
  buyer's cart and pickup checkout, with the buyer session that pays it) and
  `read_order` (`orders:read`). `tools/list` shows a key only its tools.
- Each tool calls the same routes as a site, so routes keep their own
  checks, idempotency and receipts. A receipt of an admin call names the key.
- The spec (section 3 and Appendix A) describes the server. It is outside
  the route table, as `/health` is.

Decisions taken in phase 6 (each is the default that the owner can change):

1. The server is stateless Streamable HTTP with JSON answers: no MCP session
   and no event stream. Each tool is one short request, so a stream adds
   nothing.
2. `create_checkout` needs `orders:write`, although a buyer route needs no
   credential. The tool holds stock, so an agent's key must allow orders.
3. Checkout is pickup only. A shipping checkout needs an address validation
   step; add a tool when an operator's site sells by post.
4. No tool pays. A site pays with the buyer session through the buyer
   routes, as a browser does, so no agent holds a payment.
5. No Satyr agent tool: this is an Underclerk API for the operator's own
   coding agent, not a Portal or Slack action. The Portal does not yet show
   the MCP address; the operator guide gives it.

Not done in phase 6: a real coding agent (Claude Code or Codex) on the
deployed Worker, the MCP address on the Portal's API keys page, and the
Satyr MCP server that the plan's demo site uses for email and queries.

### Release of 2026-11-05 (phases 4 and 6)

Underclerk `759eb825` replaced `30996299` at 07:34 UTC, from `origin/dev`
`90b49e7ee`. It also carries the Plan 86 Supply Cost Terms list and a test
prune; the schema stays 85. `satyr-edge` stays `89ca96c5` (06:49 UTC, another
session's release of `dev`), which already holds the phase 4 Portal and agent
code. The schema check passed (global 61, APAC 364 with 1 extra).

Live checks:

- MCP with the production operator token: `initialize` (2025-06-18),
  `tools/list` (four tools), `list_storefronts` (`storefront_cafe`) and
  `read_catalog` (the café menu, with `compareAtPrice` on each entry). A
  call without a key gets 401.
- 60 s tails: Underclerk 12 ok, `satyr-edge` 14 ok, no exceptions.
- A real model (Claude Sonnet 5.5, Portal chat) proposed the Black sesame
  financier at ¥320 instead of ¥330, and the card showed both prices. The
  first try failed: production has no board, and the agent found the menu
  entry only from a board, so it needed the menu entry and offer IDs from
  the operator. The card expired before the owner's approval. A second
  proposal failed: the Claude account route did not finish the turn.

Not done in this release: the owner's approval and the price on the QR page,
the restore, a real coding agent on the MCP server, and a real TV.

### Phase 7 plan: agents on the canvas (2026-11-06)

In progress; see the [status](#phase-7-status-2026-11-08). The owner asked for this phase on 2026-11-06, from two design
references: a video where 49 coloured cursors rebuild a web page, and a
pencil.dev video where six named agents design an app together. The goal: a
person sees what an agent does on the board while the agent does it, in the
agent's own colour, as clearly as the person sees another person today. The
phase builds on phase 5, which is not released yet.

What the references show, and what this phase takes from them:

| Reference feature                                                    | Phase 7                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| One colour and one name tag for each agent, with an AI mark          | Taken (slice 2)                                      |
| The cursor shape tells the action: arrow, crosshair or text cursor   | Taken (slice 2)                                      |
| A new box grows at its place with a W×H badge                        | Taken as a ghost box at the real rect (slice 3)      |
| Placeholder frames named "Generating …" (pencil.dev)                 | Taken as the ghost box label (slice 3)               |
| A text box fills letter by letter                                    | Taken from the model's real tool arguments (slice 4) |
| Rulers, edge guides and red spacing numbers                          | Taken, for people and agents (slice 5)               |
| A bar with avatars, counts, a follow control and Stop                | Taken, with Follow off by default (slice 6)          |
| A line of the agent's own words under the canvas (pencil.dev)        | Taken for the person who asked (slice 6)             |
| Cursors that travel between targets; a staged rebuild of a done page | Not taken: Plan 40C forbids invented pointer travel  |
| Several agents from one prompt (pencil.dev "Parallel agents 1x–6x")  | Not in this phase; see the open decisions            |
| A replay of the whole build                                          | Not in this phase; phase 5 has the version history   |

Starting state (facts from the code, 2026-11-06):

- The canvas shows other people: cursors, selection boxes with names, live
  drags (the `moving` presence) and layer badges. A person's colour is a hash
  of the user ID over six colours (`participantColor` in
  `apps/portal/src/features/menu-boards/canvas-editor.tsx`).
- `CanvasEditor` does not receive the room's agent activity. Only the prompt
  panel reads it, to name the author of a change (`boards-panel.tsx`,
  `prompt-edit.tsx`).
- An agent activity has three keys: `agent` (`sessionId` and
  `displayName`), `operationId` and `target`
  (`packages/collaboration/src/agent-presence.ts`). The room shows it while
  the edit runs and holds it for `AGENT_ACTIVITY_HOLD_MS` (5 s) after an
  accepted edit. It lives in Actor memory.
- `boardEditTarget` (`services/platform/src/actors/menu-boards.ts`) names
  `"board"` for `add_text`, `stack_elements`, `set_style`, `rename_board` and
  the history edits. A new text element takes the ID
  `element_<operation ID prefix>`, so the server knows it before the commit.
- Each board tool call is one atomic Yjs update. A text prop is a plain
  string of at most 280 characters.
- Pi 1.5.0 sends `toolcall_delta` events with the partial arguments, and
  `@earendil-works/pi-ai` has a tolerant `StreamingJsonParser`. The stream
  loop in `services/platform/src/actors/pi-durable-runtime.ts` does not use
  these events. The tool operation ID comes from the tool call ID
  (`logicalToolOperationId`), so it is known when the call starts.
- An agent board edit passes `passSharedDraftExit` with the turn's flow
  binding before it reaches the room
  (`services/platform/src/agent-tools/drafts/handlers.ts`).

Slices:

1. **Agent action presence (2 days).** An agent activity in a board room
   gets an `action`: the kind (`select`, `create`, `move`, `resize`, `text`,
   `style`, `remove`, `comment` or `history`), the element IDs (at most 12),
   the proposed rect in board units or null, the text field or null, and the
   state `pending` or `applied`. `boardEditTarget` becomes
   `boardEditAction`: `add_text` names its new element and rect, and
   `stack_elements` names the new stack and its members. `CollaborationAgent`
   gets a colour key from the agent definition; the default agent has a
   fixed key. An action is at most 900 bytes, as a drag presence is. The
   other rooms (workflow canvas, product description, reply drafts) keep
   their present activity.
2. **The agent on the canvas (2 days).** `CanvasEditor` receives the agent
   activity. For each agent it draws an outline in the agent's colour around
   the named elements; a cursor at the rect's corner, whose shape follows the
   kind (arrow, crosshair or text cursor); a name tag with an AI mark and an
   action label, such as "Urk · placing Seasonal"; and a W×H badge for a
   create, a move or a resize. The layers list shows the agent's badge on the
   element. Agents have their own colours, apart from the six colours of
   people, so an agent never looks like a person. The code goes in a new
   module beside `canvas-editor.tsx`.
3. **Ghost box, then the real move (2 days).** While an action is `pending`
   (admission, checks and the room queue), the canvas shows the proposed rect
   as a dashed box in the agent's colour, with the label "Generating" for a
   new element. When the action is `applied`, the element moves from its old
   rect to its new rect in about 240 ms; with reduced motion it moves at
   once. If the activity goes away while it is `pending`, the ghost box fades
   out and the element stays where it was. A colour halo and the author tag
   stay for the 5 s hold.
4. **Real typing (1 to 1.5 weeks).** For `menu_board_edit` calls of kind
   `set_text` and `add_text`, the Session reads the `toolcall_delta` events,
   parses the text so far with `StreamingJsonParser`, and sends it to the
   room as the action's draft text: at most 10 times a second and at most 280
   characters. The canvas shows it in a text box with the agent's colour and
   a text cursor. Before the first part, the Session runs the checks of the
   edit: the live menu draft authority, the edit capability, and
   `passSharedDraftExit` with the turn's current flow binding. If a check
   fails, no draft text reaches the room, and the edit later fails on its own
   checks. The commit stays one atomic edit, and its accepted value replaces
   the draft text. If a model route sends the arguments in one part, the text
   shows at once. Draft text is presence: the room never persists it, and no
   version or release holds it.
5. **Rulers, size badges and spacing numbers (1 week).** The canvas gets
   rulers on its top and left edges. Each actor's selection shows as a range
   on the rulers in that actor's colour. A drag or a resize shows a W×H badge
   and, in red, the distance to the nearest neighbour on each side. The snap
   guides stay. This slice changes no wire format.
6. **Presence bar and the agent's words (3 to 4 days).** A bar under the
   canvas shows the avatars of people and agents, the number of active
   agents, and the number of changes in the agent's current request. Follow
   pans the view to an agent's target; it is off until a person turns it on,
   and any input from the person turns it off. Stop cancels the agent's
   request through the Plan 81 Cancel path; only the person who asked sees
   it. The person who asked also sees the agent's latest line of text, which
   already streams to that person's chat. Other people see only the action
   labels.

Decisions (each is the default that the owner can change):

1. The Plan 40C rule stays: no invented pointer travel or clicks. A cursor
   marks the real target, and the only motion on the canvas is one element
   that goes from its real old rect to its real new rect. The owner has not
   answered this question; the recommendation and the default are the same.
2. Draft text and action labels reach the room only after the flow check of
   an edit. The agent's words between tool calls go only to the person who
   asked.
3. A Portal tab from before this phase cannot read an agent action. It asks
   the person to reload, as slice 4 of phase 5 did for drag presence. No
   screen is affected, because screens play releases.
4. The board document, the releases and the capabilities do not change. A
   release is satyr-edge only: no D1 patch and no capability policy
   backfill.
5. Several agents from one request stay out of this phase. Satyr has no
   subagent feature: Plan 57 kept it out of scope, and a Plan 74 side Case
   is not a subagent. It needs its own plan, with one Session for each
   helper, its own budget, the requester's authority, and one board or frame
   for each helper. A room admits at most 20 active agent operations
   (`COLLABORATION_SOCKET_LIMIT`). Slices 1–4 are the same for one agent or
   several.

Journey 5, "Agent on the canvas" (an E2E test and a two-browser journey
through `scripts/plan-74/run-browser.py`):

- A controlled model stream sends Urk's `add_text` arguments in parts.
  Person A drags another element at the same time. Viewer B watches the
  board.
- B sees the ghost box in Urk's colour at the requested rect, with its W×H
  badge, before the element exists. Then B sees the text box with part of
  the text. Then B sees the element at its rect with Urk's tag.
- A's drag and Urk's element both converge. B's own edit is refused (404
  `organisation_role_insufficient`).
- Denied case: in a private chat, the flow check holds the first edit. B
  sees no draft text and no action label. After Allow, the edit shows.
- The artifact is a JSON timeline of the presence frames that B received
  (time, agent, kind, element IDs, rect and text length), the screenshots,
  and their SHA-256 digests.
- One run with a real model route records whether that route sends tool
  arguments in parts. This is not known for the OpenRouter, ChatGPT
  sign-in and BYO OpenAI routes.

Not in phase 7: several agents from one request, a replay of the board
history, an agent check of a board render, and a real TV.

### Phase 7 status (2026-11-08)

All six slices are on `origin/dev`: slices 1 and 2 since merge
`f4c420b1d`, slices 3 to 6 since `b45ad50f2` (2026-11-08). Phase 7 is
released: satyr-edge version `3b998e9f` (2026-11-08 09:57 UTC) was its first
upload, and its Portal chunks hold the `menu-presence-bar` and
`menu-canvas-agent` styles. The live version on 2026-11-09 is a later upload,
`e96dd4b4` (2026-11-08 15:26 UTC). The uploads came from the shared main
checkout, so production can hold files that are not on `dev`. The release
was satyr-edge only: no D1 patch and no capability policy backfill.

- **Slice 1.** `CollaborationAgentActivity` has an optional `action`
  (`packages/collaboration/src/agent-presence.ts`) and `CollaborationAgent`
  an optional `colorKey` (`violet`, `teal`, `gold`). Only a board room sends
  them; the other rooms send the same activity as before, so their open tabs
  need no reload. `boardEditAction`
  (`services/platform/src/actors/menu-board-agent-action.ts`) maps each
  board edit to its kind, element IDs, proposed rect and text field. A
  `place_on_canvas` that changes the size is a `resize`. The room marks the
  action `applied` for its hold. `resolveCanvasCollaborationAgent` gives Urk,
  and a Session with no pinned definition, `violet`; another definition takes
  a colour from its ID. The colour comes from the definition ID because the
  definition has no colour column; a column would need a D1 patch.
- **Slice 2.** `canvas-agents.tsx` draws each agent on the free canvas: an
  outline in the agent's colour, a cursor at the real target (an arrow, a
  crosshair for a create or a resize, a text cursor for a text), a tag with
  an AI mark, the action label and the W×H size, a badge in the layers list,
  and a status line for screen readers.
- **Slices 3 and 4, one change.** The two slices share one path, so they
  are one commit. The room's own `pending` window (admission, checks, queue)
  lasts milliseconds, too short to see. So the board shows an edit while the
  model writes it: the Session reads each `menu_board_edit` call's
  arguments as they stream (`PiToolArgumentStream`, with pi-ai's
  `StreamingJsonParser`; a number counts only when the model finished it)
  and sends a draft preview to the room (`board-draft-preview.ts`), at most
  10 frames a second. A preview covers `add_text`, `set_text` and
  `place_on_canvas`. Before its first frame, the Session runs the edit's
  checks: the edit capability, the live menu draft authority, an editor of
  the board, and `passSharedDraftExit` with the turn's current binding in a
  new check form, which asks nobody and takes no approval pass
  (`exitApprovalPassReady`, `hasHeldEffectPass`). The room admits the agent
  as it admits an edit, at most every 2 s, and keeps the preview in memory
  for at most 6 s after its last frame. The real edit takes its place; each
  tool call first waits for the frames already sent, so a late frame never
  shows after its edit. The action has an optional `text` (at most 280
  characters, outside the 900-byte limit). The canvas shows a dashed ghost
  box at the rect that the model wrote, with "Generating …" and the W×H
  badge for a new element, then the text letter by letter with a caret; a
  text change shows its text over its element. A move or a resize lands as
  one 240 ms motion of the element from its real old rect to its real new
  rect (none with reduced motion). A preview that goes away without its
  edit fades out in 320 ms; the element stays. An applied edit keeps a
  colour halo and its tag for the 5 s hold. The `menu_board_edit` schema
  now names the rect before the text, so a model writes the box first.
- **Slice 5.** `canvas-rulers.tsx` puts rulers on the board's top and left
  edges, not on the viewport's edges, because the floating panels cover
  those. Each actor's selection shows on both rulers as a range in that
  actor's colour: the person's own (orange), other people's (their colour)
  and each agent's target or ghost box (its agent colour). A box that moves
  or changes size now (the person's own drag, another person's drag from
  the `moving` presence, or an agent's pending create, move or resize)
  shows its W×H size, and in red the distance to the nearest element whose
  span overlaps it on each side, or to the board's edge. An agent's tag
  already shows its size, so its box shows only the distances. The snap
  guides stay. No wire format changes.
- **Slice 6.** `canvas-presence-bar.tsx` floats above the canvas footer.
  It shows the avatars of the people and the agents on the board, the
  number of active agents and, for each agent, the changes of its current
  request (the edits that the page saw land; a Portal chat request has its
  own Session, so the count belongs to that request). Follow is off at
  first; when a person turns it on, the view pans at once, with no motion,
  so that the newest agent's real target stands in its middle, and any
  pointer, wheel or key input of that person on the canvas turns it off.
  The person who asked sees Stop and the agent's latest line, and nobody
  else does: the chat publishes its running request (`conversation.work`
  with the Session ID, and the last line of the streamed answer, else its
  progress label) to a store in the browser (`chat/agent-request.ts`), and
  the bar shows them only for the agent whose Session ID matches. Stop
  calls the chat's own Cancel (`ChatPage.stop`, `POST …/chat/cancel`) with
  its checks. Nothing new leaves the browser and no wire format changes.
  `chat/route.tsx` keeps its 4,297 lines: three imports became one.
  The agent gets no tool for Follow or Stop (AGENTS.md, agent access):
  Follow moves only the person's own view, and Stop ends the agent's own
  request, which the agent ends by ending its turn.
- **Journey 5.** `scripts/plan-40b/browser-board-agent.js` runs through the
  Plan 81 harness (`scripts/plan-81/run-browser.py`, real chat turns). The
  simulated model streams each board edit in parts: one part for each
  field, a pause after the rect, then the text two letters at a time. The
  second person is now a viewer (Member, seeded as `viewer`). The journey
  checks 86 outcomes, among them: the private chat holds each first edit,
  and neither browser receives a new agent operation before the Allow; the
  viewer sees the move's ghost box at the rect that the model wrote, then
  one 240 ms motion of the heading to it; the viewer sees the new note's
  ghost box with "Generating …" and "640 × 96" before the element exists,
  then part of the note ("Oa"), then the note with the agent's tag; the
  owner drags another element meanwhile, and both views show the same
  rect; the viewer sees part of the rewrite over the note; the viewer's
  presence frames carry the note's text in growing parts; the viewer's own
  edit (a saved version) is refused with 404
  `organisation_role_insufficient`. Slice 5 adds: during the owner's drag,
  the owner sees its size and a red distance on each side that equals the
  real gap to the nearest element or edge; the viewer sees the same
  numbers on the owner's drag; the owner's selection, the owner's range on
  the viewer's rulers and the agent's new box (in violet) show on the
  rulers at their real place. Slice 6 adds: the viewer's bar shows both
  people, the agent, "1 agent active" and "Satyr: 1 change", and no Stop
  and no words; Follow is off at first, then keeps the agent's draft in the
  middle of the viewer's view, and the viewer's wheel turns it off; the
  owner sees Stop and the chat's latest line on the bar during a fifth,
  streamed request, presses Stop, and the chat request ends, the ghost box
  goes away and the note never lands. 102 checks pass. Evidence:
  [board-agent-browser.json](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-7/board-agent-browser.json)
  (checks, tags, streamed edits, the viewer's presence frames with time,
  kind, rect and text length, and each picture's SHA-256 digest) and 13
  pictures in `docs/evidence/plan-40b-phase-7/`.
  `scripts/plan-40b/board-agent-evidence.py` writes it from a run.
- **Real model routes (2026-11-09).** Each route sends a `menu_board_edit`
  call's arguments in parts. `scripts/plan-40b/real-route-tool-stream.ts`
  (in `services/platform`) sends one `add_text` request with the production
  tool schema and thinking level through pi-ai, from this machine to the
  provider (not through the exit Workers), and feeds each event into the
  real `PiToolArgumentStream`. Three runs for each route; the note has 89
  characters:

  | Route (model)                                                          | Parts | Arguments take | Rect before text | Text grows over      |
  | ---------------------------------------------------------------------- | ----- | -------------- | ---------------- | -------------------- |
  | `platform`, OpenRouter (`moonshotai/kimi-k3`)                          | 32–33 | 1.8–2.1 s      | yes, 0.2–0.4 s   | 0.35–0.6 s, 6 steps  |
  | `platform`, OpenRouter (`qwen/qwen3.7-flash`)                          | 41–43 | 1.4 s          | no rect at all   | 0.4–0.45 s, 7 steps  |
  | `organisation_byo` + `openai` (`gpt-5.6-luna`)                         | 85    | 0.25–0.54 s    | yes, 0.01–0.09 s | 0.1–0.2 s, 22 steps  |
  | `organisation_subscription` + `openai` (Codex sign-in, `gpt-5.6-luna`) | 85    | 1.4–1.5 s      | yes, 0.2 s       | 0.55–0.6 s, 22 steps |

  At 10 frames a second, a viewer sees the ghost box first and then about 4
  to 6 text steps on Kimi and the ChatGPT sign-in, and 1 or 2 on the BYO key.
  `qwen/qwen3.7-flash` writes the rect as strings (`"x": "80"`); Pi converts
  them to numbers before the edit runs, so the edit works. Fixed
  2026-11-10: `draftRect` (now in `board-draft-edit.ts`) accepts a string
  of up to four digits once the model has started a later field. In three
  new qwen runs the preview's rect (`firstPreviewRectMs`, from the
  production `draftEdit`) shows with the first text.
  Claude Sonnet 5.5 (2026-11-10): this machine has no Anthropic key, so the
  run used OpenRouter (`anthropic/claude-sonnet-5.5`), not the Anthropic
  route. 21 parts in 1.5 s; the rect comes 0.1 s before the text, and the
  text grows over 0.5 s in 5 steps. pi-ai asks Anthropic for
  `eager_input_streaming` on each tool, so the Anthropic route also streams
  the arguments in parts. The model is therefore not why no text showed in
  the production check (see below).
  Evidence: `docs/evidence/plan-40b-phase-7/real-routes/` (each part's size
  and time, and each frame's fields, rect and text length; no secret). The
  path through the room and a viewer's browser was not run on a real route.
- **Not checked.** The scripted model writes no text before
  its tool calls, so the bar showed the chat's progress label ("Using
  menu_board_read.") as the agent's line; a real model's own words were
  not seen there. No run used a real TV or a second real person.
- **Found.** In a private Portal chat, each board edit asks for its own
  Allow ("Satyr asks again for each later step"). A request with several
  edits therefore stops at each edit. Slices 3–4 do not change this.
  The cause (2026-11-09): every member reads a board draft, and a private
  chat's label lets only its own readers see it, so each board edit is an
  exit that `passSharedDraftExit` holds (`handlers.ts`, the
  `menu-board:<id>` scope). One Allow stores one `held_output_request` row,
  and `consumeHeldEffectPass` (`data/held-output-request.ts`) uses it for
  one edit only. The held edit ends the turn ("Do not try this step again
  in this turn"), so the person asks again, the first edit uses the pass,
  and the second edit asks again. The pass match does not compare the flow
  label that the person allowed with the label of the edit that uses it.
  **Changed 2026-11-10 (the owner's decision): one Allow covers one
  request.** The turn that uses a board edit's pass stores its id in
  `held_output_request.consumed_turn_id`
  (`plan-40b-one-allow-per-request-d1-patch.sql`), and the later board
  edits of that turn use the same pass. Each use, the first one too, passes
  only when the edit's label joined to the label stored with the request
  keeps that label's digest, so an edit with more private content asks
  again. A later request needs a new Allow. Other held effects, such as a
  Slack draft, keep one pass for each call. The draft preview's check uses
  the same rule. Journey: `tests/e2e/pi-menu-board-one-allow.test.ts`. Not
  covered by a journey: an edit whose content grows inside the request.
  **Fixed 2026-11-10 after the production check:** Claude Sonnet 5.5 wrote
  both notes in one message, so the two edits ran at the same time. The
  first edit took the pass. The second edit had read the pass 13 ms
  before, lost the update, and asked again. The update now uses the
  same rule as the read in one statement (a pass that this turn took
  stays usable), and the journey sends its two edits in one message. It
  fails without the fix.
  **Passed in production 2026-11-10 (satyr-edge `a344c368`, the owner's
  Chrome, board "Image check").** After one Allow, one request added two
  notes. Both notes showed their draft letters, no second prompt opened,
  and both notes were in the draft after a reload. Nothing was published.
- **Open: the board stops with `invalid_message` while the agent edits.**
  Seen two times in the production checks: the editor showed "The shared
  board could not be synchronized. Reload the page." during the second
  edit of a request. A reload showed the correct draft, so no edit was
  lost. The cause is not known. The journey now checks that the Portal's
  parser takes every frame of the request and that the room sends no
  failure while the owner moves the pointer at the Portal's rate; it
  passes, so these two causes do not show on a local room. Not excluded: a
  room queue that is slower in production (more than 8 waiting messages of
  one socket end it), and a client state fault on `update_accepted` or
  `sync_response`. When the room refuses a message, it now writes the
  trace `collaboration.socket_refused` with the cause (`frame_size`,
  `queue_limit`, `frame_shape` or `attachment_write`), so the next
  occurrence after a release names the room's side or excludes it.
  The trace and the prompt text for one request are in production since
  2026-11-11 (satyr-edge `23b8e8b9`, dev `46b273788`). No agent edit ran
  on that version yet.
- **Production check in the owner's Chrome (2026-11-09).** Passed for the
  held edit, the ghost box, the agent's marks and the presence bar; the
  typing was not seen. "Image check" was archived, so it was restored for
  the check and archived again after it. In a private Portal chat (Claude
  Sonnet 5.5), a request to add one note was held with "Satyr agent wants
  to do one step" (Edit the shared menu draft), and the board showed no
  agent mark before the Allow. After the owner's Allow and a second
  request, the board showed the ghost box with "Generating …" and
  "640 × 96", the agent cursor and tag, the ruler ranges and the presence
  bar with "1 agent active", Follow, Stop and the agent's line. The note
  landed 0.3 s later with its outline, tag, red spacing numbers and
  "Satyr: 1 change"; the bar then showed the agent's own words. No partial
  text showed. The cause, found 2026-11-10 in the Workers Logs: both
  turns logged `menu_board.draft_preview_refused` ("Menu board disclosure
  is not authorized"), also the turn after the Allow. The preview took the
  board id from the first frame that had one, while the model was still
  writing it (`board_3f…`). Its check then looked for a pass on that cut
  id, found none, and the preview ignored the frames with the full id. So
  the ghost box and the tag came from the edit itself, not from the
  preview. Fixed 2026-11-10: `draftBoardId` waits until a later field has
  started. The one-Allow journey streams its note in parts and fails
  without the fix. Undo
  does not cover an agent's edit, so the owner removed the note with
  "Remove from board". Nothing was published, and "Morning menu" did not
  change. Evidence: `prod-01` to `prod-07` pictures and
  `prod-presence-log.json` in `docs/evidence/plan-40b-phase-7/`.

## Acceptance journeys

Each journey is an E2E test that produces a repeatable artifact (AGENTS.md).

1. **Live board (phase 1).** The owner publishes a board, and a paired screen
   shows it. Staff mark an item sold out; the screen shows it, and the QR
   checkout refuses the item. The screen loses its network and keeps the
   saved copy with the "not verified" mark. It catches up after reconnect.
2. **Order page (phase 2).** `shopname.menu.<domain>` serves the right shop.
   An unknown name answers 404. No name reaches another tenant's merchant.
3. **Pickup (phase 3).** A QR order shows its code in "Preparing". Staff mark
   it ready, and the code moves to "Ready". It leaves the board when the order
   is completed.
4. **Together (phases 4 and 5).** Two people and Urk edit one board at the
   same time, and all three converge. Urk's price proposal waits for the
   owner. The published board shows the merged result.
5. **Agent on the canvas (phase 7).** While a person drags an element, Urk
   adds a text element. A viewer sees Urk's ghost box, then Urk's text as the
   model writes it, then the element with Urk's tag. The viewer's own edit is
   refused. A held private-chat edit shows the viewer nothing. See
   [Phase 7 plan](#phase-7-plan-agents-on-the-canvas-2026-11-06).

Before a release, run one journey on a real TV or tablet against production.

## Open decisions

| Decision                         | Recommendation                                                            | Default if no answer             |
| -------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| The domain for `*.menu.<domain>` | Decided 2026-10-30: `seams.tokyo` for now, so `shopname.menu.seams.tokyo` | —                                |
| Where screens and live facts run | Satyr Platform, one Durable Object for each shop's screens                | Satyr Platform                   |
| Who serves the QR order page     | The standalone storefront Worker, the same app as `shop.seams.tokyo`      | The standalone storefront Worker |
| "Sold out today" and time slots  | Underclerk commands, so that checkout respects them                       | Underclerk                       |
| The board CRDT package           | A new package in the Plan 40C family                                      | A new package                    |
| Where the MCP server runs        | The Underclerk Worker, with merchant API keys                             | The Underclerk Worker            |
| Several agents from one request  | Decide after phase 7 slices 1–4; it needs its own plan (see phase 7)      | Not planned                      |

## What the earlier Plan 40B gave this plan

Kept: the element model rules, agent changesets at checkpoints with operation
IDs and receipts, publication as a separate authorized action with immutable
releases, and the cached tablet display rules.

Dropped: the website builder, code components with isolated builds, source
files in the shared document, storefront pages, and the Claude Code harness
adapter.
