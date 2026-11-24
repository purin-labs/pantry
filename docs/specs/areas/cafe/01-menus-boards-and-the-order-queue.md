# CAFE-01 — Menus, boards and the order queue

Café in Purin Pantry gives a shop one live menu on every screen in the shop and on the
QR order page. People and Sous Chef agents edit one shared menu draft and its menu
boards together, in Plan 40C rooms of the Organisation Actor. A person publishes a board
as an immutable release, and a paired TV or tablet plays the newest release at `/tv`. The
screen reads live facts from Purin Checkout on top of the release: prices, deals,
photos, sold-out marks and the pickup codes. A board never holds a price. A price or a
deal is a governed commerce action that an owner or an admin approves. Staff move QR
orders through the order queue and mark items "sold out today" on one Portal page.

## What it does

### The menu draft and its publication

- The menu draft is one shared document for each Organisation: a title, sections and
  items. Each item names a product, with a display name, a description and a placement.
  A new draft has one section, "Menu".
- The Menus page opens on the board canvas. **Menu items** and **Screens** open sheets in
  the `SideDrawer`. The Menu items sheet edits the draft, publishes it, sets the serving
  hours and the shop name, and shows the order page address.
- An owner or an admin publishes the draft revision that they saw. Pantry checks each
  item against the stock snapshot: the product needs a `listed` offer in the café sales
  channel and an `active` consumption plan at the café that tracks stock. An item that
  fails is named in the refusal (`menu_items_not_sellable`). A draft that changed since
  the read gets `menu_draft_changed` (409).
- The publication replaces menu `menu_cafe_main` of storefront `storefront_cafe` with its
  next revision. An entry that the published menu already sells keeps its modifier
  groups. A repeated click on the same draft and menu revision replays.
- Serving hours: a publication with no `hours` field keeps the menu's hours, `null`
  makes it all day, and a value sets a `schedule` (an IANA time zone and slots of days
  and times). Outside the slots, the guest read of the menu leaves the menu out, so the
  order page has no menu, and checkout refuses its lines (`checkout.menu`). A board whose
  facts hold no menu entry says "Not serving now", except a `pickup_board`.

### Boards

- A board is a shared Yjs document (`@purin-labs/menu-board-crdt`) in its own room. It
  holds the title, the layout, the style tokens and at most 48 elements. It never holds a
  price, a tax, stock, availability or order state.
- Layouts: `three_columns`, `two_columns`, `pickup_board` (landscape TV),
  `portrait_list`, `portrait_pickup` (portrait TV), `tablet_two_columns`, and the free
  canvas `canvas_landscape`, `canvas_portrait` and `canvas_tablet`. The board sizes are
  1600 × 900, 720 × 1280 and 1200 × 900 board units.
- Element kinds: `heading`, `section`, `featured` (the editor calls it "Product"),
  `order_qr`, `pickup_codes`, `text`, `image` and `stack`. A section lists the items of a
  menu section. A product binds one menu item, in the look `card`, `row`, `tile` or
  `price`. An image names a `mediaId` of the shop's library, with `cover` or `contain`.
- Each property is a separate key. A placement is one atomic value: a frame and an
  ordering key in a fixed layout, a rect with its constraints on the free canvas, or a
  stack, an order and a size inside a stack. The value is one string key of the element's
  Yjs map, so two moves of one element converge to one of the two moves.
- An element whose frame or stack is gone goes to the unplaced list. A board with an
  unplaced element cannot be published (`menu_board_unplaced`).
- Style tokens: `background`, `surface`, `ink` and `accent` (`#rrggbb`), `fontDisplay`
  and `fontBody` (`serif`, `sans`, `rounded`, `mono`), `typeBase` (12 to 32), `typeRatio`
  (1.125 to 1.5) and `itemRow`. The presets are Espresso, Paper, Matcha and Night market.
  A board with no token keeps the default look. The contrast warning below 4.5 : 1 does
  not stop a publication.
