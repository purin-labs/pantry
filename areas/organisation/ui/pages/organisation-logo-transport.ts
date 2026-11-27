import {
  controlUpload,
  controlWrite,
} from "@purin-labs/control/portal/control-client";
import { logoPath } from "@purin-labs/control/portal/control-paths";
import type { LogoActions } from "@purin-labs/area-organisation-contract/ui/pages/organisations";

/** The control API calls behind the Logos dialog. */
export const ORGANISATION_LOGO_ACTIONS: LogoActions = {
  set: setLogo,
  remove: removeLogo,
};

async function setLogo(
  organisationId: string,
  workspaceId: string | null,
  file: File,
): Promise<void> {
  const form = new FormData();
  form.set("logo", file);
  await controlUpload(
    logoPath(organisationId, workspaceId),
    form,
    `portal-${crypto.randomUUID()}`,
  );
}

async function removeLogo(
  organisationId: string,
  workspaceId: string | null,
): Promise<void> {
  await controlWrite(logoPath(organisationId, workspaceId), "DELETE", {
    remove: true,
  });
}
