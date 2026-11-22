import { runDeviceCommand } from "../../devices/commands";
import {
  listStoredSnapshots,
  snapshotsAreEnabled,
} from "../../devices/snapshots";
import { listDevices } from "../../devices/store";
import { readKitchenDeviceViews } from "../../devices/views";
import { shopMacDevices } from "../../devices/contract/shop-mac-devices";
import { normalizeUntrustedCommerceText } from "@purin-labs/agent-tools/context/untrusted-commerce-text";
import {
  DeviceRequestError,
  type DevicePauseRequest,
  type DeviceToolRead,
} from "./services";
import type { StaffPageToolReceipt } from "@purin-labs/agent-tools/catalog/types";
import { requireSessionExecution } from "@purin-labs/agent/actors/session-execution-admission";
import { digestCanonical } from "@purin-labs/authority/policy/index";
import { roleMayOperate } from "@purin-labs/tenancy/data/control-plane";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  liveDeviceMember,
  type ToolEffect,
  untrustedDeviceText,
} from "@purin-labs/tool-handlers/agent-tools/session-support";
import type { SessionToolContext } from "@purin-labs/agent/agent-tools/context";
import { readMemberRecord } from "@purin-labs/tool-handlers/agent-tools/member-record-read";

/**
 * The Devices page's list for the agent. A device's own words stay in fields
 * that the tool's description marks as untrusted, and they enter the turn only
 * after the information-flow boundary admits them.
 */
export function readDevicesForEmbeddedHarness(
  context: SessionToolContext,
): Promise<DeviceToolRead> {
  const { env, execution } = context;
  const { scope } = execution;
  return readMemberRecord(context, {
    source: "device_fleet",
    recordId: "devices",
    refusal: () =>
      new DeviceRequestError(
        "Only a member of this workspace can read its devices. Nothing was read. Tell the person.",
      ),
    read: async (member) => {
      const now = Date.now();
      const views = await readKitchenDeviceViews(env, scope, {
        mayReadFaultText: roleMayOperate(member.role),
        now,
      });
      const macs = await shopMacDevices
        .use()
        .readShopMacDevices(env, scope.database, scope.organisationId, {
          mayReadNetwork: false,
          now,
        });
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
      return value;
    },
  });
}

/**
 * When the cameras took a still image, and why. The image itself stays in the
 * Portal, because a picture of staff must not reach a model.
 */
export function readDeviceSnapshotsForEmbeddedHarness(
  context: SessionToolContext,
): Promise<
  Readonly<{
    snapshotsEnabled: boolean;
    snapshots: readonly Readonly<Record<string, unknown>>[];
  }>
> {
  const { scope } = context.execution;
  return readMemberRecord(context, {
    source: "device_fleet",
    recordId: "device-snapshots",
    mayRead: (member) => roleMayOperate(member.role),
    refusal: () =>
      new DeviceRequestError(
        "Camera snapshots need a person with the staff role or higher, and the person who asked does not have it now. Nothing was read. Tell the person.",
      ),
    read: async () => {
      const now = Date.now();
      const names = new Map(
        (await listDevices(scope.database, scope.organisationId)).map(
          (device) => [device.deviceId, device.name],
        ),
      );
      return {
        snapshotsEnabled: await snapshotsAreEnabled(
          scope.database,
          scope.organisationId,
        ),
        snapshots: (
          await listStoredSnapshots(
            scope.database,
            scope.organisationId,
            null,
            now,
          )
        ).map((snapshot) => ({
          deviceId: snapshot.deviceId,
          deviceName: names.get(snapshot.deviceId) ?? null,
          reason: snapshot.reason,
          takenAt: snapshot.storedAt ?? snapshot.createdAt,
        })),
      };
    },
  });
}

export async function pauseDeviceForEmbeddedHarness(
  context: SessionToolContext,
  request: DevicePauseRequest,
  operationId: string,
): Promise<ToolEffect<StaffPageToolReceipt>> {
  const { env, execution, lease } = context;
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
  return {
    kind: "effect",
    label: {
      source: "turn",
      unavailable: "device pause information-flow authority unavailable",
    },
    sink: {
      kind: "tool_effect" as const,
      destinationAuthority: lease.requestAuthority,
      capabilityId: CAPABILITY_KEYS.devicePause,
      integrationAccountId: "platform",
      resourceScope: `device:${request.deviceId}`,
      approvalSatisfied: false,
    },
    action: { operation: "device.pause", arguments: request },
    refusal: (decision) => `Device pause is not authorized: ${decision}`,
    run: async () => {
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
    },
  };
}
