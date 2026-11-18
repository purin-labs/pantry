import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ActorSqliteDatabase } from "../../services/platform/src/actors/pi-durable-database.ts";
import { parsePortalInputIdentity } from "./portal-input-identity.mjs";
import {
  authorizePortalObservation,
  canObservePortal,
  preparePortalObservation,
} from "./portal-observation-fixture.mjs";

// This projection uses the existing Portal TaskList item shape. Raw native
// task inputs, checkpoints, arguments, and error text never cross this boundary.
export async function readPortalTaskItems(actor, request) {
  const observation = await authorizePortalObservation(actor, request);
  if (observation instanceof Response) return observation;
  const current = await preparePortalObservation(actor);
  if (observation.stream.turnId !== current.stream.turnId)
    return new Response("Task snapshot requires the current turn.", {
      status: 409,
    });
  const storage = await SqliteStorage.open(
    new ActorSqliteDatabase(actor.ctx.storage),
  );
  let snapshot;
  try {
    snapshot = await actor.ctx.storage.transaction(
      readSnapshot.bind(null, storage, actor.ctx.storage.sql),
    );
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
  }
  const latest = await preparePortalObservation(actor);
  if (observation.stream.turnId !== latest.stream.turnId)
    return new Response("Task snapshot changed turn.", { status: 409 });
  if (!(await canObservePortal(observation)))
    return new Response("Conversation unavailable.", { status: 403 });
  return Response.json(snapshot);
}

const MAX_TASKS_PER_GROUP = 100;

async function readSnapshot(storage, sql) {
  const pendingInputs = await readPendingInputs(storage);
  // The native scan API only supports ascending task IDs. Select a bounded
  // window here, then use the native reader to materialize each task.
  const active = sql
    .exec(
      "SELECT id FROM tasks WHERE conversation_id = ? AND status IN ('pending', 'running', 'waiting', 'sleeping', 'completing') ORDER BY id DESC LIMIT ?",
      ROOT_CONVERSATION_ID,
      MAX_TASKS_PER_GROUP + 1,
    )
    .toArray();
  const completed = sql
    .exec(
      "SELECT id FROM tasks WHERE conversation_id = ? AND status = 'terminal' ORDER BY id DESC LIMIT ?",
      ROOT_CONVERSATION_ID,
      MAX_TASKS_PER_GROUP + 1,
    )
    .toArray();
  const items = [];
  for (const row of [
    ...active.slice(0, MAX_TASKS_PER_GROUP),
    ...completed.slice(0, MAX_TASKS_PER_GROUP),
  ]) {
    const task = await storage.task(row.id, BACKGROUND_CONTEXT);
    if (task === undefined) throw new Error("Task disappeared from snapshot");
    items.push(portalTaskItem(task));
  }
  return {
    items,
    pendingInputs,
    tasksTruncated:
      active.length > MAX_TASKS_PER_GROUP ||
      completed.length > MAX_TASKS_PER_GROUP,
  };
}

async function readPendingInputs(storage) {
  const record = await storage.findDocument(
    {
      kind: InboxDoc.definition.kind,
      scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
    },
    "current",
    BACKGROUND_CONTEXT,
  );
  if (record === undefined) return [];
  const document = await storage.document(
    record.id,
    "current",
    BACKGROUND_CONTEXT,
  );
  const pending = [];
  for (const item of document.value.items) {
    if (item.mode === "write") continue;
    const submission = await storage.submission(item.id, BACKGROUND_CONTEXT);
    if (submission?.type !== "input" || submission.status !== "queued")
      continue;
    const identity = parsePortalInputIdentity(submission.requestId);
    if (identity === null) continue;
    if (typeof item.content !== "string")
      throw new Error("Unsupported admitted Portal input content");
    pending.push({
      inputId: identity.inputId,
      requestId: identity.requestId,
      mode: identity.mode,
      parts: [{ kind: "text", text: item.content }],
      acceptedAt: identity.acceptedAt,
    });
  }
  return pending;
}

function portalTaskItem(task) {
  return {
    id: `task_${task.id}`,
    label: taskLabel(task),
    state: taskState(task),
  };
}

function taskLabel(task) {
  switch (task.kind) {
    case "pi.generation":
      return "Response";
    case "pi.tool":
      return "Tool call";
    case "pi.compaction":
      return "Prepare context";
    default:
      return task.background ? "Background work" : "Task";
  }
}

function taskState(task) {
  switch (task.state.status) {
    case "pending":
      return { kind: "pending" };
    case "running":
    case "waiting":
    case "sleeping":
    case "completing":
      return { kind: "running", progress: null };
    case "terminal":
      switch (task.state.outcome.status) {
        case "completed":
          return { kind: "completed" };
        case "aborted":
          return { kind: "cancelled" };
        case "orphaned":
          return { kind: "blocked" };
        case "failed":
        case "faulted":
          return { kind: "failed" };
        default:
          throw new Error("Unsupported native task outcome");
      }
    default:
      throw new Error("Unsupported native task state");
  }
}
