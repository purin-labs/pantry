import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "@purin-labs/surface-portal/ui/styles.css";
import {
  EMPTY_AGENT_OPERATIONS_SNAPSHOT,
  type AgentOperationsSnapshot,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import type { CommerceApiKey } from "@purin-labs/control-api/portal/api-keys";
import type {
  OrganisationInvitation,
  OrganisationMember,
} from "@purin-labs/control-api/portal/settings";
import {
  AgentOperationsRoute,
  CommerceApiKeysRoute,
  WorkspaceSettingsRoute,
} from "@purin-labs/surface-portal/ui/page-code";
import { PageHeader } from "@purin-labs/ui/page-components";
import { SignIn } from "@purin-labs/surface-portal/ui/portal-shell";
import { PortalFrame } from "@purin-labs/surface-portal/ui/shell";

/*
 * API keys, Workspace settings and the sign-in page with example data.
 *   ?page=api-keys   ?scenario=populated (default) | empty | viewer
 *   ?page=settings   ?scenario=owner (default) | admin | viewer | archived
 *   ?page=sign-in
 * The preview answers the reads of each page; a change answers at once and
 * keeps nothing.
 */
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Settings preview is development-only.");

const params = new URL(window.location.href).searchParams;
const page = params.get("page") ?? "api-keys";
const scenario = params.get("scenario");
if (params.get("theme") === "dark")
  document.documentElement.dataset.portalTheme = "dark";
// controlMutation reads the session's CSRF cookie before it sends.
document.cookie = "pantry_csrf=preview; path=/";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 9);

const KEYS: readonly CommerceApiKey[] = [
  {
    credentialId: "cred_online_shop",
    label: "Online shop",
    scopes: ["catalog:read", "inventory:read", "orders:read", "orders:write"],
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    revokedAt: null,
  },
  {
    credentialId: "cred_stock_sheet",
    label: "Stock sheet",
    scopes: ["inventory:read"],
    createdAt: new Date(NOW - 12 * DAY).toISOString(),
    revokedAt: null,
  },
  {
    credentialId: "cred_old_pos",
    label: "Old register",
    scopes: ["orders:read", "catalog:read"],
    createdAt: new Date(NOW - 90 * DAY).toISOString(),
    revokedAt: new Date(NOW - 20 * DAY).toISOString(),
  },
];

const MEMBERS: readonly OrganisationMember[] = [
  member("user_pta", "Pta", "pta@nuki.example", "owner"),
  member("user_mika", "Mika Sato", "mika@nuki.example", "admin"),
  member("user_ren", "Ren Ito", "ren@nuki.example", "operator"),
  member("user_yui", "Yui Mori", "yui@nuki.example", "viewer"),
];

const INVITATIONS: readonly OrganisationInvitation[] = [
  {
    kind: "pending",
    organisationInvitationId: "invitation_kai",
    invitedEmail: "kai@nuki.example",
    role: "operator",
    createdAt: NOW - DAY,
    expiresAt: NOW + 6 * DAY,
  },
];

const AREAS: AgentOperationsSnapshot = {
  ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
  areas: [
    {
      areaId: "area_cafe",
      name: "Cafe operations",
      purpose: "Daily café service",
      lifecycle: "active",
    },
    {
      areaId: "area_online",
      name: "Online shop",
      purpose: "Orders and stock for delivery",
      lifecycle: "active",
    },
  ],
  responsibilityScopes: [
    {
      scopeId: "scope_menu",
      organisationId: "organisation_preview",
      areaId: "area_cafe",
      scope: { kind: "commerce_list", listId: "menu_today" },
      lifecycle: "published",
      revision: 1,
      publishedAt: NOW - 3 * DAY,
    },
  ],
};

