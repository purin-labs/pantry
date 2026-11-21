// Starts the Kitchen run fixture Worker (Plan 81) and answers every
// request it sends out. The model provider is simulated here, in this
// process: it only answers each model request with the next tool call of a
// fixed script, built from the tool results that Pantry returned. Pantry and
// the Portal produce every outcome that the journey checks.
import {
  json,
  startFixtureWorker,
  stopOnSignal,
  stream,
} from "../lib/fixture-worker.mjs";
import { writeFileSync } from "node:fs";
import { sleep } from "../../packages/std/src/index.ts";

const [config, persistence, evidencePath] = process.argv.slice(2);

const MODEL = "https://openrouter.ai/api/v1/chat/completions";
const CONTROL = "https://kitchen-fixture.internal";
// The journey's words. The browser journey sends RUN, then RERUN.
const RUN =
  "Run the shift with two financier batches, then step to the next event and play it.";
const RERUN = "Re-run the shift with the applied inputs.";
const OBSERVED = "Re-run the shift from the draft that you can see.";
const IN_PROSE = "Run the shift and answer in your own words.";
const PROSE_ANSWER = "The shift ran. The page shows 2 batches late.";
const OBSERVED_ANSWER = "I re-ran the shift from the draft that I can see.";
const WHILE_EDITED = "Run the shift while I change an input.";
const QUEUE_FIRST = "Run the shift while I queue another request.";
const QUEUE_FIRST_ANSWER = "I ran the shift. Your queued request is next.";
const QUEUE_SECOND =
  "Then run the shift once more from the draft that you see.";
const QUEUE_SECOND_ANSWER = "I ran the shift again from the newest draft.";
const LAYOUT =
  "Select the cooling station, turn the cooling rack a quarter turn and compare the oven outage.";
const OPEN = "Open the financier production run with the procedure inputs.";
const OPEN_ANSWER =
  "I opened the financier production run with the procedure inputs.";
const SIMULATE = "Simulate the next robot step and accept its result.";
const SIMULATE_ANSWER =
  "I simulated the next robot step and accepted its result.";
const APPLY = "Plan for an oven outage, preview it and apply it as a new run.";
const APPLIED_ANSWER = "I applied the oven-outage preview as a new run.";
const REVIEW_ANSWER =
  "The run holds an accepted result, so the replacement waits for your review in Edit scenario.";
const LAYOUT_ANSWER =
  "I selected Cooling, turned the cooling rack a quarter turn and opened the oven-outage comparison.";
const FLOOR_PLAN =
  "Switch the floor plan to Kinshicho, apply the Parisian Noix interior, open the toilet door, move the cooling rack to (100, -200) mm at 45 degrees and undo that angle.";
const FLOOR_PLAN_ANSWER =
  "I switched to Kinshicho, applied the Parisian Noix interior, opened the toilet door, moved the cooling rack to (100, -200) mm, turned it to 45 degrees and undid the angle.";
const FLOOR_PLAN_RESET = "Reset the floor plan to its initial layout.";
const FLOOR_PLAN_RESET_ANSWER = "I reset the floor plan to its initial layout.";
const MEMBER_FLOOR_PLAN = "As a member, switch the floor plan to Kinshicho.";
const MEMBER_REFUSED_ANSWER =
  "Only an owner or administrator can control the Kitchen floor plan.";
const RUN_ANSWER =
  "I ran the shift with two financier batches, stepped to the next event and started playback.";

const MENU = "Add a Coffee section to the menu.";
const MENU_AGAIN = "Please add the Coffee section again.";
const MENU_ASKED =
  "Seams Pantry asked you for approval in this chat. Ask me again after you allow it.";
const MENU_ANSWER = "I added a Coffee section to the menu.";
// The permission toast journey: menu editing is off, so the agent asks.
const MENU_PERMISSION = "Turn on menu editing, then add a Coffee section.";

