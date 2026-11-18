import { parseBakeryProductionControl } from "@seams/bakery-model/bakery-surface";
import {
  isBakeryFloorPlanResetAction,
  normalizeYawDegrees,
  parseBakeryFileAction,
  parseBakeryStoreInteriorAction,
} from "@seams/bakery-model/bakery-surface";
import {
  parseBakerySurfaceCommand,
  parseBakeryPlaybackAction,
  parseBakeryProductionPanel,
  parseBakeryWorkspaceViewAction,
  parseBakeryWorkcellPreparation,
  parseBakerySurfaceReceipt,
  parseScenarioSaveManifest,
  parseRecordingAcceptanceReference,
  type BakerySurfaceToolCommandName,
} from "@seams/bakery-model/bakery-surface";
import { parseRunSnapshotSummary } from "@seams/bakery-model/bakery-run-snapshot";
import { KITCHEN_SURFACE } from "@seams/control-api";
import type { AgentRunSaveVerification } from "../../commerce/bakery/agent-run-save";
import type { AgentScenarioSaveResult } from "../../commerce/bakery/agent-scenario-save";
import { assertNever, hasExactKeys, isRecord } from "@seams/std";
import type {
  HarnessBakerySurfaceToolRequest,
  HarnessBakerySurfaceToolResult,
} from "../catalog/types";
import { defineTool, jsonSchema } from "../define-tool";

export const BAKERY_DIRECT_CALL_GUIDANCE =
  "Call Kitchen browser tools directly after tool discovery, outside Code Mode. Their accepted call owns durable preparation and recovery.";

export type BakerySurfaceHarnessToolName =
  | "bakery_surface_inspect"
  | "bakery_surface_read_draft"
  | "bakery_surface_query_tasks"
  | "bakery_surface_set_view"
  | "bakery_surface_control_baseline"
  | "bakery_surface_show_production_panel"
  | "bakery_surface_control_workspace_view"
  | "bakery_surface_control_playback"
  | "bakery_surface_prepare_workcell"
  | "bakery_surface_prepare_layout"
  | "bakery_surface_prepare_production_control"
  | "bakery_surface_prepare_edit"
  | "bakery_surface_run_shift"
  | "bakery_surface_select"
  | "bakery_surface_rotate_equipment"
  | "bakery_surface_set_equipment_angle"
  | "bakery_surface_move_equipment"
  | "bakery_surface_toggle_opening"
  | "bakery_surface_select_floor_plan"
  | "bakery_surface_configure_interior"
  | "bakery_surface_reset_floor_plan"
  | "bakery_surface_compare_shift"
  | "bakery_surface_start_production"
  | "bakery_surface_prepare_run_save"
  | "bakery_surface_file"
  | "bakery_surface_inspect_scenario_save"
  | "bakery_surface_inspect_run_save"
  | "bakery_surface_list_saved_runs"
  | "bakery_surface_prepare_run_open"
  | "bakery_surface_prepare_scenario_save"
  | "bakery_surface_stop_simulation"
  | "bakery_surface_simulate_workcell"
  | "bakery_surface_accept_candidate"
  | "bakery_surface_discard_candidate"
  | "bakery_surface_edit_rehearsal"
  | "bakery_surface_edit_production"
  | "bakery_surface_preview_production"
  | "bakery_surface_apply_production";

