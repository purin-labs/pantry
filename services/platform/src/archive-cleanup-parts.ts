import type { ArchiveCleanupParts } from "@purin-labs/area-organisation/server/data/onboarding-reconciliation";
import { purgeOrganisationWhatsAppConnectors } from "./data/whatsapp";
import { purgeOrganisationDeviceFleets } from "@purin-labs/area-devices/server/purge";
import { revokeOrganisationDevicesStatements } from "@purin-labs/area-devices/server/store";
import {
  listSlackInstallationCredentialHandles,
  revokeSlackOrganisationConnections,
} from "@purin-labs/authority/slack/installation-store";
import { removeVoiceMacNames } from "./voice/dns";
import {
  listVoiceMacNameIds,
  prepareArchivedOrganisationVoiceMacsRevocation,
} from "./voice/store";

/**
 * The Worker gives the archive cleanup of an Organisation the steps of the
 * voice Macs, Slack, the devices and the WhatsApp Connectors.
 */
export const ARCHIVE_CLEANUP_PARTS: ArchiveCleanupParts = {
  // Each part names its function when it runs, as the cleanup did before.
  removeVoiceMacNames: async (env, db, organisationId) =>
    removeVoiceMacNames(env, await listVoiceMacNameIds(db, organisationId)),
  revokeSlackConnections: (directory, input) =>
    revokeSlackOrganisationConnections(directory, input),
  listSlackCredentialHandles: (directory, organisationId) =>
    listSlackInstallationCredentialHandles(directory, organisationId),
  prepareVoiceMacsRevocation: (db, input) =>
    prepareArchivedOrganisationVoiceMacsRevocation(db, input),
  revokeDevicesStatements: (session, organisationId, now) =>
    revokeOrganisationDevicesStatements(session, organisationId, now),
  purgeDeviceFleets: (env, db, organisationId, placement) =>
    purgeOrganisationDeviceFleets(env, db, organisationId, placement),
  purgeWhatsAppConnectors: (input) =>
    purgeOrganisationWhatsAppConnectors(input),
};
