import {
  compileProcedure,
  parseProcedureAssumptions,
} from "@purin-labs/bakery-model/bakery-procedure";
import {
  bakeryFingerprint,
  sampleSettings,
} from "@purin-labs/bakery-model/bakery";
import { parseScenarioCopy } from "@purin-labs/bakery-model/bakery-scenario";
import assert from "node:assert/strict";
import { test } from "node:test";
import { operationForRun, runProcedure } from "@purin-labs/production-simulation/simulator/procedure";
import { simulate } from "@purin-labs/production-simulation/recipes/bakery/schedule";

function entity(typeId, entityId, values) {
  const attributes = [];
  for (const [attributeId, value] of Object.entries(values))
    attributes.push({
      attributeId,
      scope: { kind: "custom", entityTypeId: typeId, typeRevision: 1 },
      definitionRevision: 1,
      sensitivity: "internal",
      value:
        typeof value === "number"
          ? { kind: "integer", value: BigInt(value) }
          : { kind: "short_text", value },
    });
  return {
    reference: { origin: "custom", typeId, entityId },
    revision: 1,
    typeRevision: 1,
    displayName: entityId,
    state: { state: "active" },
    sensitivity: "internal",
    attributes,
  };
}
function edge(snapshot, definitionId, source, target) {
  snapshot.relationships.push({
    origin: "custom",
    relationshipId: `edge-${snapshot.relationships.length}`,
    definition: { origin: "custom", definitionId, revision: 1 },
    source: source.reference,
    target: target.reference,
    revision: 1,
    sensitivity: "internal",
  });
}
function fixture() {
  const settings = sampleSettings(),
    snapshot = {
      revision: 7,
      procedure: entity("bakery_procedure", "financier", {}),
      operations: [],
      equipment: [],
      relationships: [],
    };
  for (const station of ["stage", "portion", "bake", "cool", "pack"])
    snapshot.equipment.push(
      entity("bakery_equipment", `equipment-${station}`, {
        station,
        capacity_trays: station === "cool" ? 8 : 4,
      }),
    );
  for (const operation of [
    "stage",
    "portion",
    "bake",
    "cool",
    "demould",
    "finishCooling",
    "pack",
  ]) {
    const item = entity("bakery_operation", `operation-${operation}`, {
      operation,
      minutes: settings[operation],
    });
    snapshot.operations.push(item);
    edge(snapshot, "bakery_procedure_operation", snapshot.procedure, item);
    edge(
      snapshot,
      "bakery_operation_equipment",
      item,
      snapshot.equipment.find(
        equipmentFor.bind(
          null,
          operation === "demould" || operation === "finishCooling"
            ? "cool"
            : operation,
        ),
      ),
    );
    if (snapshot.operations.length > 1)
      edge(snapshot, "bakery_operation_next", snapshot.operations.at(-2), item);
  }
  return snapshot;
}
function equipmentFor(station, item) {
  return item.reference.entityId === `equipment-${station}`;
}

test(
  "entity-backed procedure produces the same schedule and preserves observation identities",
  checkProcedure,
);
function checkProcedure() {
  const snapshot = fixture(),
    result = compileProcedure(snapshot, sampleSettings());
  assert.equal(result.kind, "ready");
  const run = runProcedure(result.procedure, "normal");
  assert.deepEqual(run.schedule, simulate(sampleSettings(), "normal"));
  assert.equal(run.source.snapshotRevision, 7);
  assert.equal(
    operationForRun(run, "bake").equipment.entityId,
    "equipment-bake",
  );
  assert.equal(
    operationForRun(run, "demould").equipment.entityId,
    "equipment-cool",
  );
  snapshot.operations[2].attributes[1].value.value = 60n;
  snapshot.operations[2].reference.entityId = "changed-after-run";
  assert.equal(run.source.operations[2].minutes, 16);
  assert.equal(
    operationForRun(run, "bake").reference.entityId,
    "operation-bake",
  );
  const updated = compileProcedure(fixtureWithLongBake(), sampleSettings());
  assert.equal(updated.kind, "ready");
  assert.ok(
    runProcedure(updated.procedure, "normal").schedule.end > run.schedule.end,
  );
}
function fixtureWithLongBake() {
  const snapshot = fixture();
  snapshot.operations[2].attributes[1].value.value = 30n;
  return snapshot;
}

