import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { canonicalJson } from "@purin-labs/std";
import WorkflowSimulatorRoute from "../features/workflow-simulator/route";
import "../styles.css";

declare global {
  interface Window {
    factoryAcceptance?: Readonly<{ canonicalJson: typeof canonicalJson }>;
  }
}
window.factoryAcceptance = { canonicalJson };

// This separate build entry exercises production React and the actual workspace.
// The Portal deployment builds index.html and does not include this fixture.
const root = document.getElementById("root");
if (root === null) throw new Error("The factory fixture has no root element.");
createRoot(root).render(
  <MemoryRouter>
    <WorkflowSimulatorRoute connection={{ kind: "preview" }} />
  </MemoryRouter>,
);
