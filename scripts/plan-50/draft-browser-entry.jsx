import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { TaskList } from "../../foundation/ui/task-list.tsx";
import { parsePendingInputs } from "../../packages/control-api/src/portal/chat.ts";
import DescriptionEditor from "../../areas/commerce/ui/features/commerce/description-draft/editor.tsx";
import { responseJson } from "../../foundation/control/portal/control-client.ts";
import { parseCommerceActionRecordResponse } from "../../packages/commerce-control-api/src/portal/commerce-actions.ts";
import "../../areas/commerce/ui/features/commerce/description-draft/styles.css";

const organisationId = "organisation_plan50_seams";
const productId = "product_financier";
const source = await (
  await fetch(
    `/v1/control/organisations/${organisationId}/commerce/products/${productId}/description-draft`,
  )
).json();
const transport = { proposeAction };
const product = {
  productId: source.canonicalProductId,
  title: source.product.title,
  description: source.product.description,
  revision: source.product.revision,
};

async function proposeAction(organisation, action, intent) {
  const headers = controlHeaders();
  headers.set("idempotency-key", `draft-browser:${intent}`);
  const result = await responseJson(
    await fetch(`/v1/control/organisations/${organisation}/commerce/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify(action),
    }),
  );
  return parseCommerceActionRecordResponse(result);
}

async function readPublication(setPublication) {
  const status = await responseJson(await fetch("/fixture/draft"));
  const nonce = status.publicationNonce ?? status.proposalNonce;
  if (nonce === null) throw new Error("No publication proposal");
  const result = await responseJson(
    await fetch(
      `/v1/control/organisations/${organisationId}/commerce/actions/${nonce}`,
    ),
  );
  setPublication(JSON.stringify(parseCommerceActionRecordResponse(result)));
}

function controlHeaders() {
  const csrf = document.cookie.split("; ").find(isCsrfCookie);
  if (csrf === undefined) throw new Error("Missing operator session");
  return new Headers({
    "content-type": "application/json",
    "x-pantry-csrf": decodeURIComponent(
      csrf.slice("pantry_csrf=".length),
    ),
  });
}

function isCsrfCookie(cookie) {
  return cookie.startsWith("pantry_csrf=");
}

function noRefresh() {}

async function startAssignment() {
  await fetch("/fixture/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "begin" }),
  });
}

async function readExecution(setExecution, turn) {
  const response = await fetch(`/fixture/execution?turn=${turn}&after=-1`);
  if (!response.ok) throw new Error(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const events = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      pending += decoder.decode(result.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim() !== "") events.push(JSON.parse(line));
        newline = pending.indexOf("\n");
      }
      setExecution(JSON.stringify(events));
    }
  } finally {
    await reader.cancel();
  }
}

async function queueDraftFollowup(setQueue) {
  const response = await fetch("/fixture/queue", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({
      kind: "next",
      conversationId: "conv_aaaaaaaa-1111-4111-8111-111111111111",
      requestId: "request_draft_followup",
      inputId: "input_draft_followup",
      model: "qwen/qwen3.7-flash",
      text: "Read the saved draft again after recovery. Preserve the serving note and wait for review.",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  setQueue(JSON.stringify(await response.json()));
}

function DraftJourney() {
  const [tasks, setTasks] = React.useState([]);
  const [pendingInputs, setPendingInputs] = React.useState([]);
  const [action, setAction] = React.useState(null);
  const [execution, setExecution] = React.useState("[]");
  const [queuedExecution, setQueuedExecution] = React.useState("[]");
  const [queue, setQueue] = React.useState("No queued input");
  const [steering, setSteering] = React.useState("No steering input");
  const [steeredExecution, setSteeredExecution] = React.useState("[]");
  const [publication, setPublication] = React.useState("No publication result");
  return (
    <main className="description-draft-workspace">
      <h1>Shared financier draft</h1>
      <button
        onClick={readTasks.bind(
          null,
          setTasks,
          setPendingInputs,
          "turn_plan50_seams",
        )}
      >
        Inspect active tasks
      </button>
      <button
        onClick={readTasks.bind(
          null,
          setTasks,
          setPendingInputs,
          "turn_plan50_followup_3",
        )}
      >
        Inspect completed tasks
      </button>
      <TaskList title="Agent tasks" items={tasks} />
      <ul aria-label="Queued messages">
        {pendingInputs.map(renderPendingInput)}
      </ul>
      <button onClick={startAssignment}>Start agent assignment</button>
      <button
        onClick={readExecution.bind(null, setExecution, "turn_plan50_seams")}
      >
        Observe agent execution
      </button>
      <output aria-label="Agent execution">{execution}</output>
      <button onClick={queueDraftFollowup.bind(null, setQueue)}>
        Queue draft follow-up
      </button>
      <output aria-label="Queued input">{queue}</output>
      <button
        onClick={readExecution.bind(
          null,
          setQueuedExecution,
          "turn_plan50_followup_3",
        )}
      >
        Observe queued follow-up
      </button>
      <output aria-label="Queued execution">{queuedExecution}</output>
      <button onClick={steerDraftFollowup.bind(null, setSteering)}>
        Steer draft follow-up
      </button>
      <output aria-label="Steering input">{steering}</output>
      <button
        onClick={readExecution.bind(
          null,
          setSteeredExecution,
          "turn_plan50_followup_3",
        )}
      >
        Observe steered execution
      </button>
      <output aria-label="Steered execution">{steeredExecution}</output>
      <DescriptionEditor
        organisationId={organisationId}
        productId={productId}
        currentProductRevision={source.product.revision}
        currentProduct={product}
        canPropose={true}
        actionBusy={false}
        actionTransport={transport}
        onActionProposed={setAction}
        onReviewRefresh={noRefresh}
      />
      <output aria-label="Submitted proposal">
        {action === null ? "No proposal" : JSON.stringify(action)}
      </output>
      <button onClick={readPublication.bind(null, setPublication)}>
        Read publication result
      </button>
      <output aria-label="Publication result">{publication}</output>
    </main>
  );
}

async function steerDraftFollowup(setSteering) {
  const response = await fetch("/fixture/steer", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({
      kind: "steer",
      conversationId: "conv_aaaaaaaa-1111-4111-8111-111111111111",
      requestId: "request_draft_steering",
      inputId: "input_draft_steering",
      cancellationId: "cancel_draft_steering",
      model: "qwen/qwen3.7-flash",
      text: "Keep the serving note. Give a short review summary.",
    }),
  });
  if (!response.ok) throw new Error(await response.text());
  setSteering(JSON.stringify(await response.json()));
}

function renderPendingInput(input) {
  return <li key={input.inputId}>{input.text}</li>;
}

async function readTasks(setTasks, setPendingInputs, turnId) {
  const result = await responseJson(
    await fetch(`/fixture/tasks?turn=${encodeURIComponent(turnId)}`),
  );
  setTasks(result.items);
  setPendingInputs(parsePendingInputs(result.pendingInputs));
}

const router = createBrowserRouter([{ path: "*", element: <DraftJourney /> }]);
createRoot(document.getElementById("root")).render(
  <RouterProvider router={router} />,
);
