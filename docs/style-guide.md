# Satyr design system & style guide

Governs every user-facing web surface Satyr ships. That is the merchant portal
served from `apps/portal` (workspace list and workspace pages, sign-in, the
public policy pages, the identity-link page, and the provider authorization
popup) **and the buyer storefront served from `apps/storefront`**. Both consume
the same tokens from
[`packages/frontend-theme.css`](../packages/frontend-theme.css); the portal's
stylesheet is [`apps/portal/src/styles.css`](../apps/portal/src/styles.css) and
the storefront's is
[`apps/storefront/src/styles.css`](../apps/storefront/src/styles.css). Shared
shell and semantic page patterns live in `shell.tsx`, `page-components.tsx`, and
the owned modules under `pages/`. There is no CSS framework, and the only
external component library is Radix — used for behaviour (focus management,
dismissal, collision-aware placement), never for appearance.

The storefront uses the same theme with larger touch-sized controls.
Weights stay at or below 500, colour comes from shared semantic tokens, and
radii sit on the same ladder.

The source contract is explicit:

- `portal.tsx` owns the control-portal route controller and the CafeOS `SignIn`
  view. The Google action remains a native link to the Worker authentication
  boundary.
- `main.tsx` owns the identity-link and action-approval bootstraps, including
  their wallet-authenticated states.
- `console-sidebar.tsx` owns the generic controlled sidebar, responsive rail/drawer
  controller, toggle, navigation semantics, and keyboard-operable switcher.
  `use-console-sidebar-preference.ts` owns the persisted desktop rail preference.
- `shell.tsx` owns `PortalFrame`, `OrganisationLayout`, CafeOS sidebar configuration,
  workspace/product switchers, the command palette, and route focus. Workspace
  pages render in its outlet and do not recreate global or workspace navigation.
- `page-components.tsx` owns `PageHeader`, `EmptyState`, `RecoverableError`,
  `Notice`, `TechnicalDetails`, `StatusChip`, `ResourceList`,
  `ResourceRow`, `WorkQueue`, `WorkItem`, and `ActionBar`. Route modules
  compose these patterns and own only their
  domain data and presentation state.
- `page-content.ts` owns the closed `PageContent<T>` route-state union used by
  page loaders and recovery surfaces.

Provenance: visual language derived from elevenlabs.io (marketing pages, July 2026),
adapted for an operations console. Their product app validates the console patterns
(left rail, flat surfaces) used here.

## Product language

Satyr is a provider-backed commerce operations system. Product copy should
describe a clear path from connected commerce providers to products, orders,
governed actions, and operational outcomes. The web experience should make
integration health, provider projections, action state, and blockers legible.
File-native content, product folders, and file synchronization are deferred.

---

## 1. Principles

1. **Slate carries the interface.** In the default slate-coral theme, slate
   carries the canvas, cards, text, navigation, chat, and primary actions. Dark
   mode uses slate 650–800 surfaces with slate 50–300 text. The light sidebar
   uses slate 50 against the slate 100 workspace, with slate 100 hover and a
   coral 100 selection.
2. **Coral is an accent.** Coral marks selection, links, keyboard focus,
   activity animation, and small accent details. Keep large surfaces, primary
   actions, and status fills out of coral; coral never signals an error.
   Category fills do not imply domain state.
3. **Light display type.** Headings are a light-weight (300) grotesque, large, tightly
   tracked. Nothing anywhere exceeds font-weight 500 — hierarchy comes from size and
   color, not boldness.
4. **Shape follows context.** Console controls use pills. Inputs and the dedicated
   sign-in action use a compact 10px radius. Content containers are soft rectangles
   (10–20px). Status chips are flat pills that never look raised.
5. **Depth signals interactivity.** Buttons get whisper shadows and
   inset rings; recessed wells are flat slate; cards float on a barely-there
   shadow.
6. **Sentence case, no exceptions.** Headings, buttons, labels, nav. No title case, no
   all-caps headings (uppercase is reserved for tiny tracked eyebrows), no exclamation
   marks.
7. **The page states its goal.** Daily surfaces lead with work requiring attention.
   Setup progress appears while a workspace is incomplete. Dead-end raw codes are
   never shown to users.

---

## 2. Color tokens

