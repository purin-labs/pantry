# Workflow canvas design profile

Status: applied to the Plan 84 recipe canvas on 3 November 2026.

This profile sets the look and behaviour of workflow canvas pages in Satyr Kitchen. It adds
to the [style guide](style-guide.md). If the two disagree, the style guide wins, except for
the one exception in [Port colours](#port-colours). The profile comes from five screenshots
of two other products, a dark canvas (reference A) and a light canvas (reference B), and from
the owner's direct requests for the recipe canvas.

| Light, after an approved proposal                                  | Dark, with Step details open                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| ![Light canvas](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile/canvas-light.png) | ![Dark canvas](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile/canvas-dark.png) |

![A run: done steps have a check, and running steps pulse](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile/run-light.png)

![Proposal review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile/proposal-review.png)

![Financier bake: wires that skip columns run in the gaps](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/workflow-canvas-profile/wires-routed.png)

The light and review images come from the Plan 84 proposal journey, with the Portal's own
styles. The run, dark and wire images come from the local factory fixture.

## The idea in one sentence

The work fills the page, the controls float above it in small quiet groups, and colour says
what kind of work each wire carries.

## Principles

1. **The canvas gets the room.** The canvas fills the workspace. The page header, the stages,
   the tools and the footer float above it. No bar sits between the person and the graph.
2. **Steps stay compact.** A recipe must read on one screen. A long chain wraps into rows.
3. **Every action stays in view.** Shop staff use this page. Use visible labelled buttons, and
   do not hide actions in menus or folds.
4. **Hue says what kind of work it is. Coral says what needs attention.** Ports and wires carry
   the hue of the step kind. Coral marks selection, the running step and agent changes only.
5. **A task changes the mode of the page, and does not open a new page.** The graph stays in
   place, and one side panel leads the task.
6. **The agent works on the same surface.** The composer sits beside the tools, and the
   agent's changes appear on the graph as marked steps.

## Decisions on the references

| Reference pattern                                    | Decision | Satyr form                                                     |
| ---------------------------------------------------- | -------- | -------------------------------------------------------------- |
| Floating groups at the corners (A, B)                | Keep     | Bottom left: zoom. Bottom right: review, run and apply.        |
| Bottom dock with tools and an agent composer (B)     | Keep     | Select, Pan, Add step, Add wait, Add decision, Undo, Redo.     |
| Example prompts in the composer that change (B)      | Keep     | Three examples that change every 6 seconds.                    |
| Tinted round ports and wires in the same hue (B)     | Keep     | One hue for each step kind. The owner asked for this.          |
| Mode with a tinted canvas and a side panel (B)       | Adapt    | Proposal review: other steps at 60%, coral ring on changes.    |
| Label row, large result and toolbar on each card (B) | Reject   | The owner asked for compact cards. The panel holds the fields. |
| Stepper in the side panel (B)                        | Reject   | One flat panel, with every action in view.                     |
| Queue pill at the bottom right (A)                   | Reject   | The footer already shows the clock and the run.                |
| Left tool rail (A)                                   | Reject   | The Portal has a left rail already.                            |
| Pure black canvas and white primary (A)              | Reject   | Use the slate dark theme.                                      |
| Blurred page behind a dialog (B)                     | Reject   | Use the standard scrim.                                        |
| Run button and model picker on each node (B)         | Reject   | A recipe runs as one draft.                                    |
| Promotion banners and credit counters (A, B)         | Reject   | Satyr has none on a work surface.                              |
| Comment pins, sharing, minimap, timeline node (A, B) | Later    | Show no control until the feature exists.                      |

## Page layout

The canvas fills the Workflow surface, as the 3D scene fills the Factory surface. On Split, the
canvas takes the start pane and the 3D scene takes the end pane, with a resize handle between
them. Every other part floats over its surface, 12px from the edges and 8px from the next part:

| Place        | Content                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| Top, start   | The page header: a back icon, the recipe name, Factory, Workflow and Split,      |
|              | Scenario and Results                                                             |
| Top, end     | The draft group: the draft status, then Workflow, Reviews, Run draft and Apply   |
| Under them   | The stage track, full width, on recipes with a fixed animation                   |
| Under it     | The run summary after a run, then the notices: proposals, problems, alerts       |
| Bottom       | The footer: the simulation clock, then Start production and Timeline with icons  |
| Over it      | One row: zoom at the start, tools and the agent composer in the middle           |
| Over the row | The comparison after a draft run, full width, with a close button                |
| Right edge   | One side panel between the stages and the footer: Step details or Agent proposal |

The header and the draft group share the first row when both fit. On a narrower canvas the
draft group moves under the header, at the end, and the stage track moves down below it.
The draft status shows the revision and the words of the connection; the number of people on
the draft shows as "2 people", and the full sentence is for assistive technology.

Split opens at 48% for the Workflow pane, and the handle moves between 30% and 68% by pointer or
keyboard and remembers the width. A double-click returns to 48%. Single-station runs in
`OvenWorkspace` also offer Split; multi-cell runs keep their floor-plan Split instead. When the
workspace or the screen is 840px wide or less, Split hides and returns to Factory. When the
Workflow pane is 900px wide or less, the
stage segments stay compact on one row, the draft comparison stacks into one column, and the
side panel opens below the stage track and above the tool row so that it never crowds the stages.

The stage track is the clock of the run: each segment follows the simulation, and a segment
moves the simulation. It is one bar with a segment for each stage and a divider between two
segments. The current segment has the accent fill and a progress line. A stage name takes two
lines at most. "Not started" is for assistive technology only.

The graph measures the header, the draft group, the stage track, the summary, the notices, the
tool row, the comparison and the footer, and sets the offsets as CSS variables on the workspace. A header
that wraps, an open timeline or a new notice moves the other parts, and nothing overlaps. The
tool row keeps the tools in the middle while both sides fit. On a narrow canvas the row wraps.

The scroll area has padding, so that the first and last rows can clear the floating parts. A
graph that is smaller than the free space sits in its middle. A graph that is larger scrolls,
and its steps fade out over the last 32px before the edge. A drag keeps the step under the
pointer when the graph grows and moves. If a side panel is open, the stage track, the tool row
and the comparison stop 12px before it, and the scroll area gets extra room on the right. If
the panel opens over the selected step, the canvas scrolls the step clear of the panel, with no
change to the zoom.

On a phone (640px and less), the steps become a list, and every part stays in the page flow:
the header, the stacked stages, the tools, the list and the footer.

## Surfaces

| Layer              | Surface                                                            | Radius                   | Depth                  |
| ------------------ | ------------------------------------------------------------------ | ------------------------ | ---------------------- |
| Canvas             | `--ground` with 55% `--surface`, dots every 20px, no edge          | None                     | None                   |
| Workspace bar      | `--paper`: header, footer, summary                                 | `--satyr-radius-card`    | Floating shadow        |
| Stage track        | `--paper`, segments `--satyr-radius-card` less 4px                 | `--satyr-radius-card`    | Floating shadow        |
| Wire               | `--port-wire`, 1.25px, curved                                      | Round ends               | None                   |
| Step               | `--paper`, 176 × 68px                                              | `--satyr-radius-card`    | `--shadow-card`        |
| Step on hover      | The same                                                           | The same                 | Floating shadow        |
| Kind tile          | `--port-fill`, 32px, icon 16px in `--port-ink`                     | 6px                      | None                   |
| Floating group     | `--paper`, 44px high                                               | `--satyr-radius-card`    | Floating shadow        |
| Control in a group | Clear; hover `--surface`; pressed accent, 36px                     | `--satyr-radius-control` | None                   |
| Select in a group  | Text and a 14px caret 8px from the edge, no box; hover `--surface` | `--satyr-radius-control` | None                   |
| Primary            | `--satyr-primary`, one in each view at most                        | `--satyr-radius-control` | `--satyr-primary-ring` |
| Notice             | `--paper`, or `--danger-bg` for a problem                          | `--satyr-radius-notice`  | `--shadow-card`        |
| Comparison         | `--paper`, numbers beside a lane for each task, 320px high at most | `--satyr-radius-card`    | Floating shadow        |
| Task bar           | `--port-fill` with a 1px `--port-wire` edge, 12px high             | 3px                      | None                   |
| Side panel         | `--paper`, 340px; header and actions stay in view, fields scroll   | `--satyr-radius-panel`   | Floating shadow        |

The Satyr Kitchen workspace has tighter corners than the rest of the Portal. It sets
`--satyr-radius-control` to 4px, `--satyr-radius-notice` to 6px, `--satyr-radius-card` to 8px
and `--satyr-radius-panel` to 10px, for the Factory and the Workflow surfaces. A button with no
style of its own takes 4px, not a pill. A group with 4px of padding has an 8px corner, so the
corners of a group and its controls stay concentric. Ports, dots and marks stay round.

`--shadow-card` already holds a 1px ring. In light mode, paper on ground is only 1.09:1, so that
ring gives the step its edge. Do not add a border as well. The floating shadow is
`--shadow-card` and one soft drop of 28px; it marks what floats over the board.

## The step

```text
            [icon] Work           latte-cobot
          ╭───────────────────────────╮
 (port)───│ [icon]  Steam stretch   ● │───(port)
          │         10 s · Running    │
          ╰───────────────────────────╯
```

- The size is 176 × 68px, on a grid of 248 × 108px. A chain wraps after five ranks.
- A label above the card names the kind on the start side, and on the end side who or what
  does the step: its workers, or the equipment that it holds. The label is 11px, 6px above the
  card, and the end side cuts with an ellipsis. The owner chose this form from a reference.
- The kind tile comes first. Its hue and icon are the ones of the step's ports.
- The name comes next, at 14px weight 500, on one line. The full name is in the tooltip.
- The line under the name holds the time of the step, then the state after a run reaches the
  step, at 12px. An "Added" badge can follow it.
- A mark in the top corner repeats the state: a coral dot that pulses for Running, a green
  check for Done, and an alert for Failed.
- Maximum weight: 500.

### States

| State          | Mark on the step                                           | Text                     |
| -------------- | ---------------------------------------------------------- | ------------------------ |
| Not started    | None                                                       | The kind only            |
| Current        | 1.5px inset ring in `--satyr-focus`, pulsing coral dot     | Running                  |
| Done           | State word in `--ok-text`, green check                     | Done                     |
| Failed         | `--danger-bg` fill, with a ring and an alert               | Failed                   |
| Skipped        | Opacity 60%, with a badge                                  | Skipped                  |
| Selected       | 2px outline in `--satyr-focus`, 1px offset                 | None                     |
| Added, Changed | Badge in `--satyr-accent-text` on `--satyr-accent-surface` | Added, Changed           |
| Has a problem  | 2px inset ring in `--danger-text`                          | The problem, in a notice |

Every state that a run sets has a word. Colour never carries a state alone. The step's
accessible name always holds the state, "Not started" too. The dot pulses with scale and
opacity; with reduced motion it pulses with opacity only.

### Tools

The Add tools show the icon of the step that they add, in its hue. Undo and Redo are icons with
a name and a tooltip. Run draft has a play icon. The composer starts with a coral sparkle,
because the agent's changes are coral. The draft status starts with a dot: green when every
edit is saved, amber while the draft connects. The back button is an arrow icon with the name
"Back to recipes".

The footer controls start with a 14px icon: play for Start and Resume, pause for Pause, a
circular arrow for Run again, a Gantt chart for Timeline and a clock arrow for History.

### Comparison timeline

The comparison shows the numbers on the start side and the task timeline beside them. Each task
that ran has one lane, named by its step. Its bar runs from its start to its end, in the hue of
its step. A step that the draft added has its name and its bar in the accent, so the change is
easy to find. A wait has an empty bar with an edge, and an unresolved fault has a danger bar.

### Ports and wires

- A port is an 18px tinted circle with a 10px icon and a faint ring of its wire hue, 6px off
  the card. It sits on the left and on the right of the card.
- `PORT_CENTRE` in `recipe-workflow-graph.tsx` must match the port position.
- A wire takes the hue of what leaves its step, and "Accept" and "Reject" have their own hues.
- A wire never crosses a card. A wire to the next column is a curve in the gap between the
  two columns. Every other wire runs only in the gaps: to the middle of the column gap beside
  its step, along the row gap above the labels of the row of the step that needs it, and back
  to the port. Its corners have a 14px radius.
- A wire label is 11px weight 500, with a 3px stroke of the page ground behind the text.
- A wire does not animate. The running step shows the activity.

### Port colours

| Kind              | Hue | Icon   |
| ----------------- | --- | ------ |
| Person            | 250 | Person |
| Timed process     | 65  | Timer  |
| Machine           | 195 | Cog    |
| Robot             | 295 | Robot  |
| Decision          | 335 | Branch |
| Accept            | 150 | Check  |
| Reject            | 25  | Cross  |
| Workflow overview | 250 | Layers |

**Exception to the style guide:** the style guide keeps coral as the only accent and does not
allow local palettes. The owner asked for these colours on 3 November 2026, so the canvas keeps
them. They are hue values in `recipe-workflow-graph.css`, not theme tokens, so they do not change
with the theme. The icon also names the kind, so colour never carries the meaning alone.

## Modes

Each mode keeps the graph in place.

| Mode            | Graph                                    | Side panel                 | Dock           |
| --------------- | ---------------------------------------- | -------------------------- | -------------- |
| Edit            | All steps active                         | Step details, on selection | All tools      |
| Run             | Steps show the state of their stage      | Step details, on selection | All tools      |
| Proposal review | Changed steps ringed, other steps at 60% | Agent proposal             | Edits disabled |

The Agent proposal panel holds, in this order: the reason, **What went wrong**, **What changed**,
the simulated result, then Approve, Decline and Close. Plan 84 sets who can read and approve.

The person approves the layout that the review shows. So an approval also moves each step that
the reviewed layout moved to make room, and an added step never covers another step. A step
that a person moved in the shared draft stays where the person put it.

## Input

- **Pointer:** drag a step to move it. Drag an empty part of the canvas to pan. With the Pan tool
  or with Space held, a drag on a step also pans. A middle-button drag always pans.
- **Zoom:** 40% to 150%. Use the buttons, or Ctrl or ⌘ with the wheel or a pinch. The point
  under the pointer stays in place. Fit shows the whole graph, and a second press returns to 100%.
- **Keyboard:** each step is a button. Enter opens the side panel. Escape closes it. Every wire
  edit also works from the panel fields, because a port is a small target.
- **Agent composer:** the words go to the chat as a draft. A person reads them there and sends
  them. No agent turn starts from the canvas. The composer shows only on a shared recipe with a
  chat.
- **Split:** the surface switch and the pane width stay with the person, like the floor-plan
  split in [Plan 81](plan-81-agent-portal-control.md). The agent composer and proposal review work
  in the Workflow pane as usual.
- **Phone:** below 640px the graph becomes a list of the same steps, with the controls above it.
  The Select and Pan tools and the zoom controls do not show.
- **Copy:** sentence case. Say "step", not "node", in the interface.

## Measured contrast

Measured with the `slate-coral` theme. The targets are 4.5:1 for text and 3:1 for graphics. Check
the other three themes before a change to these colours, because the port hues do not follow them.

| Pair                  | Light     | Dark       |
| --------------------- | --------- | ---------- |
| Port or tile icon     | 5.4–6.7:1 | 7.4–7.6:1  |
| Wire label on canvas  | 6.2–7.9:1 | 9.7–10.6:1 |
| Wire on canvas        | 3.1–3.4:1 | 4.1–4.4:1  |
| Step label on canvas  | 4.9–6.3:1 | 7.5–9.6:1  |
| Added badge           | 6.7:1     | 8.6:1      |
| Current ring on paper | 5.9:1     | 3.7:1      |
| Primary label         | 9.1:1     | 11.7:1     |

## Checks

These journeys pass on the canvas as it is now:

- `scripts/production-simulation/verify-workflow-graph-browser.js`
- `scripts/production-simulation/verify-workflow-edit-browser.js`
- `scripts/production-simulation/verify-workflow-branch-browser.js`
- `scripts/production-simulation/verify-workflow-engine-edit-browser.js`
- `scripts/production-simulation/verify-recipe-workflow-browser.js`
- `scripts/production-simulation/verify-recipe-split-browser.js`
- `scripts/plan-84/browser-draft.js`: two people on one shared draft
- `scripts/plan-84/browser-proposal.js`: proposal review, and the composer words in the chat box

A wire check samples every wire every 3px and reports a point inside a card other than its two
ends. It found three crossings in Ginger tea and Financier bake before the router, and none
after it, on six recipes. The check is a local script, not a repository journey.

## Carets

A dropdown or a panel toggle uses the lucide chevron at 14px, never a text triangle. A text
triangle sits on the text baseline, so it looks too high and too small beside the label.

## Limits

- A step that a person adds keeps its place, so a late join can make one long wire.
- A draft that already exists keeps its old stored positions. A shared draft made before the
  labels has rows 84px apart, so its labels touch the row above until a person moves a step.
- No journey checks pan, zoom, Space or the wheel. They were checked by hand in a browser.
- The canvas was not checked inside the signed-in Portal route, so its full height there is
  not checked. The preview page ends below the footer.
- `ProcedureCanvas` in `features/workflow-simulator/canvas.tsx` was a separate canvas. Plan 84
  decision D7 removed it on 2026-11-14.
