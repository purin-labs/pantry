// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { StaticRouter } from "../../../apps/portal/node_modules/react-router";
import { describe, expect, it } from "vitest";

import {
  OrganisationListPage,
  type OrganisationActions,
  type OrganisationListItem,
  type WorkspaceSupportTools,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "@purin-labs/area-organisation/ui/pages/workspaces";
// @ts-expect-error Platform's test tsconfig intentionally excludes JSX; the portal builds this module separately.
import { selectPreferredWorkspace } from "../../../apps/portal/src/portal";

describe("Café organisations page ownership", () => {
  it("opens the last valid workspace and falls back to the default workspace", () => {
    const [defaultWorkspace, previousWorkspace] =
      organisationFixture().workspaces;
    if (defaultWorkspace === undefined || previousWorkspace === undefined) {
      throw new Error("Workspace preference fixture is incomplete.");
    }
    const workspaces = [defaultWorkspace, previousWorkspace] as const;

    expect(
      selectPreferredWorkspace(workspaces, previousWorkspace.workspaceHandle),
    ).toEqual(previousWorkspace);
    expect(selectPreferredWorkspace(workspaces, "retired-workspace")).toEqual(
      defaultWorkspace,
    );
    expect(selectPreferredWorkspace(workspaces, null)).toEqual(
      defaultWorkspace,
    );
  });

  it("associates support recovery copy with the workspace lookup", () => {
    const markup = renderOrganisationList([], {
      busy: false,
      error: "Café could not inspect that workspace. Try again.",
      operatorCase: null,
      inspect: ignoreInspect,
      archive: ignoreArchive,
    });

    expect(markup).toContain('id="workspace-support-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-describedby="workspace-support-error"');
  });
});

function renderOrganisationList(
  organisations: readonly OrganisationListItem[],
  supportTools: WorkspaceSupportTools | null = null,
): string {
  return renderToStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/portal" },
      React.createElement(OrganisationListPage, {
        organisations,
        supportTools,
        userId: "workspaces-page-test",
        organisationActions,
        refresh: ignoreOpenWorkspace,
        openWorkspace: ignoreOpenWorkspace,
      }),
    ),
  );
}

function organisationFixture(): OrganisationListItem {
  return {
    organisationId: "organisation_cafe_central",
    organisationHandle: "cafe-central",
    name: "Cafe Central",
    role: "owner",
    plan: "beta",
    lifecycle: "active",
    configurationVersion: 3,
    workspaces: [
      {
        workspaceId: "workspace_front_counter",
        workspaceHandle: "front-counter",
        name: "Front counter",
        createdAt: 1,
      },
      {
        workspaceId: "workspace_production_kitchen",
        workspaceHandle: "production-kitchen",
        name: "Production kitchen",
        createdAt: 2,
      },
    ],
  };
}

function ignoreOpenWorkspace(): void {}

async function ignoreInspect(): Promise<void> {}

async function ignoreArchive(): Promise<void> {}

const organisationActions: OrganisationActions = {
  rename: ignoreRenameOrganisation,
  archive: ignoreOrganisationAction,
  restore: ignoreOrganisationAction,
  delete: ignoreOrganisationAction,
};

async function ignoreRenameOrganisation(
  _organisation: OrganisationListItem,
  _name: string,
): Promise<void> {}

async function ignoreOrganisationAction(
  _organisation: OrganisationListItem,
): Promise<void> {}