// Agents on the canvas (Plan 40B phase 7): the agent edits the open board,
// one edit for each request. A private chat holds each edit until the owner
// allows it, so the journey sends each request twice.
const BOARD_MOVE = "Move the board heading down a little.";
const BOARD_RESIZE = "Make the board heading bigger.";
const BOARD_ADD = "Add a note under the board heading.";
const BOARD_WRITE = "Change the note to say until 11:00.";
const BOARD_DONE = "I changed the board.";
// Slice 6: the owner stops this request from the board's presence bar.
const BOARD_STOP = "Add a long welcome note under the board heading.";
const BOARD_STOP_TEXT =
  "Welcome to our café. Today we bake croissants, pain au chocolat and seasonal tarts every morning.";
const BOARD_NOTE = "Oat milk is free today";
const BOARD_NOTE_AFTER = "Oat milk is free until 11:00";

const state = {
  paused: new Set(),
  modelRequests: [],
  invalidAnswers: new Set(),
  holding: false,
  release: null,
  held: new Set(),
};

function record() {
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        calls: state.modelRequests,
      },
      null,
      2,
    ) + "\n",
  );
}
record();

function chunkBase(id) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1_787_500_000,
    model: "moonshotai/kimi-k3",
  };
}

function modelText(content, id) {
  const base = chunkBase(id);
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}

function modelToolCall(name, args, callId) {
  const base = chunkBase(`chatcmpl_${callId}`);
  return stream([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    },
  ]);
}

/** The order of menu_board_edit's fields, as a model writes them. */
const BOARD_EDIT_ORDER = [
  "kind",
  "boardId",
  "elementId",
  "frameId",
  "x",
  "y",
  "width",
  "height",
  "prop",
  "before",
  "text",
  "title",
  "itemId",
  "order",
];
const PART_MS = 110;
const LETTERS_MS = 160;
const THINK_MS = 1_200;

/**
 * A tool call whose arguments arrive in parts, as a real model streams
 * them (Plan 40B phase 7): one part for each field, a pause after the rect,
 * then the text two letters at a time. The parts are cut from the one JSON
 * text of the arguments, so they join to exactly what the model sent.
 */
