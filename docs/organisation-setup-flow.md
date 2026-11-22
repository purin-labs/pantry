# Organisation setup flow

This spec covers the Organisations page when a person has no Purin Pantry
organisation, and the **Set up Purin Pantry** dialog. Pantry makes the
organisation itself ([Plan 95](plan-95-pantry-own-accounts.md) step 2); no
outside account takes part.

1. `POST /v1/control/organisations` with `{ operationId, name }` makes the
   organisation, and the person becomes its owner. The route answers when the
   organisation exists, so the Portal does not poll.
2. The Portal reads the session again. The new membership puts the
   organisation in the list.

The Portal keeps the request in `sessionStorage`
(`pantry:account-onboarding:<userId>`, the value `{ operationId, name }`). A
reload, a retry or a new sign-in sends the same operation id, which is the
idempotency key of the route. Pantry does not make a second organisation.

## Shape

One dialog with the constant title **Set up Purin Pantry** and a counter,
"Step 2 of 4". A thin segmented bar under the title shows the four steps with
a short label under each segment. The body below the bar changes for each
step. The page behind the dialog does not change.

| #   | Step bar label | Body heading                            | Primary action    |
| --- | -------------- | --------------------------------------- | ----------------- |
| 1   | Organisation   | Name your organisation                  | Create            |
| 2   | Prepare        | Purin Pantry prepares your organisation | (none)            |
| 3   | Jev            | Jev (optional)                          | Turn on · Skip    |
| 4   | Done           | Purin Pantry is ready                   | Open organisation |

A segment is filled when its step is done or current, empty when it is next,
red when its step failed, and amber when it needs attention. The current step
has `aria-current="step"`, and each label carries its state for screen
readers. Each new step moves the focus to its heading.

The Organisations page owns the dialog, not the list. The dialog stays open
while the Portal reads the session again, so the result is always visible.

## Steps

1. **Organisation.** One field, "Organisation name", of at most 120
   characters. An empty name sends nothing: "Enter a name for the
   organisation."
2. **Prepare.** An indeterminate progress bar while Pantry makes the
   organisation. Then "Pantry adds the organisation to your list" while the
   Portal reads the session again.
3. **Jev.** The optional Jev step of Plan 88: one choice turns on the three
   Jev switches, or the person skips it. A switch that cannot turn on shows
   its reason and never blocks the setup.
4. **Done.** The Portal shows this step only when the new session lists the
   organisation. Then it removes the setup record. Lead: "{name} is in your
   organisation list. Open it to start."

## Failure states

A failure replaces the body of the step that failed, and the step bar marks
that step. Each failure has a heading, a plain reason, the next action, and
the error code when the server sent one.

| Cause                                          | Heading                                   | Action                        |
| ---------------------------------------------- | ----------------------------------------- | ----------------------------- |
| The session ended                              | Your session has ended                    | Sign in again                 |
| The browser could not keep the setup record    | Pantry cannot keep this setup             | Try again                     |
| `organisation_owner_unverified`                | Pantry needs a verified email             | Sign in with another account  |
| `organisation_limit_reached` (five owned)      | You cannot own more organisations         | Close                         |
| `idempotency_key_conflict`                     | This setup changed                        | Start again                   |
| `authority_unavailable` or no answer           | The setup stopped                         | Try again (same operation id) |
| The session does not list the organisation yet | Your organisation is not in your list     | Check again                   |
| The session read failed                        | Pantry cannot read your organisation list | Check again                   |

"Try again" sends the same request with the same operation id. "Start again"
removes the setup record and returns to step 1. The Portal keeps the setup
record after a failure in step 2 or 4, so a reload or a new sign-in sends the
saved request again.

## Verification

- `apps/portal/organisations-preview.html?setup=live` runs the real dialog
  against a fake of the route. `live-limit`, `live-unverified` and
  `live-missing` show the refusals, and `?invitation=<code>` shows the
  invitation page with each accept refusal.
- `scripts/frontend-foundation/portal-account-setup-journey.mjs` runs on the
  real Portal: `PANTRY_PORTAL_URL=<portal url> node
scripts/frontend-foundation/browser-journeys.mjs --account-setup`. It checks
  an empty name, a lost answer and its retry with one operation id, a reload,
  an unlisted organisation, the limit and the unverified refusals, and the
  invitation page.
- `services/platform/tests/e2e/organisation-setup.test.ts` (J4) checks the
  route.
