#!/usr/bin/env node
// Verifies Option 1 (initial floor-plan walk routes at shift preparation) and
// Option 2 (live mid-run update-worker-travel commands, in-flight walk
// preservation, command idempotency/refusals, host protocol execution, and
// resumable save/restore invariants) against the real engine and Wasm runtime.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activeWorkerRoutes,
  admitScenario,
  authoredId,
  durationFromSeconds,
  openResumable,
  parseId,
  submitCommand,
  TICK_MICROSECONDS,
  travelDurationFromRoutes,
} from "../../packages/production-simulation/src/index.ts";
import {
  compileBakeryShift,
  SHIFT_LOCATIONS,
  shiftTravel,
  sixHourShiftRecipeInput,
} from "../../packages/production-simulation/src/recipes/bakery/bakery-shift.ts";
import { PRODUCTION_EXECUTION_MANIFEST as manifest } from "../../packages/production-simulation/src/execution-manifest.generated.ts";
import { prepareCell, runtimeModule } from "./build-execution-bundle.mjs";
import { collectingExecutionHost } from "./collecting-execution-host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeDir = join(
  root,
  "apps/portal/public/bakery-physics/bundles",
  manifest.runtime.id,
);
const engineDir = join(
  root,
  "apps/portal/public/bakery-physics/executions",
  manifest.bundle.id,
);
const outputDir = join(root, "output/acceptance/live-appliance-move");
mkdirSync(outputDir, { recursive: true });

function must(result) {
  if (!result.ok) {
    throw new Error(`Unexpected failure: ${JSON.stringify(result)}`);
  }
  return result.value;
}

function buildCustomShiftRoutes(prepToOvenSeconds, otherSeconds) {
  const routes = [];
  for (const from of SHIFT_LOCATIONS) {
    for (const to of SHIFT_LOCATIONS) {
      if (from === to) continue;
      const isOvenLeg =
        (from === "prep" && to === "oven") ||
        (from === "oven" && to === "prep") ||
        (from === "oven" && to === "cooling") ||
        (from === "cooling" && to === "oven");
      const sec = isOvenLeg ? prepToOvenSeconds : otherSeconds;
      routes.push({
        from: authoredId("location", from),
        to: authoredId("location", to),
        duration: must(durationFromSeconds(sec)),
        evidence: "model",
      });
    }
  }
  return routes;
}

async function createHost(E) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return collectingExecutionHost(
    E,
    E.wasmTransport(await runtimeModule(runtimeDir), {
      encode: encoder.encode.bind(encoder),
      decode: decoder.decode.bind(decoder),
    }),
  );
}

function collectCheckpoints(...saves) {
  const byDigest = new Map();
  for (const saved of saves) {
    for (const artifact of saved.artifacts ?? []) {
      if (artifact.role === "cell-checkpoint") {
        byDigest.set(artifact.digest, {
          digest: artifact.digest,
          content: artifact.content,
        });
      }
    }
  }
  return [...byDigest.values()];
}

