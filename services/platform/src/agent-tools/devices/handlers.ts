import { runDeviceCommand } from "../../devices/commands";
import {
  listStoredSnapshots,
  snapshotsAreEnabled,
} from "../../devices/snapshots";
import { listDevices } from "../../devices/store";
import { readKitchenDeviceViews } from "../../devices/views";
import { readShopMacDevices } from "../../voice/mac-devices";
import { normalizeUntrustedCommerceText } from "../../context/untrusted-commerce-text";
import { acceptedExecutionAccountAuthority } from "../../account-platform/access";
import {
  DeviceRequestError,
  type DevicePauseRequest,
  type DeviceToolRead,
} from "./services";
import type { StaffPageToolReceipt } from "../catalog/types";
import { requireSessionExecution } from "../../actors/session-execution-admission";
import { admitSessionInformationFlowObservation } from "../../actors/agent-session-information-flow";
import {
  createCurrentSourceFlowLabel,
  decideContextAdmission,
  ObservationEvidence,
} from "../../policy";
import { digestCanonical } from "../../policy";
import { roleMayOperate } from "../../data/control-plane";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import {
  currentTurnFlowLabel,
  evaluateHarnessFlowSink,
  liveDeviceMember,
  toolEffectPassesExit,
  untrustedDeviceText,
} from "../session-support";
import type { SessionToolContext } from "../context";

/**
 * The Devices page's list for the agent. A device's own words stay in fields
 * that the tool's description marks as untrusted, and they enter the turn only
 * after the information-flow boundary admits them.
 */
export async function readDevicesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<DeviceToolRead> {
  const { env, storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null) {
    throw new DeviceRequestError(
      "Only a member of this workspace can read its devices. Nothing was read. Tell the person.",
    );
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "device_fleet",
    db: scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Device source policy unavailable");
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Device read context admission denied");
  }
  const now = Date.now();
  const views = await readKitchenDeviceViews(env, scope, {
    mayReadFaultText: roleMayOperate(member.role),
    now,
  });
  const macs = await readShopMacDevices(
    env,
    scope.database,
    scope.organisationId,
    { mayReadNetwork: false, now },
  );
  await requireSessionExecution(execution, lease);
  const value: DeviceToolRead = {
    gateways: views.gateways.map((gateway) => ({
      gatewayId: gateway.deviceId,
      name: untrustedDeviceText(gateway.name),
      enrollment: gateway.enrollment,
      connection: gateway.connection.state,
      needsAttention: gateway.needsAttention,
    })),
    devices: views.devices.map((device) => ({
      deviceId: device.deviceId,
      name: untrustedDeviceText(device.name),
      kind: device.hardware,
      model: untrustedDeviceText(device.model),
      station: device.stationId,
      enrollment: device.enrollment,
      readiness: device.readiness,
      connection: device.connection.state,
      health: device.health,
      faultCode: device.faultCode,
      deviceSaid:
        device.faultText === null
          ? null
          : normalizeUntrustedCommerceText(device.faultText, "note").text,
      paused: device.paused,
      pauseConfirmed: device.pauseConfirmed,
      work: device.work,
      needsAttention: device.needsAttention,
    })),
    // Atelier names each Mac, and the engine ids come from the catalogue, so a
    // row holds no text that the Mac wrote.
    shopMacs: macs.map(({ view, engineChoice }) => ({
      macId: view.deviceId,
      name: view.name,
      enrollment: view.enrollment,
      connection: view.connection.state,
      modelState: view.modelState,
      engine: view.engine,
      engineChoice,
      needsAttention: view.needsAttention,
    })),
  };
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: scope.organisationId,
      recordId: "devices",
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(value),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) {
    throw new Error("Device observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: label.value,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Device observation admission failed");
  }
  await requireSessionExecution(execution, lease);
  return value;
}

/**
 * When the cameras took a still image, and why. The image itself stays in the
 * Portal, because a picture of staff must not reach a model.
 */
export async function readDeviceSnapshotsForEmbeddedHarness(
  context: SessionToolContext,
): Promise<
  Readonly<{
    snapshotsEnabled: boolean;
    snapshots: readonly Readonly<Record<string, unknown>>[];
  }>
