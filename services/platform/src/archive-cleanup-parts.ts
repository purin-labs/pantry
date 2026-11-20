import type { ArchiveCleanupParts } from "./data/onboarding-reconciliation";
import { purgeOrganisationWhatsAppConnectors } from "./data/whatsapp";
import { purgeOrganisationDeviceFleets } from "./devices/purge";
import { revokeOrganisationDevicesStatements } from "./devices/store";
import {
  listSlackInstallationCredentialHandles,
  revokeSlackOrganisationConnections,
} from "./slack/organisation-routing";
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
  removeVoiceMacNames: async (env, db, organisationId) =>
    removeVoiceMacNames(env, await listVoiceMacNameIds(db, organisationId)),
  revokeSlackConnections: revokeSlackOrganisationConnections,
  listSlackCredentialHandles: listSlackInstallationCredentialHandles,
  prepareVoiceMacsRevocation: prepareArchivedOrganisationVoiceMacsRevocation,
  revokeDevicesStatements: revokeOrganisationDevicesStatements,
  purgeDeviceFleets: purgeOrganisationDeviceFleets,
  purgeWhatsAppConnectors: purgeOrganisationWhatsAppConnectors,
};