- Item rows: `line`, `leader`, `stacked`, `price_first` and `tiles`. The board sets the
  default with `itemRow`, and a section can set its own `row`.
- A new board starts from one of `template`, `blank`, `espresso_bar`, `bakery_counter`,
  `matcha_bar` and `night_market` (`MENU_BOARD_STARTS`). Each start other than
  `template` needs a `canvas_*` layout, else 422 `menu_board_invalid`. The template and
  the designs fill the board from the menu draft. Night market shows the order codes and
  the QR code. The Portal start screen makes only landscape boards.

### The board editor

- On the free canvas, a person selects, moves and resizes elements. Edges and centres snap
  to other elements and to the board, else to an 8-unit grid. Alt stops the snap, Shift
  keeps the ratio, and the arrow keys nudge by 1 (10 with Shift).
- The editor has multi-select, a marquee, align and distribute, a layers list, duplicate,
  remove, rulers, W × H badges and red distance numbers. "Show on" previews the board on
  the other screen shapes, and dashed guide bands show each shape's width.
- Undo belongs to each person. The Portal keeps the inverse of each own edit, at most 100
  steps (`HISTORY_LIMIT`). Typing in one field within 1 s is one step
  (`HISTORY_MERGE_MS`). Undo applies the inverse as a new edit. It writes back only the
  props and placements that the person's own edit changed, and it skips an element that
  another person removed. If another person changed the same prop later, undo replaces
  that value too.
- A drag writes the board one time, on release (`placeElements` at pointer up). During
  the drag, the person's presence carries the move at most every 66 ms
  (`MOVING_INTERVAL_MS`), for at most 12 elements (`MENU_BOARD_MOVING_LIMIT`) and 900
  bytes.
- Comments: a thread starts on one element. Every member reads comments, and staff and
  above write them. The Portal reads the threads again every 5 s (`COMMENT_POLL_MS`).
  Only the author deletes a comment. A delete of the first comment of a thread deletes
  the whole thread, with the replies of other people and of agents. An agent's comment
  has no author who can delete it; a person resolves its thread instead. A thread whose
  element is gone stays, marked "Not on the board now".
- Versions: a board keeps a version when it is made, when a person names one, at each
  release and before each restore. Before an edit, it also saves an `auto` version when
  the newest version of any kind is 10 minutes old or older
  (`MENU_BOARD_AUTO_VERSION_MS`). Thus a board that people edit with no pause gets an
  automatic version about every 10 minutes. A restore is one edit of the draft. It first
  saves the draft as `before_restore`, so a restore of that version undoes it.
- Prompt to edit: with elements selected, **Ask Sous Chef** sends the words to a new
  private Portal chat. The message carries the board and the selection in the page view.
  The panel shows the reply and offers to undo the agent's change as the person's own
  edit, and then **Bring the change back**.
- Agents on the canvas: each agent has its colour (`violet`, `teal` or `gold`), an
  outline, a cursor, a tag with an AI mark, and a dashed ghost box with "Generating …"
  for a new element. A move lands in one 240 ms motion. A presence bar shows the people,
  the agents and the changes of the current request. **Follow** is off by default. Only
  the person who asked sees **Stop** and the agent's last line.

### Publication and archive

- Staff (`operator`) and above publish the draft revision that they saw. The release
  freezes the title, the layout, the style, the elements and the menu copy that they
  name, with a SHA-256 digest of its canonical JSON. When the same person repeats the
  publish of the same document and release revision, the route answers the release again
  (200). A repeat by another member gets `menu_board_release_conflict`. A stale draft
  gets `menu_board_changed`, and a stale release revision `menu_board_release_conflict`
  (409). An empty board gets `menu_board_empty` (422). A product or section element that
  names a menu item or section that is gone gets `menu_board_binding_missing` (422, with
  the `elementIds`). If the media address is not available, the publish gets
  `menu_board_media_unavailable` (503).
