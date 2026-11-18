import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import "../styles.css";
import { EMPTY_AGENT_OPERATIONS_SNAPSHOT } from "../agent-operations";
import type { AgentDefinition, AgentDocumentRevision, AgentOperationsSnapshot, AgentRevisionTarget } from "@seams/control-api/portal/agent-operations";
import {
  AgentsPage,
  AgentsTabs,
  SkillsLibraryPage,
} from "../pages/agent-console";
import type { AgentOperationSubmitter } from "../pages/agent-console-shared";
import { PortalFrame } from "../shell";

const MERCHANT_AGENT: AgentDefinition = {
  agentDefinitionId: "agent_urk",
  displayName: "Sous Chef",
  role: "merchant_operator",
  purpose:
    "Checks stock, answers order questions, and prepares product updates for review.",
  lifecycle: "active",
  currentRevision: {
    revision: 2,
    instructions:
      "Review café operations and prepare changes for owner approval.",
    requestedCapabilities: [
      "commerce.entity_plane.context",
      "commerce.action.propose",
    ],
    skillRefs: [{ skillId: "listing_checklist", revision: 1 }],
    contentDigest: "preview_urk",
  },
};

const SUPPORT: AgentDefinition = {
  agentDefinitionId: "agent_support",
  displayName: "WhatsApp support",
  role: "Customer support",
  purpose:
    "Helps customers with product questions and order updates on WhatsApp.",
  lifecycle: "active",
  currentRevision: {
    revision: 1,
    instructions:
      "Help customers understand their orders. Escalate changes to the owner.",
    requestedCapabilities: ["commerce.entity_plane.context"],
    skillRefs: [],
    contentDigest: "preview_support",
  },
};

function previewSnapshot(scenario: string | null): AgentOperationsSnapshot {
  if (scenario === "empty") return EMPTY_AGENT_OPERATIONS_SNAPSHOT;
  const automated = scenario !== "setup";
  return {
    ...EMPTY_AGENT_OPERATIONS_SNAPSHOT,
    areas: [
      {
        areaId: "area_cafe",
        name: "Cafe operations",
        purpose: "Daily café operations",
        lifecycle: "active",
      },
    ],
    definitions: [MERCHANT_AGENT, SUPPORT],
    installations: [
      {
        installationId: "installation_urk",
        agentDefinitionId: MERCHANT_AGENT.agentDefinitionId,
        definitionRevision: MERCHANT_AGENT.currentRevision.revision,
        policyRevision: 1,
        grantedCapabilities: MERCHANT_AGENT.currentRevision.requestedCapabilities,
        lifecycle: "active",
        areaAssignments: [
          {
            areaId: "area_cafe",
            responsibility: "Daily café operations",
            scopeIds: [],
          },
        ],
      },
    ],
    scheduleBindings: automated
      ? [
          {
            bindingId: "morning_stock",
            areaId: "area_cafe",
            scopeIds: [],
            installationId: "installation_urk",
            spec: {
              cadence: "daily",
              timeOfDay: "07:00",
              timezone: "Asia/Tokyo",
            },
            enabled: true,
            instructionBody: "Check stock before opening.",
            revision: 1,
          },
        ]
      : [],
    skills: [
      {
        skillId: "listing_checklist",
        title: "Listing quality checklist",
        lifecycle: "published",
        sensitivity: "ordinary",
        currentRevision: {
          revision: 1,
          markdownBody:
            "Confirm the name, description, price, and allergen information before requesting publication.",
          contentDigest: "preview_checklist",
        },
      },
    ],
    configurationProposals: automated
      ? [
          {
            proposalId: "proposal_checklist",
            installationId: "installation_urk",
            targetKind: "agent_instructions",
            targetId: MERCHANT_AGENT.agentDefinitionId,
            expectedRevision: MERCHANT_AGENT.currentRevision.revision,
            proposedBody:
              "Review café operations and prepare changes for owner approval. Include confirmed allergen information in product updates.",
            rationale:
              "Include allergen information in every product description review.",
            status: "open",
            publishedRevision: null,
          },
        ]
      : [],
    activeCases: automated
      ? [
          {
            caseId: "case_stock",
            pinnedOrganisationId: "organisation_preview",
            purpose: "Check stock for tomorrow’s service",
            revision: 2,
            lifecycle: "completed",
            assignments: [
              {
                assignmentId: "assignment_stock",
                sessionId: "session_stock",
                lifecycle: "settled",
              },
            ],
            outputs: { pending: 0, settled: 1 },
          },
          {
            caseId: "case_delivery",
            pinnedOrganisationId: "organisation_preview",
            purpose: "Find the delivery status for order #1042",
            revision: 2,
            lifecycle: "open",
            assignments: [
              {
                assignmentId: "assignment_delivery",
                sessionId: "session_delivery",
                lifecycle: "running",
              },
            ],
            outputs: { pending: 1, settled: 0 },
          },
          {
            caseId: "case_long",
            pinnedOrganisationId: "organisation_preview",
            purpose:
              "<@U0BP17AHYTV> Review the café catalog and check all descriptions for product names, prices, and confirmed allergen information before the next service. Keep the complete original request available for the operator.",
            revision: 1,
            lifecycle: "waiting",
            assignments: [],
            outputs: { pending: 0, settled: 0 },
          },
          {
            caseId: "case_review",
            pinnedOrganisationId: "organisation_preview",
            purpose: "Prepare the weekend menu updates",
            revision: 2,
            lifecycle: "completed",
            assignments: [],
            outputs: { pending: 0, settled: 1 },
          },
        ]
      : [],
  };
}