[`packages/frontend-theme.css`](../packages/frontend-theme.css) is the entry
point. Import it once at the application stylesheet entry point. It imports
every theme from [`packages/frontend-themes/`](../packages/frontend-themes/) and
holds the color-independent tokens: rings, radii, spacing, motion, and type. All
palette values are sRGB-safe OKLCH. Components consume semantic `--satyr-*`
roles. Raw shade variables exist only while their theme is selected, so they
belong in theme files and never in component CSS. The portal's short names
(`--paper`, `--ink`, `--ok-bg`, etc.) refer to these same shared roles. Header
CSS owns only portal aliases, never another palette.

### Themes

A theme is one file that defines its shade ramps and every semantic role for
both appearances. `data-satyr-theme` on `<html>` selects the theme and
`data-portal-theme` selects the appearance. Without `data-satyr-theme`,
slate-coral applies.

| Theme         | File                                                             | Status                          |
| ------------- | ---------------------------------------------------------------- | ------------------------------- |
| `slate-coral` | [`slate-coral.css`](../packages/frontend-themes/slate-coral.css) | Default                         |
| `paper`       | [`paper.css`](../packages/frontend-themes/paper.css)             | Alternate                       |
| `sageberry`   | [`sageberry.css`](../packages/frontend-themes/sageberry.css)     | Alternate; the previous default |

To add a theme, copy an existing file and scope its two blocks to
`:root[data-satyr-theme="<name>"]` and
`:root[data-satyr-theme="<name>"][data-portal-theme="dark"]`. Define every
semantic role below in the light block; the dark block overrides what changes.
Import the file from `frontend-theme.css`, add it to `THEMES` in
`apps/portal/src/dev/theme-preview.tsx`, and measure the contrast pairs below in
both appearances.

### Slate-coral reference colors

| Reference                  | Palette anchor      | OKLCH                      |
| -------------------------- | ------------------- | -------------------------- |
| Blush `#F6E8E3`            | `--satyr-coral-100` | `oklch(0.941 0.017 40.8)`  |
| Peach `#F0B1A1`            | `--satyr-coral-300` | `oklch(0.815 0.078 34.7)`  |
| Coral `#C96357`            | `--satyr-coral-500` | `oklch(0.619 0.132 28.4)`  |
| Slate gray `#8B9BA7`       | `--satyr-slate-450` | `oklch(0.681 0.025 240.3)` |
| Light slate gray `#778899` | `--satyr-slate-500` | `oklch(0.619 0.032 248.4)` |
| Dark slate `#3C4552`       | `--satyr-slate-700` | `oklch(0.387 0.025 257.5)` |

Each family provides **50 through 800 in increments of 50** (16 shades).
Intermediate shades interpolate lightness, chroma, and hue in OKLCH between the
anchors. Shades outside this range are not part of the UI palette. Lightness
decreases through each ramp, with chroma tapering toward the ends: slate peaks
at 0.032 and coral at 0.132, both at 500. Slate 500 and coral 500 share
lightness 0.619, so equal steps in the two families pair at equal lightness.
Three-decimal OKLCH rounding can change a source RGB channel by one level.

- **50–100:** quiet light surfaces.
- **200–400:** quiet fills and category accents; pair with dark text.
- **500–600:** midtones and boundaries. Check contrast before using as text.
  Coral 500 is 3.65:1 on paper: use it for fills and outlines, and coral 600 or
  darker for text.
- **700–800:** light-mode foregrounds and dark-mode surfaces.

### Semantic roles