test(
  "scenario assumptions preserve the procedure and replay changed staffing from saved inputs",
  checkAssumptions,
);
async function checkAssumptions() {
  const source = compileProcedure(fixture(), sampleSettings());
  assert.equal(source.kind, "ready");
  const raw = {
    workerCount: "3",
    horizonMinutes: "120",
    outageStart: "20",
    outageEnd: "45",
    bake: "60",
    ovenTrays: "1",
    batchCount: "6",
  };
  const changed = parseProcedureAssumptions(source.procedure, raw);
  assert.equal(changed.kind, "valid");
  assert.equal(changed.procedure.reference, source.procedure.reference);
  assert.equal(changed.procedure.operations, source.procedure.operations);
  assert.equal(
    changed.procedure.snapshotRevision,
    source.procedure.snapshotRevision,
  );
  assert.equal(changed.procedure.revisionKey, source.procedure.revisionKey);
  assert.equal(changed.procedure.settings.bake, 16);
  assert.equal(changed.procedure.settings.ovenTrays, 4);
  assert.equal(changed.procedure.settings.batchCount, 3);
  assert.equal(source.procedure.settings.workerCount, 2);
  assert.equal(changed.procedure.settings.workerCount, 3);
  assert.ok(
    runProcedure(changed.procedure, "normal").schedule.end <
      runProcedure(source.procedure, "normal").schedule.end,
  );
  const fingerprint = await bakeryFingerprint(changed.procedure.revisionKey);
  const copy = parseScenarioCopy(
    JSON.parse(
      JSON.stringify({
        id: "two-worker-shift",
        name: "Two workers",
        note: "Assumed timings, pending calibration",
        procedureId: changed.procedure.reference.entityId,
        fingerprint,
        settings: changed.procedure.settings,
      }),
    ),
  );
  assert.ok(copy);
  const reloaded = compileProcedure(fixture(), copy.settings);
  assert.equal(reloaded.kind, "ready");
  assert.equal(
    await bakeryFingerprint(reloaded.procedure.revisionKey),
    copy.fingerprint,
  );
  for (const variant of ["normal", "outage"])
    assert.deepEqual(
      runProcedure(reloaded.procedure, variant),
      runProcedure(changed.procedure, variant),
    );
  for (const invalid of [
    { ...raw, workerCount: "" },
    { ...raw, workerCount: "4" },
    { ...raw, outageEnd: "19" },
    { ...raw, horizonMinutes: "30" },
  ]) {
    const result = parseProcedureAssumptions(source.procedure, invalid);
    assert.equal(result.kind, "invalid");
    assert.ok(result.field);
    assert.equal(result.procedure, undefined);
  }
  assert.equal(source.procedure.settings.outageEnd, 30);
}

test(
  "incomplete, branched, incompatible and duplicate entity graphs cannot run",
  checkInvalidGraphs,
);
function checkInvalidGraphs() {
  for (const change of [
    missingConnection,
    extraConnection,
    wrongEquipment,
    duplicateOperation,
    duplicateAttribute,
    wrongAttributeScope,
    archivedEquipment,
    tinyEquipment,
    unknownOperation,
  ]) {
    const snapshot = fixture();
    change(snapshot);
    const result = compileProcedure(snapshot, sampleSettings());
    assert.equal(result.kind, "invalid", change.name);
    assert.ok(result.message.length > 0);
  }
}
function missingConnection(snapshot) {
  snapshot.relationships.pop();
}
function extraConnection(snapshot) {
  edge(
    snapshot,
    "bakery_operation_next",
    snapshot.operations[0],
    snapshot.operations[4],
  );
}
function wrongEquipment(snapshot) {
  snapshot.relationships[1].target = snapshot.equipment[2].reference;
}
function duplicateOperation(snapshot) {
  snapshot.operations[1] = snapshot.operations[0];
}
function duplicateAttribute(snapshot) {
  snapshot.operations[0].attributes.push(snapshot.operations[0].attributes[1]);
}
function wrongAttributeScope(snapshot) {
  snapshot.operations[0].attributes[1].scope.entityTypeId = "unrelated";
}
function archivedEquipment(snapshot) {
  snapshot.equipment[0].state = {
    state: "archived",
    archivedAt: "2026-09-08T00:00:00Z",
  };
}
function tinyEquipment(snapshot) {
  snapshot.equipment[0].attributes[1].value.value = 1n;
}
function unknownOperation(snapshot) {
  snapshot.operations[0].attributes[0].value.value = "fry";
}