- A release with an image names `mediaBase`, the screen route
  `/v1/screens/media/<organisationId>/`. The route serves an image only while the newest
  release of an active board names it, with `cache-control: public, max-age=300`. Any
  other image answers 404.
- An owner or an admin archives a board that no screen shows, and restores it. While a
  screen shows the board, an archive gets `menu_board_on_screen` with the screen count.
  An archive ends the open editors of the board with `access_revoked`. A restore gets
  `menu_board_limit` when 12 boards are already active. An archived board leaves the
  list, the editor and the screen picker, and its images stop being public. Nothing is
  deleted.
- A new board over the limit of 12 active boards gets 409 `menu_board_limit`.
- An owner or an admin deletes a library image only when no board shows it in its draft
  or its newest release, also an archived board (409 `media_on_board`). Commerce keeps an
  image that a product shows (`media_on_product`).

### Screens

1. A TV opens `/tv`. It asks for a six-letter code from 32 letters and digits
   (`MENU_SCREEN_CODE_ALPHABET`), which lasts 10 minutes. The `screen_pairing` row
   keeps the SHA-256 of the pairing secret and of the client address.
2. A member with the operator role enters the code in **Screens** and picks a board. The
   Actor keeps the new screen with the SHA-256 of its secret. The pairing row takes the
   token `scr1.<organisationId>.<screenId>.<secret>` one time, and keeps it until the
   TV collects it: the TV's first read of the token deletes the row. An unknown code
   gets 404 `menu_screen_code_unknown`, and a code that another member took gets 409
   `menu_screen_code_used`. A pairing over 40 screens gets 409 `menu_screen_limit`.
3. The TV asks every 3 s (`POLL_PAIRING_MS`) until it gets the token. After the code
   expires or the token was collected, the poll gets 404 `menu_screen_pairing_expired`,
   and the TV asks for a new code. A TV that loses the answer with its token therefore
   needs a new pairing. After it gets the token, the TV reads
   `/v1/screens/feed`, keeps one signal socket open, and reads again at each signal and
   every 60 s (`READ_EVERY_MS`).
4. The TV keeps the last feed in `localStorage`. When the shop cannot be reached, it shows
   that copy and says that the prices and the sold-out marks are not verified.
5. A removed screen's token stops at once. Its socket closes with 4403, and the TV goes
   back to a new code.

The Screens sheet lists each screen with its board, the last time that it was seen and an
open socket. It reads the list every 15 s. While a screen's socket is open, the list shows
the socket's last ping, and the screen's feed reads write nothing. The Actor stores the
time when the socket ends or a sweep closes it as silent. A sweep also stores it when the
stored time is more than an hour behind the socket (`SEEN_STORED_WITHIN_MS`). Staff show
another board on a screen or end the pairing. The Devices page (DEV-01) only reads this list.

### Live facts

The feed has the screen, the newest release and the facts. The facts come from a guest
read of the published café menu in Purin Checkout, as the order page reads it. For each
entry they give the price, the `compareAtPrice` only when it is above the price, the
availability (`available` or `unavailable`), and the first photo of the listing. They
also give `orderUrl` for the QR code. If Purin Checkout does not answer, the facts are
null and the TV keeps its saved facts as not verified.