| Global token                                              | Role                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `--satyr-ground`                                          | Page canvas                                                    |
| `--satyr-paper`                                           | Cards, menus, input and secondary-button surfaces              |
| `--satyr-surface`                                         | Recessed groups, tracks, neutral chips                         |
| `--satyr-border`                                          | Decorative dividers; never the sole control boundary           |
| `--satyr-hairline`                                        | Visible input and control boundary                             |
| `--satyr-ink` / `--satyr-ink-strong`                      | Body text / emphasized supporting text                         |
| `--satyr-ink-muted` / `--satyr-ink-subtle`                | Supporting copy / captions and placeholders                    |
| `--satyr-primary` / `--satyr-on-primary`                  | Primary action / contrasting label                             |
| `--satyr-primary-hover` / `--satyr-primary-border`        | Action hover / visible action boundary                         |
| `--satyr-hover`                                           | Quiet navigation hover surface                                 |
| `--satyr-selected` / `--satyr-on-selected`                | Selected navigation and text selection                         |
| `--satyr-link`                                            | Inline links and form-control accents; underline links         |
| `--satyr-focus`                                           | Opaque keyboard focus outline, with a 2px offset               |
| `--satyr-disabled-surface` / `--satyr-disabled-text`      | Unavailable controls; preserve disabled semantics              |
| `--satyr-{success,info,warning,danger}-surface` / `-text` | Paired status surfaces and labels                              |
| `--satyr-category-{accent,neutral}-surface` / `-text`     | Paired category fills and labels, including workflow timelines |
| `--satyr-sidebar` / `--satyr-chat-surface`                | Workspace navigation / chat canvas                             |
| `--satyr-sidebar-hover` / `--satyr-sidebar-selected`      | Rail item hover / selected rail item                           |
| `--satyr-sidebar-selected-ring`                           | Inset outline on the selected rail item, or `none`             |
| `--satyr-shadow-color` / `--satyr-shadow-card`            | Tint for shadows and scrims / raised card elevation            |

Mix `--satyr-shadow-color` with `transparent` for shadows and modal scrims, for
example `color-mix(in oklch, var(--satyr-shadow-color) 24%, transparent)`.
Neutral black shadows are acceptable; warm or cool literal tints are not,
because they belong to one theme.

Success uses green, information a slate blue, warnings a restrained amber, and
danger a crimson. Danger (hue 18, chroma 0.15) is deliberately deeper than
coral so errors never read as accents; coral never signals state. Always
include a label or icon with status; category colors do not determine domain
state. On charts, label series directly and use markers or line patterns; these
fills alone do not establish sufficient contrast for thin lines or adjacent
regions.

Use `--satyr-accent` and `--satyr-accent-soft` for decorative animation, and
`--satyr-accent-text` on `--satyr-accent-surface` for small labeled accents.
`--satyr-focus` uses an accessible coral shade. Activity effects respect reduced
motion; animation never carries the only indication of state.

### Appearance and contrast

The default is light. Set `data-portal-theme="light"` or `"dark"` on `<html>` to
select the shared appearance. The portal's `usePortalTheme` owns system preference
and persistence; a standalone consumer may set the same attribute explicitly.
Primitives stay fixed while semantic roles change. Both appearances live in each
theme file. Do not override palette values in individual components.

In slate-coral light mode, the canvas is slate 100, cards and the sidebar slate
50, and recessed surfaces and chat slate 150. The sidebar hovers to slate 100
and selects with coral 100. Dark mode uses slate 800 for the canvas, 750 for
navigation and recessed surfaces, 700 for raised cards, and 650 for dividers
and selected fills. Dark chat uses `oklch(0.225 0.018 258)`, below the ramp.
While chat is open, the workspace floats on the chat surface, so the chat
surface stays the darkest layer in both appearances, then the canvas, then the
sidebar. Text uses slate 50–300. Dark sidebar selection adds
a full slate 400 inset outline. Labeled secondary buttons use the subtle
`--satyr-button-ring`. Inputs retain `--satyr-ring` for a clear boundary, and
keyboard focus retains its coral outline.

Workflow inputs use `--satyr-hairline` for their border: slate 500 in light mode
and slate 400 in dark mode. Workflow panels and playback controls share
`--shadow-card`. The bakery floor, wall, and grid switch to medium stone
materials in dark mode without changing equipment materials or simulation state.

Target at least **4.5:1** for normal text and **3:1** for control boundaries and
focus outlines on their surrounding surface. Decorative dividers are exempt.
Use `--satyr-ink` for long reading passages. Light-mode primary actions use
slate 700 with slate 50 labels and slate 750 hover. Dark-mode actions use slate
150 with slate 800 labels. Always pair action fills with `--satyr-on-primary`.
Use the supplied focus color with an offset so it borders the surrounding
surface. Changing a token requires checking all its rendered foreground/background
pairs in both appearances. Measured slate-coral pairs:

