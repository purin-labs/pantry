# Agent UI components

These components are reusable presentation and interaction building blocks for
agent conversations. Import them from the stable UI entrypoint:

```tsx
import {
  Attachment,
  InlineCitations,
  MessageScroller,
  QuestionCard,
  ReasoningSteps,
  ResponseActions,
  StreamingText,
  EmptyState,
  TaskList,
} from "../../ui";
```

The components accept plain typed props and do not depend on Chat route state.
Each component imports its own styles, so a direct
component import remains styled. The preview at
`/agent-components-preview.html` is the canonical visual reference for their
interactions and motion.

Use the exported prop and domain types from the same entrypoint when building a
new surface. Chat-specific adapters stay under `features/chat`.

### Select

`Select` is the [Base UI Select](https://base-ui.com/react/components/select)
with Portal styles in `select.css`. It is the only dropdown in Portal. Its
parts keep the Base UI names and props. `Select.Trigger` adds the caret, and
`Select.Popup` adds the Base UI Portal, Positioner, List and scroll arrows, so
that no page places them itself. Import `Select` from `./select` or the UI
entrypoint.

```tsx
const LOCATIONS = [
  { value: "tokyo", label: "Tokyo boutique" },
  { value: "paris", label: "Paris boutique" },
];

<label>
  Pickup location
  <Select.Root name="location" required items={LOCATIONS}>
    <Select.Trigger>
      <Select.Value placeholder="Choose a location" />
    </Select.Trigger>
    <Select.Popup>
      {LOCATIONS.map((location) => (
        <Select.Item key={location.value} value={location.value}>
          {location.label}
        </Select.Item>
      ))}
    </Select.Popup>
  </Select.Root>
</label>
```

- Pass `items` to `Select.Root`. Without it, `Select.Value` shows the raw
  value.
- `Select.Root` takes the value props: `value`, `defaultValue`,
  `onValueChange`, `name`, `required`, `disabled` and `multiple`.
  `onValueChange` receives the value, or `null` when nothing is chosen.
- `Select.Trigger` is a `<button role="combobox">`. It takes `id`, the ARIA
  props, `className` and `style`. A wrapping `<label>` names it.
  `variant="ghost"` is for a toolbar or a table cell: no box, a 14px caret.
  `variant="swatch"` is a round 28px button (40px on a touch screen) that
  shows only its children, a colour or a picture of the value, and no caret.
  Name the value in its `aria-label`. `size="sm"` is for a dense panel.
- `Select.Group` and `Select.GroupLabel` replace `<optgroup>`.
  `Select.Value placeholder` replaces a disabled empty option.
- `name` renders a hidden input, so `FormData` and `required` work as with a
  native select.
- Inside a modal `<dialog>`, the popup renders in the dialog, above the page.
- Browser journeys find a trigger by its role and name, or by
  `.pantry-select-trigger[data-name="…"]`, the open popup by
  `.pantry-select-popup[data-open]`, and an item by
  `.pantry-select-item[data-value="…"]`.

`select.css` owns the caret: its size, its inset and the gap before it. Those
declarations are important, so no page rule can move the caret to the edge.
Page CSS targets the trigger as `.pantry-select-trigger`; a page rule for
buttons excludes it with `button:not(:where(.pantry-select-trigger))`.
`pnpm lint:portal-select` refuses a raw `<select>`, an `<option>` outside a
`<datalist>`, a `<Select.Root>` without `items`, a direct
`@base-ui/react/select` import, and page CSS for a `select` element or
`.pantry-select-icon`. Use `Combobox` for searchable resource lists and
`ActionMenu` for commands rather than form values.

### Button

`Button` (`button.tsx`) is the Portal button on
[Base UI Button](https://base-ui.com/react/components/button). It renders
`<button type="button">`; pass `type="submit"` in a form. Use it for each new
button with a label.

- `variant="primary"` is the main action of a page or a dialog.
- `variant="secondary"` (the default) is each other action.
- `variant="danger"` is an action that removes or stops something.
- `variant="link"` is an action that reads as text, such as Cancel beside a
  main action.
- `size="lg"` is the main action at the foot of a page or a dialog. It is
  44px high and takes the text size of its place. The default `md` is 40px
  high with 14px text.

```tsx
<Button variant="link" onClick={close}>Cancel</Button>
<Button variant="primary" size="lg" type="submit" disabled={saving}>
  Save
</Button>
```

A disabled button shows a wait pointer, because a button is disabled while its
write runs. `button.css` owns the look. Each of its rules has more specificity
than a page rule for every raw button of a container, such as
`.home-recovery button`, so that rule does not change a `Button`. A page that
sets the size, the width or the font of a `Button` in its own container
targets `button.pantry-button` there:

```css
.order-queue-actions button.pantry-button {
  min-block-size: 48px;
}
```

The classes `primary-button`, `secondary` and `danger` in `styles.css` give a
raw `<button>` the same look. They stay for the pages that do not use `Button`
yet. Do not use them in new code. A toggle in a segmented control, an icon
button and a row that opens a record are not a `Button`.

### Grain fields

`GrainField` (`grain-field.tsx` + `grain-field.css`) is a moving, grainy
gradient that fills its positioned parent behind the parent's content. The
parent sets `position` and `isolation: isolate`. One WebGL context draws every
field on the page (`grain-field-renderer.ts`); reduced motion, a field off the
screen and a hidden tab hold the current frame. The 14 named fields of the
Seams site are data in `grain-field-data.ts` (`GRAIN_FIELD_NAMES`,
`grainFieldLabel`), ported from `packages/grain-field-ts` in seams-monorepo.

`GrainFieldSelect` (`grain-field-select.tsx` + `grain-field-select.css`) is
the Select for a field: a `variant="swatch"` trigger with a picture of the
chosen field, and a dark glass popup that lists every field with its picture,
a check on the chosen one and an optional tag. It sits on a coloured ground,
so its trigger is glass and its keyboard focus is darker glass, with no ring.
`grainFieldThumb(field)` gives the picture: the field's colour grid as a small
PNG data URL.

```tsx
<section className="hero">
  <GrainField field={field} pace={0.5} />
  <GrainFieldSelect
    value={field}
    onValueChange={setField}
    label="Hero gradient"
    tags={{ "teal-peach-wisp": "Seams home" }}
  />
</section>
```

The preview at `/gradients-preview.html` shows both on a hero panel.

### Popover and Switch

`Popover` (`popover.tsx` + `popover.css`) wraps Base UI `Popover` with automatic
`<dialog>` top-layer portalling and collision-aware positioning (`Popover.Root`,
`Popover.Trigger`, `Popover.Popup`, `Popover.Title`, `Popover.Description`,
`Popover.Close`). `Switch` (`switch.tsx` + `switch.css`) wraps Base UI `Switch`
(`Switch.Root` + `Switch.Thumb`) for accessible boolean toggles with form input
support. Import both from `../../ui`.

### Side drawer

`SideDrawer` (`side-drawer.tsx` + `side-drawer.css`) is the one Portal drawer.
It is a modal `<dialog>` that opens from the inline end and fills the screen on
a phone. Escape and a click on the backdrop call `close`, and focus goes back
to the control that opened it. The children render only while the drawer is
open; wrap plain content in `.side-drawer-body`. `footer` holds the main action
and stays at the bottom edge. Do not add Vaul or a second drawer. If a drawer
needs a swipe or drag gesture, add it to `SideDrawer`.

### Trace

`Trace` builds its rows on Base UI `Collapsible`. Each part has a Portal class
(`pantry-trace`, `pantry-trace-line`, `pantry-trace-title`, ...) that `trace.css`
styles.
It uses Portal colors, 14px text, 16px icons, and 8px row gaps.
The reference video presents these rows inside twelve demonstration cards.
The development preview at `/trace-preview.html` reproduces those patterns with
simulated data and a complete turn. It includes replay, pause, manual events,
light and dark themes, and slow or reduced motion.

Import `Trace`, `TraceLine`, `TraceIcon`, `TraceTitle`, `TraceDescription`,
`TraceCollapsible`, `TraceCollapsibleTrigger`, and `TraceCollapsibleContent`
from the UI entrypoint. A line requires one presentation status: `completed`,
`running`, `error`, or `pending`. Put the status in the title or accessible text
as well. Icons remain decorative. A plain line is text. An enclosing link or
trigger supplies its interaction and keyboard behavior.

`TraceCollapsible` accepts `defaultOpen` for local state, or `open` with a
required `onOpenChange` callback for controlled state. These modes are mutually
exclusive. `keepMounted` on the content preserves nested disclosure state.
For streamed content, use `open={readerChoice ?? running}` and store the reader's
choice in `onOpenChange`. New chunks must preserve that choice.

Panel height and chevrons use the existing 210ms quick motion token.
New rows and detail blocks use the same short transition: an opacity fade and
a 4px rise. Existing rows keep their position and opacity. The chevron fades
with its incoming row. CSS starting styles require no timer or delivery queue.
Transitions can reverse during an active animation. Running titles use the
shared chat shimmer: a 1.8-second sweep with a proportional highlight and a 70%
base layer. Trace and response indicators share `activity-shimmer.css`.
Set `spinning` on `TraceIcon` for a one-second loader rotation.
Reduced motion removes the shimmer, rotation, and panel motion. Touch pointers
receive 44px triggers. Desktop rows keep the compact reference spacing.
The `ReasoningSteps` adapter composes Trace for accepted Portal tool events.
Tool identity preserves inspected details when an event receives its receipt.
Chat's **Agent activity** expands the existing Case execution records. It groups
recorded assignments, turns, tools, proposals, approvals, effects, and deliveries
by their recorded relationships. Facts, receipts, arguments, and results load
on expansion through the existing authorized detail
reader. Open activity refreshes while a chat is active. A failed access check
removes displayed content and stops automatic reads. Reopening performs a fresh
read. Actor restart does not remove the saved inputs or outputs.

Source references, pending messages, and accepted progress updates also use
Trace. Streamed progress labels now reach the working indicator. Terminal logs
and error stacks appear as stored tool results. The runtime has no structured
plan, test-result, or public reasoning event contract, so those gallery examples
remain demonstrations. No private model reasoning is exposed.

The native journey is `services/platform/tests/e2e/chat-execution.test.ts`.
Run it with `PANTRY_ACCOUNT_WORKER_ARTIFACT` set to the built account Worker and
the platform's E2E Vitest configuration. It checks real accepted tool data,
pagination, Actor restart, and denied reads from another member. The browser
journey is `scripts/frontend-foundation/chat-trace-journey.js`, starting from
`/chat-preview.html?scenario=trace-execution&conversation=conv_00000000-0000-0000-0000-000000000001`.
Its simulated API events check out-of-order completion, preserved expansion,
failure output, sources, pending work, and access loss in the actual chat UI.

The commerce review uses `CommerceActionTrace` for proposed changes, approval,
execution, and provider receipts. Its controls retain the existing authority
checks. An unknown outcome offers reconciliation through the existing execution
endpoint. A pending reconciliation retains the unknown state. A recorded refund
attempt or accepted provider job does not establish payment settlement or email
delivery. Chat approval and receipt events use the same Trace composition.

The production overview uses `ProductionActivityTrace` with accepted `HostView`
records. It shows task blockers, prerequisites, allocations, and recovery states.
Task links open the existing inspector. Recovery links open the existing review
controls. Paused work stops its shimmer. These records describe simulation;
physical robot dispatch is outside this component.

`/operations-trace-preview.html` renders these production components with sample
commerce responses and the real local simulation worker. Run
`scripts/frontend-foundation/operations-trace-journey.js` and
`scripts/production-simulation/verify-recovery-journey-browser.js` through
`scripts/bakery-robots/browser-acceptance.mjs` for repeatable browser evidence.
The recovery journey includes an occupied destination and two worker restarts.
Both journeys write repeatable evidence under `output/playwright/trace-runtime/`.

The reference preview uses neutral colors sampled from the supplied video.
It includes the official site's Geist and Geist Mono fonts under the SIL Open
Font License in `src/dev/fonts/OFL.txt`. The fonts load locally in the preview.
Its 420px cards match the original proportions at a 2024px viewport. The card
captions, borders, nested guides, and code padding follow the final video frame.
The gallery uses 16px row gaps; Portal retains the standard 8px Trace gaps.
**Replay reference** follows the 500-frame presentation at 30fps. The frame slider
pauses at any frame. The presentation keeps the card surface steady during
100ms text exits and 200ms entrances. Each exit ends before the next entrance,
so words do not overlap. The zoom follows measured source frames 370–398.
Progressive terminal lines and the final staggered grid reveal complete the
presentation. **Show all examples** restores
the interactive gallery. All timing and generated events remain in development
code. They do not schedule or advance real agent work.

Run the repeatable browser journey after `pnpm portal` starts:

```bash
mkdir -p output/playwright/trace
playwright-cli --session trace open http://127.0.0.1:3103/trace-preview.html
playwright-cli --session trace run-code --filename scripts/frontend-foundation/trace-journey.js
```

The journey checks nested state, keyboard controls, streamed content, failure
details, source links, replay, reduced motion, mobile layout, and receipt updates.
It saves screenshots in `output/playwright/trace/`.

The selected chat component appears at `/trace-preview.html#chat-activity`.
It combines the Trace layout and entrances with the original chat shimmer.
Use **Add next step** to inspect arrivals, or **Scenario** to inspect completion,
failure, and approval states. The preview starts expanded through the optional
`defaultOpen` UI prop. Existing chat callers keep their collapsed default.

The live Chat route uses these components. `activity.tsx` projects tool events
into reasoning steps; `sources.tsx` maps response sources to citations and file
attachments. Structured questions submit through Chat's normal message flow.
`ResponseActions` accepts controlled `rating` and `ratingDisabled` props, while
its callbacks keep persistence and regeneration in the consuming application.
Chat stores ratings on assistant timeline entries and requests regeneration as
a follow-up message, preserving the accepted conversation history.

`StreamingText` takes `text` and an optional `streaming` flag. Chat uses the same
renderer for arriving and completed responses. It immediately shows received
text, with overlapping grapheme fades through blue, violet, and rose into the
normal text color. Appended text has a bounded reveal stagger; existing text
does not replay. Settled runs collapse back into plain text, and reduced motion
shows received text immediately. There is no artificial token-delivery queue.
It supports headings, paragraphs, bold, inline/fenced code, quotes, lists,
HTTPS links, tables, and Markdown task checklists. HTML is rendered as text.

`EmptyState` takes a title with optional description, icon, and actions. Chat's
welcome screen uses it; its styles are independent of Chat.

`TaskList` takes stable item IDs, labels, optional details, and explicit states:
pending, running (with known percentage or null), completed, blocked, failed,
or cancelled. It never advances itself. Markdown `[ ]` and `[x]` lists in Chat
map to pending and completed tasks; rich running/blocked states are available
to callers with structured task data. Task updates from backend planning tools
are not currently part of the Chat event protocol.

Working labels shimmer over 1.35 seconds. Completion draws a strike-through on
the smooth spring after a 40 ms delay; percentage and completed-count digits roll
individually on the same spring. The header ring tracks aggregate task progress
and transitions to a check when all tasks finish. Rows use 14px labels and icons at a 26px pitch.
Initial values and
already-completed tasks render immediately. Reduced motion disables these
effects. The preview's **Advance task** control demonstrates percentage updates
and completion without adding a simulated timer to the component.

Use the **Streaming text, empty state, and tasks** section in the component
preview to exercise partial Markdown, pause/resume, completion, task state
changes, and the empty state. The existing motion selector supports inspection
at 10% speed and a reduced-motion preview.

### Voice assistant

`VoiceAssistantCard` reproduces the Aria card from
[Transitions.dev](https://transitions.dev/). Its bottom light uses the same
MIT-licensed `voice-glow@0.2.1` engine. The preview at
`/voice-assistant-preview.html` plays the original simulated conversation,
including the moving colors, voice response, and processing sweep.

The card is controlled. The caller owns the microphone, transcript, and work.
It never requests microphone access. Pass a `VoiceAssistantState` with one of
three states: `idle`, `listening`, or `processing`. A listening state requires
one input: a `level` source (0–1 or a getter), or a `microphone` stream.
The dependency respects reduced motion and stops its driver outside the viewport.

```tsx
import { VoiceAssistantCard, type VoiceAssistantState } from "../../ui";

const voice: VoiceAssistantState = {
  kind: "listening",
  input: { kind: "microphone", stream },
};

<VoiceAssistantCard
  name="Aria"
  initials="AR"
  description="Voice assistant"
  message="How can I help you today?"
  transcript={transcript}
  state={voice}
  theme={theme}
  onToggle={toggleVoice}
/>;
```

The default size is 360 × 340 pixels. `className` and `style` allow a different
width. Long content increases the height. The `theme` prop controls the card
and glow together. The preview uses synthetic levels and needs no audio access.

Chat and BakeryOS also use the light in their text inputs through
`features/chat/work-glow.tsx`. This overlay follows the existing work and stream
states. It fades after completion, failure, pause, cancellation, approval, or
expiry. It follows the portal theme and preserves reduced motion.
The overlay leaves controls and menus outside the beam's clipping area.

### Permission requests

`PermissionRequestCard` is a consent card for a permission request, in the
style of an OAuth consent screen. It shows the requester and target avatars, a
title, the account chip and the subtitle, an optional scope `<select>`, the
requested permissions, the footnote and the decision buttons. The inline card
stacks these in one narrow column.

`PermissionRequestDialog` is the authorization screen, in a native modal
`<dialog>` (through `syncDialog` and `cancelDialog`). It has two layouts, set
with `layout`:

- `compact`: a narrow sheet with the app's icon, the question, the points in
  a filled box, the footnote and full-width actions. This is the default for
  three items or fewer without a scope choice.
- `split`: a wide card. The requester, the question, the account chip and the
  decision are on the left; the permissions are on the right, on a tinted
  band. Below 760px wide the card stacks. This is the default for a longer
  request.

Both layouts are modal cards over the dimmed page, with a close button in the
corner. Escape and the close button call `onClose`. A click outside the card
does nothing, because a consent decision is always an explicit button.

When the caller passes a `result` decision, the card shows the answer: a mark
(a check for `allowed`), the title, the message and the caller's actions. The
card resizes from its old size to the short result card, and the result fades
in. Focus moves to the primary action. With reduced motion, the card changes
size at once.

#### Minimize into a toast

Every `PermissionRequestDialog` can minimize into a toast at the bottom right,
so a prompt never blocks the page. The card has a Minimize button beside the
close button. Allow minimizes the card by itself: `onAllow` returns a
`Promise<boolean>`, the toast shows the loading state ("Saving your
decision…") until it settles, then the success (`true`) or the failure
(`false`, with the caller's `error`). A `result` decision shows its own title
in the toast. A click on the toast grows it back into the modal, at any time;
Deny and the other actions stay in the modal.

The card and the toast share one layout morph (`layout-morph.ts`, the FLIP
technique): a surface in the top layer moves and resizes from one box to the
other on the glide spring, while a copy of the old content fades out with a
4px blur and a copy of the new content fades in. Neither real element moves.
The page's dimmed backdrop fades with it. With reduced motion there is no
morph: the modal fades out and the toast fades in.

The toast is `prompt-toast.tsx`. It is drawn in the Portal's one Sonner
stack, which the shell mounts, so prompts and other notices stack together and
several prompts show as several toasts. Its tones are `waiting`, `loading`,
`success`, `denied` and `failure`. Sonner's region is a polite live region,
so each change is announced. Focus moves to the toast when the card
minimizes, into the modal when it grows back, and to the prompt's original
trigger when a settled toast closes. A waiting or loading toast cannot be
swiped away, because it is the way back to its prompt. A settled toast closes
after 5 seconds and closes its prompt with it. If the prompt's component
unmounts while its decision saves, the toast still shows how it ended. On a
page with no toast stack, Minimize leaves the modal open.

`AuthorizationScreen` does not minimize: its one action leaves the Portal for
a provider's sign-in.

The permission list never scrolls. On the split screen it keeps the height of
the left column; a longer list fades out under a "View all" button that opens
the rest. The compact sheet and the inline card fold their list at 260px in
the same way. A keyboard user who tabs to a faded row opens the list. A
required item shows as a granted line, not as a checkbox; the "Required" mark
shows only in a list that also has choices. `signedInAs` shows as a chip under
the question, with a menu mark when it has an action.

`AuthorizationScreen` is the same screen for a consent with no choices, such as
a provider sign-in. It is compact by default. The caller passes the list
(`aside`) and one action (`confirm`); the split layout adds a cancel button
(`cancelLabel`) that calls `onClose`. `ConnectConsentDialog` in
`features/integrations` uses it. A screen that opens over a shown connection
sheet stands in for that sheet: the sheet hides on its own backdrop, and the
card grows from the sheet's size while its content fades in. When the screen
closes, the sheet grows back from the card. With reduced motion the two
cross-fade.

The card is presentation only. The caller owns `selectedIds`, the scope value,
`pending`, and `error`, and does the work in the callbacks. Required items stay
checked and disabled, and `onAllow` always receives them. While `pending` is set,
both buttons are `aria-disabled` and the chosen button shows a spinner, so focus
stays on it.

`decision` has two modes:

- `grant` shows Deny and Allow (labels can change) for a person who can grant.
  `onAllow` resolves `true` when the decision is saved and `false` when it
  failed; the toast shows which.
- `explain` shows the list read-only, a caller message about who must allow
  the request, and up to two caller actions, such as "Stop run" and "Check
  again".
- `result` replaces the list with the answer after a decision, as above.

When the agent asks, name it with `AGENT_NAME` from `src/agent-name.ts`.

```tsx
<PermissionRequestDialog
  open={open}
  onClose={close}
  requester={{ name: AGENT_NAME, icon: <SatyrMark /> }}
  target={{ name: "Noix de Beurre", icon: <Croissant /> }}
  title={`${AGENT_NAME} would like to read a public link`}
  subtitle="Only allow this if you trust the request."
  scope={null}
  listHeading={`This will allow ${AGENT_NAME} to:`}
  items={items}
  selectedIds={selectedIds}
  onSelectionChange={setSelectedIds}
  decision={{ kind: "grant", pending, error, onAllow: grant, onDeny: deny }}
  footnote={null}
  signedInAs={{ name: "Camille Laurent", action: null }}
/>
```

The preview at `/permission-request-preview.html` shows grant, pending, error,
and explain modes, and opens the dialog in both layouts. A decision in the
dialog shows the result card, and each dialog minimizes into a toast. The
browser journey `scripts/permission-toasts/browser-permission-toasts.js`
proves the toast path in a Portal chat; see
`docs/evidence/permission-toasts/README.md`.

### Decision buttons

`DecisionButtons` shows the buttons of one decision that waits for a person:
allow, then refuse. Use it for every place that shows such a decision outside
the `PermissionRequestDialog`: a governed action, a custom connector write and
an email reply. Each place gives its own labels and classes, so each place
keeps its look. `refuse.confirm` asks one more time before a refusal:
`resetAfterMs` goes back with no answer, and `resetWhenDone` goes back when
the refusal ends. `between` puts a control between the two answers, for
example Edit. With `className` the buttons get a group element, and with
`groupLabel` that element has the group role. Without `className` the buttons
join the row of the page. `refuse` is null where a decision has no refusal.

### Drafted messages

`DraftMessageCard` shows a message that the agent drafted for another app,
such as a Slack message or an email. It has the provider mark and a status,
the fields (Workspace, To, Subject), the message with Show more for long text,
and Send, Discard and Edit. Nothing is sent until a person selects Send.
`decision` is null for a viewer who cannot send and for a settled draft.
`status` is `ready`, `waiting` (someone else must send it), `sent`,
`discarded`, `expired`, `unavailable` or `unconfirmed`; the last three carry
a message. Each callback returns an error message, or null when the step
succeeded, and the card shows a spinner on the button while it waits.
`edit.revision` is the version of the body on the card. The editor keeps the
revision that it started from. If a newer revision arrives before Save, for
example the agent's revision, the card saves nothing and says that the draft
changed, so a save cannot replace the newer body.

`features/chat/draft-cards.tsx` builds the Slack and email cards and places
each one in the timeline at the time of its draft. The chat preview shows both
at `/chat-preview.html?scenario=drafts&conversation=conv_00000000-0000-0000-0000-000000000001`.

### Motion

State changes use the spring shorthands from `styles.css`: `--motion-quick`
for icons, presses, and small disclosures, `--motion-smooth` for containers and
layout, `--motion-glide` for shape morphs, and `--motion-exit` for leaving
elements. They scale with `--agent-motion-factor`, so the preview's 10% speed
applies to every component. `spring.ts` holds the same springs as closed-form
step responses; `SpringValue` sums one response per retarget, so an interrupted
motion keeps its position and velocity.

Modal sheets (`ConnectionDialog`, the permission and sign-in screens) enter
over 300ms with an opacity fade, a 4px blur and a 12px rise, and leave over
150ms with a 12px lift (`--sheet-enter`, `--sheet-exit`). The rise and lift
stop at the edge of the window. Reduced motion keeps only a 150ms fade
(`--sheet-fade`); these sheets are the one exception to the Portal rule that
stops every transition under reduced motion. `closeDialog` in `dialog.tsx`
sets `data-closing` and closes the dialog when its opacity transition ends;
a dialog with no exit transition closes at once. `useDialogPresent` and
`useHeldWhileClosed` keep a closing dialog's content on screen until then.
A `ConnectionDialog` follows its content height through a ResizeObserver
on the `--motion-smooth` spring, so a change inside any child resizes it.
A sheet that opens inside another sheet takes its place and grows from its
size; the outer sheet grows back when the inner one closes.

`GlideHighlight` draws one highlight for a whole menu or list. Render it as the
first child of the container with a `target` selector, such as
`[data-highlighted]` for Radix menu items or `[aria-current="page"]` for
navigation. It follows keyboard and pointer changes and layout resizes; its
leading edge rides a stiffer spring than its trailing edge, so it stretches
toward the next item. Theme it with `--glide-highlight-background`,
`--glide-highlight-radius`, and `--glide-highlight-shadow` on the container.
Under reduced motion it jumps. A Radix menu
that holds one fades out as it closes. When the close came from choosing an
item, that item's highlight first dips off and back on over 140 ms, then the
menu fades; the item's action runs on the click, without waiting. Under reduced
motion the menu closes at once.

### Action menus

`ActionMenu` is the dropdown for a list of actions. Pass a `label`, one
`trigger` element (usually a button), and `sections`; each section has a stable
`id`, an optional heading, and items with an `id`, `label`, and `onSelect`. Items
also take an optional `description`, `icon`, `shortcut` (display text only; the
menu does not bind the key), `tone: "danger"`, and `disabled`. `side` and `align`
place the menu against its trigger.

```tsx
<ActionMenu
  label="Order actions"
  trigger={<button type="button">Order actions</button>}
  sections={[
    {
      id: "actions",
      label: "Actions",
      items: [
        {
          id: "export",
          label: "Export orders",
          description: "Download tomorrow’s production sheet",
          icon: <Download />,
          shortcut: "⌘E",
          onSelect: exportOrders,
        },
      ],
    },
  ]}
/>
```

It is built on Radix's dropdown menu, so arrow keys, typeahead, Escape, and
focus return work as usual. One `GlideHighlight` follows the active item.
Choosing an item runs `onSelect` on the click, blinks that item's highlight, and
fades the menu out. `CrmTable` uses it for row actions and footer calculations.
The **Action menu** section of the preview shows sections, icons, shortcuts, a
danger item, and a disabled item.

### CRM tables

Import `CrmTable`, `CrmColumn<Row>`, and the optional `CrmIdentity`, `CrmTag`,
`CrmProgress`, and `CrmSparkline` cells from this entrypoint. The table is generic:
it has no product, order, customer, or backend dependency. Each column supplies
a stable `id`, `label`, and `render(row, index)`; the index follows the displayed
sort order. Text and number columns also supply
`value(row)` for sorting and calculations; display columns do neither.

```tsx
const columns: readonly CrmColumn<Product>[] = [
  {
    id: "name",
    label: "Product",
    kind: "text",
    value: productName,
    render: productName,
  },
  {
    id: "price",
    label: "Price",
    kind: "number",
    value: productPrice,
    render: productPriceCell,
    format: formatPrice,
  },
];

<CrmTable
  label="Products"
  rows={products}
  columns={columns}
  rowId={productId}
  rowLabel={productName}
  initialPinned={["name"]}
  selection={{ selectedIds, onChange: setSelectedIds }}
/>;
```

Use stable, unique row and column IDs. Pass filtered/paged rows from the caller:
sorting, footer calculations, and select-all apply to the supplied rows only.
Controlled selection preserves IDs outside that view. Omit `selection` to hide
checkboxes; optional `actions` provide accessible row-menu callbacks.
Use `isRowActive(row)` to highlight the record open in a detail panel,
`onRowClick(row)` when clicking a row selects it, and `renderExpandedRow(row, index)`
to render an inline full-width (`colSpan`) detail panel directly beneath a row
without affecting column sorting or footer calculations. Columns can set `align: "end"`
for formatted quantity cells, `minWidth` (down to 40px) for compact spreadsheet
columns, `headerClassName`, and `cellProps(row, index)` for cell attributes such
as `data-cell-key` and multiplayer peer outlines. Pass `initialCalculations` to
seed default footer calculations (`"sum"`, `"average"`, `"count"`, `"unique"`).
Sorting cycles ascending → descending → source order, with nulls last.
Widths and pinning are local UI state; mount with a different React key for a
different dataset/schema. Resize by dragging or focusing a separator and using
Left/Right (16px), Home (minimum), or End (maximum).

Sort and pin icons cross-fade with scale and blur. Sorting and filtering animate
existing rows with a maximum 8px shift over 160 ms, with a 0.5px settle.
Reduced motion keeps updates immediate. Frozen columns gain a continuous
viewport-level shadow only while content is scrolled underneath them.
Compact custom scrollbars appear on hover, keyboard focus, and scrolling;
touch devices keep them visible. Drag either thumb or click its track to scroll.
The 4px thumbs overlay the interior edges, reserving no gutter space.
The focusable viewport retains native keyboard and touch scrolling.

The Product and Order fixtures at `/agent-components-preview.html#crm-preview`
demonstrate filters, selection, actions, calculations, custom cells, and empty
results. Products, inventory, orders, saved commerce collections, and the email
inbox use this table with their existing filters, pagination, record links,
detail panels, and governed status controls. Commerce quantities use display
columns to retain exact source formatting and units.

### Reads and writes

`useLatestRead` and `useMutation` are the one way to read and to change a
record in a Portal component. The request itself is a function in the request
module of the feature, for example `features/devices/requests.ts`: it calls
`controlRead` or `controlMutation`, parses the answer, and fails with an error.
A component file calls no function of the control client;
`pnpm lint:portal-requests` refuses a new call. The Devices page, the order
queue, Payments, Payouts and the order timeline use the hooks.

`useLatestRead(read, options)` reads when the page opens and on `reload()`.
Its `read` is `loading`, `failed` (no answer yet) or `ready` with the value,
the time of the answer, and `stale` when a later read failed. An answer that
arrives out of order is dropped, so the page never shows an older answer after
a newer one. The answer of `reload()` also replaces each read that started
before it. Call `reload()` after a write: a poll that started before the write
cannot then show the old record. `retry()` reads again and shows `loading`
until the answer, for a "Try again" button.

- `read` gets an `AbortSignal`. The signal ends when the page closes, when
  `read` changes, and when a later read made this answer useless. Pass it to
  `controlRead`, and the request stops then. A read that the Portal starts
  early (`early-reads.ts`) passes no signal, because a read with a signal is
  not shared.
- `everyMs` reads again on a timer, and `pauseWhenHidden` starts no timed read
  while the tab is hidden.
- `reloadOn` reads again when its value changes, and keeps the answer on
  screen meanwhile. A new `read` function starts again from `loading`.

```tsx
const readList = React.useCallback(
  (signal: AbortSignal) => readDevices(organisationId, signal),
  [organisationId],
);
const { read, reload, retry } = useLatestRead(readList, {
  everyMs: 15_000,
  pauseWhenHidden: true,
});
```

`usePeriodRead(period, read, words)` is `useLatestRead` for a page with a
period picker: it reads the window of the period in view and gives the
`TimeLanesStatus` of the read.

`useMutation(write, settled)` runs one write for each key at a time, for
example one order on the queue. The state of a key is `idle`, `running` or
`failed` with the error, and `busy` says that a write runs for any key. Each
attempt has its own idempotency key, which the hook gives to `write`. A second
`run` for a key while its write runs sends nothing and answers `busy`.
`settled` runs after each attempt, before the key is `idle` again, so the
button stays busy until the page has read again. A page with one write at a
time uses one constant key. A write is not stopped when the page closes.

```tsx
const advance = useMutation(
  (action: OrderQueueAction, idempotencyKey: string, fulfillmentId: string) =>
    advanceOrder(organisationId, fulfillmentId, action, idempotencyKey),
  reload,
);
const state = advance.state(entry.fulfillmentId);
<Button disabled={state.kind === "running"}
  onClick={() => void advance.run(entry.fulfillmentId, "ready")}>Ready</Button>;
```

The Organisation settings keep their writes in the `MutationLedger` of the
shell (`mutation-state.ts`), which also refuses two different writes of one
scope. It is the state of the `Portal` class, so those pages do not use
`useMutation` yet.

`controlMutation` and `controlUpload` forget every shared read when a write
starts and when it ends. A caller that reads after the write gets a new read,
not a read that started before the write or while it ran.
