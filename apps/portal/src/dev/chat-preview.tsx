import { isUserId } from "@purin-labs/control-api";
import { UserPreferencesProvider } from "@purin-labs/ui/preferences/context";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import "@purin-labs/surface-portal/ui/styles.css";
import { PortalFrame } from "@purin-labs/surface-portal/ui/shell";
import {
  readPortalRoute,
  type WorkspaceDetailPage,
} from "@purin-labs/ui/route";
import { ConnectedChatPage as ChatPage } from "@purin-labs/surface-portal/ui/features/chat/route";
import { UNAVAILABLE_ACCESS } from "@purin-labs/area-organisation-contract/ui/features/access/unavailable-access";
import { installChatPreviewFetch } from "./chat-preview-data";
import { ChatExecutionPreviewControls } from "./chat-execution-preview";

const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Chat preview is development-only.");
installChatPreviewFetch();
// With `?organisation=<id>` the chat uses the control routes of the Worker
// behind this server, under the browser's own session; the sample store
// answers only the preview Organisation. A browser journey drives it that way.
const organisationId =
  new URL(window.location.href).searchParams.get("organisation") ??
  "organisation_chat_preview";
// Two organisations, so the workspace menu shows the current one's
// workspaces and one row for the other.
const PREVIEW_WORKSPACES = [
  {
    organisationHandle: "nuki",
    workspaceHandle: "cafe",
    name: "Cafe operations",
    tile: { seed: "workspace_preview_cafe", logoUrl: null },
  },
  {
    organisationHandle: "nuki",
    workspaceHandle: "central",
    name: "Central kitchen",
    tile: { seed: "workspace_preview_central", logoUrl: null },
  },
];
const PREVIEW_ORGANISATIONS = [
  {
    organisationHandle: "nuki",
    name: "Nuki Inc.",
    tile: { seed: "organisation_preview_nuki", logoUrl: null },
    workspaces: PREVIEW_WORKSPACES,
  },
  {
    organisationHandle: "noix",
    name: "Noix test shop",
    tile: { seed: "organisation_preview_noix", logoUrl: null },
    workspaces: [
      {
        organisationHandle: "noix",
        workspaceHandle: "shop",
        name: "Shop",
        tile: { seed: "workspace_preview_shop", logoUrl: null },
      },
    ],
  },
];
function previewLogout(): Promise<void> {
  return Promise.resolve();
}
function openPreviewRequests(): void {}
// What the full frame shows in a shop: the usage ring, the waiting requests
// and the counts beside Knowledge and Access.
const PREVIEW_ATTENTION = {
  knowledge: { count: 3, label: "3 to review" },
  access: { count: 2, label: "2 permission requests waiting" },
};
// The frame follows the address, as in the Portal: a page link, a product
// tab or the search marks the page that it opened.
function previewPage(pathname: string): WorkspaceDetailPage {
  const route = readPortalRoute(pathname);
  return route.kind !== "workspace" || route.destination.page === "chat"
    ? "overview"
    : route.destination.page;
}
function closePreviewChat(navigate: NavigateFunction): void {
  navigate("/portal/nuki/cafe/overview", { replace: true });
}
function ChatPreview(): React.ReactNode {
  const userId = new URL(window.location.href).searchParams.get("preferenceUser");
  const content = <ChatPreviewContent />;
  return isUserId(userId) ? <UserPreferencesProvider key={userId} userId={userId}>{content}</UserPreferencesProvider> : content;
}
function ChatPreviewContent(): React.ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const open = location.pathname.endsWith("/chat");
  const close = closePreviewChat.bind(null, navigate);
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: "Pta",
        logout: previewLogout,
        usagePercent: 34,
        permissionRequests: { count: 2, open: openPreviewRequests },
      }}
      organisation={{
        organisationHandle: "nuki",
        name: "Nuki Inc.",
        choices: PREVIEW_ORGANISATIONS,
      }}
      workspace={{
        organisationHandle: "nuki",
        workspaceHandle: "cafe",
        name: "Cafe operations",
        choices: PREVIEW_WORKSPACES,
      }}
      sidebar={{
        activePage: previewPage(location.pathname),
        chatOpen: open,
        footer: null,
        attention: PREVIEW_ATTENTION,
      }}
      chat={
        open
          ? {
              close,
              content: (
                <ChatPage
                  context={{
                    organisation: "Nuki Inc.",
                    workspace: "Cafe operations",
                    area: "commerce",
                    view: "Orders",
                  }}
                  close={close}
                  organisationId={organisationId}
                  basePath="/chat-preview.html"
                  integrationsPath="/integrations-preview.html"
                  accessPath="/access-preview.html"
                  sourceLinks={{
                    orderHref: (id) => `/portal/noix/cafe/customer_order/${id}`,
                    supplierHref: (id) => `/portal/noix/cafe/supplier/${id}`,
                    memoryHref: (id) => `/portal/noix/cafe/knowledge/${id}`,
                  }}
                  access={UNAVAILABLE_ACCESS}
                  signedInAs={null}
                  canManage={true}
                />
              ),
            }
          : null
      }
    >
      <h1>Cafe operations</h1>
      <p>Manage your workspace and ask your assistant for help.</p>
    </PortalFrame>
  );
}
createRoot(root).render(
  <><ChatExecutionPreviewControls />
  <MemoryRouter initialEntries={["/portal/nuki/cafe/overview"]}>
    <ChatPreview />
  </MemoryRouter></>,
);