| Pair                                   | Light     | Dark      |
| -------------------------------------- | --------- | --------- |
| Body text on canvas                    | 12.7:1    | 13.8:1    |
| Subtle text on canvas                  | 5.1:1     | 8.3:1     |
| Subtle text on recessed surface        | 4.7:1     | 6.9:1     |
| Action label on primary action         | 9.1:1     | 11.7:1    |
| Control boundary on card               | 3.4:1     | 4.0:1     |
| Focus outline on canvas                | 5.4:1     | 5.6:1     |
| Link on card                           | 5.9:1     | 5.3:1     |
| Status labels on their status surfaces | 5.9–6.6:1 | 6.6–6.9:1 |

```css
/* In the application entry stylesheet, using the appropriate relative path. */
@import "../../../packages/frontend-theme.css";

.save-action {
  background: var(--satyr-primary);
  color: var(--satyr-on-primary);
  box-shadow: var(--satyr-primary-ring);
  border: 0;
  border-radius: var(--satyr-radius-pill);
  padding: var(--satyr-space-3) var(--satyr-space-6);
  transition: background-color var(--satyr-motion-fast) ease;
}

.save-action:hover:not(:disabled) {
  background: var(--satyr-primary-hover);
}

.save-action:focus-visible {
  outline: 2px solid var(--satyr-focus);
  outline-offset: 2px;
}

.save-action:disabled {
  background: var(--satyr-disabled-surface);
  color: var(--satyr-disabled-text);
  box-shadow: none;
}
```

Run `pnpm portal` and open `/theme-preview.html` for the live shade ramps,
semantic pairs, and existing portal controls. This development-only page imports
the actual shared themes, switches between them, and supports the persisted
light/dark switch. Its theme choice is not persisted.

---

## 3. Typography

| Token       | Stack                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------- |
| `--display` | `"Waldenburg", "Helvetica Neue", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif` |
| body (root) | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |

Waldenburg is the reference display face (licensed, not shipped); Helvetica Neue Light
is the working fallback. Body text carries `letter-spacing: 0.005em`.

### Scale

Global size tokens are `--satyr-text-caption` (12px), `--satyr-text-label`
(14px), `--satyr-text-body` (16px), `--satyr-text-heading` (24px), and
`--satyr-text-title` (36–44px). Font stacks remain `--satyr-font-sans` and
`--satyr-font-display`.

| Role                 | Face / weight | Size / line                              | Notes                                                    |
| -------------------- | ------------- | ---------------------------------------- | -------------------------------------------------------- |
| Page title (h1)      | display / 300 | `clamp(36px, 5vw, 44px)` / 1.08          | Tracking −2%, `text-wrap: balance`.                      |
| Section heading (h2) | display / 300 | 24–26px / 1.2                            | Tracking −1%.                                            |
| Body                 | Inter / 400   | 16px / 1.5                               | Supporting copy shifts to `--ink-2`, not a smaller size. |
| UI label / nav       | Inter / 500   | 13–14px                                  | Form labels, rail links, chips.                          |
| Eyebrow              | Inter / 500   | 12px, `letter-spacing: .08em`, uppercase | `--ink-3`. The only uppercase in the system.             |
| Caption / fine       | Inter / 400   | 12–13px                                  | `--ink-3`.                                               |
| Mono                 | ui-monospace  | 12–14px                                  | Counters, IDs, references.                               |

**Hierarchy rule:** jump from 16px body straight to 24px+ display. There is no
20–22px middle heading — mid-level emphasis is weight 500 or color, never size.
Weight 500 is the ceiling; never use 600+.

---

## 4. Shape & elevation

- **`--satyr-radius-pill` (`9999px`)** — buttons, chips, select-as-control.
- **`--satyr-radius-control` (`10px`)** — inputs, selects, rail links, small menus.
- **`--satyr-radius-notice` (`12px`)** — banners and notices.
- **`--satyr-radius-card` (`16px`)** — row-list cards.
- **`--satyr-radius-panel` (`20px`)** — large identity panels and recessed wells.
- Shadows: `--shadow-card` for anything raised; `--ring` for secondary buttons; a
  `--satyr-danger-ring` for destructive controls and `--satyr-primary-ring` for
  the primary action boundary.
  No other shadows. Nothing is ever both bordered and shadowed.

---

## 5. Components

Class names are the contract — reuse them rather than inventing parallel styles.

### Buttons

- **Primary** (`.connection-primary-action` on buttons, `.primary-button` on
  link CTAs): slate pill,
  light `--satyr-on-primary` text, weight 400, heights 38–48px, hover
  `--satyr-primary-hover`. One primary action per
  view region. The auth-only `.signin-button` is a 50px rectangle capped at 26rem,
  with a 10px radius so the identity choice reads as the page's single entry point.
