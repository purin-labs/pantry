# Organisation setup flow

This spec covers the Organisations page when a person has no Satyr
organisation, and the **Set up Satyr** dialog. It changes the Portal only.
The routes and the data flow stay the same:

1. `GET /v1/control/account-onboarding` lists the organisations and projects
   of the person's account.
2. `POST /v1/control/account-onboarding` starts or resumes one setup. The
   Portal repeats the same request each second until the result is `ready`.
3. The Portal reads the session again. The new membership puts the Satyr
   organisation in the list.

The Portal keeps the accepted request in `sessionStorage`
(`satyr:account-onboarding:<userId>`). A reload, a retry, or a new sign-in
continues the same operation. Satyr does not create a second organisation.

## Problem

Before this change, step 3 had no check. When the session did not list the new
organisation, the dialog closed and the page showed the empty list again. The
person saw no reason and had no next action. The dialog also put three
decisions on one screen with two selects, so the order of the decisions was
not clear.

## Shape

One dialog with the constant title **Set up Satyr** and a counter, "Step 2 of
5". A thin segmented bar under the title shows the five steps with a short
label under each segment. The body below the bar changes for each step. The
dialog has one column; choices are a single list of rows. The page behind the
dialog does not change.

| #   | Step bar label | Body heading                     | Primary action    |
| --- | -------------- | -------------------------------- | ----------------- |
| 1   | Organisation   | Choose an organisation           | Continue          |
| 2   | Project        | Choose a project                 | Continue          |
| 3   | Billing        | Confirm billing                  | Start setup       |
| 4   | Prepare        | Satyr prepares your organisation | (none)            |
| 5   | Done           | Satyr is ready                   | Open organisation |

A segment is filled when its step is done or current, empty when it is next,
red when its step failed, and amber when it needs attention. The current step
has `aria-current="step"`, and each label carries its state for screen
readers. On a narrow screen, the bar shows the label of the current step only.
Each new step moves the focus to its title.

The Organisations page owns the dialog, not the list. The dialog stays open
while the Portal reads the session again, so the result of step 5 is always
visible.

### Visual style

The style follows the quiet, monochrome onboarding of ElevenLabs:

- The step title uses the display face (Waldenburg, with Helvetica Neue as the
  fallback) at 24 px. The text under it is muted and 14 px.
- A choice is a soft card with a 40 px tile (the first letter of the name, or
  a plus sign for "create") and a round check mark on the right. A selected
  card has a dark outline and a filled check mark.
- The primary action is a dark pill. Secondary actions (Cancel, Back, Close,
  Sign in again) are text buttons.
- Colour appears only where it has a meaning: a reached step, a failed step,
  and the failure badge.

## Empty Organisations page

> **No organisations yet**
> Satyr runs in a project of your account. Set it up in three steps:
>
> 1. Choose an organisation
> 2. Choose or create a project
> 3. Confirm billing
>
> [Set up Satyr]

## Step states and copy

### 1. Organisation

- While the Portal reads the account: three skeleton rows and the status
  "Satyr gets the organisations from your account."
- Lead: "Satyr runs in an organisation of your account. Choose one, or create
  a new one."
- One row for each organisation: its name and "1 project", "2 projects" or
  "No projects".
- Last row: "Create an organisation", with the detail "Satyr creates it in
  your account." When selected, the row shows the field "Organisation name".
- If the account has no organisation, the lead is "Your account has no
  organisations. Create one for Satyr." The create row is selected.
- If the name is empty: "Enter a name for the organisation."
- Footer: Cancel · Continue.

### 2. Project

- Lead: "Satyr uses one project in {organisation}. The project holds the
  account and billing for Satyr."
- One row for each project. Last row: "Create a project", with the detail
  "Satyr creates it in {organisation}." The field "Project name" starts with
  "Satyr".
- For a new organisation, the lead is "{organisation} is a new organisation.
  Satyr creates a project in it." The create row is selected.
