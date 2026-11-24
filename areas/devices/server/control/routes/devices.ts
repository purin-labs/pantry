import { currentGrantedCapabilityIds } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { CAPABILITY_KEYS } from "@purin-labs/authority/authorization/capability-catalogue";
import {
  mailControlAuthority,
} from "@purin-labs/area-inbox-contract/server/control-authority";
import {
  parseDeviceAlertSetting,
  parseDeviceStationId,
  type DeviceActivity,
  type DeviceAlertSetting,
  type DeviceConnection,
  type DeviceGatewayStart,
  type DeviceKind,
  type DeviceList,
  type DeviceSnapshotList,
  type DeviceStationId,
  type DeviceView,
} from "@purin-labs/control-api";
import { type MenuScreenSummary } from "@purin-labs/cafe-control-api";

import { type DeviceSample } from "../../actors/device-fleet";
import { deviceFleetStub } from "@purin-labs/area-devices-contract/server/fleet-stub";
import { roleMayConfigure, roleMayOperate } from "@purin-labs/tenancy/data/control-plane";
import { cafeServices } from "@purin-labs/area-cafe-contract/server/cafe-services";
import {
  DEVICE_COMMAND_ROLE,
  runDeviceCommand,
  type DeviceCommand,
} from "../../commands";
import {
  listStoredSnapshots,
  readStoredSnapshot,
  requestSnapshotFromPage,
  setSnapshotsEnabled,
  snapshotsAreEnabled,
} from "../../snapshots";
import {
  listDeviceEvents,
  readDevice,
  readDeviceAlertSetting,
  readGateway,
  startGatewayEnrollment,
  writeDeviceAlertSetting,
} from "../../store";
import {
  describeDeviceEvent,
  readKitchenDeviceViews,
} from "../../views";
import type { Env } from "@purin-labs/kernel/env";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { requirePublicOrigin } from "@purin-labs/kernel/public-origin";
import { shopMacDevices } from "../../contract/shop-mac-devices";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "@purin-labs/control/worker/authorization";
import { controlError, controlJson, readJsonRecord } from "@purin-labs/control/worker/http";

/**
 * The Devices page's routes (Plan 85):
 *
 *   GET  …/devices                      every device (viewer)
 *   GET  …/devices/alert-settings       shop hours and delay (viewer)
 *   PUT  …/devices/alert-settings       (admin)
 *   POST …/devices/gateways             start a gateway enrollment (admin)
 *   PUT  …/devices/camera-policy        turn snapshots on or off (admin)
 *   POST …/devices/:id/snapshot         ask a camera for one image (with access)
 *   GET  …/devices/:id/snapshots        a camera's images (with access)
 *   GET  …/devices/snapshots/:id        one image (with access)
 *   GET  …/devices/:id/activity         state changes and samples (operator)
 *   POST …/devices/:id/:command         one action, by its own role
 *
 * Menu screens, shop Macs and payment terminals keep their own routes for
 * changes. When one kind cannot be read, the others still answer and the list
 * names the kind that is missing.
 */
export type DeviceControlRoute = Readonly<{
  kind: "devices";
  organisationIdRaw: string;
  target:
    | Readonly<{ kind: "list" }>
    | Readonly<{ kind: "alert_settings" }>
    | Readonly<{ kind: "gateways" }>
    | Readonly<{ kind: "camera_policy" }>
    | Readonly<{ kind: "snapshot_image"; snapshotId: string }>
    | Readonly<{ kind: "snapshot_request"; subjectId: string }>
    | Readonly<{ kind: "snapshot_list"; subjectId: string }>
    | Readonly<{ kind: "activity"; subjectId: string }>
    | Readonly<{ kind: "command"; subjectId: string; command: string }>;
}>;

const SUBJECT_ID = "(?:dgw|dev)_[a-f0-9]{24}";
const NAME_LIMIT = 120;
const REASON_LIMIT = 200;
const LOCATION_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u;
const ACTIVITY_EVENTS = 50;
const ACTIVITY_SAMPLES = 30;