> {
  const { storage, execution, lease, assignment } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null || !roleMayOperate(member.role)) {
    throw new DeviceRequestError(
      "Camera snapshots need a person with the staff role or higher, and the person who asked does not have it now. Nothing was read. Tell the person.",
    );
  }
  const label = await createCurrentSourceFlowLabel({
    kind: "device_fleet",
    db: scope.database,
    authority: lease.requestAuthority,
  });
  if (!label.ok) {
    throw new Error("Device source policy unavailable");
  }
  const admission = await decideContextAdmission({
    subject: {
      kind: "authority_derived",
      requestAuthority: lease.requestAuthority,
      caseId: String(assignment.caseId),
    },
    inputLabel: label.value,
  });
  if (admission.kind !== "admit") {
    throw new Error("Device snapshot context admission denied");
  }
  const now = Date.now();
  const names = new Map(
    (await listDevices(scope.database, scope.organisationId)).map((device) => [
      device.deviceId,
      device.name,
    ]),
  );
  const value = {
    snapshotsEnabled: await snapshotsAreEnabled(
      scope.database,
      scope.organisationId,
    ),
    snapshots: (
      await listStoredSnapshots(scope.database, scope.organisationId, null, now)
    ).map((snapshot) => ({
      deviceId: snapshot.deviceId,
      deviceName: names.get(snapshot.deviceId) ?? null,
      reason: snapshot.reason,
      takenAt: snapshot.storedAt ?? snapshot.createdAt,
    })),
  };
  const evidence = await ObservationEvidence.create({
    source: {
      kind: "organisation_record",
      organisationId: scope.organisationId,
      recordId: "device-snapshots",
    },
    sourceRevision: now,
    contentDigest: await digestCanonical(value),
    inputLabel: label.value,
    observedAt: now,
  });
  if (!evidence.ok) {
    throw new Error("Device snapshot observation is invalid");
  }
  const admitted = await admitSessionInformationFlowObservation({
    authorizeCommit: requireSessionExecution.bind(null, execution, lease),
    sql: storage.sql,
    transactionSync: storage.transactionSync.bind(storage),
    organisationId: scope.organisationId,
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    authorityPartitionDigest: lease.authorityPartitionDigest,
    inputLabel: label.value,
    observation: evidence.value,
    observedAt: evidence.value.observedAt,
  });
  if (!admitted.ok) {
    throw new Error("Device snapshot observation admission failed");
  }
  await requireSessionExecution(execution, lease);
  return value;
}

export async function pauseDeviceForEmbeddedHarness(
  context: SessionToolContext,
  request: DevicePauseRequest,
  operationId: string,
): Promise<StaffPageToolReceipt> {
  const { env, storage, execution, lease } = context;
  await requireSessionExecution(execution, lease);
  const { scope } = execution;
  const member = await liveDeviceMember(
    scope.database,
    scope.organisationId,
    lease,
  );
  if (member === null || !roleMayOperate(member.role)) {
    throw new DeviceRequestError(
      "A pause needs a person with the staff role or higher, and the person who asked does not have it now. Nothing changed. Tell the person. Do not ask for a permission or retry.",
    );
  }
  const flowLabel = await currentTurnFlowLabel(
    storage,
    execution,
    lease,
    "device pause",
  );
  const sink = {
    kind: "tool_effect" as const,
    destinationAuthority: lease.requestAuthority,
    capabilityId: CAPABILITY_KEYS.devicePause,
    integrationAccountId: "platform",
    resourceScope: `device:${request.deviceId}`,
    approvalSatisfied: false,
  };
  const decision = await evaluateHarnessFlowSink(
    scope.database,
    scope.accountAccess,
    acceptedExecutionAccountAuthority(
      lease.session.sessionId,
      lease.turn.turnId,
    ),
    { flowLabel, sink },
  );
  if (
    !(await toolEffectPassesExit(env, execution, lease, {
      decision,
      flowLabel,
      sink,
      action: { operation: "device.pause", arguments: request },
    }))
  ) {
    throw new Error(`Device pause is not authorized: ${decision.kind}`);
  }
  const digest = await digestCanonical({
    sessionId: lease.session.sessionId,
    turnId: lease.turn.turnId,
    operationId,
    deviceId: request.deviceId,
  });
  const key = `agent_${digest.replace(/[^0-9a-f]/gu, "").slice(-40)}`;
  const result = await runDeviceCommand({
    env,
    scope,
    subjectId: request.deviceId,
    command: { kind: "pause" },
    actor: { kind: "agent", id: member.userId },
    idempotencyKey: key,
    now: Date.now(),
  });
  if (!result.ok) {
    throw new DeviceRequestError(
      result.code === "device_not_found"
        ? "That device does not exist. Nothing changed. Call device_read for the list."
        : "That device cannot pause now: it is already paused, not confirmed or revoked. Nothing changed. Call device_read to see it.",
    );
  }
  return {
    receiptId: result.receiptId,
    result:
      "New work on this device stopped, and its gateway has the request. A person resumes it. Emergency stop stays on the machine.",
  };
}