The Actor sends the signal `menu_screen_changed` to the screens at once after each of
these: a board publication (only that board's screens), a new board on one screen, a menu
publication, a new shop name, an order queue move, a sold-out mark, an approved menu
publication (`publish_cafe_menu`) or menu price change (`change_menu_price`) and the
reconciliation of each, and a Commerce outbox pass with a new event. Other approved
commerce actions, such as a refund or a stock operation, send no signal. A lost signal
costs only the next timed read.

### The order queue and the pickup board

- Café › Order queue is one list for a tablet: "To prepare" and "Ready to collect". The
  page reads the queue every 5 s. Each order shows its pickup code (`F-062` form, from
  `commercePickupCode`), its wait, "QR order" or "Counter", and its lines with modifiers.
- The main action is **Ready**, then **Hand over**. **Start** is optional. Ready walks the
  preparation ticket through what is left, and makes the station `station_counter`
  ("Counter") when the shop has none. Hand over needs the stage `ready` and a payment
  (`order_queue_payment_missing`). Each step reads the queue again, and a stale revision
  costs a repeat, at most 10 steps (`STEP_LIMIT`).
- A move records a commerce mutation receipt under the request's idempotency key. A
  refusal names the step and the Commerce code (`order_queue_refused`, 409).
- A pickup board is a release with a `pickup_codes` element. The TV player reads
  `/v1/screens/pickup` only for such a release. The route gives any paired screen of the
  shop the codes in `preparing` and in `ready`, with no buyer. The TV
  keeps the codes in memory only, and a restart loses them.

### Sold out today

The order queue page lists the items of the published café menu with **Mark sold out**
and **Put back on sale**. A mark belongs to one variant at the menu's location, so it
holds on every menu of that location. The guest menu shows the item as unavailable,
checkout refuses it (`checkout.soldOut`), and the mark ends at the next midnight in the
time zone of the device. The stock count and the price do not change. A stale merchant
revision costs a repeat, at most 4 tries (`MARK_ATTEMPT_LIMIT`).

### Prices and deals

A board never changes a price. A new price or a deal is the governed action
`change_menu_price` (verb `commerce.menu.change_price`). Its path freezes the offer, the
offer revision and the price before and after, so the card shows both and the approval
signs that change. A deal keeps the earlier price as the offer's compare-at price, and
the new price must be lower. `deal: false` ends a deal. An owner or an admin approves the
card in the chat or the Portal, or from the Slack card with no Google step-up. Slack
refuses a click from a Slack account that is not linked to an owner or an admin. A menu
publication is not approvable from Slack (`SLACK_APPROVABLE_ACTION_KINDS`). Pantry then
calls `update_offer` with the price and the compare-at price, and every board, screen and
the order page read the new price live, with no new release.

### The QR order page

The shop Worker `purin-shop` (`apps/storefront`) serves the demo shop at `shop.purin.io`
and the page `/shops/<merchantId>`. It shows the shop's published menu in its own
sections, with each listing's title, description and first image. For a host
`<shop name>.<MENU_HOST_SUFFIX>`, it answers 404 for an unknown name, moves an earlier
name to the current one with 301, and passes on only that storefront's buyer routes. An
owner or an admin sets the shop name through `PUT …/commerce/shop-name`. The commerce
engine keeps the names (COM-02).

### Agents

The tools are in `areas/cafe/server/agent-tools/drafts/drafts.ts`,
`agent-tools/commerce/order-queue.ts` and `agent-tools/commerce/proposals.ts`. A turn
offers a tool when it holds the capability. The agent acts with the role of the person
who asked.

| Tool                                | Capability                      | Effect   | What it does                                                                                                                                                                    |
| ----------------------------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `menu_draft_read`                   | `commerce.menu_draft.read`      | Read     | The draft, its revision and its item positions                                                                                                                                  |
| `menu_draft_edit`                   | `commerce.menu_draft.edit`      | Draft    | One change: `rename_menu`, `add_section`, `add_item`, `rename_item`, `describe_item`, `move_item`, `remove_item`                                                                |
| `commerce_propose_menu_publication` | `commerce.action.propose`       | Proposal | Publishes a draft revision after an owner or admin approves `publish_cafe_menu`                                                                                                 |
| `menu_board_read`                   | `commerce.menu_draft.read`      | Read     | Boards, `canvasRects`, comments, the newest 20 versions, releases, screen counts, archived boards, images, and every menu item with its live price, `wasPrice` and availability |
| `menu_board_edit`                   | `commerce.menu_draft.edit`      | Draft    | 13 kinds, from `rename_board` and `set_text` to `add_image` and `set_fit`                                                                                                       |
| `menu_board_stack`                  | `commerce.menu_draft.edit`      | Draft    | `stack_elements` (2 to 12), `set_stack`, `move_in_stack`, `unstack`                                                                                                             |
| `menu_board_comment`                | `commerce.menu_draft.edit`      | Draft    | Add, reply, resolve and reopen a thread                                                                                                                                         |
| `menu_board_history`                | `commerce.menu_draft.edit`      | Draft    | Save a named version or restore one                                                                                                                                             |
| `menu_board_create`                 | `commerce.menu_draft.edit`      | Draft    | A new board from a layout and a start                                                                                                                                           |
| `menu_board_archive`                | `commerce.menu_draft.edit`      | Draft    | Archive or restore; the person who asked must be an owner or admin                                                                                                              |
| `menu_board_propose_price`          | `commerce.action.propose`       | Proposal | A `change_menu_price` proposal for one item                                                                                                                                     |
| `order_queue_read`, `sold_out_read` | `commerce.entity_plane.context` | Read     | The open pickups, or the menu items and their marks                                                                                                                             |
| `order_queue_advance`               | `commerce.order_queue.advance`  | Receipt  | `start`, `ready` or `hand_over`                                                                                                                                                 |
| `sold_out_mark`                     | `commerce.sold_out.mark`        | Receipt  | Marks or clears one item; the agent gives the IANA time zone                                                                                                                    |

- A `set_text` edit names the text that the agent read. A different text now gets
  `menu_board_text_changed` with the current text. A new element takes its ID from the
  operation, so a repeated call adds one element.
- The agent never publishes a board, and it does not delete a library image.
- While the model writes a `menu_board_edit` call, the Session streams a draft preview
  for `add_text`, `set_text` and `place_on_canvas`, at most one frame each 100 ms
  (`FRAME_INTERVAL_MS`). The preview first passes the edit's own checks. The room admits
  a preview at most every 2 s (`AGENT_PREVIEW_ADMISSION_MS`) and keeps it at most 6 s
  after its last frame (`AGENT_PREVIEW_LIFETIME_MS`). The real
  edit takes its place. The room shows an applied edit's tag for 5 s
  (`AGENT_ACTIVITY_HOLD_MS`).
- The "Pricing and promotions" skill (`data/merchant-agent-skills.ts`) names the tool.

## Contracts

- Packages: `@purin-labs/menu-draft-crdt` (`menu_draft_crdt.v2`),
  `@purin-labs/menu-board-crdt` (`menu_board_crdt.v1`, with `board.ts` and
  `protocol.ts`), and `@purin-labs/cafe-control-api` (`menu-boards.ts`: releases,
  summaries, the feed, facts, pairing shapes and the parsers). The order queue, sold-out,
  pickup, comment and version shapes are in `@purin-labs/control-api`.
- `OrganisationDO` (`workers/platform/src/actors/organisation.ts`) holds the rooms
  through `cafe-collaboration-rooms.ts`. Its SQLite tables:

| Table                              | Owner file                      | Holds                                                                             |
| ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `menu_draft`, `menu_draft_review`  | `actors/menu-draft.ts`          | The one draft (`cafe-menu`, at most 768 KiB) and each staff review snapshot       |
| `menu_board`, `menu_board_release` | `actors/menu-boards.ts`         | Each board (at most 256 KiB, with `archived_at`) and each release with its digest |
| `menu_board_comment`               | `actors/menu-board-comments.ts` | Comments; the Actor writes the author kind (`person` or `agent`), name and time   |
| `menu_board_version`               | `actors/menu-board-versions.ts` | Frozen copies: `created`, `named`, `published`, `before_restore`, `auto`          |
| `menu_screen`                      | `actors/menu-screens.ts`        | Paired screens, the token hash, `last_seen_at` and `removed_at`                   |

- Global D1 (`workers/platform/migrations-global/0001_current_schema.sql`):
  `screen_pairing`, written only by `data/screen-pairing.ts`. The regional D1 has no
  table of this subsystem.
- The Actor's commands are in `actors/menu-board-commands.ts`. The templates, the agent
  actions and the archive columns are in `templates.ts` of `@purin-labs/menu-board-crdt`,
  `menu-board-agent-action.ts` and `menu-board-archive.ts`.
- Shared code for routes and tools is in `areas/cafe/server/contract/`:
  `menu-publication.ts` (`planCafeMenu`), `order-queue-commands.ts`, `media.ts` and
  `request-errors.ts`. The price action is `commerce/menu-price-action.ts`, and the menu
  action is `commerce/cafe-menu-action.ts`.

Control routes under `/v1/control/organisations/:id/`:

| Route                                                                             | Role                           | Purpose                                                   |
| --------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `GET`, `POST` `menu-boards`                                                       | Viewer, operator               | List boards; make a board (`title`, `layout`, `start`)    |
| `GET menu-boards/facts`                                                           | Viewer                         | The live facts, as a screen reads them                    |
| `GET menu-boards/:boardId/socket`                                                 | Viewer (read), operator (edit) | The board's room                                          |
| `POST menu-boards/:boardId/releases`                                              | Operator                       | Publish `documentRevision` over `expectedReleaseRevision` |
| `POST menu-boards/:boardId/archive`                                               | Admin                          | `archived: true` or `false`                               |
| `GET`, `POST` `menu-boards/:boardId/comments`; `PATCH`, `DELETE` `…/comments/:id` | Viewer, operator               | Threads; add; resolve; delete an own comment              |
| `GET`, `POST` `menu-boards/:boardId/versions`; `POST …/versions/:id/restore`      | Viewer, operator               | List, name and restore versions                           |
| `GET`, `POST` `menu-screens`; `PUT`, `DELETE` `menu-screens/:screenId`            | Viewer, operator               | List; pair by code; show another board; end the pairing   |
| `GET collaboration/menu-draft`, `…/socket`; `POST …/review`                       | Viewer, operator               | The draft snapshot, its room, a review snapshot           |
| `GET`, `POST` `commerce/menu-publication`                                         | Viewer, admin                  | Products, address and hours; publish the draft            |
| `PUT commerce/shop-name`                                                          | Admin                          | The shop name of the order page                           |
| `GET commerce/order-queue`; `POST …/order-queue/:fulfillmentId/advance`           | Operator                       | The open pickups; one move                                |
| `GET commerce/sold-out`; `POST …/sold-out/:variantId`                             | Operator                       | The menu items and marks; mark or clear                   |
| `GET commerce/order-times`                                                        | Operator                       | Order times of a window of at most 32 days                |

Screen routes (`control/routes/menu-screens.ts`), with no Portal session:

| Route                                            | Credential                                                    | Purpose                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /v1/screens/pairings`                      | None                                                          | A new code: 429 `menu_screen_pairing_limit` or `menu_screen_pairing_busy` |
| `GET /v1/screens/pairings/:pairingId`            | The pairing secret                                            | `waiting`, or `paired` with the token                                     |
| `GET /v1/screens/feed`                           | The token                                                     | The screen, the newest release and the facts                              |
| `GET /v1/screens/pickup`                         | The token                                                     | The pickup codes                                                          |
| `GET /v1/screens/socket`                         | The token, as the second subprotocol after `pantry-screen.v1` | The signal socket                                                         |
| `GET /v1/screens/media/:organisationId/:mediaId` | None                                                          | A published board's image                                                 |

The capabilities are in `foundation/authority/authorization/capability-catalogue.ts`:
`commerce.menu_draft.read`, `commerce.menu_draft.edit`, `commerce.order_queue.advance`,
`commerce.sold_out.mark`, `commerce.action.propose` and `commerce.entity_plane.context`.

## Rules and limits

| Action                                                        | Viewer | Operator | Admin and owner   | Agent                                                                                           |
| ------------------------------------------------------------- | ------ | -------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| Read boards, facts, screens, comments, versions               | Yes    | Yes      | Yes               | `menu_board_read`                                                                               |
| Edit the draft or a board, comment, save or restore a version | No     | Yes      | Yes               | Draft tools, as an operator or higher                                                           |
| Publish a board, pair or change a screen                      | No     | Yes      | Yes               | No                                                                                              |
| Publish the menu                                              | No     | No       | Yes               | `commerce_propose_menu_publication`, which an owner or admin approves; the menu keeps its hours |
| Set the serving hours or the shop name                        | No     | No       | Yes               | No                                                                                              |
| Archive or restore a board                                    | No     | No       | Yes               | `menu_board_archive`, if the person is an admin or owner                                        |
| Add or delete a library image                                 | No     | No       | Yes               | No; `add_image` places a library image                                                          |
| Move an order, mark sold out                                  | No     | Yes      | Yes               | Receipt tools, as an operator or higher                                                         |
| Change a price or set a deal                                  | No     | No       | Approves the card | `menu_board_propose_price`                                                                      |

| Limit                                                                                                               | Value                     | Constant                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| Active boards for each Organisation                                                                                 | 12                        | `BOARD_LIMIT`                                                |
| Elements on a board; text prop                                                                                      | 48; 280 characters        | `MENU_BOARD_ELEMENT_LIMIT`, `MENU_BOARD_TEXT_LIMIT`          |
| Menu sections, items, text                                                                                          | 20, 200, 1,000 characters | `MENU_SECTION_LIMIT`, `MENU_ITEM_LIMIT`, `MENU_TEXT_LIMIT`   |
| Paired screens; sockets for each screen                                                                             | 40; 3                     | `SCREEN_LIMIT`, `SOCKETS_PER_SCREEN`                         |
| Pairing code life                                                                                                   | 10 minutes                | `PAIRING_MS`                                                 |
| Open codes for one address (IPv6 /64 is one); for all shops                                                         | 50; 5,000                 | `ADDRESS_PAIRING_LIMIT`, `OPEN_PAIRING_LIMIT`                |
| Comments on a board; comment text                                                                                   | 300; 1,000 characters     | `MENU_BOARD_COMMENT_LIMIT`, `MENU_BOARD_COMMENT_TEXT_LIMIT`  |
| Versions of a board; version name                                                                                   | 40; 80 characters         | `MENU_BOARD_VERSION_LIMIT`, `MENU_BOARD_VERSION_LABEL_LIMIT` |
| Open sockets in a room (a 21st person or tab gets `room_full`); active agent operations and draft previews together | 20; 20                    | `COLLABORATION_SOCKET_LIMIT`                                 |
| Agent action presence                                                                                               | 900 bytes                 | `COLLABORATION_AGENT_ACTION_BYTES`                           |
| Silent screen socket                                                                                                | Closed after 90 s         | `SOCKET_SILENCE_LIMIT_MS`                                    |
| Agent proposal                                                                                                      | Lapses after 15 minutes   | `ACTION_PROPOSAL_EXPIRY_MS`                                  |

When a board keeps 40 versions, the oldest automatic versions go first, then the oldest
others. The newest named version always stays. A board and its releases have no other
retention: an archive deletes nothing, and no route deletes a board.

- **Information flow.** Every member reads a draft, so an agent edit is an exit into a
  shared draft. `passSharedDraftExit` checks the turn's flow binding with the scope
  `menu-draft:cafe-menu`, `menu-board:<boardId>` or `menu-board:new`. If an edit carries
  content that a member may not read, the check stops the step and stores a permission
  request (`ExitApprovalRequestedError`). The agent tells the person, and the person
  allows it and asks again. For board edits, the turn that uses the Allow keeps it for
  its later edits (`held_output_request.consumed_turn_id`), while each edit keeps the
  allowed label's digest. The draft preview uses the same check and asks nobody.
  `menu_board_archive` has no exit check (Refactor 17, Appendix C).
- **Screens show only releases.** A draft edit, a restore, a drag, a draft preview and a
  comment never reach a screen. Pickup codes name no buyer, so any paired screen of the
  shop reads them.
- **No code on a screen.** A board has no code component. The image route answers with
  `default-src 'none'; sandbox` and `nosniff`.
- **Plan 90** owns the Register. It sells from the same published café menu, and its
  counter orders appear in the order queue as "Counter". CAFE-01 does not describe the
  Register, the terminals or the counter receipt.
- **COM-02** owns the commerce engine: the menu, its `validity`, the pickup queue, the
  preparation tickets, the sold-out marks (`checkout.soldOut`), the shop names and the MCP
  server for operators' own sites (`services/commerce/docs/mcp.md`).
- **FND-10** owns the shared draft rooms. **FND-09** owns the page view that prompt to
  edit sends. **FND-07** owns the flow check. **DEV-01** reads the screen list.
- **Out of scope:** merchant websites, a vector pen, code components, several agents from
  one request, a replay of the board history and an agent check of a render.

## Open work

- The order page domain is not chosen. Production sets no `SHOP_ORDER_PAGE_ORIGIN`,
  `apps/storefront/wrangler.jsonc` sets no `MENU_HOST_SUFFIX`, and `purin-shop` has no
  route for an order page host. The Menus page then shows no shop name form.
- With no order page origin, `hostedShopUrl` names `<COMMERCE_BASE_URL>/shops/<merchant>`
  (`areas/cafe/server/control/routes/commerce-menu-publication.ts`). The commerce
  Worker serves no page: it redirects a `GET` outside `/v1/` to `SHOP_SITE_ORIGIN`
  (`services/commerce/src/worker.ts`). So a QR code opens
  `shop.purin.io/shops/<merchant>` after one redirect (checked in production on
  2026-11-23). A QR code that names the order page itself needs the order page origin.
- A board shows no stock count ("3 left"). The sold-out mark uses the device's time
  zone, because the commerce engine has no shop time zone.
- The Portal edits one menu. A second menu, for example a morning menu, needs the commerce
  engine API.
- Not built: shop domains through Cloudflare for SaaS, printed table cards, offline
  editing, several products in one drag, a drop into a fixed frame under the pointer, a
  collapsible left panel, the MCP address on the API keys page, and an undo of an
  agent's board edit (a person removes the element).
- The board stopped two times in production with `invalid_message` during an agent
  edit; the cause is not known. The room writes `collaboration.socket_refused` with the
  cause, and no later case is recorded.
- Not run: a real TV, a second real person, and a real model route to a viewer's browser.

## Sources

- [Plan 40B](../../../history/plan-40B-collaborative-menu-editor.md). Where it differs from the
  code, this spec follows the code. Its evidence in the archive:
  [Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-1.md),
  [Phase 2](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-2.md),
  [Phase 3](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-3.md),
  [Phase 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-4.md),
  [Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-5.md),
  [Phase 6](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-6.md),
  [Phase 7 browser journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-40b-phase-7/board-agent-browser.json).
- Background: [Plan 90](../../../plan-90-cafe-pos-checkout.md), which stays a plan. The
  commerce contract: [the commerce spec](../../../../services/commerce/docs/spec.md).
- E2E journeys in `workers/platform/tests/e2e/`: `menu-board-screen.test.ts`,
  `cafe-menu-publication.test.ts`, `pi-cafe-menu-publication.test.ts`,
  `order-queue.test.ts`, `chat-agent-order-queue.test.ts`,
  `chat-agent-order-queue-recovery.test.ts`, the `pi-menu-board-*.test.ts` journeys
  (together, price, style, rows, comments, history, stacks, create, products, image,
  archive, one-allow) and `chat-menu-board-permission-live.test.ts` (a real model).
- In `services/commerce/tests/`: `sold-out-and-slots-journey.test.ts`,
  `expired-lot-journey.test.ts` and `mcp-server-journey.test.ts`.
- Browser journeys in `scripts/plan-40b/` (`run-browser.py`): the `browser-*.js` files
  for the screen, the start screen, products, images, archive, the chat, the price card
  and the agent, and `order-page-journey.js` (`run-order-page-journey.py`).