function member(
  userId: string,
  displayName: string,
  email: string,
  role: OrganisationMember["role"],
): OrganisationMember {
  return {
    kind: "active",
    userId,
    personId: `person_${userId}`,
    role,
    email,
    displayName,
    createdAt: NOW - 60 * DAY,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let keys = KEYS;

window.fetch = async function previewFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  const post = (init?.method ?? "GET") === "POST";
  if (url.pathname.endsWith("/commerce/api-keys")) {
    if (post)
      return json({
        ok: true,
        apiKey: {
          credentialId: "cred_new",
          label: "New key",
          scopes: ["catalog:read"],
          createdAt: new Date(NOW).toISOString(),
          revokedAt: null,
        },
        key: "pk_live_preview_0123456789abcdef",
      });
    return json({ ok: true, apiKeys: scenario === "empty" ? [] : keys });
  }
  // A revoke marks the key as revoked, as on the server.
  const revoked = /\/commerce\/api-keys\/([^/]+)\/revocation$/u.exec(
    url.pathname,
  );
  if (revoked !== null && post) {
    const credentialId = decodeURIComponent(revoked[1] ?? "");
    keys = keys.map((key) =>
      key.credentialId === credentialId
        ? { ...key, revokedAt: new Date().toISOString() }
        : key,
    );
    return json({
      ok: true,
      apiKey: keys.find((key) => key.credentialId === credentialId),
    });
  }
  // The areas section reads the published commerce resources for its drawer.
  return json({
    ok: true,
    metadata: {
      kind: "enumerated",
      organisationId: "organisation_preview",
      merchantId: "merchant_preview",
      merchantRevision: 1,
      entityTypes: [],
      fields: [],
      lists: [],
      views: [],
    },
  });
};

type AreasProps = React.ComponentProps<typeof AgentOperationsRoute>;

async function refuseInPreview(): Promise<never> {
  throw new Error("Changes are not saved in the preview.");
}

const AREAS_TRANSPORT: AreasProps["transport"] = {
  read: async () => ({ ok: true, operations: AREAS }),
  mutate: refuseInPreview,
  readRevisions: refuseInPreview,
};

const COMMERCE_OPERATIONS: AreasProps["commerceOperations"] = {
  previewTrackingBatch: refuseInPreview,
  proposeAction: refuseInPreview,
};

const SETTINGS_TRANSPORT = {
  read: async () => ({
    members: MEMBERS,
    invitations: INVITATIONS,
    lifecycle:
      scenario === "archived" ? ("archived" as const) : ("active" as const),
    configurationVersion: 7,
  }),
  execute: async () => ({ kind: "applied" as const }),
};

function Frame(props: {
  readonly page: "api-keys" | "settings";
  readonly children: React.ReactNode;
}): React.ReactNode {
  // The titles as the Portal shows them; Workspace settings has no subtitle.
  const header =
    props.page === "api-keys"
      ? {
          title: "API keys",
          description:
            "Keys for your own systems. Each change records its key.",
        }
      : { title: "Workspace settings", description: null };
  return (
    <PortalFrame
      identity={{ kind: "ready", displayName: "Pta", logout: async () => {} }}
      organisation={{
        organisationHandle: "nuki",
        name: "Nuki Inc.",
        choices: [],
      }}
      workspace={{
        organisationHandle: "nuki",
        workspaceHandle: "cafe",
        name: "Cafe operations",
        choices: [],
      }}
      chat={null}
      sidebar={{ activePage: props.page, chatOpen: false, footer: null }}
    >
      <PageHeader title={header.title} description={header.description} />
      <React.Suspense fallback={null}>{props.children}</React.Suspense>
    </PortalFrame>
  );
}

function PreviewPage(): React.ReactNode {
  switch (page) {
    case "sign-in":
      return <SignIn />;
    case "settings": {
      const role =
        scenario === "admin"
          ? "admin"
          : scenario === "viewer"
            ? "viewer"
            : "owner";
      const canManage = role !== "viewer";
      return (
        <Frame page="settings">
          <WorkspaceSettingsRoute
            organisationId="organisation_preview"
            refreshKey="preview"
            organisation={{ name: "Nuki Inc.", lifecycle: "active", role }}
            canManage={canManage}
            transport={SETTINGS_TRANSPORT}
            operationalAreas={
              canManage ? (
                <AgentOperationsRoute
                  organisationId="organisation_preview"
                  page="areas"
                  canManage
                  commerceActionBusy={false}
                  refreshKey="preview"
                  loadAction={refuseInPreview}
                  transport={AREAS_TRANSPORT}
                  commerceOperations={COMMERCE_OPERATIONS}
                />
              ) : null
            }
          />
        </Frame>
      );
    }
    default:
      return (
        <Frame page="api-keys">
          <CommerceApiKeysRoute
            organisationId="organisation_preview"
            canManage={scenario !== "viewer"}
          />
        </Frame>
      );
  }
}

createRoot(root).render(
  <BrowserRouter>
    <PreviewPage />
  </BrowserRouter>,
);
