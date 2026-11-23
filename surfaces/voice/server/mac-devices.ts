import type { DeviceConnection, DeviceView } from "@purin-labs/control-api";

import type { ShopMacDevice } from "@purin-labs/area-devices/server/contract/shop-mac-devices";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { voiceMacHostname } from "./dns";
import { listVoiceMacs, MAC_HEARTBEAT_FRESH_MS, type VoiceMac } from "./store";
import type { Variant } from "@purin-labs/type-utils";

type ShopMacDeviceView = Variant<DeviceView, "shop_mac">;

/**
 * The shop's Macs that are not revoked. Only a member who may configure the
 * Organisation reads where a Mac is on the network.
 */
export async function readShopMacDevices(
  env: Env,
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  options: Readonly<{ mayReadNetwork: boolean; now: number }>,
): Promise<readonly ShopMacDevice[]> {
  const macs = await listVoiceMacs(db, organisationId);
  return macs.flatMap((mac) =>
    mac.state === "revoked"
      ? []
      : [
          {
            view: shopMacView(env, mac, options.mayReadNetwork, options.now),
            engineChoice: mac.engineChoice,
          },
        ],
  );
}

function shopMacView(
  env: Env,
  mac: VoiceMac,
  mayReadNetwork: boolean,
  now: number,
): ShopMacDeviceView {
  const enrollment = mac.state === "pending" ? "pending" : "enrolled";
  const connection: DeviceConnection =
    mac.lastHeartbeatAt === null
      ? { state: "never_connected" }
      : now - mac.lastHeartbeatAt <= MAC_HEARTBEAT_FRESH_MS
        ? { state: "connected", lastHeardAt: mac.lastHeartbeatAt }
        : { state: "offline", lastHeardAt: mac.lastHeartbeatAt };
  const hostname = mayReadNetwork ? voiceMacHostname(env, mac.nameId) : null;
  return {
    kind: "shop_mac",
    deviceId: mac.macId,
    name: `Shop Mac ${mac.macId.slice(-4)}`,
    connection,
    needsAttention:
      enrollment === "enrolled" && connection.state !== "connected",
    enrollment,
    serviceVersion: mac.serviceVersion,
    modelState: mac.modelState,
    engine: mac.engine,
    network:
      hostname === null
        ? null
        : { hostname, privateAddress: mac.privateAddress },
  };
}
