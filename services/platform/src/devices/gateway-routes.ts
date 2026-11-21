import {
  parseDeviceGatewayEnrollRequest,
  type DeviceGatewayEnrollResponse,
} from "@purin-labs/control-api";

import { deviceFleetStub } from "./contract/fleet-stub";
import { controlError, controlJson } from "../control/http";
import type { Env } from "../env";
import { parseOrganisationId } from "../ids";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import {
  SNAPSHOT_BYTE_LIMIT,
  readPendingSnapshot,
  recordStoredSnapshot,
  snapshotsAreEnabled,
} from "./snapshots";
import {
  completeGatewayEnrollment,
  readDevice,
  readGatewayByCredential,
  type GatewayRecord,
} from "./store";

/**
 * The routes of a shop gateway (Plan 85), with no Portal session:
 *
 *   POST /v1/device-gateways/enroll   the one-time code, for a credential
 *   GET  /v1/device-gateways/socket   the gateway's one outbound socket
 *   POST /v1/device-gateways/snapshots/:id   one image that Pantry asked for
 *
 * The credential can do only these things. The Platform never calls the
 * gateway. It answers on the socket that the gateway opened.
 */
export async function handleDeviceGatewayRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const route = new URL(request.url).pathname.slice(
    "/v1/device-gateways/".length,
  );
  if (route === "enroll")
    return request.method === "POST"
      ? enroll(request, env)
      : controlError("method_not_allowed", 405);
  if (route === "socket")
    return request.method === "GET"
      ? openSocket(request, env)
      : controlError("method_not_allowed", 405);
  if (route.startsWith("snapshots/"))
    return request.method === "POST"
      ? receiveSnapshot(request, env, route.slice("snapshots/".length))
      : controlError("method_not_allowed", 405);
  return controlError("not_found", 404);
}

/** A JPEG starts with these bytes. Nothing else enters the store. */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function receiveSnapshot(
  request: Request,
  env: Env,
  snapshotId: string,
): Promise<Response> {
  const caller = await authenticate(request, env);
  if (caller === null) return controlError("device_gateway_refused", 401);
  const { scope, gateway } = caller;
  const now = Date.now();
  // Off also refuses an image that was on its way when an admin turned them off.
  const allowed = await snapshotsAreEnabled(
    scope.database,
    scope.organisationId,
  );
  const snapshot =
    allowed && /^dsn_[a-f0-9]{24}$/u.test(snapshotId)
      ? await readPendingSnapshot(
          scope.database,
          scope.organisationId,
          snapshotId,
          now,
        )
      : null;
  if (snapshot === null) return controlError("device_snapshot_not_found", 404);
  // A gateway answers only for its own camera.
  const device = await readDevice(
    scope.database,
    scope.organisationId,
    snapshot.deviceId,
  );
  if (device?.gatewayId !== gateway.gatewayId)
    return controlError("device_snapshot_not_found", 404);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > SNAPSHOT_BYTE_LIMIT)
    return controlError("device_snapshot_too_large", 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > SNAPSHOT_BYTE_LIMIT)
    return controlError("device_snapshot_too_large", 413);
  if (!isJpeg(bytes)) return controlError("device_snapshot_invalid", 415);
  await env.ARCHIVE.put(snapshot.objectKey, bytes, {
    httpMetadata: { contentType: "image/jpeg" },
  });
  await recordStoredSnapshot(
    scope.database,
    scope.organisationId,
    snapshot,
    bytes.byteLength,
    now,
  );
  return controlJson({ ok: true });
}

async function authenticate(
  request: Request,
  env: Env,
): Promise<Readonly<{
  scope: OrganisationExecutionScope;
  gateway: GatewayRecord;
}> | null> {
  const match =
    /^Bearer sgw1\.([A-Za-z0-9][A-Za-z0-9:_-]{0,127})\.(dgw_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get("authorization") ?? "",
    );
  if (match === null) return null;
  const organisationId = parseOrganisationId(match[1] ?? "");
  if (!organisationId.ok) return null;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) return null;
  const gateway = await readGatewayByCredential(scope.value.database, {
    organisationId: organisationId.value,
    gatewayId: match[2] ?? "",
    secret: match[3] ?? "",
  });
  return gateway === null ? null : { scope: scope.value, gateway };
}

async function enroll(request: Request, env: Env): Promise<Response> {
  const body = parseDeviceGatewayEnrollRequest(
    await request.json().catch(() => null),
  );
  if (body === null) return controlError("device_gateway_refused", 401);
  const organisationId = parseOrganisationId(body.organisationId);
  if (!organisationId.ok) return controlError("device_gateway_refused", 401);
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!scope.ok) return controlError("device_gateway_refused", 401);
  const secret = await completeGatewayEnrollment(scope.value.database, {
    organisationId: organisationId.value,
    gatewayId: body.gatewayId,
    code: body.code,
    now: Date.now(),
  });
  if (secret === null) return controlError("device_gateway_refused", 401);
  return controlJson({
    credential: `sgw1.${organisationId.value}.${body.gatewayId}.${secret}`,
  } satisfies DeviceGatewayEnrollResponse);
}

async function openSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return controlError("websocket_required", 426);
  const caller = await authenticate(request, env);
  if (caller === null) return controlError("device_gateway_refused", 401);
  const { scope, gateway } = caller;
  const stub = deviceFleetStub(env, scope, gateway.locationId);
  if (stub === null) return controlError("device_gateway_unavailable", 503);
  const headers = new Headers({
    Upgrade: "websocket",
    "x-pantry-device-gateway": gateway.gatewayId,
    "x-pantry-device-organisation": scope.organisationId,
    "x-pantry-device-location": gateway.locationId,
  });
  return stub.fetch(new Request(request.url, { headers }));
}