export function matchDeviceControlRoute(
  pathname: string,
): DeviceControlRoute | null {
  const match = new RegExp(
    `^/v1/control/organisations/([^/]+)/devices(?:/(alert-settings|gateways|camera-policy)|/snapshots/(dsn_[a-f0-9]{24})|/(${SUBJECT_ID})/([a-z]+))?$`,
    "u",
  ).exec(pathname);
  if (match === null) return null;
  const organisationIdRaw = decodeURIComponent(match[1] ?? "");
  const named = match[2];
  const snapshotId = match[3];
  const subjectId = match[4];
  const verb = match[5];
  if (snapshotId !== undefined)
    return {
      kind: "devices",
      organisationIdRaw,
      target: { kind: "snapshot_image", snapshotId },
    };
  if (named === "camera-policy")
    return {
      kind: "devices",
      organisationIdRaw,
      target: { kind: "camera_policy" },
    };
  if (named === "alert-settings")
    return {
      kind: "devices",
      organisationIdRaw,
      target: { kind: "alert_settings" },
    };
  if (named === "gateways")
    return { kind: "devices", organisationIdRaw, target: { kind: "gateways" } };
  if (subjectId !== undefined && verb !== undefined)
    return {
      kind: "devices",
      organisationIdRaw,
      target:
        verb === "activity"
          ? { kind: "activity", subjectId }
          : verb === "snapshot"
            ? { kind: "snapshot_request", subjectId }
            : verb === "snapshots"
              ? { kind: "snapshot_list", subjectId }
              : { kind: "command", subjectId, command: verb },
    };
  return { kind: "devices", organisationIdRaw, target: { kind: "list" } };
}

export async function handleDeviceControlRoute(
  request: Request,
  env: Env,
  route: DeviceControlRoute,
): Promise<Response> {
  const { target, organisationIdRaw } = route;
  const authorize = (
    role: "viewer" | "operator" | "admin",
    mutation: boolean,
  ) =>
    authorizeOrganisationRequest(
      request,
      env,
      organisationIdRaw,
      role,
      mutation,
    );
  switch (target.kind) {
    case "list": {
      if (request.method !== "GET")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("viewer", false);
      return authorized.ok ? readList(env, authorized) : authorized.response;
    }
    case "alert_settings": {
      if (request.method === "GET") {
        const authorized = await authorize("viewer", false);
        if (!authorized.ok) return authorized.response;
        return controlJson({
          ok: true,
          setting: await readDeviceAlertSetting(
            authorized.executionScope.database,
            authorized.organisationId,
          ),
        });
      }
      if (request.method !== "PUT")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("admin", true);
      return authorized.ok
        ? putAlertSetting(request, authorized)
        : authorized.response;
    }
    case "gateways": {
      if (request.method !== "POST")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("admin", true);
      return authorized.ok
        ? startGateway(request, env, authorized)
        : authorized.response;
    }
    case "camera_policy": {
      if (request.method !== "PUT")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("admin", true);
      if (!authorized.ok) return authorized.response;
      const body = await readJsonRecord(request);
      if (!body.ok || typeof body.value.enabled !== "boolean")
        return controlError("device_camera_policy_invalid", 422);
      await setSnapshotsEnabled(authorized.executionScope.database, {
        organisationId: authorized.organisationId,
        enabled: body.value.enabled,
        actor: { kind: "person", id: authorized.authenticated.session.userId },
        now: Date.now(),
      });
      return controlJson({ ok: true, enabled: body.value.enabled });
    }
    case "snapshot_request": {
      if (request.method !== "POST")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("operator", true);
      return authorized.ok
        ? askSnapshot(env, authorized, target.subjectId)
        : authorized.response;
    }
    case "snapshot_list": {
      if (request.method !== "GET")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("operator", false);
      return authorized.ok
        ? listSnapshots(authorized, target.subjectId)
        : authorized.response;
    }
    case "snapshot_image": {
      if (request.method !== "GET")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("operator", false);
      return authorized.ok
        ? readSnapshotImage(env, authorized, target.snapshotId)
        : authorized.response;
    }
    case "activity": {
      if (request.method !== "GET")
        return controlError("method_not_allowed", 405);
      const authorized = await authorize("operator", false);
      return authorized.ok
        ? readActivity(env, authorized, target.subjectId)
        : authorized.response;
    }
    case "command": {
      if (request.method !== "POST")
        return controlError("method_not_allowed", 405);
      const verb = target.command;
      if (!isCommandKind(verb)) return controlError("not_found", 404);
      const role = DEVICE_COMMAND_ROLE[verb];
      const authorized = await authorize(
        role === "admin" ? "admin" : "operator",
        true,
      );
      return authorized.ok
        ? runCommand(request, env, authorized, target.subjectId, verb)
        : authorized.response;
    }
  }
}

