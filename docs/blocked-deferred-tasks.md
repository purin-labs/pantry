# Blocked and deferred tasks

This register records work intentionally paused behind an external dependency
or a later product decision. The owning plan remains authoritative for design
and completion criteria.

## Plan 32 — WhatsApp customer support

Deferred on 2026-09-08 while Pantry waits for Meta to permit external customer
onboarding.

### Meta approval dependencies

- Finish the Japanese company incorporation.
- Update the Meta Business Portfolio and Pantry's public policies with the final
  legal entity name, address, and company support contact.
- Complete Meta Business Verification and any required Access Verification.
- Submit App Review for `business_management`,
  `whatsapp_business_management`, and `whatsapp_business_messaging`.
- Obtain Advanced Access and permission to onboard businesses outside Pantry's
  Meta app roles.
- Confirm that each organisation can fund its own WhatsApp account without Pantry
  sharing a credit line.

### Resume after approval

- Complete Embedded Signup with an organisation-owned test business and verify that
  Pantry stores its organisation-specific credential.
- Cut the existing test connection over from its legacy credential only after
  the organisation credential, WABA subscription, and one inbound message are proven.
- Run the controlled live recovery drill: stage a second known-good signup,
  revoke the first organisation credential, verify subscription and content cleanup,
  complete fresh signup, and receive another inbound message.
- Confirm Meta's production token lifetime, permission grant, app-subscription
  removal response, and ambiguous-send status-webhook behavior.
- Run one isolated real-phone-number production canary.
- Open external organisation onboarding after the review, recovery drill, funding
  boundary, public legal details, and canary all pass.

Keep the current production WhatsApp credential and WABA subscription intact
until a replacement credential has passed the live cutover checks.

References:

- [Plan 32](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-32-whatsapp-customer-support.md)
- [WhatsApp development sandbox](runbooks/whatsapp-development-sandbox.md)
- [Meta review package](runbooks/whatsapp-meta-review-package.md)
- [2026-09-04 Embedded Signup drill](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-32-meta-embedded-signup-drill-2026-09-04.md)

## Plan 33B — Supplier payouts

Blocked on provider access approvals as of 2026-09-08. Local foundations exist;
provider adapters and the initial provider-backed quote-to-approval flow remain
unfinished.

### External blockers

- Obtain Wise enterprise approval for API funding and statement access on the
  Japanese business profile.
- Obtain GMO Aozora's written acceptance of Pantry's production access arrangement.
- Obtain the approved provider's credentials and contracted API specifications.

### Resume per provider after approval

- Implement the authenticated adapter and provider-backed quote preparation,
  exact economics approval, and operator presentation.
- Complete one end-to-end payout: approved payable, submission, funding or
  bank-side action where required, reconciliation, and receipt.
- Verify provider-specific uncertainty, duplicate prevention, returns, failures,
  credential lifecycle, and the supported route/amount certification matrix.

Either provider can proceed independently once its prerequisites are available.
Speculative adapter and fixture work remains paused.

References: [Plan 33B](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-33B-payouts.md) and
[implementation record](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-33BC-completion-record.md).

## Plan 33D — Square release acceptance

Deferred by the user on 2026-09-08. P33C is complete for the agreed Sandbox scope,
including exact-binding certification. Resume these tasks only when requested:

- **Distinct-seller isolation:** connect a distinct Sandbox seller to the second
  Pantry organisation and verify payment authority, refresh, and revocation isolation.
  Both current connections use the Japan seller. Preserve them until replacement
  is explicitly undertaken; a separate Square login may not be necessary.
- **Physical Terminal/live certification:** after the Sandbox release gates pass,
  obtain hardware and explicit approval for live charges and planned refunds.
  Verify pairing, expiry/replacement, payment, cancellation, offline/interruption
  recovery, refunds, receipt agreement, and credential lifecycle. Record costs
  and certification for the exact production binding.

Reference: [Plan 33D](plan-33D-square-release-acceptance.md).
Sandbox completion does not imply production readiness.

## Deferred product proposals

These documents remain discoverable outside the active Kitchen/Café delivery
sequence. Their existence creates no implementation requirement.

| Proposal                                                                 | Current boundary and resume condition                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [Plan 29G: Outlook](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29G-outlook-mail-integration.md)                | The typed Gmail facet exists. Outlook adapter and acceptance remain deferred; resume for a selected customer or supplier workflow. |
| [Plan 29H: Apple Mail](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-29H-apple-mail-integration.md)               | Retain as a proposed provider extension. Resume only with an accepted operational need and verified provider boundary.             |

[Plan 48](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/plan-48-ecommerce-agent-semantic-verification-and-case-routing.md)
records withdrawn features. Its scope stays closed. Any future proposal needs
new merchant evidence and a new decision.
