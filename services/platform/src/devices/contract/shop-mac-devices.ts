import type { DeviceView, VoiceEngineId } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationDatabase } from "../../database-handles";
import type { Env } from "../../env";
import type { OrganisationId } from "../../ids";
import { definePort } from "../../port";

/** A shop Mac as the Devices page and the agent's `device_read` see it. */
export type ShopMacDevice = Readonly<{
  view: Variant<DeviceView, "shop_mac">;
  /** The engine that a manager chose. The Mac changes to it after its download. */
  engineChoice: VoiceEngineId;
}>;

/**
 * The shop Macs of an Organisation. The voice surface keeps the Mac
 * records, and the Worker registers the implementation (`worker-ports.ts`).
 */
export type ShopMacDevices = Readonly<{
  /**
   * The shop's Macs that are not revoked. Only a member who may configure
   * the Organisation reads where a Mac is on the network.
   */
  readShopMacDevices(
    env: Env,
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    options: Readonly<{ mayReadNetwork: boolean; now: number }>,
  ): Promise<readonly ShopMacDevice[]>;
}>;

export const shopMacDevices = definePort<ShopMacDevices>("shop_mac_devices");