const previewSubmit: AgentOperationSubmitter = async function previewSubmit(
  _formKey,
  _kind,
  event,
) {
  event.preventDefault();
  return false;
};

async function previewRun(): Promise<boolean> {
  return false;
}

let revisionReadFailed = false;

async function previewRevisions(
  target: AgentRevisionTarget,
): Promise<readonly AgentDocumentRevision[]> {
  const scenario = new URLSearchParams(window.location.search).get("scenario");
  if (scenario === "history-retry" && !revisionReadFailed) {
    revisionReadFailed = true;
    throw new Error("The preview revision read failed once.");
  }
  if (target.kind === "agent_definition") {
    const definition = target.id === MERCHANT_AGENT.agentDefinitionId ? MERCHANT_AGENT : SUPPORT;
    if (target.id !== definition.agentDefinitionId) {
      throw new Error("The preview agent does not exist.");
    }
    const current = {
      revision: definition.currentRevision.revision,
      body: definition.currentRevision.instructions,
      contentDigest: definition.currentRevision.contentDigest,
      createdAt: Date.parse("2026-10-23T01:00:00Z"),
    };
    if (definition === SUPPORT) return [current];
    return [
      current,
      {
        revision: 1,
        body: "Review café stock each morning. Ask the owner before any change.",
        contentDigest: "preview_urk_revision_1",
        createdAt: Date.parse("2026-10-20T01:00:00Z"),
      },
    ];
  }
  const skill = previewSnapshot(scenario).skills.find(
    matchesPreviewSkill.bind(null, target.id),
  );
  if (skill === undefined) throw new Error("The preview skill does not exist.");
  return [
    {
      revision: skill.currentRevision.revision,
      body: skill.currentRevision.markdownBody,
      contentDigest: skill.currentRevision.contentDigest,
      createdAt: Date.parse("2026-10-20T01:00:00Z"),
    },
  ];
}

function matchesPreviewSkill(
  id: string,
  skill: AgentOperationsSnapshot["skills"][number],
): boolean {
  return skill.skillId === id;
}

async function previewLogout(): Promise<void> {}

async function previewFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  if (
    url.pathname ===
    "/v1/control/organisations/organisation_preview/brain/summary"
  ) {
    return Response.json({
      ok: true,
      summary: { memoriesToReview: 0, evalsToReview: 0 },
    });
  }
  if (
    url.pathname !==
    "/v1/control/organisations/organisation_preview/commerce/published-resources"
  ) {
    throw new Error(`Unsupported agent preview request: ${url.pathname}`);
  }
  return Response.json({
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
}

function PreviewApp(): React.ReactNode {
  const query = new URLSearchParams(window.location.search);
  const scenario = query.get("scenario");
  // The Skills library is a view of the Knowledge page. "?view=skills" shows it.
  const Page = query.get("view") === "skills" ? SkillsLibraryPage : AgentsPage;
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
      sidebar={{ activePage: "agents", chatOpen: false, footer: null }}
    >
      <p
        style={{ margin: "0 0 18px", color: "var(--ink-2)", fontSize: "12px" }}
      >
        Visual preview · Example data · Writes disabled
      </p>
      <Page
        organisationId="organisation_preview"
        snapshot={previewSnapshot(scenario)}
        submit={previewSubmit}
        run={previewRun}
        mutation={{ kind: "idle" }}
        canConfigure={scenario !== "viewer"}
        loadRevisions={previewRevisions}
        activityHref="/agents-preview.html?view=activity"
        tabs={
          <AgentsTabs
            active="agents"
            agentsHref="/agents-preview.html"
            activityHref="/agents-preview.html?view=activity"
            schedulesHref="/agents-preview.html?view=schedules"
          />
        }
      />
    </PortalFrame>
  );
}

const container = document.getElementById("root");
if (container !== null) {
  window.fetch = previewFetch;
  createRoot(container).render(
    <BrowserRouter>
      <PreviewApp />
    </BrowserRouter>,
  );
}
