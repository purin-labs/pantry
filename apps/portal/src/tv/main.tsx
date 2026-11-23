import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TvPlayer } from "@purin-labs/surface-portal/ui/tv/player";
import "@purin-labs/surface-portal/ui/tv/tv.css";

const root = document.getElementById("root");
if (root === null) throw new Error("The screen page has no root");
createRoot(root).render(
  <StrictMode>
    <TvPlayer />
  </StrictMode>,
);

// The service worker keeps the player, so that a screen that restarts with
// no network still opens it and shows its saved board.
if ("serviceWorker" in navigator)
  void navigator.serviceWorker
    .register("/tv-sw.js", { scope: "/tv" })
    .catch(() => undefined);