/**
 * An admin or an owner may see snapshots. An operator needs a grant on
 * `device.camera.read`, and the Organisation must have that capability on, so
 * an admin can remove the access in one place.
 */
async function mayReadSnapshots(
  authorized: AuthorizedOrganisationRequest,
): Promise<boolean> {
  if (roleMayConfigure(authorized.membership.role)) return true;
  const requestAuthority = await mailControlAuthority(authorized);
  if (requestAuthority === null) return false;
  const granted = await currentGrantedCapabilityIds({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    requestAuthority,
  });
  return granted.ok && granted.value.has(CAPABILITY_KEYS.deviceCameraRead);
}

function snapshotAccessRefused(): Response {
  return controlError("device_camera_access_needed", 403);
}

async function askSnapshot(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  deviceId: string,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await mayReadSnapshots(authorized))) return snapshotAccessRefused();
  const device = await readDevice(db, authorized.organisationId, deviceId);
  if (device === null) return controlError("device_not_found", 404);
  const result = await requestSnapshotFromPage(env, authorized.executionScope, {
    device,
    actor: { kind: "person", id: authorized.authenticated.session.userId },
    now: Date.now(),
  });
  return result.ok
    ? controlJson({ ok: true, snapshotId: result.snapshotId }, 202)
    : controlError(result.code, 409);
}

async function listSnapshots(
  authorized: AuthorizedOrganisationRequest,
  deviceId: string,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await mayReadSnapshots(authorized))) return snapshotAccessRefused();
  const snapshots = await listStoredSnapshots(
    db,
    authorized.organisationId,
    deviceId,
    Date.now(),
  );
  return controlJson({
    ok: true,
    snapshots: snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      reason: snapshot.reason,
      takenAt: snapshot.storedAt ?? snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    })),
  } satisfies DeviceSnapshotList);
}