export const surfaceInspect = defineTool({
  name: "bakery_surface_inspect",
  description:
    "Read the attached Kitchen workspace, including selected task timing, resource constraints and source identity. saveVerification reports the latest verified rehearsal run; scenarioSaveResult reports the latest canonical scenario save result for this operator and surface.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_inspect", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "inspect_surface",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceReadDraft = defineTool({
  name: "bakery_surface_read_draft",
  description:
    "Read the exact current Kitchen shift draft values with their revision and digest. Use this before calculating a relative edit.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_read_draft", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "read_draft",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceQueryTasks = defineTool({
  name: "bakery_surface_query_tasks",
  description:
    "Find up to eight Kitchen shift tasks matching a bounded text filter without loading the full schedule.",
  input: jsonSchema({
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 160 },
      limit: { type: "integer", minimum: 1, maximum: 8 },
    },
    required: ["text", "limit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_query_tasks", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "query_tasks",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareWorkcell = defineTool({
  name: "bakery_surface_prepare_workcell",
  description:
    "Prepare a one-tray robot rehearsal on the production scheduler from an installed example or the recording already open in the canvas. The tray's steps start without results; dispatch time becomes its earliest staging time, a whole number of seconds from 0 to 43200. Replaces an open rehearsal run but keeps unresolved saves. Examples are prerecorded reference data; preparation does not simulate, accept evidence or save. Call simulate_workcell separately for each new MuJoCo result.",
  input: jsonSchema({
    type: "object",
    properties: {
      preparation: {
        anyOf: [
          {
            type: "object",
            properties: {
              source: { type: "string", enum: ["example"] },
              example: {
                type: "string",
                enum: [
                  "table-to-rack",
                  "table-to-oven",
                  "oven-cycle",
                  "rack-cycle",
                ],
              },
              dispatchSeconds: {
                type: "integer",
                minimum: 0,
                maximum: 43200,
              },
            },
            required: ["source", "example", "dispatchSeconds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              source: { type: "string", enum: ["recording"] },
              dispatchSeconds: {
                type: "integer",
                minimum: 0,
                maximum: 43200,
              },
            },
            required: ["source", "dispatchSeconds"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["preparation"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_prepare_workcell", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_workcell",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceStopSimulation = defineTool({
  name: "bakery_surface_stop_simulation",
  description:
    "Stop the exact browser simulation attached to this chat, including one started by the operator. Completed tasks and accepted evidence are preserved. An old stop request cannot cancel a restarted or different operation.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_stop_simulation", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "stop_simulation",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceControlWorkspaceView = defineTool({
  name: "bakery_surface_control_workspace_view",
  description:
    "Control the attached workspace view: open a dock (inspector is Details, inputs is its Inputs tab, floorPlan is Floor plan, comparison is Compare shifts), set overhead/perspective camera, recenter, set labels, show/hide the corner map or interface, or reset the view. Uses the same controls as clicks. Camera and recenter are available in Shift, production, rehearsal and the recording viewer. The recording viewer also supports cell, current recorded task, currently selected equipment, operator-height camera views, and inspectionOverhead (selected equipment or the robot cell). setDoorPreview previews an oven door at an integer angle from 0 to 110 degrees and pauses recording playback; degrees: null restores its recorded pose. This visual pose never changes simulation evidence. Docks, labels, minimap, interface visibility and full view reset are available in Shift.",
  input: jsonSchema({
    type: "object",
    properties: {
      action: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["openDock"],
              },
              dock: {
                type: "string",
                enum: [
                  "closed",
                  "workflow",
                  "inputs",
                  "inspector",
                  "timeline",
                  "scenarios",
                  "comparison",
                  "floorPlan",
                ],
              },
            },
            required: ["kind", "dock"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["setCamera"],
              },
              camera: {
                type: "string",
                enum: [
                  "perspective",
                  "overhead",
                  "cell",
                  "task",
                  "selection",
                  "operator",
                  "inspectionOverhead",
                ],
              },
            },
            required: ["kind", "camera"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["setDoorPreview"] },
              degrees: {
                type: ["integer", "null"],
                minimum: 0,
                maximum: 110,
              },
            },
            required: ["kind", "degrees"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["setLabels"],
              },
              labels: {
                type: "string",
                enum: ["auto", "all", "off"],
              },
            },
            required: ["kind", "labels"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["setMinimap"],
              },
              visible: {
                type: "boolean",
              },
            },
            required: ["kind", "visible"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["setChrome"],
              },
              chrome: {
                type: "string",
                enum: ["shown", "hidden"],
              },
            },
            required: ["kind", "chrome"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["resetCamera"],
              },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["resetView"],
              },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest(
      "bakery_surface_control_workspace_view",
      input,
    ),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "control_workspace_view",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceShowProductionPanel = defineTool({
  name: "bakery_surface_show_production_panel",
  description:
    "Open a panel in the attached financier production run or scheduled rehearsal: workflow, timeline, files, details, or author (Edit scenario / Edit trays). Opening author or files only shows controls; it never edits, accepts evidence or confirms a proposal. Playback and pending work are preserved.",
  input: jsonSchema({
    type: "object",
    properties: {
      panel: {
        type: "string",
        enum: ["workflow", "timeline", "files", "details", "author"],
      },
    },
    required: ["panel"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest(
      "bakery_surface_show_production_panel",
      input,
    ),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "show_production_panel",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceControlBaseline = defineTool({
  name: "bakery_surface_control_baseline",
  description:
    "Pin the displayed rehearsal or financier run (including a displayed draft preview) as the comparison baseline, or clear it. Uses the exact comparison attached to this turn. Inspect comparison.current and comparison.baseline for measures. Baselines are session-local; this neither changes the plan nor saves a run.",
  input: jsonSchema({
    type: "object",
    properties: { action: { type: "string", enum: ["pin", "clear"] } },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_control_baseline", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "control_baseline",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceControlPlayback = defineTool({
  name: "bakery_surface_control_playback",
  description:
    "Control playback in the attached shift, rehearsal or production run, as the Play shift, Next event, Restart and Speed controls do: explicit play/pause, seek (run seconds), restart, next event, or speed. In a shift, play runs the calculated shift forward from the cursor; to recalculate it with new inputs, call bakery_surface_run_shift first. Playback never saves a run or runs a robot workcell. Shift speeds: 30/120. Workcell: 0.25/0.5/1/2/30/120. Standalone recording: 0.25/0.5/1/2. Multi-tray: 1/4/16. Production: fixed at 120.",
  input: jsonSchema({
    type: "object",
    properties: {
      action: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["play", "pause", "restart", "next_event"],
              },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["seek"] },
              seconds: { type: "number", minimum: 0 },
            },
            required: ["kind", "seconds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["speed"] },
              speed: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["kind", "speed"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_control_playback", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "control_playback",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceSetView = defineTool({
  name: "bakery_surface_set_view",
  description:
    "Pause and navigate the attached Kitchen workspace to one exact task, resource, station, batch, or operation at an exact simulation time. Scheduled rehearsal and financier navigation uses the applied run. The recording viewer accepts only transfers and resources listed in its attached context, within the recording's time range. A native operation ID opens its Files selector even before it has a scheduled task; a scheduled task ID must already exist in the run.",
  input: jsonSchema({
    type: "object",
    properties: {
      selection: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["batch", "station", "task", "resource", "operation"],
          },
          id: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
      cursorSeconds: { type: "number", minimum: 0 },
    },
    required: ["selection", "cursorSeconds"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_set_view", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: { kind: "surface", surface: KITCHEN_SURFACE, command: "set_view" },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceSimulateWorkcell = defineTool({
  name: "bakery_surface_simulate_workcell",
  description:
    "Run the native step the attached financier production run or rehearsal awaits (its pendingOperation) in the browser worker. Pass that step's mode: transfer, oven-cycle or rack-cycle. The result waits as an unaccepted candidate for review; accept it with accept_candidate before simulating the tray's next step.",
  input: jsonSchema({
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["transfer", "oven-cycle", "rack-cycle"],
      },
    },
    required: ["mode"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_simulate_workcell", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "simulate_workcell",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceDiscardCandidate = defineTool({
  name: "bakery_surface_discard_candidate",
  description:
    "Discard the exact unaccepted production or rehearsal recording attached to this turn. Accepted results remain unchanged. A changed candidate is rejected.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_discard_candidate", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "discard_candidate",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceAcceptCandidate = defineTool({
  name: "bakery_surface_accept_candidate",
  description:
    "Accept the exact recording candidate shown in the attached Kitchen workspace. Use its full candidate reference from the surface context. This changes the current simulation and requires an explicit operator request.",
  input: jsonSchema({
    type: "object",
    properties: {
      candidate: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["workcell"] },
              surfaceSessionId: { type: "string" },
              surfaceEpoch: { type: "integer", minimum: 0 },
              recordingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              inputFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
            required: [
              "kind",
              "surfaceSessionId",
              "surfaceEpoch",
              "recordingDigest",
              "inputFingerprint",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["trays"] },
              surfaceSessionId: { type: "string" },
              surfaceEpoch: { type: "integer", minimum: 0 },
              recordingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              operationId: { type: "string" },
              runFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
            required: [
              "kind",
              "surfaceSessionId",
              "surfaceEpoch",
              "recordingDigest",
              "operationId",
              "runFingerprint",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["production"] },
              surfaceSessionId: { type: "string" },
              surfaceEpoch: { type: "integer", minimum: 0 },
              recordingDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
              operationId: { type: "string" },
              planFingerprint: { type: "string" },
            },
            required: [
              "kind",
              "surfaceSessionId",
              "surfaceEpoch",
              "recordingDigest",
              "operationId",
              "planFingerprint",
            ],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["candidate"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_accept_candidate", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "accept_candidate",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareLayout = defineTool({
  name: "bakery_surface_prepare_layout",
  description:
    "Prepare a bounded rack translation for operator Apply or Discard on the attached rehearsal tray named in rackLayout. Use the attached modelHash and absolute offsets from the original fixture in whole millimetres. Applying it clears that tray's results. Does not apply, simulate or save.",
  input: jsonSchema({
    type: "object",
    properties: {
      baseModelHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      xMm: { type: "integer", minimum: -600, maximum: 600 },
      yMm: { type: "integer", minimum: -600, maximum: 600 },
    },
    required: ["baseModelHash", "xMm", "yMm"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_prepare_layout", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_layout",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceEditRehearsal = defineTool({
  name: "bakery_surface_edit_rehearsal",
  description:
    "Edit the trays of the attached scheduled rehearsal. Timing, baker and prerequisite edits preserve accepted results. Add a browser tray chain (loading, retrieval and racking), give a tray another baker from 1 to bakerCount, set one step's earliest start in whole seconds, or replace a tray's prerequisites with steps of other trays. Use batch and operation IDs from the attached trays and tasks. Set simulation-only fault assumptions with set_faults: supply all three fields, using null to clear an assumption. Outages postpone new dispatch on a named resource within the shift; injected failures target staging/clearance; assumed recovery releases held resources but does not complete a failed tray. Read current faults, resource IDs and task IDs from the attached context. Use add_human_transfer for a single nominal table-to-rack tray in cell 1 to add an assumed human transfer through a one-slot buffer to cell 2, with another native table-to-rack task. Use set_ingredients with batchId and ingredients (massKg: total ingredients excluding tray/tool, 0–4; forwardMm: whole millimetres from -100 to 100; lateralMm: whole millimetres from -60 to 60) to review a load change. Applying it clears that tray’s results and continuation states. Use set_cell (cold-cell-1 or cold-cell-2), clear_results, remove_tray or replace_preset to prepare a review; cell reassignment clears that tray’s results; these do not change the run until the operator applies it. Presets open recorded examples. Does not simulate or save.",
  input: jsonSchema({
    type: "object",
    properties: {
      edit: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["replace_preset"] },
              preset: {
                type: "string",
                enum: [
                  "two-trays",
                  "table-to-rack",
                  "table-to-oven",
                  "oven-cycle",
                  "oven-table-rack",
                ],
              },
            },
            required: ["kind", "preset"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["clear_results", "remove_tray", "add_human_transfer"],
              },
              batchId: { type: "string" },
            },
            required: ["kind", "batchId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_ingredients"] },
              batchId: { type: "string" },
              ingredients: {
                type: "object",
                properties: {
                  massKg: { type: "number", minimum: 0, maximum: 4 },
                  forwardMm: { type: "integer", minimum: -100, maximum: 100 },
                  lateralMm: { type: "integer", minimum: -60, maximum: 60 },
                },
                required: ["massKg", "forwardMm", "lateralMm"],
                additionalProperties: false,
              },
            },
            required: ["kind", "batchId", "ingredients"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_cell"] },
              batchId: { type: "string" },
              cellId: {
                type: "string",
                enum: ["cold-cell-1", "cold-cell-2"],
              },
            },
            required: ["kind", "batchId", "cellId"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_faults"] },
              faults: {
                type: "object",
                properties: {
                  outage: {
                    anyOf: [
                      { type: "null" },
                      {
                        type: "object",
                        properties: {
                          resource: { type: "string" },
                          start: { type: "integer", minimum: 0 },
                          end: { type: "integer", minimum: 1 },
                        },
                        required: ["resource", "start", "end"],
                        additionalProperties: false,
                      },
                    ],
                  },
                  failure: {
                    anyOf: [
                      { type: "null" },
                      {
                        type: "object",
                        properties: {
                          bakeryTaskId: { type: "string" },
                          afterSeconds: {
                            type: "integer",
                            minimum: 1,
                            maximum: 600,
                          },
                        },
                        required: ["bakeryTaskId", "afterSeconds"],
                        additionalProperties: false,
                      },
                    ],
                  },
                  recovery: {
                    anyOf: [
                      { type: "null" },
                      {
                        type: "object",
                        properties: {
                          bakeryTaskId: { type: "string" },
                          seconds: {
                            type: "integer",
                            minimum: 1,
                            maximum: 3600,
                          },
                        },
                        required: ["bakeryTaskId", "seconds"],
                        additionalProperties: false,
                      },
                    ],
                  },
                },
                required: ["outage", "failure", "recovery"],
                additionalProperties: false,
              },
            },
            required: ["kind", "faults"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["add_tray_chain"] },
              rackCase: { type: "string", enum: ["nominal", "slip"] },
            },
            required: ["kind", "rackCase"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_baker"] },
              batchId: { type: "string" },
              baker: { type: "integer", minimum: 1, maximum: 16 },
            },
            required: ["kind", "batchId", "baker"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_start"] },
              operationId: { type: "string" },
              earliestStartSeconds: { type: "integer", minimum: 0 },
            },
            required: ["kind", "operationId", "earliestStartSeconds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_prerequisites"] },
              batchId: { type: "string" },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                maxItems: 48,
              },
            },
            required: ["kind", "batchId", "dependsOn"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["edit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_edit_rehearsal", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "edit_rehearsal",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceEditProduction = defineTool({
  name: "bakery_surface_edit_production",
  description:
    "Edit the draft of the attached financier production run. The applied run and its native requests are unchanged until a preview is applied. Give a batch's tray the FR10 cold transfer or remove it, set a tray's staging baker (1 to bakerCount), earliest staging second or prerequisites, set a manual task's baker (null for any available baker), prerequisites and earliest start, choose the normal or assumed-outage oven, or discard the draft back to the applied run. Task IDs: batch:<B>:process:<stage|portion|bake|cool|demould|finishCooling|pack>, batch:<B>:transfer:<stage:portion|portion:bake|bake:cool|cool:pack>, and for assigned trays batch:<B>:native:<tray> and batch:<B>:handoff:<tray>-<stage|clear>. Manual tasks are the stage, portion, demould and pack processes and the transfers. Does not preview, apply or save. Use prepare_replacement with source preview, procedure, or one-batch to propose replacing the run. The operator must confirm; this command keeps the current run and its accepted results.",
  input: jsonSchema({
    type: "object",
    properties: {
      edit: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["prepare_replacement"] },
              source: {
                type: "string",
                enum: ["preview", "procedure", "one-batch"],
              },
            },
            required: ["kind", "source"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["assign_tray", "unassign_tray"],
              },
              batchId: { type: "string" },
              tray: { type: "integer", minimum: 1, maximum: 16 },
            },
            required: ["kind", "batchId", "tray"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_baker"] },
              batchId: { type: "string" },
              tray: { type: "integer", minimum: 1, maximum: 16 },
              baker: { type: "integer", minimum: 1, maximum: 16 },
            },
            required: ["kind", "batchId", "tray", "baker"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_prerequisites"] },
              batchId: { type: "string" },
              tray: { type: "integer", minimum: 1, maximum: 16 },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                maxItems: 160,
              },
            },
            required: ["kind", "batchId", "tray", "dependsOn"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_start"] },
              batchId: { type: "string" },
              tray: { type: "integer", minimum: 1, maximum: 16 },
              earliestStartSeconds: { type: "integer", minimum: 0 },
            },
            required: ["kind", "batchId", "tray", "earliestStartSeconds"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_manual_task"] },
              bakeryTaskId: { type: "string" },
              baker: {
                type: ["integer", "null"],
                minimum: 1,
                maximum: 16,
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                maxItems: 160,
              },
              earliestStartSeconds: { type: "integer", minimum: 0 },
            },
            required: [
              "kind",
              "bakeryTaskId",
              "baker",
              "dependsOn",
              "earliestStartSeconds",
            ],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_variant"] },
              variant: { type: "string", enum: ["normal", "outage"] },
            },
            required: ["kind", "variant"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["discard_draft"] },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["edit"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_edit_production", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "edit_production",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePreviewProduction = defineTool({
  name: "bakery_surface_preview_production",
  description:
    "Compile the attached financier production draft into a preview for review: its FR10 transfers, run end and unfinished batches. Does not change the applied run.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_preview_production", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "preview_production",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceApplyProduction = defineTool({
  name: "bakery_surface_apply_production",
  description:
    "Apply the attached draft's reviewed preview as a fresh financier production run with new native requests, as the operator's Apply preview button does. While the run holds no result it applies at once. When the run holds accepted results, it prepares the production replacement review in Edit scenario instead: the run stays unchanged until the operator applies or discards that review in the workspace, so tell the operator. Refused while a result waits for review, a browser job runs or a save is unresolved. Does not save.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_apply_production", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "apply_production",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareProductionControl = defineTool({
  name: "bakery_surface_prepare_production_control",
  description:
    "Prepare a control for the attached persistent production execution. The operator must confirm it in the workspace. Times are integer microseconds on the 2000-microsecond grid. Resource unavailability and floor-plan equipment moves or rotations affect new work and future worker walk routes while preserving accepted history. This tool returns the proposal immediately and does not run the factory.",
  input: jsonSchema({
    type: "object",
    properties: {
      control: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["pause", "resume"] },
            },
            required: ["kind"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["close-arrivals"] },
              source: { type: "string" },
            },
            required: ["kind", "source"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["extend-horizon"] },
              horizon: { type: "integer", minimum: 0 },
            },
            required: ["kind", "horizon"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["withhold-resource"] },
              resource: { type: "string" },
              interval: {
                type: "object",
                properties: {
                  start: { type: "integer", minimum: 0 },
                  end: { type: "integer", minimum: 0 },
                },
                required: ["start", "end"],
                additionalProperties: false,
              },
            },
            required: ["kind", "resource", "interval"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["recover-appliance-fault"] },
              appliance: { type: "string" },
              checkpointDigest: { type: "string" },
            },
            required: ["kind", "appliance", "checkpointDigest"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["move-equipment"] },
              applianceId: { type: "string" },
              xMm: { type: "integer", minimum: -20000, maximum: 20000 },
              zMm: { type: "integer", minimum: -20000, maximum: 20000 },
            },
            required: ["kind", "applianceId", "xMm", "zMm"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["rotate-equipment"] },
              applianceId: { type: "string" },
            },
            required: ["kind", "applianceId"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["control"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest(
      "bakery_surface_prepare_production_control",
      input,
    ),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_production_control",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareEdit = defineTool({
  name: "bakery_surface_prepare_edit",
  description:
    "Prepare a reviewed Kitchen shift-assumption edit against the exact attached draft. This creates an operator-visible proposal and does not apply it.",
  input: jsonSchema({
    type: "object",
    properties: {
      baseDraft: {
        type: "object",
        properties: {
          revision: { type: "integer", minimum: 0 },
          digest: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
        },
        required: ["revision", "digest"],
        additionalProperties: false,
      },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["set_assumption"] },
            field: {
              type: "string",
              enum: [
                "batchCount",
                "workerCount",
                "rackTrays",
                "ovenTrays",
                "traysPerBatch",
                "piecesPerTray",
                "loadWindow",
                "loadSeconds",
                "unloadSeconds",
                "stage",
                "portion",
                "bake",
                "cool",
                "demould",
                "pack",
                "horizonMinutes",
                "outageStart",
                "outageEnd",
              ],
            },
            value: { type: "number" },
          },
          required: ["kind", "field", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["baseDraft", "edits"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_prepare_edit", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_edit",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceRunShift = defineTool({
  name: "bakery_surface_run_shift",
  description:
    "Run the attached Kitchen shift, as the operator's Apply changes does: set up to eight inputs against the exact attached draft (read it first), then recalculate the normal and outage runs from 06:00 with playback reset and paused. Pass no edits to re-run the applied inputs. Refused while the operator has unapplied input changes or an unsaved operation draft. The run stays local to the page until a scenario copy is saved. Then use bakery_surface_control_playback to play or step it.",
  input: jsonSchema({
    type: "object",
    properties: {
      baseDraft: {
        type: "object",
        properties: {
          revision: { type: "integer", minimum: 0 },
          digest: {
            type: "string",
            pattern: "^[0-9a-f]{64}$",
          },
        },
        required: ["revision", "digest"],
        additionalProperties: false,
      },
      edits: {
        type: "array",
        minItems: 0,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["set_assumption"] },
            field: {
              type: "string",
              enum: [
                "batchCount",
                "workerCount",
                "rackTrays",
                "ovenTrays",
                "traysPerBatch",
                "piecesPerTray",
                "loadWindow",
                "loadSeconds",
                "unloadSeconds",
                "stage",
                "portion",
                "bake",
                "cool",
                "demould",
                "pack",
                "horizonMinutes",
                "outageStart",
                "outageEnd",
              ],
            },
            value: { type: "number" },
          },
          required: ["kind", "field", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["baseDraft", "edits"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_run_shift", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "run_shift",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceSelect = defineTool({
  name: "bakery_surface_select",
  description:
    "Select a batch, worker (resource), station (equipment) or task in the attached Kitchen shift, as a click on a Details chip or in the 3D view does. Details opens on that item's tab: Batches, Workers or Equipment. Playback time and state stay as they are; use bakery_surface_set_view to also move to a time. For the Inputs tab, open the inputs dock with bakery_surface_control_workspace_view.",
  input: jsonSchema({
    type: "object",
    properties: {
      selection: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["batch", "station", "task", "resource"],
          },
          id: { type: "string", minLength: 1, maxLength: 160 },
        },
        required: ["kind", "id"],
        additionalProperties: false,
      },
    },
    required: ["selection"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_select", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "select_item",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceRotateEquipment = defineTool({
  name: "bakery_surface_rotate_equipment",
  description:
    "Rotate one appliance of the attached Kitchen floor plan by 90 degrees, as Rotate 90° (R) does: it snaps to a quarter turn, turns once and moves the appliance clear of walls and other equipment. applianceId is an id from layout.equipment in the attached shift. Walk times and the shift schedule then recalculate from the new layout, so the run can change. The layout stays in this browser; nothing is saved.",
  input: jsonSchema({
    type: "object",
    properties: {
      applianceId: { type: "string", minLength: 1, maxLength: 160 },
    },
    required: ["applianceId"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_rotate_equipment", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "rotate_equipment",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceMoveEquipment = defineTool({
  name: "bakery_surface_move_equipment",
  description:
    "Move one appliance of the attached Kitchen floor plan to (xMm, zMm) in millimetres relative to the room centre, keeping it clear of walls, columns, fixtures and other equipment. applianceId is an id from layout.equipment in the attached shift. Walk times, door-sweep limits and the shift schedule recalculate from the new layout.",
  input: jsonSchema({
    type: "object",
    properties: {
      applianceId: { type: "string", minLength: 1, maxLength: 160 },
      xMm: { type: "integer", minimum: -20000, maximum: 20000 },
      zMm: { type: "integer", minimum: -20000, maximum: 20000 },
    },
    required: ["applianceId", "xMm", "zMm"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_move_equipment", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "move_equipment",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceToggleOpening = defineTool({
  name: "bakery_surface_toggle_opening",
  description:
    "Open or close a door or window on the attached Kitchen floor plan. openingId is an id from layout.openings in the attached shift (for example 'door:door-corridor-access'). Walk routes and the shift schedule recalculate from the updated door state.",
  input: jsonSchema({
    type: "object",
    properties: {
      openingId: { type: "string", minLength: 1, maxLength: 160 },
      open: { type: "boolean" },
    },
    required: ["openingId", "open"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_toggle_opening", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "toggle_opening",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceSelectFloorPlan = defineTool({
  name: "bakery_surface_select_floor_plan",
  description:
    "Switch the active room floor plan in the attached Kitchen shift ('asakusabashi-t101940', 'kinshicho-61146', 'machiya-sun-reve', 'hongo-8257562' or 'reference'). Walk times and the shift schedule recalculate for the selected room.",
  input: jsonSchema({
    type: "object",
    properties: {
      floorPlan: {
        type: "string",
        enum: [
          "asakusabashi-t101940",
          "kinshicho-61146",
          "machiya-sun-reve",
          "hongo-8257562",
          "reference",
        ],
      },
    },
    required: ["floorPlan"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_select_floor_plan", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "select_floor_plan",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceSetEquipmentAngle = defineTool({
  name: "bakery_surface_set_equipment_angle",
  description:
    "Set one appliance on the attached Kitchen floor plan to an exact yaw angle in whole degrees (-180..180), keeping it clear of walls, columns, fixtures and other equipment. applianceId is an id from layout.equipment in the attached shift. Walk times and the shift schedule recalculate from the updated layout.",
  input: jsonSchema({
    type: "object",
    properties: {
      applianceId: { type: "string", minLength: 1, maxLength: 160 },
      yawDegrees: { type: "integer", minimum: -180, maximum: 180 },
    },
    required: ["applianceId", "yawDegrees"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_set_equipment_angle", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "set_equipment_angle",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceConfigureInterior = defineTool({
  name: "bakery_surface_configure_interior",
  description:
    "Configure the Store Interior Design palette on the attached Kitchen shift: apply a curated architectural preset ('kuramae-artisan', 'noix-parisien', 'kiyosumi-minimal' or 'kyoto-machiya') or set an individual floor material, wall cladding, fixture finish, ceiling lighting style, wall height mode or café furnishings toggle.",
  input: jsonSchema({
    type: "object",
    properties: {
      action: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["apply_preset"] },
              preset: {
                type: "string",
                enum: [
                  "kuramae-artisan",
                  "noix-parisien",
                  "kiyosumi-minimal",
                  "kyoto-machiya",
                ],
              },
            },
            required: ["kind", "preset"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_floor_material"] },
              floorMaterial: {
                type: "string",
                enum: [
                  "herringbone-oak",
                  "terrazzo-stone",
                  "limestone-checker",
                  "quarry-terracotta",
                  "smoked-cedar",
                ],
              },
            },
            required: ["kind", "floorMaterial"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_wall_material"] },
              wallMaterial: {
                type: "string",
                enum: [
                  "limewash-hinoki",
                  "parisian-boiserie",
                  "board-concrete",
                  "juraku-lattice",
                ],
              },
            },
            required: ["kind", "wallMaterial"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_fixture_finish"] },
              fixtureFinish: {
                type: "string",
                enum: ["blackened-steel", "aged-brass", "natural-oak"],
              },
            },
            required: ["kind", "fixtureFinish"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_lighting_style"] },
              lightingStyle: {
                type: "string",
                enum: ["brass-pendants", "atelier-track", "washi-lanterns"],
              },
            },
            required: ["kind", "lightingStyle"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_wall_height"] },
              wallHeightMode: {
                type: "string",
                enum: ["smart-cutaway", "cutaway", "full"],
              },
            },
            required: ["kind", "wallHeightMode"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["set_furnishings"] },
              showFurnishings: { type: "boolean" },
            },
            required: ["kind", "showFurnishings"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_configure_interior", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "configure_interior",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceResetFloorPlan = defineTool({
  name: "bakery_surface_reset_floor_plan",
  description:
    "Undo or redo a floor-plan edit ('undo', 'redo'), reset equipment placements on the active floor plan ('reset_appliances'), or restore the initial shift layout ('reset_initial') in the attached Kitchen shift. Walk times and the shift schedule recalculate from the resulting layout.",
  input: jsonSchema({
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["undo", "redo", "reset_appliances", "reset_initial"],
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_reset_floor_plan", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "reset_floor_plan",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceStartProduction = defineTool({
  name: "bakery_surface_start_production",
  description:
    "Open the financier production run from the attached Kitchen shift, as the recipe catalog does: procedure uses the procedure inputs; one-batch is Financier + robot with one batch and one tray. A new run prepares its native requests from these inputs. If a financier run is already open in this workspace, it reopens that run unchanged; to start it fresh, use bakery_surface_edit_production with prepare_replacement, which the operator confirms. Nothing is saved.",
  input: jsonSchema({
    type: "object",
    properties: {
      preset: { type: "string", enum: ["procedure", "one-batch"] },
    },
    required: ["preset"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_start_production", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "start_production",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceCompareShift = defineTool({
  name: "bakery_surface_compare_shift",
  description:
    "Use Compare shifts in the attached Kitchen shift: outage shows the oven-outage run against the normal run as its baseline; normal replays the normal shift. Opens the comparison panel and resets playback to 06:00, paused. The outage window comes from the shift inputs outageStart and outageEnd.",
  input: jsonSchema({
    type: "object",
    properties: {
      mode: { type: "string", enum: ["normal", "outage"] },
    },
    required: ["mode"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_compare_shift", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "compare_shift",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceFile = defineTool({
  name: "bakery_surface_file",
  description:
    "Import an explicitly attached Kitchen file by its SHA-256 digest into operator review, or download an immutable run/request/accepted recording/handoff from the selected operation. File bytes stay in the browser. Imports never apply themselves; ask the operator to review. Exports download in the current browser and return their filename, digest and size.",
  input: jsonSchema({
    type: "object",
    properties: {
      action: {
        anyOf: [
          {
            type: "object",
            properties: {
              kind: { const: "import" },
              digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
            required: ["kind", "digest"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "export" },
              format: {
                type: "string",
                enum: ["run", "request", "recording", "handoff"],
              },
            },
            required: ["kind", "format"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["action"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_file", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "file_action",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceInspectScenarioSave = defineTool({
  name: "bakery_surface_inspect_scenario_save",
  description:
    "Inspect the scenario save proposal and its current phase. Uncertain outcomes read back the exact submitted copy without writing or repairing approval. Ask the operator to Resume exact save for receipt recovery. Idle means no proposal is tracked in this browser.",
  input: jsonSchema({
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest(
      "bakery_surface_inspect_scenario_save",
      input,
    ),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "inspect_scenario_save",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceInspectRunSave = defineTool({
  name: "bakery_surface_inspect_run_save",
  description:
    "Inspect this browser workspace's latest save attempt for the given run kind. Uncertain attempts are checked by exact content readback. Inspection never writes, approves, retries or clears a recovery fence. A verified readback with an uncertain agent save still needs the operator's Check saved run action to repair its approval receipt. Idle means no attempt is tracked in this browser; use list_saved_runs for the catalogue.",
  input: jsonSchema({
    type: "object",
    properties: {
      runKind: { type: "string", enum: ["rehearsal", "production"] },
    },
    required: ["runKind"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_inspect_run_save", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "inspect_run_save",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfaceListSavedRuns = defineTool({
  name: "bakery_surface_list_saved_runs",
  description:
    "List one page of saved runs in the current workspace. Pass null cursor for the first page, then the returned nextCursor. Pages are filtered by runKind and can be empty while nextCursor is non-null. Use an observed ID with prepare_run_open. Listing preserves the current run and grants no save or replacement approval.",
  input: jsonSchema({
    type: "object",
    properties: {
      runKind: { type: "string", enum: ["rehearsal", "production"] },
      cursor: { type: ["string", "null"], minLength: 1, maxLength: 2048 },
    },
    required: ["runKind", "cursor"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_list_saved_runs", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "list_saved_runs",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareRunOpen = defineTool({
  name: "bakery_surface_prepare_run_open",
  description:
    "Read an exact saved workspace run by its content ID and prepare replacement review in Files. Use the ID from an observed saved-run receipt or the operator. The open workspace must match runKind. The current run is kept until the operator confirms Use saved production run; chat cannot confirm replacement.",
  input: jsonSchema({
    type: "object",
    properties: {
      runKind: { type: "string", enum: ["rehearsal", "production"] },
      id: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    required: ["runKind", "id"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_prepare_run_open", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_run_open",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareRunSave = defineTool({
  name: "bakery_surface_prepare_run_save",
  description:
    "Prepare an exact frozen rehearsal copy for operator review. Returns its name, content ID and byte count; the operator must confirm the save in Kitchen.",
  input: jsonSchema({
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
    },
    required: ["name"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest("bakery_surface_prepare_run_save", input),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_run_save",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

export const surfacePrepareScenarioSave = defineTool({
  name: "bakery_surface_prepare_scenario_save",
  description:
    "Prepare an immutable shift or production scenario from the current Kitchen draft for operator review. The operator must confirm the exact copy.",
  input: jsonSchema({
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      note: { type: "string", minLength: 1, maxLength: 2000 },
    },
    required: ["name", "note"],
    additionalProperties: false,
  }),
  decodeOnly: true,
  decode: (input) =>
    parseBakerySurfaceToolRequest(
      "bakery_surface_prepare_scenario_save",
      input,
    ),
  effect: "surface",
  rerun: {
    kind: "any_caller",
    reason: "The attached surface answers a repeated command from its receipt.",
  },
  selection: {
    kind: "surface",
    surface: KITCHEN_SURFACE,
    command: "prepare_scenario_save",
  },
  unavailable: "The Kitchen surface is unavailable",
  handler: ({ executeBakerySurface }) =>
    executeBakerySurface === undefined
      ? undefined
      : (request, call) => executeBakerySurface(request, call.callId),
  readReceipt: readBakerySurfaceReceiptId,
});

/** The surface tools, in the order of the old catalog. */
export const SURFACE_TOOL_LIST = [
  surfaceInspect,
  surfaceReadDraft,
  surfaceQueryTasks,
  surfacePrepareWorkcell,
  surfaceStopSimulation,
  surfaceControlWorkspaceView,
  surfaceShowProductionPanel,
  surfaceControlBaseline,
  surfaceControlPlayback,
  surfaceSetView,
  surfaceSimulateWorkcell,
  surfaceDiscardCandidate,
  surfaceAcceptCandidate,
  surfacePrepareLayout,
  surfaceEditRehearsal,
  surfaceEditProduction,
  surfacePreviewProduction,
  surfaceApplyProduction,
  surfacePrepareProductionControl,
  surfacePrepareEdit,
  surfaceRunShift,
  surfaceSelect,
  surfaceRotateEquipment,
  surfaceMoveEquipment,
  surfaceToggleOpening,
  surfaceSelectFloorPlan,
  surfaceSetEquipmentAngle,
  surfaceConfigureInterior,
  surfaceResetFloorPlan,
  surfaceStartProduction,
  surfaceCompareShift,
  surfaceFile,
  surfaceInspectScenarioSave,
  surfaceInspectRunSave,
  surfaceListSavedRuns,
  surfacePrepareRunOpen,
  surfacePrepareRunSave,
  surfacePrepareScenarioSave,
] as const;

const SURFACE_TOOL_NAMES: ReadonlySet<string> = new Set(
  SURFACE_TOOL_LIST.map((tool) => tool.name),
);

export function isBakerySurfaceHarnessToolName(
  name: string,
): name is BakerySurfaceHarnessToolName {
  return SURFACE_TOOL_NAMES.has(name);
}

export function surfaceCommandForTool(
  name: BakerySurfaceHarnessToolName,
): BakerySurfaceToolCommandName {
  switch (name) {
    case "bakery_surface_inspect":
      return "inspect_surface";
    case "bakery_surface_read_draft":
      return "read_draft";
    case "bakery_surface_query_tasks":
      return "query_tasks";
    case "bakery_surface_set_view":
      return "set_view";
    case "bakery_surface_stop_simulation":
      return "stop_simulation";
    case "bakery_surface_control_workspace_view":
      return "control_workspace_view";
    case "bakery_surface_show_production_panel":
      return "show_production_panel";
    case "bakery_surface_control_baseline":
      return "control_baseline";
    case "bakery_surface_control_playback":
      return "control_playback";
    case "bakery_surface_prepare_workcell":
      return "prepare_workcell";
    case "bakery_surface_prepare_layout":
      return "prepare_layout";
    case "bakery_surface_edit_rehearsal":
      return "edit_rehearsal";
    case "bakery_surface_edit_production":
      return "edit_production";
    case "bakery_surface_preview_production":
      return "preview_production";
    case "bakery_surface_apply_production":
      return "apply_production";
    case "bakery_surface_prepare_production_control":
      return "prepare_production_control";
    case "bakery_surface_prepare_edit":
      return "prepare_edit";
    case "bakery_surface_run_shift":
      return "run_shift";
    case "bakery_surface_select":
      return "select_item";
    case "bakery_surface_rotate_equipment":
      return "rotate_equipment";
    case "bakery_surface_set_equipment_angle":
      return "set_equipment_angle";
    case "bakery_surface_move_equipment":
      return "move_equipment";
    case "bakery_surface_toggle_opening":
      return "toggle_opening";
    case "bakery_surface_select_floor_plan":
      return "select_floor_plan";
    case "bakery_surface_configure_interior":
      return "configure_interior";
    case "bakery_surface_reset_floor_plan":
      return "reset_floor_plan";
    case "bakery_surface_compare_shift":
      return "compare_shift";
    case "bakery_surface_start_production":
      return "start_production";
    case "bakery_surface_prepare_run_save":
      return "prepare_run_save";
    case "bakery_surface_file":
      return "file_action";
    case "bakery_surface_inspect_scenario_save":
      return "inspect_scenario_save";
    case "bakery_surface_inspect_run_save":
      return "inspect_run_save";
    case "bakery_surface_list_saved_runs":
      return "list_saved_runs";
    case "bakery_surface_prepare_run_open":
      return "prepare_run_open";
    case "bakery_surface_prepare_scenario_save":
      return "prepare_scenario_save";
    case "bakery_surface_simulate_workcell":
      return "simulate_workcell";
    case "bakery_surface_discard_candidate":
      return "discard_candidate";
    case "bakery_surface_accept_candidate":
      return "accept_candidate";
    default:
      return assertNever(name);
  }
}

export function parseBakerySurfaceToolRequest(
  name: BakerySurfaceHarnessToolName,
  input: unknown,
): HarnessBakerySurfaceToolRequest {
  if (!isRecord(input)) {
    throw new TypeError("BakeryOS surface tool input must be an object");
  }
  if (name === "bakery_surface_prepare_workcell") {
    const preparation = parseBakeryWorkcellPreparation(input.preparation);
    if (Object.keys(input).length !== 1 || preparation === null) {
      throw new TypeError("BakeryOS workcell preparation is invalid");
    }
    return { kind: "prepare_workcell", preparation };
  }
  if (name === "bakery_surface_stop_simulation") {
    if (Object.keys(input).length !== 0) {
      throw new TypeError(
        "Stop uses the exact simulation in the attached context.",
      );
    }
    return { kind: "stop_simulation" };
  }
  if (name === "bakery_surface_control_workspace_view") {
    const action = parseBakeryWorkspaceViewAction(input.action);
    if (Object.keys(input).length !== 1 || action === null) {
      throw new TypeError("Invalid workspace view action");
    }
    return { kind: "control_workspace_view", action };
  }
  if (name === "bakery_surface_select") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "select_item",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "select_item") {
      throw new TypeError("BakeryOS selection is invalid");
    }
    return { kind: "select_item", selection: parsed.value.selection };
  }
  if (name === "bakery_surface_rotate_equipment") {
    if (
      !hasExactKeys(input, ["applianceId"]) ||
      typeof input.applianceId !== "string" ||
      input.applianceId.length === 0 ||
      input.applianceId.length > 160
    ) {
      throw new TypeError("BakeryOS equipment rotation is invalid");
    }
    return { kind: "rotate_equipment", applianceId: input.applianceId };
  }
  if (name === "bakery_surface_move_equipment") {
    if (
      !hasExactKeys(input, ["applianceId", "xMm", "zMm"]) ||
      typeof input.applianceId !== "string" ||
      input.applianceId.length === 0 ||
      input.applianceId.length > 160 ||
      typeof input.xMm !== "number" ||
      !Number.isInteger(input.xMm) ||
      input.xMm < -20_000 ||
      input.xMm > 20_000 ||
      typeof input.zMm !== "number" ||
      !Number.isInteger(input.zMm) ||
      input.zMm < -20_000 ||
      input.zMm > 20_000
    ) {
      throw new TypeError("BakeryOS equipment move is invalid");
    }
    return {
      kind: "move_equipment",
      applianceId: input.applianceId,
      xMm: input.xMm,
      zMm: input.zMm,
    };
  }
  if (name === "bakery_surface_toggle_opening") {
    if (
      !hasExactKeys(input, ["openingId", "open"]) ||
      typeof input.openingId !== "string" ||
      input.openingId.length === 0 ||
      input.openingId.length > 160 ||
      typeof input.open !== "boolean"
    ) {
      throw new TypeError("BakeryOS opening toggle is invalid");
    }
    return {
      kind: "toggle_opening",
      openingId: input.openingId,
      open: input.open,
    };
  }
  if (name === "bakery_surface_select_floor_plan") {
    if (
      !hasExactKeys(input, ["floorPlan"]) ||
      typeof input.floorPlan !== "string" ||
      ![
        "asakusabashi-t101940",
        "kinshicho-61146",
        "machiya-sun-reve",
        "hongo-8257562",
        "reference",
      ].includes(input.floorPlan)
    ) {
      throw new TypeError("BakeryOS floor plan selection is invalid");
    }
    return { kind: "select_floor_plan", floorPlan: input.floorPlan };
  }
  if (name === "bakery_surface_set_equipment_angle") {
    if (
      !hasExactKeys(input, ["applianceId", "yawDegrees"]) ||
      typeof input.applianceId !== "string" ||
      input.applianceId.length === 0 ||
      input.applianceId.length > 160 ||
      typeof input.yawDegrees !== "number" ||
      !Number.isInteger(input.yawDegrees) ||
      input.yawDegrees < -180 ||
      input.yawDegrees > 180
    ) {
      throw new TypeError("BakeryOS equipment angle is invalid");
    }
    return {
      kind: "set_equipment_angle",
      applianceId: input.applianceId,
      yawDegrees: normalizeYawDegrees(input.yawDegrees),
    };
  }
  if (name === "bakery_surface_configure_interior") {
    if (!hasExactKeys(input, ["action"])) {
      throw new TypeError("BakeryOS store interior configuration is invalid");
    }
    const action = parseBakeryStoreInteriorAction(input.action);
    if (action === null) {
      throw new TypeError("BakeryOS store interior configuration is invalid");
    }
    return { kind: "configure_interior", action };
  }
  if (name === "bakery_surface_reset_floor_plan") {
    if (
      !hasExactKeys(input, ["action"]) ||
      !isBakeryFloorPlanResetAction(input.action)
    ) {
      throw new TypeError("BakeryOS floor plan reset is invalid");
    }
    return { kind: "reset_floor_plan", action: input.action };
  }
  if (name === "bakery_surface_start_production") {
    if (
      !hasExactKeys(input, ["preset"]) ||
      (input.preset !== "procedure" && input.preset !== "one-batch")
    ) {
      throw new TypeError("BakeryOS production start is invalid");
    }
    return { kind: "start_production", preset: input.preset };
  }
  if (name === "bakery_surface_compare_shift") {
    if (
      !hasExactKeys(input, ["mode"]) ||
      (input.mode !== "normal" && input.mode !== "outage")
    ) {
      throw new TypeError("BakeryOS shift comparison is invalid");
    }
    return { kind: "compare_shift", mode: input.mode };
  }
  if (name === "bakery_surface_show_production_panel") {
    const panel = parseBakeryProductionPanel(input.panel);
    if (Object.keys(input).length !== 1 || panel === null) {
      throw new TypeError("BakeryOS production panel is invalid");
    }
    return { kind: "show_production_panel", panel };
  }
  if (name === "bakery_surface_control_baseline") {
    if (
      Object.keys(input).length !== 1 ||
      (input.action !== "pin" && input.action !== "clear")
    ) {
      throw new TypeError("BakeryOS baseline action is invalid");
    }
    return { kind: "control_baseline", action: input.action };
  }
  if (name === "bakery_surface_control_playback") {
    const action = parseBakeryPlaybackAction(input.action);
    if (Object.keys(input).length !== 1 || action === null) {
      throw new TypeError("BakeryOS playback action is invalid");
    }
    return { kind: "control_playback", action };
  }
  if (
    name === "bakery_surface_inspect" ||
    name === "bakery_surface_read_draft"
  ) {
    if (Object.keys(input).length !== 0) {
      throw new TypeError("BakeryOS surface read takes no fields");
    }
    return name === "bakery_surface_inspect"
      ? { kind: "inspect_surface" }
      : { kind: "read_draft" };
  }
  if (name === "bakery_surface_simulate_workcell") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "simulate_workcell",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      attemptId: "surface_tool_attempt",
      mode: input.mode,
    });
    if (
      Object.keys(input).length !== 1 ||
      parsed.kind === "invalid" ||
      parsed.value.kind !== "simulate_workcell"
    ) {
      throw new TypeError("BakeryOS workcell mode is invalid");
    }
    return { kind: "simulate_workcell", mode: parsed.value.mode };
  }
  if (name === "bakery_surface_query_tasks") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "query_tasks",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      filter: input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "query_tasks") {
      throw new TypeError("BakeryOS task query input is invalid");
    }
    return {
      kind: "query_tasks",
      text: parsed.value.filter.text,
      limit: parsed.value.filter.limit,
    };
  }
  if (name === "bakery_surface_prepare_layout") {
    if (Object.keys(input).length !== 3) {
      throw new TypeError("Invalid rack placement fields");
    }
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "prepare_layout",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      baseModelHash: input.baseModelHash,
      xMm: input.xMm,
      yMm: input.yMm,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "prepare_layout") {
      throw new TypeError("Invalid rack placement");
    }
    return {
      kind: "prepare_layout",
      baseModelHash: parsed.value.baseModelHash,
      xMm: parsed.value.xMm,
      yMm: parsed.value.yMm,
    };
  }
  if (
    name === "bakery_surface_preview_production" ||
    name === "bakery_surface_apply_production"
  ) {
    if (Object.keys(input).length !== 0) {
      throw new TypeError("BakeryOS production command takes no fields");
    }
    return name === "bakery_surface_preview_production"
      ? { kind: "preview_production" }
      : { kind: "apply_production" };
  }
  if (name === "bakery_surface_edit_production") {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "edit")) {
      throw new TypeError("BakeryOS production edit input is invalid");
    }
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "edit_production",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      draftDigest: "0".repeat(64),
      edit: input.edit,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "edit_production") {
      throw new TypeError("BakeryOS production edit input is invalid");
    }
    return { kind: "edit_production", edit: parsed.value.edit };
  }
  if (name === "bakery_surface_edit_rehearsal") {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "edit")) {
      throw new TypeError("BakeryOS rehearsal edit input is invalid");
    }
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "edit_rehearsal",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      planFingerprint: "surface_tool_plan",
      edit: input.edit,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "edit_rehearsal") {
      throw new TypeError("BakeryOS rehearsal edit input is invalid");
    }
    return { kind: "edit_rehearsal", edit: parsed.value.edit };
  }
  if (name === "bakery_surface_prepare_production_control") {
    if (!hasExactKeys(input, ["control"])) {
      throw new TypeError("The production control input is invalid.");
    }
    const control = parseBakeryProductionControl(input.control);
    if (control === null) {
      throw new TypeError("The production control input is invalid.");
    }
    return { kind: "prepare_production_control", control };
  }
  if (
    name === "bakery_surface_prepare_edit" ||
    name === "bakery_surface_run_shift"
  ) {
    const kind =
      name === "bakery_surface_run_shift" ? "run_shift" : "prepare_edit";
    if (
      Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "baseDraft") ||
      !Object.hasOwn(input, "edits")
    ) {
      throw new TypeError(`BakeryOS ${kind} input is invalid`);
    }
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind,
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      baseDraft: input.baseDraft,
      edits: input.edits,
    });
    if (
      parsed.kind === "invalid" ||
      (parsed.value.kind !== "prepare_edit" &&
        parsed.value.kind !== "run_shift")
    ) {
      throw new TypeError(`BakeryOS ${kind} input is invalid`);
    }
    return {
      kind: parsed.value.kind,
      baseDraft: parsed.value.baseDraft,
      edits: parsed.value.edits,
    };
  }
  if (name === "bakery_surface_prepare_run_save") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "prepare_run_save",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "prepare_run_save") {
      throw new TypeError("BakeryOS run-save proposal input is invalid");
    }
    return { kind: "prepare_run_save", name: parsed.value.name };
  }
  if (name === "bakery_surface_file") {
    const action = parseBakeryFileAction(input.action);
    if (!hasExactKeys(input, ["action"]) || action === null) {
      throw new TypeError("Invalid BakeryOS file action");
    }
    return { kind: "file_action", action };
  }
  if (name === "bakery_surface_inspect_scenario_save") {
    if (!hasExactKeys(input, [])) {
      throw new TypeError("Scenario inspection takes no arguments");
    }
    return { kind: "inspect_scenario_save" };
  }
  if (name === "bakery_surface_inspect_run_save") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "inspect_run_save",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "inspect_run_save") {
      throw new TypeError("BakeryOS save inspection input is invalid");
    }
    return { kind: "inspect_run_save", runKind: parsed.value.runKind };
  }
  if (name === "bakery_surface_list_saved_runs") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "list_saved_runs",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "list_saved_runs") {
      throw new TypeError("BakeryOS saved-run listing input is invalid");
    }
    return {
      kind: "list_saved_runs",
      runKind: parsed.value.runKind,
      cursor: parsed.value.cursor,
    };
  }
  if (name === "bakery_surface_prepare_run_open") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "prepare_run_open",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (parsed.kind === "invalid" || parsed.value.kind !== "prepare_run_open") {
      throw new TypeError("BakeryOS saved-run review input is invalid");
    }
    return {
      kind: "prepare_run_open",
      runKind: parsed.value.runKind,
      id: parsed.value.id,
    };
  }
  if (name === "bakery_surface_prepare_scenario_save") {
    const parsed = parseBakerySurfaceCommand({
      schemaVersion: 1,
      kind: "prepare_scenario_save",
      target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
      ...input,
    });
    if (
      parsed.kind === "invalid" ||
      parsed.value.kind !== "prepare_scenario_save"
    ) {
      throw new TypeError("BakeryOS scenario-save proposal input is invalid");
    }
    return {
      kind: "prepare_scenario_save",
      name: parsed.value.name,
      note: parsed.value.note,
    };
  }
  if (name === "bakery_surface_discard_candidate") {
    if (Object.keys(input).length !== 0) {
      throw new TypeError("Discard takes the attached candidate.");
    }
    return { kind: "discard_candidate" };
  }
  if (name === "bakery_surface_accept_candidate") {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "candidate")) {
      throw new TypeError("BakeryOS candidate input is invalid");
    }
    const candidate = parseRecordingAcceptanceReference(input.candidate);
    if (candidate === null) {
      throw new TypeError("BakeryOS candidate input is invalid");
    }
    return { kind: "accept_candidate", candidate };
  }
  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "selection") ||
    !Object.hasOwn(input, "cursorSeconds")
  ) {
    throw new TypeError("BakeryOS view input is invalid");
  }
  const parsed = parseBakerySurfaceCommand({
    schemaVersion: 1,
    kind: "set_view",
    target: { surfaceSessionId: "surface_tool_target", surfaceEpoch: 0 },
    view: {
      selection: input.selection,
      cursorSeconds: input.cursorSeconds,
      playback: "paused",
    },
  });
  if (parsed.kind === "invalid" || parsed.value.kind !== "set_view") {
    throw new TypeError("BakeryOS view input is invalid");
  }
  return {
    kind: "set_view",
    selection: parsed.value.view.selection,
    cursorSeconds: parsed.value.view.cursorSeconds,
  };
}

export function readBakerySurfaceReceiptId(value: unknown): string {
  const parsed = parseBakerySurfaceToolResult(value);
  if (parsed === null) {
    throw new Error("BakeryOS surface receipt is missing");
  }
  return parsed.receiptId;
}

export function bakerySurfaceToolSucceeded(value: unknown): boolean {
  const parsed = parseBakerySurfaceToolResult(value);
  return (
    parsed !== null &&
    // A Costs view command answers with the page it now shows (Plan 87).
    (parsed.receipt.outcome.kind === "page_completed" ||
      (parsed.receipt.outcome.kind === "completed" &&
        parsed.receipt.outcome.result.kind === "succeeded"))
  );
}

function parseBakerySurfaceToolResult(
  value: unknown,
): HarnessBakerySurfaceToolResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    typeof value.receiptId !== "string"
  ) {
    return null;
  }
  const receipt = parseBakerySurfaceReceipt(value.receipt);
  const saveVerification = parseAgentRunSaveVerification(
    value.saveVerification,
  );
  const scenarioSaveResult = parseAgentScenarioSaveResult(
    value.scenarioSaveResult,
  );
  return receipt.kind === "valid" &&
    saveVerification !== null &&
    scenarioSaveResult !== null
    ? {
        receiptId: value.receiptId,
        receipt: receipt.value,
        saveVerification,
        scenarioSaveResult,
      }
    : null;
}

function parseAgentScenarioSaveResult(
  value: unknown,
): AgentScenarioSaveResult | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "none" || value.kind === "read_failed") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (value.kind === "unavailable") {
    return Object.keys(value).length === 2 && typeof value.effectId === "string"
      ? { kind: "unavailable", effectId: value.effectId }
      : null;
  }
  if (
    value.kind !== "saved" ||
    Object.keys(value).length !== 4 ||
    typeof value.effectId !== "string" ||
    typeof value.scenarioId !== "string"
  ) {
    return null;
  }
  const manifest = parseScenarioSaveManifest(value.manifest);
  return manifest !== null && manifest.id === value.scenarioId
    ? {
        kind: "saved",
        effectId: value.effectId,
        manifest,
        scenarioId: value.scenarioId,
      }
    : null;
}

function parseAgentRunSaveVerification(
  value: unknown,
): AgentRunSaveVerification | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "none" || value.kind === "read_failed") {
    return Object.keys(value).length === 1 ? { kind: value.kind } : null;
  }
  if (
    value.kind === "unavailable" &&
    Object.keys(value).length === 2 &&
    typeof value.effectId === "string"
  ) {
    return { kind: "unavailable", effectId: value.effectId };
  }
  if (
    value.kind !== "verified" ||
    Object.keys(value).length !== 3 ||
    typeof value.effectId !== "string"
  ) {
    return null;
  }
  const snapshot = parseRunSnapshotSummary(value.snapshot);
  return snapshot === null
    ? null
    : { kind: "verified", effectId: value.effectId, snapshot };
}

/** Every surface command that a tool here sends. */
export function installedBakerySurfaceCommands(): readonly BakerySurfaceToolCommandName[] {
  return SURFACE_TOOL_LIST.map(surfaceToolCommand);
}

function surfaceToolCommand(
  tool: (typeof SURFACE_TOOL_LIST)[number],
): BakerySurfaceToolCommandName {
  if (
    tool.selection.kind !== "surface" ||
    tool.selection.surface !== KITCHEN_SURFACE ||
    tool.selection.command === "configure_pastry_bench" ||
    tool.selection.command === "prepare_pastry_bench"
  ) {
    throw new Error(`${tool.name} is not a Satyr Kitchen tool`);
  }
  return tool.selection.command;
}
