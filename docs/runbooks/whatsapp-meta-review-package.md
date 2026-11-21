# WhatsApp Meta review package

Use this checklist after the Pantry legal entity exists and Meta allows Business
Verification. It prepares one narrow review submission for the customer-support
flow implemented by Plan 32.

## Current gate

External onboarding is pending. On 2026-09-04, Embedded Signup returned no WABA
grant and **Edit settings** showed “Seams KK can't onboard customers right now.”
See the [live drill evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-32-meta-embedded-signup-drill-2026-09-04.md).

Complete these provider-owned gates in order:

1. Finish the Japanese company incorporation.
2. Update the Meta Business Portfolio and Pantry public policies with the final
   legal entity name, address, and contact details.
3. Complete Meta Business Verification and any required Access Verification.
4. Submit App Review for the three permissions below.
5. Request Advanced Access and external customer onboarding.
6. Run the live organisation-credential and full-revocation drill before inviting a
   production organisation.

## Public review URLs

Verify each deployed page from a signed-out browser before submission:

- Privacy policy: <https://pantry.purin.io/docs/privacy>
- Terms of service: <https://pantry.purin.io/docs/terms>
- User-data deletion: <https://pantry.purin.io/docs/deletion>
- Support contact: <https://pantry.purin.io/docs/contact>

The current support address is shown on those pages. Replace personal or
pre-incorporation details with the final company contact before review.

## Minimum permissions

Pantry requests only the permissions exercised by the implemented flow.

| Permission                     | Reviewer-visible use                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `business_management`          | Identify the Business Portfolio that owns the selected WABA.                                                                               |
| `whatsapp_business_management` | Read the granted WABA and its eligible phone numbers, subscribe the app, inspect connection health, and remove the subscription on revoke. |
| `whatsapp_business_messaging`  | Receive webhook-delivered customer messages and send text service replies through the selected number.                                     |

Do not add permissions for templates, marketing, history import, inbox search,
media, calls, catalogs, payments, or other deferred features.

## Reviewer test account and assets

Prepare a dedicated app-role reviewer account with administrator access to a
sanitized Business Portfolio, WABA, and eligible phone number. Keep production
customer data out of the review environment.

Record these values in the private submission worksheet:

- reviewer account and recovery contact;
- Business Portfolio display name;
- WABA display name;
- test phone-number display name;
- portal workspace URL;
- verification-code delivery method; and
- exact reset steps between review attempts.

Never place passwords, passkeys, access tokens, app secrets, or verification
codes in this repository or the review video.

## Demonstration script

Capture one continuous video with the browser address bar visible when moving
between Pantry and Meta.

1. Sign in to the dedicated Pantry test workspace and open WhatsApp settings.
2. Select **Connect with Meta**.
3. Continue with the reviewer Meta account.
4. Select or create the test Business Portfolio and WABA.
5. Select and verify the eligible phone number.
6. Approve the requested access and return to Pantry.
7. Show the connected number in a processing-disabled state. Do not display the
   organisation credential.
8. Select the number, assign an agent, publish the test ingress policy, and
   enable processing.
9. Send one synthetic customer text to the number. Show the resulting Case and
   the webhook health state.
10. Approve one exact text reply. Show the Meta message identifier and delivery
    status without exposing customer content outside the Case view.
11. Disable the number and show that new processing stops.
12. Reconnect through Embedded Signup and show the connection healthy again.
13. Revoke access. Show the WABA subscription removal, revoked credential
    state, and disappearance of active Case content.
14. Complete fresh Embedded Signup and show recovery through a new provider
    connection authority.
15. Open the public deletion page and explain how a verified workspace owner
    requests deletion.

Capture separate short clips only when Meta's reviewer form requires one video
per permission. Reuse the matching steps above so every requested permission
has a visible product action.

## Data-handling statement

Use the following facts consistently in the submission and demo:

- Each organisation approves access to its own Business Portfolio, WABA, and phone
  number through Meta Embedded Signup.
- Pantry exchanges the one-time code server-side and encrypts the organisation-specific
  business token in that organisation's Vault.
- Raw Meta credentials never enter the browser after the callback, model
  prompts, generated code, logs, analytics, or workspace executors.
- Pantry processes new webhook-delivered text messages. It does not import or
  browse WhatsApp history.
- Active Case text is application-encrypted and retained only for the open Case,
  with a maximum 24-hour bound.
- Disable, revoke, Case close, expiry, and verified deletion trigger the scoped
  cleanup implemented by Plan 32.

## Funding boundary

Pantry does not provide or share a WhatsApp credit line. The organisation owns its
Meta business assets and any payment method Meta requires. Stop the release if
Meta requires Pantry to become financially responsible for organisation messaging.

## Submission evidence

Collect and sanitize:

- Business Verification and Access Verification status;
- App Review submission and decision for each permission;
- Advanced Access status;
- the exact permission list returned for the reviewer token;
- the token lifetime form returned by `debug_token`;
- successful WABA subscription and removal responses;
- one inbound webhook receipt and one outbound delivery-status receipt;
- the fresh-authority result after full revocation; and
- confirmation that no active Case plaintext remains after cleanup.

## Release decision

External organisation onboarding opens only after all of these are true:

- Meta permits a non-app-role business to finish Embedded Signup;
- the required permissions have Advanced Access;
- the organisation-funded payment boundary is confirmed;
- the live revoke-to-fresh-signup recovery drill passes;
- one isolated real-number canary passes; and
- public policy, support, and deletion details name the final legal entity.
