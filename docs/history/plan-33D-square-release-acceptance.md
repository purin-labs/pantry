# Plan 33D — Square release acceptance

Status: **deferred** · active Sandbox certification completed; follows
[Plan 33C](plan-33C-POS-systems.md). Production readiness is not claimed.
Update (2026-11-14): Plan 80 step 4 (released 2026-10-27) moved Square into
Underclerk; a restart of this plan starts from that path.
Follow-up (2026-11-16): [Plan 90](../plan-90-cafe-pos-checkout.md) Phase 3C carries
live Square Terminal certification forward with Japan FeliCa and QR tenders.

## Active scope

As of 2026-09-08, exact-binding Sandbox certification is complete. The user
deferred distinct-seller isolation and physical/live certification until later;
do not pursue them or request accounts, hardware, or live payments until resumed.

1. **Exact-binding certification — completed.** Packet
   `square-jp-binding-20260908` certifies Japan Sandbox merchant `MLJRX6QNWVMY2`,
   location `L2YQ9SP8V534A`, successful-payment simulated target, and capability
   revision `1788817935700`. The current-binding captured canary and signed
   delivery anchor the applicable historical adapter/portal and fixture evidence.
   The admin API returned `recorded`, then `replayed`, both HTTP 200 with
   synchronized authority. The portal readback showed the same revision Ready
   without the Uncertified warning. No additional collection was submitted.
   See [evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-exact-binding-20260908.json) and
   [immutable packet](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-exact-binding-packet-20260908.json).
   This is Satyr's internal Sandbox certification, not Square approval.

   The certificate writer's Stripe-only account check and stored check list
   were corrected for Square. The focused six-file suite passed 34 tests;
   after adding the Square record/replay/readback regression, both certification
   files passed all 10 tests. Platform TypeScript checking passed directly.
   Full `check:types` stopped at a sandbox-denied Wasm tooling download; test
   type-checking reports unrelated missing `readMerchantReport` inputs in
   `harness-tool-catalog.test.ts`. Those shared-worktree issues were left intact.

## Deferred until resumed by the user

1. **Distinct-seller isolation — user-deferred.** Both local organisations currently
   authorize Japan seller `MLJRX6QNWVMY2`. When resumed, connect the distinct
   AU seller `MLB5XP163XKP5`, verify organisation-scoped payment authority, and complete
   refresh/revocation isolation. A distinct seller does not necessarily require
   a separate Square login. Preserve current connections until replacement is
   explicitly undertaken.
2. **Physical production acceptance — user-deferred.** After the Sandbox
   gates pass, obtain hardware and explicit approval for live charges and
   planned refunds. Complete P33C-6's pairing, expiry/replacement, payment,
   cancellation, offline/interruption, refund, receipt agreement, and credential
   lifecycle checks. Record costs and the exact production binding.

## Evidence and limits

- [Adapter matrix](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-terminal-sandbox-20260906-jp-3.json):
  Sandbox success, cancellation, timeout, replay, readback, and refund.
- [Portal canary](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-portal-counter-sale-20260908.json):
  sale, placement, inventory, handover, receipt, and refund.
- [Recovery fixtures](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-recovery-gaps-20260908.md): concurrency,
  late capture, persistence recovery, and fixture credential isolation. Two
  authenticated operator sessions across assignment replacement remain unproven.
- [Current runtime evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/square-post-refresh-readiness-20260908.md):
  rotated credentials, signed webhook registration/delivery/completion, browser
  reload recovery, and migrated OAuth callback completion. The two-file counter
  summary refresh change passes TypeScript checking; its in-page transition
  has not been verified after the change.

Do not repeat completed refresh/recovery demonstrations. Resolve only evidence
gaps required for release. Google OAuth migration is outside this Square plan.

## Exit

The active Sandbox task closes when its exact-binding certificate is recorded
and verified. The deferred work does not block that scoped completion.

Full release acceptance closes only when the applicable exact-binding certificates
are recorded and the distinct-seller and physical gates pass. P33C's delivered
implementation status does not change these requirements or the hardware
purchase gate.