- **Secondary** (`button.secondary` anywhere; also the default for
  `.connection-actions`, `.inline-form`, `.account-row`, and `.portal-nav`
  buttons): `--paper` pill, `--ring`, hover `--surface`.
  Row-scoped variants are 34px tall at 13px.
- **Ghost**: transparent, ink text, hover `--surface` (text links and quiet
  actions). Icon-only ghosts (dialog and panel closes) use `button.icon-button`:
  a 36px round target, `--ink-2` glyph, hover `--surface`.
- **Danger** (`button.danger` anywhere; `.danger-button` in the danger zone):
  `--paper` pill, `--danger-text` text, danger ring, hover `--danger-bg`.
- **Confirming state** (`.confirming`): any destructive button's second step —
  `--danger-bg` fill, `--danger-text` text, label changes to "Confirm …".
- Disabled: `opacity: .55`, `cursor: wait` (in-flight) or `.45` + `not-allowed`
  (unavailable). Compact row controls stay on one line. Summary actions may wrap
  at narrow widths so their full consequence remains readable.

### Chips (`StatusChip`, `.lifecycle`)

`StatusChip` renders the closed `neutral`, `info`, `success`, `warning`, and
`danger` semantic variants through `.status-chip-*`; the label always carries
the meaning. Organisation and integration lifecycle projections use `.lifecycle-*`:
`active`/`ready` use ok tints, while `activation_failed`/`degraded`/
`reauth_required` use danger tints. All chips are flat pills with no ring, no
hover, and `cursor: default` so they never look pressable.

### Inputs & selects

44px tall, `10px` radius, 1px `--hairline` border, `--paper` fill; focus uses
`--satyr-focus` for the border and a 2px outline with a 2px offset. Selects are
`appearance: none` with the shared SVG chevron (data URI in `styles.css`), inset 18px
from the right, `padding-right:
46px`. Row-scoped selects (`.account-row select`) are the 34px pill variant.
Placeholders use `--ink-3`.

### Cards & row lists (`.account-list`, `.organisation-list`)

`--paper`, `16px` radius, `--shadow-card`, internal `1px --border` dividers via
`> * + *`. Rows are 72px min, name (weight 500) over `--ink-2` 13px detail, actions
right-aligned in `.account-actions`. Empty states are quiet `--ink-2` sentences
inside the card (`.empty-state`).

### Page header (`PageHeader`)

Every route starts with an eyebrow, one h1, a one-sentence purpose, and compact
lifecycle or freshness context when it changes how the page should be trusted.
Route changes move focus to the h1. Do not repeat the page title inside a card.

### Workspace navigation (`ConsoleSidebar`)

The same typed route descriptor supplies every label and path. Above 1160px the
controlled sidebar is a persistent 264px rail that collapses to 60px. At 1160px and
below it becomes a full-width drawer that can be completely hidden. Closing that
drawer never changes the persisted desktop preference. Normal navigation closes the
drawer; modified link activation retains native browser behavior. The generic shell
accepts route groups and resolved links while `shell.tsx` supplies CafeOS labels,
icons, switchers, and footer content.

### Workspace search (`.portal-command-trigger`, `.workspace-command-dialog`)

The centered global-bar search opens the canonical workspace page palette. `⌘K` and
`Ctrl+K` invoke the same dialog. The search field is an accessible combobox over the
typed route descriptor; Arrow keys move the active option, Enter navigates, and Escape
closes the dialog and restores focus to the trigger. At narrow widths the trigger
retains its search icon and accessible name while the visible label and keycap hide.
The dialog uses the native modal boundary, contains no domain records or provider
payload search, and removes its entrance animation under reduced motion.

### Setup progress (`.summary-band`)

Sticky (top 12px) white pill: workspace name, incomplete steps, and one next action.
It is present only while setup remains incomplete and disappears for active or
archived workspaces.

### Left rail (`.console-sidebar`)

Above 1160px it has a hairline right border and fills the shell height. Its expanded
width is 264px; the topbar control collapses it to a 60px icon rail with the same
280ms coordinated width, padding, gap, label, and page-grid transition. The SATYR
brand, product switcher, and workspace switcher stay pinned while navigation scrolls.
The desktop preference persists locally and every related transition is removed under
reduced motion. Both switchers expose keyboard-operable menus with Arrow, Home, End,
and Escape behavior. Grouped routes keep accessible names and title tooltips when
their visible labels collapse. Incomplete workspaces may show their setup checklist.