async function main() {
  const teaCell = await prepareCell(runtimeDir, "tea-pan-cell", {
    fixture: "pan-staging",
  });

  // 1. Reject invalid customTravel at recipe compilation time.
  const invalidDuplicate = [
    ...shiftTravel("standard").slice(0, -1),
    shiftTravel("standard")[0],
  ];
  const rejectedCompile = await compileBakeryShift(
    sixHourShiftRecipeInput({ customTravel: invalidDuplicate }),
    teaCell,
  );
  assert.equal(rejectedCompile.ok, false, "Duplicate customTravel must fail");

  // 2. Option 1: Compile a shift with custom floor-plan routes (prep<->oven = 29s, other = 6s).
  const initialCustomTravel = buildCustomShiftRoutes(29, 6);
  const compiled = must(
    await compileBakeryShift(
      sixHourShiftRecipeInput({
        workers: 1,
        financierLoads: 1,
        financierWaves: 1,
        piesPerType: 0,
        miseEnPlace: "same-morning",
        sesameBatches: 1,
        blackTeaBatches: 1,
        milkTeaBatches: 1,
        espressoOrders: 1,
        pourOverOrders: 0,
        nativeColdHandling: false,
        customTravel: initialCustomTravel,
      }),
      teaCell,
    ),
  );
  const admitted = must(await admitScenario(compiled));
  assert.equal(admitted.scenario.id, "bakery-shift");

  const E = await import(
    pathToFileURL(join(engineDir, manifest.engine.file)).href
  );
  const bundle = manifest.bundle;
  const host = await createHost(E);
  const began = await host.handle({
    kind: "begin",
    bundle,
    cells: [teaCell],
    identity: {
      runId: "run-live-move-e2e",
      executionId: "exec-live-move-1",
      hostSession: "session-live-move-1",
      parent: null,
    },
    origin: { kind: "scenario", scenario: compiled },
  });
  assert.equal(began.kind, "began");

  // Advance second-by-second until we have completed walks AND baker is mid-walk!
  let midWalkState = null;
  for (let sec = 1; sec <= 2400; sec += 1) {
    const drove = await host.handle({
      kind: "drive",
      turns: 64,
      until: sec * 1_000_000,
    });
    assert.equal(drove.kind, "drove");
    const st = await host.handle({ kind: "state" });
    assert.equal(st.kind, "state");
    const baker = st.run.resources.find((r) => r.id === "baker");
    const pastWalks = st.run.events.filter(
      (e) => e.kind === "worker-assigned" && e.arrivesAt > e.time,
    );
    if (
      pastWalks.length >= 2 &&
      baker?.position.kind === "assigned" &&
      baker.position.arrivesAt > st.run.position.time &&
      baker.position.from !== baker.position.start
    ) {
      midWalkState = st.run;
      break;
    }
  }
  assert.notEqual(
    midWalkState,
    null,
    "Expected to catch baker mid-walk after earlier walks",
  );

  const bakerBeforeMove = midWalkState.resources.find((r) => r.id === "baker");
  assert.equal(bakerBeforeMove?.position.kind, "assigned");
  const inFlightTask = bakerBeforeMove.position.task;
  const inFlightArrivesAt = bakerBeforeMove.position.arrivesAt;
  const inFlightCompletesAt = bakerBeforeMove.position.completesAt;
  const nonZeroEarly = midWalkState.events.filter(
    (e) => e.kind === "worker-assigned" && e.from !== e.start,
  );
  assert.ok(nonZeroEarly.length >= 2);
  for (const ev of nonZeroEarly) {
    const walkSec = (ev.arrivesAt - ev.time) / 1_000_000;
    assert.ok(
      walkSec === 6 || walkSec === 29,
      `Expected Option 1 walk duration 6s or 29s, got ${walkSec}s`,
    );
  }

  // 3. Option 2: Refusals first (unknown_target, invalid_worker_travel).
  const badTarget = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-unknown-resource",
    resource: "oven",
    travel: initialCustomTravel,
  });
  assert.equal(badTarget.kind, "commanded");
  assert.equal(badTarget.receipt.status, "rejected");
  assert.equal(badTarget.receipt.reason, "unknown_target");

  const badTravel = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-incomplete-routes",
    resource: "baker",
    travel: initialCustomTravel.slice(0, 10),
  });
  assert.equal(badTravel.kind, "commanded");
  assert.equal(badTravel.receipt.status, "rejected");
  assert.equal(badTravel.receipt.reason, "invalid_worker_travel");

  // 4. Option 2: Admit a live mid-run appliance move while baker is MID-WALK!
  // Relocate appliances so non-oven legs become 19s and oven legs become 11s.
  const movedTravel = buildCustomShiftRoutes(11, 19);
  const admittedMove = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-live-appliance-move-1",
    resource: "baker",
    travel: movedTravel,
  });
  assert.equal(admittedMove.kind, "commanded");
  assert.equal(admittedMove.receipt.status, "accepted");
  assert.equal(
    admittedMove.receipt.effectiveAt,
    midWalkState.position.time + TICK_MICROSECONDS,
  );
  assert.equal(admittedMove.view.controlRevision, 1);

  // Idempotent redelivery & conflicting payload & stale revision refusals:
  const duplicateMove = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-live-appliance-move-1",
    resource: "baker",
    travel: movedTravel,
  });
  assert.equal(duplicateMove.kind, "commanded");
  assert.deepEqual(duplicateMove.receipt, admittedMove.receipt);

  const conflictingMove = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-live-appliance-move-1",
    resource: "baker",
    travel: initialCustomTravel,
  });
  assert.equal(conflictingMove.kind, "commanded");
  assert.equal(conflictingMove.receipt.status, "rejected");
  assert.equal(conflictingMove.receipt.reason, "conflicting_payload");

  const staleMove = await host.handle({
    kind: "update-worker-travel",
    commandId: "cmd-stale-move",
    expectedControlRevision: 0,
    resource: "baker",
    travel: movedTravel,
  });
  assert.equal(staleMove.kind, "commanded");
  assert.equal(staleMove.receipt.status, "rejected");
  assert.equal(staleMove.receipt.reason, "stale_control_revision");

  // 5. Pause & save BEFORE the scheduled tick executes (command in run.scheduled),
  // verify openResumable validates state-invariants & worker-invariants!
  const paused1 = await host.handle({
    kind: "pause",
    commandId: "cmd-pause-before-tick",
  });
  assert.equal(paused1.kind, "commanded");
  assert.equal(paused1.view.status.kind, "paused");
  const saved1 = await host.handle({ kind: "save" });
  assert.equal(saved1.kind, "saved");
  const validatedDoc1 = must(
    await openResumable(saved1.document, "browser", [bundle]),
  );
  assert.equal(validatedDoc1.state.position.controlRevision, 2);

  // Resume and drive forward 1,200s past the in-flight walk AND into new worker dispatches!
  const resumed1 = await host.handle({
    kind: "resume",
    commandId: "cmd-resume-1",
  });
  assert.equal(resumed1.kind, "commanded");
  const targetAfterMoveUs = midWalkState.position.time + 1_200_000_000;
  for (let i = 0; i < 4000; i += 1) {
    const d = await host.handle({
      kind: "drive",
      turns: 128,
      until: targetAfterMoveUs,
    });
    assert.equal(d.kind, "drove");
    if (
      d.view.time >= targetAfterMoveUs ||
      d.view.status.kind === "awaiting-inspection"
    ) {
      break;
    }
  }
  const afterStateReply = await host.handle({ kind: "state" });
  assert.equal(afterStateReply.kind, "state");
  const runAfterMove = afterStateReply.run;

  // Verify the in-flight task completed at its EXACT original arrivesAt & completesAt!
  const completedInFlight = runAfterMove.tasks.find(
    (t) => t.id === inFlightTask,
  );
  assert.equal(completedInFlight?.kind, "completed");
  assert.equal(completedInFlight.completedAt, inFlightCompletesAt);
  const inFlightEvent = runAfterMove.events.find(
    (e) => e.kind === "worker-assigned" && e.task === inFlightTask,
  );
  assert.equal(inFlightEvent?.arrivesAt, inFlightArrivesAt);

  // Verify command-admitted was emitted at effectiveAt and activeWorkerRoutes reflects movedTravel!
  const admittedEvent = runAfterMove.events.find(
    (e) =>
      e.kind === "command-admitted" &&
      e.command === "cmd-live-appliance-move-1",
  );
  assert.ok(admittedEvent !== undefined, "command-admitted event must exist");
  assert.equal(admittedEvent.time, admittedMove.receipt.effectiveAt);
  const bakerDef = runAfterMove.definition.scenario.resources.find(
    (r) => r.id === "baker",
  );
  assert.equal(
    travelDurationFromRoutes(
      activeWorkerRoutes(runAfterMove, bakerDef),
      authoredId("location", "prep"),
      authoredId("location", "oven"),
    ),
    must(durationFromSeconds(11)),
  );

  // Verify post-move non-zero walks use ONLY the new durations (11s or 19s)!
  const postMoveWalks = runAfterMove.events.filter(
    (e) =>
      e.kind === "worker-assigned" &&
      e.sequence > admittedEvent.sequence &&
      e.from !== e.start,
  );
  assert.ok(
    postMoveWalks.length >= 2,
    `Expected >= 2 post-move non-zero walks, got ${postMoveWalks.length}`,
  );
  for (const ev of postMoveWalks) {
    const walkSec = (ev.arrivesAt - ev.time) / 1_000_000;
    assert.ok(
      walkSec === 11 || walkSec === 19,
      `Expected post-move walk duration 11s or 19s, got ${walkSec}s`,
    );
  }

  // 6. Save & restore AFTER post-move walks have committed (validates worker-invariants
  // across BOTH historical Option 1 routes before command-admitted AND Option 2 routes after!),
  // AND continue in a brand-new host instance from that snapshot!
  if (runAfterMove.status.kind === "advancing") {
    const paused2 = await host.handle({
      kind: "pause",
      commandId: "cmd-pause-after-move",
    });
    assert.equal(paused2.kind, "commanded");
  }
  const saved2 = await host.handle({ kind: "save" });
  assert.equal(saved2.kind, "saved");
  const checkpoints2 = collectCheckpoints(saved1, saved2);
  const validatedDoc2 = must(
    await openResumable(saved2.document, "browser", [bundle]),
  );

  const restoredHost = await createHost(E);
  const restoredBegin = await restoredHost.handle({
    kind: "begin",
    bundle,
    cells: [teaCell],
    identity: {
      runId: "run-live-move-e2e",
      executionId: "exec-live-move-restored",
      hostSession: "session-live-move-restored",
      parent: {
        snapshot: validatedDoc2.snapshot,
        execution: "exec-live-move-1",
      },
    },
    origin: {
      kind: "snapshot",
      document: validatedDoc2,
      checkpoints: checkpoints2,
    },
  });
  assert.equal(restoredBegin.kind, "began");

  // Also test direct TypeScript submitCommand helper import:
  const restoredStateReply = await restoredHost.handle({ kind: "state" });
  assert.equal(restoredStateReply.kind, "state");
  const directCheck = submitCommand(restoredStateReply.run, {
    kind: "update-worker-travel",
    commandId: must(parseId("command", "cmd-direct-check")),
    runId: restoredStateReply.run.identity.runId,
    executionId: restoredStateReply.run.identity.executionId,
    hostSession: restoredStateReply.run.identity.hostSession,
    expectedControlRevision: restoredStateReply.run.position.controlRevision,
    resource: must(parseId("resource", "baker")),
    travel: initialCustomTravel,
  });
  assert.equal(directCheck.receipt.status, "accepted");

  const report = {
    result: "passed",
    bundleId: bundle.id,
    option1EarlyWalkCount: nonZeroEarly.length,
    option1SampleWalkSeconds: nonZeroEarly.slice(0, 4).map((e) => ({
      from: e.from,
      start: e.start,
      seconds: (e.arrivesAt - e.time) / 1_000_000,
    })),
    inFlightPreserved: {
      task: inFlightTask,
      moveSubmittedAtSeconds: midWalkState.position.time / 1_000_000,
      arrivesAtSeconds: inFlightArrivesAt / 1_000_000,
      completesAtSeconds: inFlightCompletesAt / 1_000_000,
    },
    option2PostMoveWalkCount: postMoveWalks.length,
    option2SampleWalkSeconds: postMoveWalks.slice(0, 4).map((e) => ({
      from: e.from,
      start: e.start,
      seconds: (e.arrivesAt - e.time) / 1_000_000,
    })),
    refusalsVerified: [
      "invalid_bakery_shift",
      "unknown_target",
      "invalid_worker_travel",
      "conflicting_payload",
      "stale_control_revision",
    ],
    resumableSnapshotsVerified: [
      {
        stage: "before_effective_tick",
        snapshot: validatedDoc1.snapshot,
        controlRevision: validatedDoc1.state.position.controlRevision,
      },
      {
        stage: "after_post_move_walks_and_host_restore",
        snapshot: validatedDoc2.snapshot,
        events: validatedDoc2.state.events.length,
      },
    ],
  };
  const reportPath = join(outputDir, "engine-journey-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(`Passed engine E2E journey -> ${reportPath}\n`);
}

await main();
