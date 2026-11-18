# Plan 42F — Shared orchestration and simulated handoffs

Status: **Complete for the high-impact simulated software scope.**
Closed: 1 October 2026, by operator scope decision. No deployment or hardware use.

The accepted outcome is one scheduler and browser execution path for supported
production/rehearsal workflows, plus explicit resources, independent two-cell
scheduling and a bounded simulated human transfer. Shared spatial presentation
and physical calibration are outside this closeout. This replaces the former
open-ended F1–F4 implementation checklist.

## Delivered scope

- [x] F1a/b: execute production and multi-tray rehearsal workflows through the
      shared scheduler and browser runner, preserving accepted continuation.
- [x] F1c: move presets, faults, native import, chat commands, reviewed edits,
      rack-layout experiments, save/recovery and reopen onto that path.
- [x] F1d: retire the previous multi-tray engine, single-rehearsal workspace and
      chain scheduler. Keep import conversion at persistence boundaries.
- [x] F2a: explicit cell, arm, clamp, tray and fixture instances.
- [x] F2b: schedule two independent FR10 cold cells with shared-resource
      contention, reviewed assignment, exact reopen and cross-cell rejection.
- [x] F3 simulation: model a human-mediated tray transfer with stable identity,
      receiving-capacity reservations, interrupted custody and held resources.
- [x] Preserve one logical clock and deterministic browser execution. Independent
      work can proceed when its prerequisites and resources permit.

## Accepted simulation boundary

The operator selected two independent FR10 cold-workcell models and a
human-mediated transfer. The route carries one tray from cell 1's rack through a
one-slot buffer to cell 2's prepared table, then a native table-to-rack operation.

Pickup (10 s), carry (20 s) and placement (10 s) remain assumptions. Model-local
fixtures and accepted evidence determine supported native boundaries. Global
cell/buffer placement and real human completion remain unmeasured. An interrupted
transfer preserves uncertainty and holds resources; dependent work cannot invent
successful placement. No MuJoCo integration state is copied between models.

Browser jobs execute serially; the scheduler models logical overlap. Separate
parallel workers, interacting arms, new pickup skills, hot handling and physical
robot execution are outside the accepted scope.

## Verification and evidence

| Milestone | Evidence |
| --- | --- |
| One production runner and rehearsal continuation | [F1a](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1a-browser-production.md), [F1b](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1b-rehearsal-chains.md) |
| Presets, faults and governed chat | [Presets](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-presets.md), [faults](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-rehearsal-faults.md), [chat](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-chat-commands.md) |
| Native import and rack dragging | [Import](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-native-import.md), [layout editing](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1c-tray-layout-drag.md) |
| Retirement and explicit instances | [F1d](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f1d-retirement.md), [F2a](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-f2a-instances.md) |
| Two-cell scheduling, contention and isolation | [Two-cell journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-two-cell-scheduling-2026-10-01.md) |
| Buffer capacity, interrupted custody and exact reopen | [Human-transfer journey](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42F-human-transfer-2026-10-01.md) |

The recorded combined browser journey completed 14 real MuJoCo results using
controlled HTTP/model transport. Authenticated Worker journeys are also recorded.
This closeout reviews that evidence; it does not report a new full-suite run or
complete live-provider acceptance. Later status is recorded in the
[closeout supplement](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42EF-closeout-2026-10-01.md).

## Deferred features

- One spatial view rendering both cells and the buffer with reviewed placement
  transforms. Existing selected-cell previews, timelines and assignments remain.
- Parallel browser workers; only reconsider after a measured performance need.
- Other handoff routes, additional manipulation skills and automatic recovery
  planning; each needs its own concrete operator use case.

These items are outside the completed scope, not completed implementations.
Automatic agent context loading is complete under
[Plan 42G](plan-42G-automatic-context-loading.md), including production Pi/Codex
acceptance. Its scope remains separate from the release gates below.

## External and release gates retained

- **Live provider release:** full signed-in Pi/Codex save/readback, Stop, stale
  edits, reload isolation and revoked-access acceptance remains required before
  claiming a general release. See [42E](plan-42E-chat-canvas-parity.md#release-gate-retained).
- **Scheduling calibration (former F4a):** collect repeated real shifts, establish
  baseline error, agree error bounds, fit supported parameters and validate on
  separate observations. No real shift dataset has been supplied.
- **Mechanical calibration (former F4b):** measure fixtures, global placement,
  material/tooling and transfers with provenance and instrument uncertainty;
  validate on separate successful and unsuccessful trials. No observed human
  completion receipts or physical transfer trials have been supplied.
- **Hardware:** enrollment, authorized dispatch and trustworthy completion or
  uncertainty receipts remain under [Plan 24](plan-24-cafeos-bakery-automation.md).

Use the existing [intake](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-42-physical-calibration.md) and
[worksheet](plan-42-calibration-worksheet.md). Keep assumed values labeled and
version measured replacements through review. Software tests and visual realism
cannot satisfy physical calibration. General timeout/power-loss, representative
performance and operator-usefulness release gates in Plan 42B are unchanged.
