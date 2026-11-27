import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";

export type DeviceEnrollmentState =
  "pending" | "active" | "restricted" | "revoked";

/** One enrolled device, by the name that a person gave it. */
type DeviceListing = Readonly<{
  name: string;
  enrollment: DeviceEnrollmentState;
}>;

/**
 * The devices of an Organisation that the voice surface names in the shop
 * vocabulary. The devices area owns the device records, and the Worker
 * registers the implementation (`worker-ports.ts`).
 */
export type DeviceReads = Readonly<{
  /** Each device of the Organisation, the oldest first. */
  listDevices(
    db: OrganisationDatabase,
    organisationId: OrganisationId,
  ): Promise<readonly DeviceListing[]>;
}>;

export const deviceReads = definePort<DeviceReads>("device_reads");