- If the name is empty: "Enter a name for the project."
- Footer: Back · Continue. Back keeps every choice and every typed name.

### 3. Billing

- Lead: "Satyr uses the account and billing of this project. Check the
  details before you start."
- Summary: Organisation {name}, Project {name}, and Billing "Satyr uses the
  billing of this project." An item that Satyr will create has the tag "New".
- If Satyr creates an item, a note: "Satyr creates the new items in your
  account when you select Start setup."
- Footer: Back · Start setup.

### 4. Prepare

- Lead: "This can take a few minutes. Keep this window open to see the
  result."
- An indeterminate progress bar and the elapsed time, "Time: 1:05".
- After the result `ready`, the status changes to "Satyr adds the
  organisation to your list."
- Note: "If you close this window, Satyr continues the setup when you open
  this page again."
- Footer: Close.

### 5. Done

- The Portal shows this step only when the new session lists the
  organisation. Then it removes the setup record.
- Lead: "{name} is in your organisation list. Open it to start." If the name
  is not known yet: "The new organisation is in your organisation list. Open
  it to start."
- Footer: Close · Open organisation.

## Failure states

A failure replaces the body of the step that failed. The step bar marks that
step as failed. Each failure has a badge, a heading, a plain reason, the next
action, and the error code when the server sent one. A support reference from
the server is part of its message.

| Step | Cause                                                     | Heading                                     | Reason and next action                                                                                                                                                                                                        | Actions                            |
| ---- | --------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1    | The account read failed                                   | Satyr cannot read your account              | The server message. "Try again. If the problem continues, sign in again."                                                                                                                                                     | Sign in again · Try again          |
| any  | The session ended (`session_ended`)                       | Your session has ended                      | "Sign in again to continue the setup." In steps 4 and 5 also: "Satyr keeps this setup and continues it after you sign in."                                                                                                    | Close · Sign in again              |
| 3    | The account refused the project (`account_setup_blocked`) | This project cannot start Satyr             | "Choose another project or ask its owner to check access."                                                                                                                                                                    | Close · Choose another project     |
| 3    | The browser could not keep the setup record               | Satyr cannot start the setup                | The browser message. "Allow site data for this page, then try again."                                                                                                                                                         | Close · Try again                  |
| 4    | The start or a status read failed                         | The setup stopped                           | The server message. "Try again to continue the same setup. Satyr does not create a second organisation."                                                                                                                      | Sign in again · Try again          |
| 4    | 60 status reads returned `pending`                        | The setup takes longer than usual (warning) | "The setup is not finished after {time}. Check again to continue the same setup."                                                                                                                                             | Close · Check again                |
| 5    | The new session does not list the organisation            | Your organisation is not available          | "Satyr finished the setup, but your organisation list does not show the organisation. The project can still point to a deleted organisation. Create a new project for Satyr, or check again." Detail: "Organisation ID: {id}" | Check again · Create a new project |

"Try again" and "Check again" in step 4 send the same request with the same
operation ID. "Check again" in step 5 reads the session again. "Create a new
project" in step 5 removes the setup record and returns to step 2 with "Create
a project" selected; the new project starts a new operation. In production on
2026-10-19 the account platform answered `ready` for a project whose old Satyr
organisation was deleted, so a new project is the action that works. The Portal
keeps the setup record after a failure in steps 4 and 5: a reload or a new
sign-in sends the saved request again and checks the list again. A blocked
project removes the record; "Choose another project" returns to step 2 with
every choice kept. Close in a failure state keeps the record.

## Verification

- `apps/portal/organisations-preview.html?setup=<state>` shows each state with
  fixed data. `?setup=live` runs the real dialog against a mocked account API.
- `scripts/frontend-foundation/portal-account-setup-journey.mjs` runs the
  steps, a stopped setup and its recovery, a replayed setup, and an
  organisation that the session lists only after "Check again".
