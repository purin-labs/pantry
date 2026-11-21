import { Type, type Static } from "typebox";
import { recordParser } from "@purin-labs/contract-schema";
import { portalPageViewSectionSchema } from "./portal-page-view.ts";

/**
 * What a person's screen shows when they send a chat message (Plan 87). The
 * browser builds it from the page's own state, so it can hold values that the
 * person has not saved. The model reads it as an observation of the screen: it
 * grants no authority and proves no saved record. The server computes its
 * digest when it admits it to a turn, so the browser sends none.
 */
export const SURFACE_OBSERVATION_MAX_BYTES = 24 * 1024;

/** The Kitchen page: the one surface whose state carries commands. */
export const KITCHEN_SURFACE = "workflow-simulator";

const label = Type.String({ minLength: 1, maxLength: 120 });
const surfaceName = Type.String({
  minLength: 1,
  maxLength: 60,
  pattern: "^[a-z0-9-]+$",
});
const kindName = Type.String({
  minLength: 1,
  maxLength: 60,
  pattern: "^[a-z][a-z0-9_]*$",
});
const identifier = Type.String({ minLength: 1, maxLength: 200 });

/** The navigation group of a Portal page. `BakeryOS` shows as Kitchen. */
export const surfaceAreaSchema = Type.Union([
  Type.Literal("Workspace"),
  Type.Literal("AgentCommerce"),
  Type.Literal("CafeOS"),
  Type.Literal("BakeryOS"),
  Type.Literal("Agents"),
  Type.Literal("Settings"),
]);

/** The record that the page has open, such as one order. */
export const surfaceRecordSchema = Type.Object({
  kind: kindName,
  id: identifier,
  label,
});

/** A record on screen, for the audience check of the turn. */
export const surfaceSourceSchema = Type.Object({
  kind: kindName,
  id: identifier,
  /** The saved revision on screen; null when the person edits it unsaved. */
  revision: Type.Union([
    Type.String({ minLength: 1, maxLength: 120 }),
    Type.Null(),
  ]),
});

/** One mount of a page in one browser tab. A command names it (phase 3). */
export const surfaceInstanceSchema = Type.Object({
  browserInstanceId: identifier,
  surfaceSessionId: identifier,
  epoch: Type.Integer({ minimum: 0 }),
});

/**
 * The typed state of a page with commands. Its `kind` names the state type,
 * and the package that owns the surface parses the rest: the Kitchen
 * state is a `BakerySurfaceContextV1` (`@purin-labs/bakery-model`). A record
 * schema keeps every field, so the owner's parser sees the whole state.
 */
export const surfaceStateSchema = Type.Record(Type.String(), Type.Unknown());

export const surfaceObservationSchema = Type.Object({
  kind: Type.Literal("surface-observation"),
  schemaVersion: Type.Literal(2),
  /** A stable page name, such as `costs` or `orders`. */
  surface: surfaceName,
  area: surfaceAreaSchema,
  /** Null for a page view that a message stored before Plan 87. */
  instance: Type.Union([surfaceInstanceSchema, Type.Null()]),
  title: label,
  path: Type.String({ minLength: 1, maxLength: 400, pattern: "^/" }),
  record: Type.Union([surfaceRecordSchema, Type.Null()]),
  capturedAt: Type.Integer({ minimum: 0 }),
  /** What the model reads. A page with no capture sends none. */
  view: Type.Array(portalPageViewSectionSchema, { maxItems: 12 }),
  /**
   * Typed page state for commands; null for a page with none. The Pantry
   * Kitchen sends its current view here, and the server makes `view` from it.
   */
  state: Type.Union([surfaceStateSchema, Type.Null()]),
  /** The commands that the agent may run on the page now. */
  commands: Type.Array(kindName, { maxItems: 40 }),
  sources: Type.Array(surfaceSourceSchema, { maxItems: 200 }),
});

/** Where a chat started. It never changes, and a fork keeps it. */
export const chatOriginSchema = Type.Object({
  area: surfaceAreaSchema,
  page: surfaceName,
  title: label,
  record: Type.Union([surfaceRecordSchema, Type.Null()]),
  startedAt: Type.Integer({ minimum: 0 }),
});

export type SurfaceArea = Static<typeof surfaceAreaSchema>;

/**
 * The names that people and the model see for each area. The wire values
 * keep their old names (Plan 91), so a label never comes from the value.
 */
const SURFACE_AREA_TITLES: Readonly<Record<SurfaceArea, string>> = {
  Workspace: "Workspace",
  AgentCommerce: "Commerce",
  CafeOS: "Café",
  BakeryOS: "Kitchen",
  Agents: "Agents",
  Settings: "Settings",
};

export function surfaceAreaTitle(area: SurfaceArea): string {
  return SURFACE_AREA_TITLES[area];
}
export type SurfaceRecord = Static<typeof surfaceRecordSchema>;
export type SurfaceSource = Static<typeof surfaceSourceSchema>;
export type SurfaceInstance = Static<typeof surfaceInstanceSchema>;
export type SurfaceState = Static<typeof surfaceStateSchema>;
export type SurfaceObservationV2 = Static<typeof surfaceObservationSchema>;
export type ChatOrigin = Static<typeof chatOriginSchema>;

const decodeSurfaceObservation = recordParser(surfaceObservationSchema);
const decodeChatOrigin = recordParser(chatOriginSchema);
const ENCODER = new TextEncoder();

/** The observation, or null when it is malformed or too large. */
export function parseSurfaceObservation(
  raw: unknown,
): SurfaceObservationV2 | null {
  const decoded = decodeSurfaceObservation(raw);
  if (!decoded.ok) return null;
  return surfaceObservationBytes(decoded.value) <=
    SURFACE_OBSERVATION_MAX_BYTES
    ? decoded.value
    : null;
}

export function surfaceObservationBytes(
  observation: SurfaceObservationV2,
): number {
  return ENCODER.encode(JSON.stringify(observation)).byteLength;
}

const SURFACE_AREAS: ReadonlySet<unknown> = new Set<SurfaceArea>([
  "Workspace",
  "AgentCommerce",
  "CafeOS",
  "BakeryOS",
  "Agents",
  "Settings",
]);

export function parseSurfaceArea(raw: unknown): SurfaceArea | null {
  return isSurfaceArea(raw) ? raw : null;
}

function isSurfaceArea(raw: unknown): raw is SurfaceArea {
  return SURFACE_AREAS.has(raw);
}

export function parseChatOrigin(raw: unknown): ChatOrigin | null {
  const decoded = decodeChatOrigin(raw);
  return decoded.ok ? decoded.value : null;
}

/** The origin that the first message of a chat sets. */
export function chatOriginFromObservation(
  observation: SurfaceObservationV2,
  startedAt: number,
): ChatOrigin {
  return {
    area: observation.area,
    page: observation.surface,
    title: observation.title,
    record: observation.record,
    startedAt,
  };
}

/**
 * The pages whose observation may go to a shared chat (Plan 87): pages that
 * every member of the Organisation may open, so every reader of the chat may
 * read them. Any other page goes only to a private chat. A page joins this
 * list when its control route has been checked; a page that needs more than
 * the viewer role must first add a check of each reader.
 */
const SHARED_CHAT_PAGES: ReadonlySet<string> = new Set([
  // control/routes/costs.ts reads with the viewer role.
  "costs",
  // control/routes/menu-boards.ts and the menu draft admission read with viewer.
  "menus",
]);

export function sharedChatMayCarry(surface: string): boolean {
  return SHARED_CHAT_PAGES.has(surface);
}
