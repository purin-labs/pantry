import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";

const abortOrder = [];
const OwnershipProbe = defineTask({
  name: "satyr.trial.ownership",
  version: 1,
  initial: initialProbe,
  phases: { waiting: waitForAbort },
  abort: abortProbe,
});

function initialProbe() {
  return { phase: "waiting" };
}

async function waitForAbort(task, runtime, context) {
  await runtime.sleepUntil(
    runtime.now() + 86_400_000,
    task.state.checkpoint,
    context,
  );
}

async function abortProbe(task, runtime, context) {
  abortOrder.push(task.input.name);
  await runtime.commit(finishProbe, context);
}

function finishProbe() {
  return { status: "terminal", outcome: { status: "aborted" } };
}

async function createProbeTasks(conversationId, tx) {
  const parent = await tx.createTask(
    OwnershipProbe,
    { name: "parent" },
    {
      ownership: { kind: "conversation" },
      conversationId,
    },
  );
  const child = await tx.createTask(
    OwnershipProbe,
    { name: "child" },
    {
      ownership: { kind: "task", taskId: parent },
    },
  );
  const background = await tx.createTask(
    OwnershipProbe,
    { name: "background" },
    {
      ownership: { kind: "conversation" },
      conversationId,
      background: true,
    },
  );
  return { parent, child, background };
}

async function readProbeTasks(harness, ids) {
  return {
    parent: await harness.getTask(ids.parent, BACKGROUND_CONTEXT),
    child: await harness.getTask(ids.child, BACKGROUND_CONTEXT),
    background: await harness.getTask(ids.background, BACKGROUND_CONTEXT),
  };
}

export async function exerciseTaskOwnership(harness, registry) {
  const extension = defineExtension({
    name: "satyr.trial.ownership",
    tasks: [OwnershipProbe],
  });
  registry.install(extension);
  abortOrder.length = 0;
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
    },
    BACKGROUND_CONTEXT,
  );
  const ids = await harness.commit(
    createProbeTasks.bind(null, conversation.id),
    BACKGROUND_CONTEXT,
  );
  await conversation.abort(BACKGROUND_CONTEXT);
  const ordinary = await readProbeTasks(harness, ids);
  await conversation.abort(BACKGROUND_CONTEXT, { background: true });
  const all = await readProbeTasks(harness, ids);
  registry.uninstall(extension);
  return { ids, ordinary, all, abortOrder: [...abortOrder] };
}

export async function createTaskHistoryFixture(
  harness,
  registry,
  conversationId,
) {
  registry.install(
    defineExtension({ name: "satyr.trial.ownership", tasks: [OwnershipProbe] }),
  );
  const ids = await harness.commit(
    createHistoryTasks.bind(null, conversationId),
    BACKGROUND_CONTEXT,
  );
  for (const id of ids.slice(0, -1))
    await harness.abortTask(id, BACKGROUND_CONTEXT);
  return { completed: ids.slice(0, -1), active: ids.at(-1) };
}

async function createHistoryTasks(conversationId, tx) {
  const ids = [];
  for (let index = 0; index < 126; index += 1) {
    ids.push(
      await tx.createTask(
        OwnershipProbe,
        { name: `history_${index}` },
        {
          ownership: { kind: "conversation" },
          conversationId,
          background: true,
        },
      ),
    );
  }
  return ids;
}
