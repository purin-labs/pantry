# Plan 42K — Brain interface

Status: U1 to U7 are built, checked locally and in production since the
release of 18 October 2026. The acceptance journey passes in part (see below).
Date: 12 October 2026. Last change: 27 October 2026.
Owners: CafeOS Portal, with Platform context and Case runtime.

This plan had the numbers 42H and 42I until 13 October 2026.
[Plan 42H — Chat Thread Forking](plan-42H-thread-forking.md) keeps the number
42H and is implemented.

## Outcome

An operator opens one page and sees these four things:

1. What waits for a decision.
2. What the agents know, and where each fact came from.
3. How a fact was learned and tested before use.
4. What happened in one Case, step by step.

[Plan 42J — Brain](plan-42J-brain.md) built the records and a first page for
them. That page works. It is a stack of cards, tables and a simple graph, and
it had no design pass. This plan gives those records one interface. It adds no
record kind and no authority. Each new read is named in "Reads".

## Reference

The operator supplied a launch video of the Hone "Engines" product and eight
screenshots of it. They are in
[docs/reference/hone-engines](reference/hone-engines/README.md).

Take the structure of those screens. Do not copy the names, the brand, the
text or the assets. Each element of this plan shows a Satyr record that
exists. An element with no record behind it is not built.

| Reference screen           | Its pattern                                                             | In this plan                       | The Satyr records behind it                         |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------- |
| 02, Brain first tab        | A flow from sources through learning stages to outputs. A log below it. | Learning view                      | Corrections, Memory revisions, Eval runs, decisions |
| 04, Knowledge              | Categories with counts. Rows with title, scope, time and a "New" mark.  | Knowledge view                     | Memory, Evals. Playbooks and agents from Plan 16.   |
| 05, Overview               | One sentence that says the present state.                               | Overview status line               | Counts of the items that wait, and the newest event |
| 06, Workflow of one run    | Columns by stage, parallel steps, state marks, a legend, a path back.   | Activity graph                     | The Case execution projection of Plan 42J B2        |
| 01 and the chat at 1:32    | The operator states a rule in one sentence.                             | Teach                              | The Memory proposal command                         |
| 01 and 03, setup interview | A step list, one question at a time, connected systems as rows.         | Not built. See "Not in this plan". | Onboarding and Plan 16 own agent setup              |
| 07, Slack delivery         | The result arrives where the team works.                                | Not built. A link only.            | Plan 56 owns the Slack review card                  |
| 08, replay with a change   | Past cases run again with a change.                                     | Evals view names its comparison so | Eval runs of Plan 42J B1b                           |
| The measure card at 2:32   | One business measure and its change.                                    | Not built. See "Not in this plan". | No record exists                                    |

## The current page