### Shared state patterns

- `EmptyState` explains why a useful record is absent and offers at most one next action.
- `RecoverableError` states the problem and places recovery beside the failed surface.
- `Notice` announces neutral, successful, or warning status without replacing content.
- `TechnicalDetails` contains provider references, canonical IDs, revisions, receipts,
  and diagnostic metadata.
- `StatusChip` carries one typed lifecycle or work outcome; color never carries the
  meaning by itself.
- `ResourceList`/`ResourceRow` and `WorkQueue`/`WorkItem` provide labeled list
  semantics, facts, status, due state, and row-scoped actions.
- `ActionBar` groups typed primary, secondary, and danger actions.
- `PageContent<T>` is a closed route state: loading, ready with freshness, empty,
  failed with recovery, or unauthorized. Route responses are normalized once before
  they reach a page. Refreshes retain usable content with an updating notice when the
  route can truthfully keep showing the previous projection.

### Home

Home is the daily operating brief. Its order is fixed: **Needs attention**, **Today**,
then **Workspace blockers**. It renders the server-owned Home view and never merges
raw provider responses in the browser. Missing sources omit facts instead of
displaying invented zeroes.

### Sign-in

The sign-in route uses a full-height split canvas rather than a card. At wide widths,
the 36% access panel appears first in the DOM and contains the Satyr CafeOS identity,
one h1, the Google action, its access explanation, and a quiet footer note. The warm
story panel carries one supporting h2 and a concise product statement. A 1px hairline
separates the panels; neither panel uses a shadow.

At 760px and below the panels stack in reading order. The access panel remains first,
the Google action stays at least 50px high, and both panels use fluid padding. Content
must reflow without horizontal scrolling at 320px and at 200% browser zoom. The Google
action remains a native link because authentication leaves the React application.

### Banners & feedback

- Inline error (`.error-text`, `.portal-error`): `--danger-text`, danger-tinted 12px
  radius bar. For anything that needs user action.
