# Plan 42E — Chat / canvas operational parity

Status: **Complete for the high-impact local software scope.**
Closed: 1 October 2026, by operator scope decision. No deployment authorized.

This closeout replaces the former exhaustive parity checklist. It accepts the
implemented operational path and explicitly defers the remaining convenience
features. It does not claim every canvas control has a chat equivalent, complete
live-provider release acceptance, or physical robot readiness.

## Delivered scope

- [x] Shared typed playback: play, pause, seek, restart, speed and next event.
- [x] Inspect, select and navigate the supported Shift, production, rehearsal and
      recording surfaces. Open the production panels through shared actions.
- [x] Preserve chat camera controls and robot simulation: overhead/recenter,
      recording focus/inspection, prepare, simulate, stop, review and accept or
      discard exact candidates.
- [x] Shared rehearsal and production authoring: assignments, prerequisites,
      start times, faults, previews, comparisons and reviewed replacement.
- [x] Scenario-save recovery and exact run save/readback. Operator confirmation
      remains required for governed saves and destructive replacement.
- [x] Production/rehearsal file attachments, reviewed imports and immutable
      exports. List and open exact saved runs through the existing catalogue.
- [x] Preserve surface epoch, source fingerprint, access, cancellation and
      duplicate-delivery fences. Late results cannot replace newer work.
- [x] Recover the existing signed-in chat and demonstrate real Codex inspection
      and playback controls. This is bounded live acceptance, not the full
      simulation/save/cancellation matrix on both providers.

No additional runtime feature is required to close this narrowed scope. Existing
camera and simulation functionality remains supported.

## Verification and evidence

The evidence records identify which runs use controlled inference, authenticated
Worker fixtures, real browser MuJoCo, or a real signed-in provider. Those are
separate levels of evidence. This documentation closeout does not claim a fresh
execution of all historical journeys.

| Outcome | Evidence |
| --- | --- |
| Playback, exact receipts, stale-state rejection | [Playback](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-playback-2026-09-27.md) |
| Simulation, cancellation and uncertain save recovery | [Operational journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-operational-2026-09-27.md) |
| Rehearsal and production authoring | [Rehearsal](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-rehearsal-edits-2026-09-29.md), [production](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-production-authoring-2026-09-29.md) |
| Faults, baselines and reviewed replacement | [Faults](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-faults-2026-09-30.md), [baselines](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-baselines-2026-09-30.md), [rehearsal review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-reviewed-changes-2026-09-30.md), [production review](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-financier-replacement-2026-09-30.md) |
| Navigation and panels | [Navigation](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-production-navigation-2026-09-30.md), [panels](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-production-panels-2026-09-30.md) |
| Camera controls, door inspection, cancellation and exact saved-run recovery | [Execution and cleanup](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-execution-and-cleanup-2026-09-30.md) |
| Scenario recovery and production/rehearsal files | [Scenario and file journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-scenario-files-2026-10-01.md) |
| Signed-in chat recovery and later live controls | [Recovery](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42E-chat-access-recovery-2026-10-01.md), [closeout supplement](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42EF-closeout-2026-10-01.md) |

## Deferred features

These are unimplemented or incompletely verified; they are not checked off as
completed and do not belong to the closed operational scope.

- Standalone recording-viewer chat attachment/import/export parity.
- Exhaustive shell, canvas-position, focused-camera and task-query parity beyond
  the supported controls. Keep the existing camera controls.
- Scenario-revision catalogue/open convenience parity beyond implemented save
  recovery and exact rehearsal/production run opening.

Reopen these only for a demonstrated operator need. Automatic context loading is
complete under [Plan 42G](plan-42G-automatic-context-loading.md), including
production Pi/Codex acceptance. That bounded acceptance does not cover the full
operational release journey below.

## Release gate retained

Before claiming a general Pi/Codex release, repeat the complete signed-in
setup → simulate → inspect → accept → confirm save → reopen journey on both
routes, including composer attachments, Stop, stale edits, reconnect, revoked
access and duplicate delivery. Existing controlled journeys and the bounded real
Codex checks do not close that gate. Keep it attached to the eventual release;
42G must not inherit an unrelated parity backlog.

Physical robot dispatch and observed calibration remain with Plan 24 and the
[calibration intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md). Completing this
plan grants neither deployment nor hardware authority.
