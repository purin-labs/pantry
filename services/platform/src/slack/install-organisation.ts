import { prepareSlackInstallOrganisationRow } from "../data/shared-rows/organisation-row";
import {
  prepareInitialPlacementActivation,
  prepareSlackInstallPlacementReservation,
  prepareSlackInstallRegionalPlacement,
} from "../data/shared-rows/placement-row";
import {
  type GlobalDatabase,
  type OrganisationDatabase,
  sameBinding,
} from "../database-handles";
import {
  selectOrganisationPlacementDatabase,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import {
  readPlacementByEpoch,
  type OrganisationPlacementFenceToken,
} from "../data/organisation-placement";
import {
  parseInitialOrganisationPlacement,
  type InitialOrganisationPlacement,
} from "../placement";
import {
  parseOrganisationId,
  type OrganisationId,
  type WorkspaceId,
} from "../ids";
import type { Result } from "../result";
import type { SlackInstallationIdentity } from "./installation-identity";

type SlackInstallOrganisationResolution =
  | { readonly kind: "existing" }
  | {
      readonly kind: "new";
      readonly organisationId: OrganisationId;
    };

export type SlackInstallOrganisationAdmissionError =
  | {
      readonly code: "slack_install_existing_workspace_requires_organisation_flow";
    }
  | { readonly code: "slack_install_bootstrap_state_invalid" };

export async function admitSlackInstallOrganisation(input: {
  readonly env: OrganisationPlacementBindings;
  readonly placement: InitialOrganisationPlacement;
  readonly workspaceId: WorkspaceId;
  readonly installationIdentity: SlackInstallationIdentity;
  readonly teamName: string;
  readonly occurredAt: number;
}): Promise<
  Result<
    {
      readonly kind: "cloudflare_native_bootstrap";
      readonly database: OrganisationDatabase;
      readonly placement: InitialOrganisationPlacement;
      readonly fenceToken: OrganisationPlacementFenceToken;
      readonly organisationId: OrganisationId;
    },
    SlackInstallOrganisationAdmissionError
  >
> {
  const resolved = await resolveSlackInstallOrganisation({
    db: input.env.DB,
    workspaceId: input.workspaceId,
    installationIdentity: input.installationIdentity,
  });
  if (resolved.kind === "existing") {
    return {
      ok: false,
      error: {
        code: "slack_install_existing_workspace_requires_organisation_flow",
      },
    };
  }
  const prepared = await prepareCloudflareNativeSlackInstallOrganisation({
    db: input.env.DB,
    organisationId: resolved.organisationId,
    teamName: input.teamName,
    now: input.occurredAt,
  });
  if (!prepared.ok) {
    return prepared;
  }

  const directory = input.env.DB;
  await prepareSlackInstallPlacementReservation(directory, {
    organisationId: resolved.organisationId,
    placement: input.placement,
    fenceToken: crypto.randomUUID(),
    createdAt: input.occurredAt,
    environment: input.installationIdentity.environment,
  }).run();
  const reservation = await readPlacementByEpoch(
    directory,
    resolved.organisationId,
    1,
  );
  if (
    !reservation.ok ||
    (reservation.value.status !== "reserved" &&
      reservation.value.status !== "active")
  ) {
    return {
      ok: false,
      error: { code: "slack_install_bootstrap_state_invalid" },
    };
  }
  const placement = parseInitialOrganisationPlacement(
    reservation.value.placement,
  );
  if (!placement.ok)
    return {
      ok: false,
      error: { code: "slack_install_bootstrap_state_invalid" },
    };
  const selected = selectOrganisationPlacementDatabase(
    input.env,
    resolved.organisationId,
    placement.value,
  );
  if (!selected.ok)
    return {
      ok: false,
      error: { code: "slack_install_bootstrap_state_invalid" },
    };
  const regional = await prepareCloudflareNativeSlackInstallOrganisation({
    db: selected.value,
    organisationId: resolved.organisationId,
    teamName: input.teamName,
    now: reservation.value.createdAt,
  });
  if (!regional.ok) return regional;
  if (!sameBinding(selected.value, directory)) {
    await prepareSlackInstallRegionalPlacement(selected.value, {
      organisationId: resolved.organisationId,
      placement: placement.value,
      fenceToken: reservation.value.fenceToken,
      createdAt: reservation.value.createdAt,
      environment: input.installationIdentity.environment,
    }).run();
  }
  await prepareInitialPlacementActivation(selected.value, {
    organisationId: resolved.organisationId,
    fenceToken: reservation.value.fenceToken,
    activatedAt: reservation.value.createdAt,
  }).run();
  const localPlacement = await readPlacementByEpoch(
    selected.value,
    resolved.organisationId,
    1,
  );
  if (
    !localPlacement.ok ||
    localPlacement.value.status !== "active" ||
    localPlacement.value.fenceToken !== reservation.value.fenceToken
  ) {
    return {
      ok: false,
      error: { code: "slack_install_bootstrap_state_invalid" },
    };
  }
  return {
    ok: true,
    value: {
      kind: "cloudflare_native_bootstrap",
      database: selected.value,
      placement: placement.value,
      fenceToken: reservation.value.fenceToken,
      organisationId: resolved.organisationId,
    },
  };
}

async function resolveSlackInstallOrganisation(input: {
  readonly db: GlobalDatabase;
  readonly workspaceId: WorkspaceId;
  readonly installationIdentity: SlackInstallationIdentity;
}): Promise<SlackInstallOrganisationResolution> {
  const existing = await input.db
    .prepare(
      `SELECT 1 AS present
       FROM slack_installation
       WHERE environment = ?
         AND app_id = ?
         AND workspace_id = ?`,
    )
    .bind(
      input.installationIdentity.environment,
      input.installationIdentity.appId,
      input.workspaceId,
    )
    .first<{ readonly present: 1 }>();

  if (existing === null) {
    return {
      kind: "new",
      organisationId: slackInstallOrganisationId(input.workspaceId),
    };
  }

  return { kind: "existing" };
}

async function prepareCloudflareNativeSlackInstallOrganisation(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly teamName: string;
  readonly now: number;
}): Promise<
  Result<null, { readonly code: "slack_install_bootstrap_state_invalid" }>
> {
  await prepareSlackInstallOrganisationRow(input.db, input).run();

  const organisation = await input.db
    .prepare("SELECT status FROM organisation WHERE organisation_id = ?")
    .bind(input.organisationId)
    .first<{ readonly status: unknown }>();
  if (organisation?.status !== "active") {
    return {
      ok: false,
      error: { code: "slack_install_bootstrap_state_invalid" },
    };
  }
  return { ok: true, value: null };
}

function slackInstallOrganisationId(workspaceId: WorkspaceId): OrganisationId {
  const parsed = parseOrganisationId(`organisation_${workspaceId}`);

  if (!parsed.ok) {
    throw new Error(
      `Slack workspace id did not produce an organisation id: ${workspaceId}`,
    );
  }

  return parsed.value;
}
