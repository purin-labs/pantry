import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryRouter } from "react-router";
import "../styles.css";
import { MenuDraftRoute } from "../features/content-studio/route";
import { registerPortalBoardChat } from "../portal-board-chat";

// Menus (Items, Boards, Screens) against a Worker's control routes, for the
// Plan 40B browser journey. `?organisation=<id>&tab=boards` picks the
// Organisation and the first tab; the browser's own session cookie signs
// each request.
registerPortalBoardChat();
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Menus preview is development-only.");
const search = new URL(window.location.href).searchParams;
const organisationId = search.get("organisation") ?? "organisation_menus_preview";
const tab = search.get("tab");
const router = createMemoryRouter(
  [{ path: "*", element: <main className="portal-main menus-preview" data-page="menus" style={{ position: "relative", height: "100vh" }}><div className="portal-main-inner"><MenuDraftRoute organisationId={organisationId} /></div></main> }],
  { initialEntries: [tab === null ? "/menus" : `/menus?tab=${encodeURIComponent(tab)}`] },
);
// A journey opens the chat as the Portal's Ask link does: a move to the chat
// route that names this page in the router state.
Reflect.set(window, "menusPreviewRouter", router);
createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
