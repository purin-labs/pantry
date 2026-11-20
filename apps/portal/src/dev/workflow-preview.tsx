// Development fixture of the public workflow simulator (workflow-demo.tsx) at
// /workflow-preview.html: the chat answers from the chat preview data, with no
// account. A browser journey that mounts the simulator itself routes this
// module to the Portal's styles (scripts/bakery-robots/simulator-navigation.js).
import React from "react";
import { createRoot } from "react-dom/client";
import {
  showRequestedPhysicsEvidence,
  WorkflowDemoApp,
} from "../workflow-demo";
import { installChatPreviewFetch } from "./chat-preview-data";

installChatPreviewFetch();
showRequestedPhysicsEvidence(window.location.search);

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <WorkflowDemoApp />
    </React.StrictMode>,
  );