- Success/ready (`.readiness-ready`, `.notice-text`): ok tints.
- Blockers (`.blocker-list`): warn tints with a `<ul>` of human sentences.
- Evaluating (`.readiness-evaluating`): `--surface`, `--ink-2`.
- **Toasts (sonner)**: transient confirmations only ("Invitation sent", "Setup
  saved"). Themed via the `[data-sonner-toaster]` variables — paper bg, 14px radius.
  Never toast an error that belongs next to the control that failed; never banner a
  transient success.

### Danger zone (`.danger-band`)

Owner-only, last section on the page. States consequences honestly (what stops
immediately, what remains restorable). Archive requires type-the-name confirmation
(`.archive-confirm`); lighter destructive actions (disable, remove, revoke) use the
two-step `.confirming` button with a 5-second auto-revert.

---

## 6. Layout

- Spacing uses `--satyr-space-{1,2,3,4,6,8,12}`: 4, 8, 12, 16, 24, 32,
  and 48px. Use these for new component gaps and padding; keep existing layout
  dimensions when their content requires them.
- `--satyr-motion-fast` is 150ms for color feedback and becomes 0ms under
  reduced motion. Animate explicit properties only.
- State changes move on springs. `--motion-quick` (210ms) covers icons, presses,
  tooltips, and small disclosures; `--motion-smooth` (340ms) covers containers,
  drawers, and layout; `--motion-glide` (390ms, 1.5% overshoot) is reserved for
  one shape morphing between states. Leaving elements use `--motion-exit`. Each
  is a `transition` shorthand of a `--satyr-spring-*` duration and `linear()`
  easing; springs never bounce further than glide. Continuous loops such as
  spinners and shimmers keep their own easing.
- A control that changes state stays one element: its content swaps with a
  short blur and scale, and swapping text leaves before the new text enters.

- Shell: full-height left rail with SATYR and the workspace picker → content top nav
  (60px, `--ground`, hairline bottom) with the sidebar toggle, current page, workspace
  search, and identity menu → `.portal-shell-workspace` grid
  (`264px minmax(0,1fr)`, or `60px minmax(0,1fr)` when collapsed, above 1160px) → `.portal-main` capped at
  `min(100%, 1040px)`, centered, `44px 28px 88px` padding.
- Section anatomy (`.portal-band`): hairline top border, `34px 0 40px` padding,
  display h2 (with `scroll-margin-top: 96px` for anchors), one-sentence `--ink-2`
  description ≤55ch, then controls, then the card/list.
- Breakpoints begin at **560px** (single-column content reflow) and
  **1160px** (persistent rail above it, compact drawer at and below it). Sign-in
  changes from split to stacked at **760px**.
  Component rules may change earlier when their content no longer fits.
- Whitespace is the luxury signal — never two dense columns of prose side by side.
- Focused controls have at least 44px targets or equivalent spacing. Sticky chrome
  reserves scroll margin, safe-area insets remain clear, and data rows reflow at
  narrow widths.
- `prefers-reduced-motion` removes nonessential animation and smooth scrolling.

---

## 7. Interaction patterns

- **Per-action busy.** `OrganisationMutation` is a closed discriminated union whose variants
  carry the identity needed by the affected control. Only the control that fired shows
  disabled. The immutable mutation ledger rejects only work in the same resource or
  action scope, while unrelated controls remain available. Server-side version fencing
  still resolves concurrent configuration changes authoritatively.
- **Auto-evaluate readiness** on detail load and after every mutation whenever the
  assessment is missing or unevaluated. Manual "Refresh status" stays as the
  secondary affordance. Users never meet `readiness_not_evaluated`.
- **Confirmation friction is proportional to damage.** Reversible mutations: none.
  Disable/remove/revoke: two-step confirm. Archive: type-to-confirm. Nothing uses
  `window.confirm`.
- **Conflict recovery.** `ControlApiError` carries the server code; on
  `configuration_version_conflict` the page silently re-fetches and shows the
  standard copy: _"This workspace was changed in another session. The page has been
  refreshed. Try again."_
- **Failure honesty.** Load failures render the `load_failed` card (message + Try
  again) — only a real 401 shows sign-in.
- **Titles.** Every view sets `document.title` (`Workspaces · Satyr`,
  `<page> · <workspace> · Satyr CafeOS`, `Sign in · Satyr`).

---

## 8. Voice & copy

- Sentence case everywhere, including buttons and nav. No exclamation marks.
- CTAs are verb-first and specific: "Connect Slack", "Save setup", "Activate
  workspace", "Try again" — never "OK", "Submit", "Yes".
- Errors say what went wrong and what to do next, in full sentences, no apology:
  "Enter the myshopify.com domain." / "Choose a replacement default account before disabling this
  connection."
- Blocker codes are always translated to imperative sentences (`formatBlocker`):
  `communication_connection_missing` → "Connect Slack." Add a mapping for every new code.
- Destructive copy states consequences and recovery honestly: "Archiving disables
  all provider connections immediately … stays restorable until the purge begins."
- Toast copy is past-tense confirmation: "Operating setup saved."

---

## 9. Quick rules

**Do**

- Use tokens for every color; pills for every pressable thing; weight 500 as the
  maximum anywhere.
- Back state with the chip system; translate every server code to a human sentence.
- Keep one primary action visible per screen; keep progress visible on onboarding
  surfaces.

**Don't**

- Add ad hoc component palettes, white labels on light fills, bold weights,
  title case, all-caps headings, or exclamation marks.
- Make chips look like buttons or buttons look like chips.
- Toast errors, banner transient successes, or surface raw `snake_case` codes.
- Add a second navigation system at any single breakpoint.

---

## 10. Extending the system

- **New connectors**: reuse the connect-button + account-row + lifecycle-chip
  pattern. When the catalog outgrows inline buttons, the intended evolution is a
  connector card grid, with the rail listing connectors with status dots and the
  main pane becoming per-connector detail — the chip/lifecycle vocabulary already
  supports it.
- **New resource pickers** (channels, accounts, catalogs): use server-side query +
  cursor pagination (the resources API pattern) behind a typeahead combobox; never
  slurp all pages into a `<select>`.
- **New sections**: follow the `.portal-band` anatomy and add a rail entry only when
  the section exists — no "coming soon" placeholders.
- When in doubt, the answer is usually: warmer, quieter, lighter, sentence case.