The page is `apps/portal/src/features/brain/`. The Portal shows it in the
group "Agents", on two pages. Knowledge has the tabs Overview, Knowledge,
Skills, Learning, Tests and Context. Activity is the second tab of the Agents
page. An old `/brain`, `/activity` or `/tests` address opens the page of its
view. The captures are in
[docs/evidence/plan-42J-brain/browser](https://github.com/seams-tech/pantry-history/tree/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42J-brain/browser/).

Known gaps:

- The Memory tab is a stack of cards. A person cannot scan 30 memories.
- The Activity graph has one row of boxes. A Case with many records runs off
  the right side of the page.
- The Evals table holds one scenario well. It has no scenario editor.
- The navigation gives no sign that an item waits.
- The Context view that Plan 42J names has no tab.
- No view shows the learning loop as a whole.

## Views

The Brain page keeps its place in the navigation. Its tabs are: Overview,
Learning, Knowledge, Evals, Activity and Context. All six exist since 13
October 2026. On a narrow page the tabs go to a second line, so none is
hidden.

### Overview

- One status line at the top. It says "Nothing waits for you", or it gives the
  number of items that wait.
- The items that wait, most recent first: memories to review and evals to
  review. Each item opens in the Knowledge view or the Evals view.
- The newest learning event in one sentence, with its time.
- Four counts as links: waiting for review, in use, not in use, evals to
  review.

### Learning

- A flow from left to right with one box for each stage of the loop:
  corrections recorded, memories proposed, eval runs, decisions, and memories
  in use.
- Each box holds its count. A count opens the list that it counts.
- Below the flow, a log in time order. A row holds the time, the kind of the
  event, the source and one sentence.
- The flow and the log come from recorded states. The page does not ingest
  connected systems. Discovery stays with
  [Plan 46](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-46-case-context-discovery.md).

### Knowledge

The operator compared the first build with reference image 04 on 13 October
2026 and said that it did not look like it. The view follows that image now.

- A rail on the left with four kinds, each with an icon and its count: Memory,
  Evals, Playbooks and Agents. The rail goes to a kind and marks the kind
  that is in view.
- Each kind is a section with a heading and its count, one below the other.
- A record is a wide row: its title with its marks, one muted line with its
  scope in words (for example "One supplier") and the time of its last
  change, and an arrow. A row that the person has not opened since its change
  carries a "New" mark. The browser keeps what was opened.
- A Memory row opens the record in place of the lists, with a path back and a
  close control. The record holds what the card held: applicability,
  validity, evidence, history, and the controls to accept, edit, decline,
  replace and revoke. A third column beside the list is not used: it made the
  rows narrow.
- An Eval row opens the Evals view at that Eval.
- Playbooks and Agents are read-only rows. Each links to its owner in
  [Plan 16](plan-16-merchant-console-commerce-operations.md). The Brain page
  changes neither.
- A filter by state, and a search in the words of the rows that the person
  may read.

### Teach

The operator chose on 13 October 2026 to teach through the chat. A person
tells the agent a rule, and the agent proposes the memory with that chat
message as its evidence. A form on this page is not built: the Memory command
needs a message in a Case as evidence, and the page cannot record one.

- One entry in the Knowledge view: "Teach a fact". It says how to teach and
  it opens the chat. Only a person who may decide a memory sees it.
- In a Portal chat, the agent has the tool `propose_memory`. It gives the
  statement and its kind: a fact or a preference. The platform cites the
  message that started the turn. The agent can cite nothing else.
- The candidate has the scope "Chats in the Portal". It is not in use before
  its review. The review rules of Plan 42J do not change.
- After a person accepts it, a later Portal chat turn is shown it. A turn
  gets it only when each reader of that chat may read the message that it
  came from. So a rule from a private chat applies to that person's private
  chats, and a rule from a shared chat applies to the chats of those readers.
- Email replies do not use it. A mailbox turn cannot receive the label of a
  chat message. A correction of a reply stays the way to teach the mailbox
  agent.

### Evals

- The scenarios of an eval as a list, with the expected result of each.
- One comparison table for a run: a row for each scenario, a column for each
  configuration and route. The page names it "the same request, with and
  without the proposed memory".
- A cell shows passed, failed, could not run, or unknown. The last two never
  look like a pass or a fail. A cell opens what the agent did.
- A scenario editor: add, change and remove a scenario. It uses the existing
  revise command. The sender is chosen from the verified contacts.
- The view lists the Evals as rows, as the Knowledge view does. A row opens
  the record in place of the list, with a path back and a close control.
- A model that ran no scenario states its reason one time, above the table.
  Its cells hold the "Could not run" mark only.
- The technical details of a run link to its Case in the Activity view. That
  Case is shape only: Plan 42J shows the results of a run under the review of
  the Eval, and withholds the records of the run's Case from each reader.

### Activity

- The records of one Case on a canvas, in columns by stage: request,
  assignment, turn and tools, proposal, approval and effect, delivery.
- One lane for each assignment. Work that ran side by side reads as parallel,
  and a proposal that follows from two assignments shows both links.
- A node shows its kind, its title and its state. A tool operation shows its
  tool.
- Pan, zoom and "fit to view". A legend. A path back: Brain, Activity, the
  Case.
- A stack of more than six records in one lane and column shows its first
  five and one control for the rest.
- A withheld node keeps its place and shows its kind only.
- The layout uses the recorded links only. It adds no edge, and it does not
  order nodes by time where no link exists.
- A detail pane for the selected node, as today. The canvas has the whole
  width until a node is selected.
- The list form stays, and it replaces the canvas at phone width.

### Context

- The tab that Plan 42J names. It links to the existing Plan 46 inspection:
  protected collections, related Cases and discovery status.
- It adds no read.
- Two pages own that inspection. "Related Cases" is on the data flow view of
  the Access and data flow page. The connection of context discovery, with
  its status, is on the Integrations page.

## Reads

The page uses the reads of Plan 42J. These reads are new:

| Read                           | Why                                                | Rule                                                                                                  |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Brain summary                  | The navigation count and the Overview status line  | One authorized read. It counts only the records that this person may review.                          |
| Verified contacts of a mailbox | The sender choice of the scenario editor           | Through the reply review authorization of that mailbox.                                               |
| Playbooks and agents           | The two read-only categories of the Knowledge view | The existing agent reads of Plan 16. If no such read exists for a reader, the category shows no rows. |
| Accepted Memory of a chat turn | A Portal chat turn follows what a person taught    | The turn's own authority admits the label, and each reader of the conversation may receive it.        |

The learning log needs no new read. The page derives it from the Memory
histories and the Eval run lists that it already reads.

Each new read follows the
[IFC integration guide](../foundation/authority/policy/information-flow/README.md).
A count, a title, a preview and an empty state are source-derived content. A
person who may not read sees the same state as a person with no records.

## Work

Do the slices in this order. Each slice ends with the page in a state that can
ship. A box is ticked when the item is built and a journey proves it. The
[evidence notes](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42K-brain-ui/README.md) give the proof and the
limits of each item.

### U1 — Shell and navigation

Status, 13 October 2026: built and checked locally. Not deployed.

- [x] Give the Brain page its tabs as links, and a layout with a rail, lists
      and a record. Four tabs exist: Overview, Knowledge, Evals and Activity.
- [x] Add the Brain summary read. Show its count on the Brain entry of the
      Portal navigation.
- [x] Keep each tab and each selected record in the address, so that a link
      opens the same view.

### U2 — Knowledge

Status, 13 October 2026: built and checked locally, in the form of reference
image 04. Not deployed.

- [x] Build the category rail, the row list and the record for Memory.
- [x] Move the decision controls and the history of the Memory cards into the
      record. Remove the cards.
- [x] Add the Evals category with the same row form.
- [x] Add the Playbooks and Agents categories as read-only rows.
- [x] Add the filter by state, the search and the "New" mark.

### U3 — Activity graph

Status, 13 October 2026: built and checked locally, in the form of reference
image 06. Not deployed.

- [x] Compute the columns and lanes from the projection. Keep the layout code
      free of the network and of the document, so that a journey can check it
      with a recorded projection. The code is
      `apps/portal/src/features/brain/execution-layout.ts`.
- [x] Draw the canvas with pan, zoom and "fit to view". The canvas of the
      BakeryOS workflow view does not separate cleanly: it is one component
      with the procedure editor and its shared editing. The Brain has its own
      small canvas. No graph library is added.
- [x] Draw the withheld nodes, the legend and the path back.
- [x] Load a Case with 200 records in pages and keep the view usable while the
      pages arrive.

### U4 — Overview and Learning

Status, 13 October 2026: built and checked locally, in the form of reference
images 05 and 02. Not deployed.

- [x] Build the status line and the list of items that wait.
- [x] Build the learning flow with its counts and links.
- [x] Build the learning log from the Memory histories and the Eval runs.

### U5 — Teach

Status, 13 October 2026: built and checked locally, as teaching through the
chat. Not deployed. The operator chose this form on that day. The first form
of this item, a form on the page with a scope and dates, is not built: see
"Teach" above.

- [x] Add the entry "Teach a fact" to the Knowledge view. It explains the
      steps and opens the chat.
- [x] Give the agent the tool `propose_memory` in a Portal chat turn, on the
      Pi and the Codex route. The candidate cites the person's message.
- [x] Show the new candidate in the list as "Needs review" at once, with the
      scope "Chats in the Portal".
- [x] Offer an accepted memory of that scope to later Portal chat turns,
      under the rule of the conversation's readers.

This item changed records of Plan 42J, which this plan first excluded:

- A Memory has a fourth scope kind, `portal_chat`.
- A Portal chat turn reads Memory. Before, only a mailbox turn did.
- The session start takes an admitted Memory of a chat turn into the turn's
  flow binding. Before, it refused such a turn.

The account-platform refactor landed on `dev` while this item was in work.
The teaching journey runs on the fixture of the account authority and
passes. The browser journey and the older journeys of Plan 42J do not run on
`dev` since that refactor: their fixtures have no account binding. The
[evidence notes](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42K-brain-ui/README.md) give the details.

Open decision: a taught fact does not reach email replies. That needs a rule
that releases a person's words to a mailbox at acceptance. It is a new
authority, and it is not built.

### U6 — Evals

Status, 13 October 2026: built and checked locally. Not deployed.

- [x] Rebuild the comparison as one table for several scenarios and routes.
      The journey runs one scenario on two models, one with no credential.
      It checks four scenarios on two models with the sample records.
- [x] Add the verified contacts read and the scenario editor. The read is
      `GET …/evals/:evalId/contacts`. The `mail-inbox` journey holds its
      allowed and its denied case.

### U7 — Context, states and quality

Status, 13 October 2026: built and checked locally. Not deployed.

- [x] Add the Context tab with its links.
- [x] Design the loading, empty, error, withheld and "could not run" states of
      each view.
- [x] Make each list, each graph node and each detail pane usable from the
      keyboard. Give each control a name for a screen reader.
- [x] Check the page at phone width, and in the light and the dark theme of
      the Portal. Use the Portal's design tokens. Add no new palette.
- [x] Extend the browser journey of Plan 42J and save new captures beside the
      reference.

## Acceptance journey

Run it in a browser against a local Worker, as the Brain journey of Plan 42J
does. Save the results and the captures in
`docs/evidence/plan-42K-brain-ui/`.

1. Use the seed of Plan 42J B1a and B1b. Sign in as the owner. The navigation
   shows one item that waits, and the Overview names it.
2. Find the candidate in the Knowledge list. Read its detail and accept it.
   The counts of the navigation, the Overview and the learning flow change.
   The log holds the decision.
3. Teach one fact in the operator's words. It is a candidate, and no turn uses
   it. Accept it. A fresh turn that it applies to records its revision.
4. Add a second scenario in the editor. Run the eval on two routes, one of
   them with no credential. Read the comparison and open what the agent did.
   The route with no credential reads as "could not run".
5. Open the Activity graph of the memory's source Case. Open a Case with two
   assignments that ran side by side: it has two lanes. Select a node from the
   keyboard and read its detail. Open a Case from Slack: each node is in its
   place and shows its kind only.
6. Sign in as an administrator who may not review the mailbox. The navigation
   count is zero, the Knowledge list is empty, the learning flow holds zeros
   and the Activity view lists no Case. No count, title or preview differs
   from an organisation with no records.
7. Repeat steps 1 to 5 at phone width and in the dark theme.

Status, 13 October 2026. The browser journey passes with 54 checks.

| Step | State                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Passed. The fixture has two items that wait: the Memory and the Eval that the agent proposed with it.                                                     |
| 2    | Passed.                                                                                                                                                   |
| 3    | Passed in the `memory-teaching` journey, with a simulated model: teach in a chat, accept, and a fresh chat turn records the revision. Not in the browser. |
| 4    | Passed in part. The run is on two models, one with no credential. The second scenario is saved for review and then declined: the run has one scenario.    |
| 5    | Passed. The Case with two lanes and the Case from Slack are sample Cases of the preview page.                                                             |
| 6    | Passed.                                                                                                                                                   |
| 7    | Passed in part. The journey opens each view at 375 pixels in the dark theme and checks it. It does not repeat each action of steps 1 to 5.                |

## Checks

- `pnpm portal:build`, the Portal type check and `pnpm lint`.
- `pnpm lint:ifc-boundaries`, and an allowed and a denied journey for each new
  read.
- The browser journey, with captures of each view at desktop and phone width.
- No unit tests. The layout of the Activity graph is checked by the journey
  with recorded projections.

## Not in this plan

- A setup interview for a new agent. Onboarding and Plan 16 own agent setup.
- The ingest of connected systems for learning. Plan 46 owns discovery.
- A card with a business measure. No record of a business outcome exists, and
  Plan 42J defers that measurement.
- A Files view.
- Workflow authoring. The Activity graph is read-only.
- The Slack review card. [Plan 56](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-56-slack-in-browser.md) owns it.
- An animated status display. The status line is text.

This plan is complete when the acceptance journey passes with saved captures,
and each view shows only records that its reader may read.
