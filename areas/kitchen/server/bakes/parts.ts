import type { DeviceReadiness } from "@purin-labs/control-api";
import type { InventoryQuantity } from "@purin-labs/area-commerce-contract/server/commerce-projection";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type { BakeRunRecord } from "@purin-labs/kitchen-control-api";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { BakeProposal } from "./records";
import type { BakeRunRunRecord } from "./run";

/**
 * The Devices records and the Work facts that a bake reads and changes
 * (`store.ts`, `views.ts` and `work.ts` of the devices area). A device
 * command goes through `deviceCommands` of the Devices contract.
 */
type BakeDevices = Readonly<{
  listGateways(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<
    readonly Readonly<{
      gatewayId: string;
      locationId: string;
      state: string;
    }>[]
  >;
  listDevices(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<
    readonly Readonly<{
      deviceId: string;
      gatewayId: string;
      sourceKey: string;
      name: string;
      enrollment: string;
      capabilities: readonly Readonly<{ id: string }>[];
    }>[]
  >;
  /** The live readiness of each device. */
  readKitchenDeviceViews(
    env: Env,
    scope: OrganisationExecutionScope,
    input: Readonly<{ mayReadFaultText: boolean; now: number }>,
  ): Promise<
    Readonly<{
      devices: readonly Readonly<{
        deviceId: string;
        readiness: DeviceReadiness;
      }>[];
    }>
  >;
  /** The active enrolled device with the capability at the location. */
  findActiveDeviceWithCapability(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
    input: Readonly<{ capabilityId: string; locationId: string }>,
  ): Promise<Readonly<{ deviceId: string; name: string }> | null>;
  reserveDeviceWork(
    env: Env,
    scope: OrganisationExecutionScope,
    input: Readonly<{
      deviceId: string;
      taskRef: string;
      runRef: string | null;
      label: string;
      now: number;
    }>,
  ): Promise<Readonly<{ ok: boolean }>>;
  changeDeviceWork(
    env: Env,
    scope: OrganisationExecutionScope,
    input: Readonly<{
      deviceId: string;
      taskRef: string;
      to: "idle";
      now: number;
    }>,
  ): Promise<boolean>;
}>;

/**
 * The counter stock of the commerce projection in the Organisation Actor's
 * storage (`commerce-projection/stock-changes.ts` of commerce).
 */
type BakeCounterStock = Readonly<{
  /** The available stock of an item at each of its positions. */
  readInventoryItemStock(
    sql: SqlStorage,
    organisationId: OrganisationId,
    inventoryItemId: string,
  ): readonly Readonly<{ locationId: string; available: InventoryQuantity }>[];
  /** The finished goods that Commerce counts in pieces, with their stock. */
  listCountedProducts(
    sql: SqlStorage,
    organisationId: OrganisationId,
  ): readonly Readonly<{
    inventoryItemId: string;
    name: string;
    counterPieces: number | null;
  }>[];
  /** Pieces of a quantity counted in `each`; null for any other unit. */
  pieceCount(quantity: InventoryQuantity): number | null;
}>;

/** The Slack cards of a proposal and of its run, in the proposal's thread. */
type BakeNotices = Readonly<{
  announceProposal(
    env: Env,
    scope: OrganisationExecutionScope,
    proposal: BakeProposal,
    now: number,
  ): Promise<void>;
  announceRun(
    env: Env,
    scope: OrganisationExecutionScope,
    record: BakeRunRunRecord,
    revision: number,
    now: number,
  ): Promise<void>;
  tellOverBake(
    env: Env,
    scope: OrganisationExecutionScope,
    record: BakeRunRunRecord,
    risk: NonNullable<BakeRunRecord["unloadRisk"]>,
    now: number,
  ): Promise<void>;
}>;

/**
 * What a bake (Plan 24) needs from the owners that Kitchen does not import:
 * the Devices records, the counter stock of the commerce projection and the
 * Slack cards. The Worker registers the implementations (`worker-ports.ts`).
 */
export type BakeParts = Readonly<{
  devices: BakeDevices;
  counterStock: BakeCounterStock;
  notices: BakeNotices;
}>;

export const bakeParts = definePort<BakeParts>("bake_parts");