function modelToolCallInParts(name, args, callId) {
  const ordered = Object.fromEntries(
    BOARD_EDIT_ORDER.filter((key) => Object.hasOwn(args, key)).map((key) => [
      key,
      args[key],
    ]),
  );
  const full = JSON.stringify(ordered);
  const parts = [];
  let at = 0;
  for (const key of Object.keys(ordered)) {
    const start = full.indexOf(`"${key}":`, at);
    const valueStart = start + key.length + 3;
    const value = JSON.stringify(ordered[key]);
    const end = valueStart + value.length;
    if (typeof ordered[key] === "string" && key === "text") {
      parts.push({ text: full.slice(at, valueStart + 1), delay: THINK_MS });
      for (let index = valueStart + 1; index < end - 1; index += 2)
        parts.push({
          text: full.slice(index, Math.min(index + 2, end - 1)),
          delay: LETTERS_MS,
        });
      at = end - 1;
    } else {
      parts.push({ text: full.slice(at, end), delay: PART_MS });
      at = end;
    }
  }
  parts.push({ text: full.slice(at), delay: PART_MS });
  const base = chunkBase(`chatcmpl_${callId}`);
  const chunks = [
    {
      chunk: {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      delay: 0,
    },
    ...parts.map((part) => ({
      chunk: {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: part.text } }],
            },
            finish_reason: null,
          },
        ],
      },
      delay: part.delay,
    })),
    {
      chunk: {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
      delay: PART_MS,
    },
  ];
  if (parts.map((part) => part.text).join("") !== full)
    throw new Error("The parts do not join to the arguments");
  const encoder = new TextEncoder();
  return {
    parts: parts.length,
    response: new Response(
      new ReadableStream({
        async start(controller) {
          for (const { chunk, delay } of chunks) {
            if (delay > 0) await sleep(delay);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  };
}

function reply(answer, id) {
  return modelText(JSON.stringify({ kind: "reply", text: answer }), id);
}

/** The messages of the current turn: those after the person's request. */
function turnMessages(body) {
  const messages = body.messages ?? [];
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1)
    if (messages[index]?.role === "user") {
      start = index;
      break;
    }
  return messages.slice(start);
}

/** The person's request of this turn, as Pantry quotes it to the model. */
function currentRequest(body) {
  const content = JSON.stringify(turnMessages(body)[0]?.content ?? "");
  const at = content.indexOf("Current user request");
  return at < 0 ? content : content.slice(at);
}

/** The tool calls of this turn with their results, in order. */
function turnCalls(body) {
  const calls = [];
  const results = new Map();
  for (const message of turnMessages(body)) {
    for (const call of message.tool_calls ?? [])
      calls.push({ id: call.id, name: call.function?.name ?? "" });
    if (message.role === "tool")
      results.set(message.tool_call_id, message.content);
  }
  return calls.map((call) => ({ ...call, result: results.get(call.id) }));
}

/** Every object inside a tool result, including JSON held in strings. */
function* objects(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        yield* objects(JSON.parse(trimmed));
      } catch {
        // Text that is not JSON holds no object.
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* objects(item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  yield value;
  for (const item of Object.values(value)) yield* objects(item);
}

/** The draft reference that bakery_surface_read_draft returned. */
function draftReference(result) {
  for (const value of objects(result))
    if (
      value.kind === "draft" &&
      typeof value.draft?.reference?.digest === "string"
    )
      return value.draft.reference;
  throw new Error("The draft read returned no draft reference");
}

/**
 * The draft reference in the Kitchen observation of this model request:
 * what a model that reads no draft first has.
 */
function observedDraft(body) {
  const content = turnMessages(body)[0]?.content ?? "";
  const text =
    typeof content === "string"
      ? content
      : content.map((part) => part.text ?? "").join("");
  const at = text.indexOf("Kitchen observation");
  const found = /"draft":\{"revision":(\d+),"digest":"([0-9a-f]{64})"\}/u.exec(
    text.slice(at),
  );
  if (at < 0 || found === null)
    throw new Error("The model request holds no observed draft");
  return { revision: Number(found[1]), digest: found[2] };
}

/** The step that the attached production run awaits. */
function pendingMode(result) {
  for (const value of objects(result))
    if (typeof value.pendingOperation?.mode === "string")
      return value.pendingOperation.mode;
  throw new Error("The production run awaits no step");
}

/** The unaccepted production result that a simulation left. */
function productionCandidate(result) {
  for (const value of objects(result))
    if (value.candidate?.kind === "production") return value.candidate;
  throw new Error("The simulation left no candidate");
}

/** True when an apply opened the operator's replacement review. */
function reviewOpened(result) {
  for (const value of objects(result))
    if (value.replacement?.source === "preview") return true;
  return false;
}

/** The refusal of a Kitchen command, if Pantry refused it. */
function refusal(result) {
  for (const value of objects(result))
    if (value.kind === "rejected" && typeof value.message === "string")
      return value.message;
  return null;
}

/**
 * The fixed script of each turn. A step names a tool and builds its
 * arguments from the earlier results of the turn. A large catalogue offers a
 * Kitchen tool after a search, as a real model sees it.
 */
function menuEdit(fields) {
  return {
    itemId: null,
    sectionId: null,
    productId: null,
    title: null,
    description: null,
    order: null,
    ...fields,
  };
}

/** The first board of a menu_board_read with its canvas rects. */
function boardOf(result) {
  for (const value of objects(result))
    if (Array.isArray(value.boards) && value.boards[0]?.boardId)
      return value.boards[0];
  throw new Error("The board read returned no board");
}

/** The board's heading and its rect on the canvas. */
function headingOf(result) {
  const board = boardOf(result);
  const heading = board.elements.find((element) => element.kind === "heading");
  const rect = board.canvasRects?.[heading?.id];
  if (heading === undefined || rect === undefined)
    throw new Error("The board has no heading on its canvas");
  return { boardId: board.boardId, elementId: heading.id, rect };
}

function boardEdit(fields) {
  return {
    elementId: null,
    prop: null,
    before: null,
    text: null,
    title: null,
    itemId: null,
    frameId: null,
    order: null,
    x: null,
    y: null,
    width: null,
    height: null,
    ...fields,
  };
}

/** The board's note and its text. */
function noteOf(result) {
  const board = boardOf(result);
  const note = board.elements.find(
    (element) => element.kind === "text" && element.text === BOARD_NOTE,
  );
  if (note === undefined) throw new Error("The board has no note");
  return { boardId: board.boardId, elementId: note.id };
}

/** A turn that reads the board, then makes one edit. */
function boardScript(request, turn, edit) {
  return {
    request,
    turn,
    // A held step ends the turn: the model does not try it again.
    endWhenStopped: true,
    answer: (calls) =>
      calls.some((call) =>
        String(call.result).includes("Seams Pantry stopped this step"),
      )
        ? MENU_ASKED
        : BOARD_DONE,
    steps: [
      { tool: "menu_board_read", args: () => ({ boardId: null }) },
      {
        tool: "menu_board_edit",
        args: (calls) => edit(calls[0].result),
        inParts: true,
      },
    ],
  };
}

const SCRIPTS = [
  boardScript(BOARD_MOVE, "board-move", (result) => {
    const { boardId, elementId, rect } = headingOf(result);
    return boardEdit({
      kind: "place_on_canvas",
      boardId,
      elementId,
      x: rect.x,
      y: rect.y + 60,
      width: rect.width,
      height: rect.height,
    });
  }),
  boardScript(BOARD_RESIZE, "board-resize", (result) => {
    const { boardId, elementId, rect } = headingOf(result);
    return boardEdit({
      kind: "place_on_canvas",
      boardId,
      elementId,
      x: rect.x,
      y: rect.y,
      width: Math.round(rect.width * 0.75),
      height: rect.height + 60,
    });
  }),
  boardScript(BOARD_ADD, "board-add", (result) => {
    const { boardId, rect } = headingOf(result);
    return boardEdit({
      kind: "add_text",
      boardId,
      frameId: "canvas",
      text: BOARD_NOTE,
      x: rect.x,
      y: rect.y + rect.height + 40,
      width: 640,
      height: 96,
    });
  }),
  boardScript(BOARD_STOP, "board-stop", (result) => {
    const { boardId, rect } = headingOf(result);
    return boardEdit({
      kind: "add_text",
      boardId,
      frameId: "canvas",
      text: BOARD_STOP_TEXT,
      x: rect.x + 700,
      y: rect.y + rect.height + 40,
      width: 640,
      height: 160,
    });
  }),
  boardScript(BOARD_WRITE, "board-write", (result) => {
    const { boardId, elementId } = noteOf(result);
    return boardEdit({
      kind: "set_text",
      boardId,
      elementId,
      prop: "text",
      before: BOARD_NOTE,
      text: BOARD_NOTE_AFTER,
    });
  }),
  {
    request: MENU_PERMISSION,
    turn: "menu-permission",
    // The run pauses on the request; the resume runs the step again.
    pauseAfter: 1,
    pauseAnswer:
      "I asked for menu editing. The request continues here after you allow it.",
    answer: (calls) =>
      calls.some((call) =>
        String(call.result).includes("Seams Pantry stopped this step"),
      )
        ? MENU_ASKED
        : MENU_ANSWER,
    steps: [
      {
        tool: "request_permission",
        args: () => ({
          capabilityIds: [
            "commerce.menu_draft.read",
            "commerce.menu_draft.edit",
          ],
          entityTypeReads: [],
        }),
      },
      {
        tool: "menu_draft_edit",
        args: () => menuEdit({ kind: "add_section", title: "Coffee" }),
      },
    ],
  },
  {
    request: MENU,
    turn: "menu-asks",
    answer: (calls) =>
      String(calls[0]?.result).includes("Seams Pantry stopped this step")
        ? MENU_ASKED
        : MENU_ANSWER,
    steps: [
      {
        tool: "menu_draft_edit",
        args: () => menuEdit({ kind: "add_section", title: "Coffee" }),
      },
    ],
  },
  {
    request: MENU_AGAIN,
    turn: "menu-allowed",
    answer: (calls) =>
      String(calls[0]?.result).includes("Seams Pantry stopped this step")
        ? MENU_ASKED
        : MENU_ANSWER,
    steps: [
      {
        tool: "menu_draft_edit",
        args: () => menuEdit({ kind: "add_section", title: "Coffee" }),
      },
    ],
  },
  {
    request: RUN,
    turn: "run",
    steps: [
      { tool: "bakery_surface_read_draft", args: () => ({}) },
      {
        tool: "bakery_surface_run_shift",
        args: (calls) => ({
          baseDraft: draftReference(calls[0].result),
          edits: [{ kind: "set_assumption", field: "batchCount", value: 2 }],
        }),
      },
      {
        tool: "bakery_surface_control_playback",
        args: () => ({ action: { kind: "next_event" } }),
      },
      {
        tool: "bakery_surface_control_playback",
        args: () => ({ action: { kind: "play" } }),
      },
    ],
  },
  {
    request: RERUN,
    turn: "rerun",
    steps: [
      { tool: "bakery_surface_read_draft", args: () => ({}) },
      {
        tool: "bakery_surface_run_shift",
        args: (calls) => ({
          baseDraft: draftReference(calls[0].result),
          edits: [],
        }),
      },
    ],
  },
  // As the real model did on 2026-11-02: it runs from the draft in its
  // observation, then answers in prose. Prose is the answer.
  {
    request: IN_PROSE,
    turn: "in-prose",
    prose: PROSE_ANSWER,
    steps: [
      {
        tool: "bakery_surface_run_shift",
        args: (_calls, body) => ({
          baseDraft: observedDraft(body),
          edits: [],
        }),
      },
    ],
  },
  // An invalid action makes the chat ask again in a second step of the same
  // request. The model runs from the observation of that step.
  {
    request: OBSERVED,
    turn: "observed",
    invalidFirst: true,
    answer: OBSERVED_ANSWER,
    steps: [
      {
        tool: "bakery_surface_run_shift",
        args: (_calls, body) => ({
          baseDraft: observedDraft(body),
          edits: [],
        }),
      },
    ],
  },
  // The model waits for the journey here, so that the owner changes the draft
  // after the message was sent and before the run reaches the page.
  {
    request: WHILE_EDITED,
    turn: "while-edited",
    hold: true,
    steps: [
      {
        tool: "bakery_surface_run_shift",
        args: (_calls, body) => ({
          baseDraft: observedDraft(body),
          edits: [],
        }),
      },
    ],
  },
  // The model waits while the journey queues a second message. That message
  // captured the page before this run changed the draft.
  {
    request: QUEUE_FIRST,
    turn: "queue-first",
    hold: true,
    answer: QUEUE_FIRST_ANSWER,
    steps: [
      {
        tool: "bakery_surface_run_shift",
        args: (_calls, body) => ({
          baseDraft: observedDraft(body),
          edits: [],
        }),
      },
    ],
  },
  {
    request: QUEUE_SECOND,
    turn: "queue-second",
    answer: QUEUE_SECOND_ANSWER,
    steps: [
      {
        tool: "bakery_surface_run_shift",
        args: (_calls, body) => ({
          baseDraft: observedDraft(body),
          edits: [],
        }),
      },
    ],
  },
  {
    request: OPEN,
    turn: "open",
    answer: OPEN_ANSWER,
    steps: [
      {
        tool: "bakery_surface_start_production",
        args: () => ({ preset: "procedure" }),
      },
    ],
  },
  {
    request: SIMULATE,
    turn: "simulate",
    answer: SIMULATE_ANSWER,
    steps: [
      { tool: "bakery_surface_inspect", args: () => ({}) },
      {
        tool: "bakery_surface_simulate_workcell",
        args: (calls) => ({ mode: pendingMode(calls[0].result) }),
      },
      {
        tool: "bakery_surface_accept_candidate",
        args: (calls) => ({ candidate: productionCandidate(calls[1].result) }),
      },
    ],
  },
  {
    request: APPLY,
    turn: "apply",
    answer: (calls) =>
      reviewOpened(calls[2].result) ? REVIEW_ANSWER : APPLIED_ANSWER,
    steps: [
      {
        tool: "bakery_surface_edit_production",
        args: () => ({ edit: { kind: "set_variant", variant: "outage" } }),
      },
      { tool: "bakery_surface_preview_production", args: () => ({}) },
      { tool: "bakery_surface_apply_production", args: () => ({}) },
    ],
  },
  {
    request: LAYOUT,
    turn: "layout",
    answer: LAYOUT_ANSWER,
    steps: [
      {
        tool: "bakery_surface_select",
        args: () => ({ selection: { kind: "station", id: "cool" } }),
      },
      {
        tool: "bakery_surface_rotate_equipment",
        args: () => ({ applianceId: "cool" }),
      },
      {
        tool: "bakery_surface_compare_shift",
        args: () => ({ mode: "outage" }),
      },
    ],
  },
  {
    request: FLOOR_PLAN,
    turn: "floor-plan",
    answer: FLOOR_PLAN_ANSWER,
    steps: [
      {
        tool: "bakery_surface_select_floor_plan",
        args: () => ({ floorPlan: "kinshicho-6992842011" }),
      },
      {
        tool: "bakery_surface_configure_interior",
        args: () => ({
          action: { kind: "apply_preset", preset: "noix-parisien" },
        }),
      },
      {
        tool: "bakery_surface_toggle_opening",
        args: () => ({ openingId: "door:door-toilet", open: true }),
      },
      {
        tool: "bakery_surface_move_equipment",
        args: () => ({ applianceId: "cool", xMm: 100, zMm: -200 }),
      },
      {
        tool: "bakery_surface_set_equipment_angle",
        args: () => ({ applianceId: "cool", yawDegrees: 45 }),
      },
      {
        tool: "bakery_surface_reset_floor_plan",
        args: () => ({ action: "undo" }),
      },
    ],
  },
  {
    request: FLOOR_PLAN_RESET,
    turn: "floor-plan-reset",
    answer: FLOOR_PLAN_RESET_ANSWER,
    steps: [
      {
        tool: "bakery_surface_reset_floor_plan",
        args: () => ({ action: "reset_initial" }),
      },
    ],
  },
  {
    request: MEMBER_FLOOR_PLAN,
    turn: "member-floor-plan",
    answer: MEMBER_REFUSED_ANSWER,
    forbidSurfaceTools: true,
    steps: [],
  },
];

/** The model waits until the journey releases it. */
function holdModel() {
  return new Promise((resolve) => {
    state.holding = true;
    state.release = resolve;
  });
}

async function model(request) {
  const body = await request.json();
  const current = currentRequest(body);
  const script = SCRIPTS.find((candidate) =>
    current.includes(candidate.request),
  );
  if (script === undefined)
    throw new Error(`Unexpected model request: ${current.slice(0, 200)}`);
  const offered = (body.tools ?? []).map((tool) => tool.function?.name);
  const id = `kitchen_${state.modelRequests.length + 1}`;
  if (script.forbidSurfaceTools === true) {
    const surfaceOffered = offered.filter(
      (name) => typeof name === "string" && name.startsWith("bakery_surface_"),
    );
    if (surfaceOffered.length > 0)
      throw new Error(
        `Unauthorized surface tools offered to non-admin: ${surfaceOffered.join(", ")}`,
      );
    const searchCalls = turnCalls(body).filter(
      (call) => call.name === "tool_search",
    );
    if (offered.includes("tool_search") && searchCalls.length === 0) {
      state.modelRequests.push({
        turn: script.turn,
        call: "tool_search",
        query: "bakery_surface_select_floor_plan",
        surfaceToolsOffered: 0,
      });
      record();
      return modelToolCall(
        "tool_search",
        { query: "bakery_surface_select_floor_plan" },
        id,
      );
    }
    state.modelRequests.push({
      turn: script.turn,
      answer: script.answer,
      surfaceToolsOffered: 0,
      tools: [],
    });
    record();
    return reply(script.answer, id);
  }
  const calls = turnCalls(body).filter((call) => call.name !== "tool_search");
  const refused = calls.map((call) => refusal(call.result)).find(Boolean);
  const stopped =
    script.endWhenStopped === true &&
    calls.some((call) =>
      String(call.result).includes("Seams Pantry stopped this step"),
    );
  const step = stopped ? undefined : script.steps[calls.length];
  if (script.pauseAfter === calls.length && !state.paused.has(script.turn)) {
    state.paused.add(script.turn);
    state.modelRequests.push({ turn: script.turn, answer: script.pauseAnswer });
    record();
    return reply(script.pauseAnswer, id);
  }
  if (!refused && step === undefined && script.prose !== undefined) {
    state.modelRequests.push({ turn: script.turn, prose: script.prose });
    record();
    return modelText(script.prose, id);
  }
  if (
    !refused &&
    step === undefined &&
    script.invalidFirst === true &&
    !state.invalidAnswers.has(script.turn)
  ) {
    state.invalidAnswers.add(script.turn);
    state.modelRequests.push({ turn: script.turn, invalid: true });
    record();
    return reply("", id);
  }
  if (refused || step === undefined) {
    const answer = refused
      ? `Kitchen refused the run: ${refused}`
      : typeof script.answer === "function"
        ? script.answer(calls)
        : (script.answer ?? RUN_ANSWER);
    state.modelRequests.push({
      turn: script.turn,
      answer,
      tools: calls.map((call) => call.name),
      results: calls.map((call) => String(call.result).slice(0, 400)),
    });
    record();
    return reply(answer, id);
  }
  if (!offered.includes(step.tool)) {
    if (turnCalls(body).at(-1)?.name === "tool_search")
      throw new Error(`The search did not offer ${step.tool}`);
    state.modelRequests.push({
      turn: script.turn,
      call: "tool_search",
      query: step.tool,
    });
    record();
    return modelToolCall("tool_search", { query: step.tool, limit: 8 }, id);
  }
  if (script.hold === true && !state.held.has(script.turn)) {
    state.held.add(script.turn);
    await holdModel();
  }
  const args = step.args(calls, body);
  if (step.inParts === true) {
    const streamed = modelToolCallInParts(step.tool, args, id);
    state.modelRequests.push({
      turn: script.turn,
      call: step.tool,
      args,
      parts: streamed.parts,
    });
    record();
    return streamed.response;
  }
  state.modelRequests.push({ turn: script.turn, call: step.tool, args });
  record();
  return modelToolCall(step.tool, args, id);
}

/** The journey's own request: what the model was asked. */
function control(request, url) {
  if (request.method === "GET" && url.pathname === "/state") {
    record();
    return json({
      modelRequests: state.modelRequests,
      holding: state.holding,
    });
  }
  if (request.method === "POST" && url.pathname === "/release") {
    const release = state.release;
    state.holding = false;
    state.release = null;
    release?.();
    return json({ released: true });
  }
  throw new Error(`Unexpected control request: ${request.url}`);
}

async function respond(request) {
  const url = new URL(request.url);
  if (request.url === MODEL) return model(request);
  if (request.url.startsWith(CONTROL)) return control(request, url);
  throw new Error(`Unexpected external request: ${request.url}`);
}

const worker = await startFixtureWorker({
  config,
  persistence,
  port: 8881,
  respond,
});
stopOnSignal(worker);