async function readSnapshotImage(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  snapshotId: string,
): Promise<Response> {
  const db = authorized.executionScope.database;
  if (!(await mayReadSnapshots(authorized))) return snapshotAccessRefused();
  const snapshot = await readStoredSnapshot(
    db,
    authorized.organisationId,
    snapshotId,
    Date.now(),
  );
  if (snapshot === null) return controlError("device_snapshot_not_found", 404);
  const object = await env.ARCHIVE.get(snapshot.objectKey);
  if (object === null) return controlError("device_snapshot_not_found", 404);
  return new Response(object.body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isCommandKind(value: string): value is DeviceCommand["kind"] {
  return Object.hasOwn(DEVICE_COMMAND_ROLE, value);
}

async function runCommand(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  subjectId: string,
  kind: DeviceCommand["kind"],
): Promise<Response> {
  const body = await readJsonRecord(request);
  const fields = body.ok ? body.value : {};
  const command = commandFrom(kind, fields);
  if (command === null) return controlError("device_command_invalid", 422);
  const key = request.headers.get("idempotency-key");
  const result = await runDeviceCommand({
    env,
    scope: authorized.executionScope,
    subjectId,
    command,
    actor: { kind: "person", id: authorized.authenticated.session.userId },
    idempotencyKey:
      key === null ? null : `${kind}:${subjectId}:${key.slice(0, 128)}`,
    now: Date.now(),
  });
  if (!result.ok)
    return controlError(
      result.code,
      result.code === "device_not_found" ? 404 : 409,
    );
  return controlJson({
    ok: true,
    receiptId: result.receiptId,
    replayed: result.replayed,
  });
}

function commandFrom(
  kind: DeviceCommand["kind"],
  fields: Readonly<Record<string, unknown>>,
): DeviceCommand | null {
  switch (kind) {
    case "confirm": {
      const name = cleanName(fields.name);
      const stationId = stationOf(fields.stationId);
      return name === null || stationId === null
        ? null
        : { kind, name, stationId };
    }
    case "rename": {
      const name = cleanName(fields.name);
      return name === null ? null : { kind, name };
    }
    case "move": {
      const stationId = stationOf(fields.stationId);
      return stationId === null ? null : { kind, stationId };
    }
    case "restrict": {
      const reason =
        typeof fields.reason === "string" ? fields.reason.trim() : "";
      return reason.length === 0 || reason.length > REASON_LIMIT
        ? null
        : { kind, reason };
    }
    case "lift":
    case "pause":
    case "resume":
    case "settle":
    case "revoke":
      return { kind };
  }
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name.length === 0 || name.length > NAME_LIMIT ? null : name;
}

function stationOf(raw: unknown): DeviceStationId | null {
  return parseDeviceStationId(raw);
}

async function startGateway(
  request: Request,
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const body = await readJsonRecord(request);
  const fields = body.ok ? body.value : {};
  const name = cleanName(fields.name);
  const locationId =
    typeof fields.locationId === "string" ? fields.locationId.trim() : "";
  if (name === null || !LOCATION_PATTERN.test(locationId))
    return controlError("device_gateway_invalid", 422);
  const started = await startGatewayEnrollment(
    authorized.executionScope.database,
    {
      organisationId: authorized.organisationId,
      locationId,
      name,
      userId: authorized.authenticated.session.userId,
      now: Date.now(),
    },
  );
  const origin = requirePublicOrigin(env.PANTRY_PUBLIC_ORIGIN);
  return controlJson(
    {
      ok: true,
      gatewayId: started.gatewayId,
      code: started.code,
      expiresAt: started.expiresAt,
      installCommand: `curl -fsSL ${origin}/shop-gateway/install.sh | sh -s -- --url ${origin} --organisation ${authorized.organisationId} --gateway ${started.gatewayId} --code ${started.code}`,
    } satisfies DeviceGatewayStart,
    201,
  );
}

async function putAlertSetting(
  request: Request,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const body = await readJsonRecord(request);
  const setting: DeviceAlertSetting | null = body.ok
    ? parseDeviceAlertSetting(body.value)
    : null;
  if (setting === null || !isTimeZone(setting.timeZone))
    return controlError("device_alert_setting_invalid", 422);
  await writeDeviceAlertSetting(
    authorized.executionScope.database,
    authorized.organisationId,
    setting,
    Date.now(),
  );
  return controlJson({ ok: true, setting });
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

async function readActivity(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  subjectId: string,
): Promise<Response> {
  const db = authorized.executionScope.database;
  const { organisationId } = authorized;
  let samples: readonly DeviceSample[] = [];
  if (subjectId.startsWith("dev_")) {
    const device = await readDevice(db, organisationId, subjectId);
    if (device === null) return controlError("device_not_found", 404);
    const gateway = await readGateway(db, organisationId, device.gatewayId);
    if (gateway !== null)
      samples =
        (await deviceFleetStub(
          env,
          authorized.executionScope,
          gateway.locationId,
        )
          ?.samples(device.gatewayId, device.sourceKey, ACTIVITY_SAMPLES)
          .catch(() => [])) ?? [];
  } else if ((await readGateway(db, organisationId, subjectId)) === null) {
    return controlError("device_not_found", 404);
  }
  const events = await listDeviceEvents(
    db,
    organisationId,
    subjectId,
    ACTIVITY_EVENTS,
  );
  return controlJson({
    ok: true,
    events: events.map((event) => ({
      eventId: event.eventId,
      kind: event.kind,
      actorKind: event.actorKind,
      text: describeDeviceEvent(event),
      createdAt: event.createdAt,
    })),
    samples: [...samples],
  } satisfies DeviceActivity);
}

async function readList(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<Response> {
  const requestId = newRequestId();
  const now = Date.now();
  const reads = await Promise.allSettled([
    readScreens(env, authorized),
    readMacs(env, authorized, now),
    readTerminals(authorized, now),
    readKitchen(env, authorized, now),
  ]);
  const kinds: readonly (readonly DeviceKind[])[] = [
    ["menu_screen"],
    ["shop_mac"],
    ["payment_terminal"],
    ["gateway", "kitchen_device"],
  ];
  const devices: DeviceView[] = [];
  const unavailableKinds: DeviceKind[] = [];
  reads.forEach((read, index) => {
    const named = kinds[index] ?? [];
    if (read.status === "fulfilled") devices.push(...read.value.devices);
    if (read.status === "fulfilled" && read.value.complete) return;
    unavailableKinds.push(...named);
    traceWarn("control.device_read_failed", {
      requestId,
      organisationId: authorized.organisationId,
      kinds: named,
    });
  });
  const locations = new Set<string>();
  for (const device of devices) {
    if (device.kind === "gateway") locations.add(device.locationId);
    if (device.kind === "payment_terminal") locations.add(device.name);
  }
  return controlJson({
    ok: true,
    devices,
    unavailableKinds,
    locations: [...locations],
    snapshotsEnabled: await snapshotsAreEnabled(
      authorized.executionScope.database,
      authorized.organisationId,
    ).catch(() => false),
  } satisfies DeviceList);
}

type DeviceRead = Readonly<{
  devices: readonly DeviceView[];
  complete: boolean;
}>;

async function readKitchen(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  now: number,
): Promise<DeviceRead> {
  const views = await readKitchenDeviceViews(env, authorized.executionScope, {
    mayReadFaultText: roleMayOperate(authorized.membership.role),
    now,
  });
  return { devices: [...views.gateways, ...views.devices], complete: true };
}

async function readScreens(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
): Promise<DeviceRead> {
  const screens = await cafeServices
    .use()
    .readMenuScreenList(env, authorized);
  return screens === null
    ? { devices: [], complete: false }
    : { devices: screens.map(screenView), complete: true };
}

function screenView(screen: MenuScreenSummary): DeviceView {
  const connection: DeviceConnection =
    screen.lastSeenAt === null
      ? { state: "never_connected" }
      : screen.connected
        ? { state: "connected", lastHeardAt: screen.lastSeenAt }
        : { state: "offline", lastHeardAt: screen.lastSeenAt };
  return {
    kind: "menu_screen",
    deviceId: screen.screenId,
    name: screen.name,
    connection,
    needsAttention: connection.state !== "connected",
    pairedAt: screen.pairedAt,
  };
}

async function readMacs(
  env: Env,
  authorized: AuthorizedOrganisationRequest,
  now: number,
): Promise<DeviceRead> {
  const macs = await shopMacDevices.use().readShopMacDevices(
    env,
    authorized.executionScope.database,
    authorized.organisationId,
    { mayReadNetwork: roleMayConfigure(authorized.membership.role), now },
  );
  return { devices: macs.map((mac) => mac.view), complete: true };
}

async function readTerminals(
  authorized: AuthorizedOrganisationRequest,
  now: number,
): Promise<DeviceRead> {
  // This page does not use `paymentsLinked`, so it makes no Commerce call.
  const operations = await cafeServices.use().readTerminalOperations({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    now,
    linkedLocationIds: new Set(),
  });
  return {
    devices: operations.counters.map((counter) => ({
      kind: "payment_terminal",
      deviceId: counter.assignment.assignmentId,
      name: counter.pantryLocationId,
      connection: { state: "managed_by_provider" },
      needsAttention:
        counter.blockedReason !== null || counter.credentialHealth !== "active",
      simulated: counter.assignment.targetKind === "sandbox_simulated",
      blocked: counter.blockedReason !== null,
      credentialHealth: counter.credentialHealth,
    })),
    complete: operations.unreadableAssignments === 0,
  };
}
