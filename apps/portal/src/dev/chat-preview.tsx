import { isUserId } from "@purin-labs/control-api";
import { UserPreferencesProvider } from "../preferences/context";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router";
import "../styles.css";
import { PortalFrame } from "../shell";
import { ConnectedChatPage as ChatPage } from "../features/chat/route";
import { UNAVAILABLE_ACCESS } from "./unavailable-access";
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
function previewLogout(): Promise<void> {
  return Promise.resolve();
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
      identity={{ kind: "ready", displayName: "Pta", logout: previewLogout }}
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
      sidebar={{ activePage: "overview", chatOpen: open, footer: null }}
      chat={
        open
          ? {
              close,
              content: (
                <ChatPage
                  context={{
                    organisation: "Nuki Inc.",
                    workspace: "Cafe operations",
                    area: "AgentCommerce",
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
