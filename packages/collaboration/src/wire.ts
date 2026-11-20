import type { TextPresenceSelection } from "./text-selection.ts";
import { decodeBase64Url, isRecord } from "@purin-labs/std";
export const COLLABORATION_FRAME_LIMIT = 384 * 1024;
export const COLLABORATION_SOCKET_LIMIT = 20;
// The Actor's runtime answers this text frame without waking the Actor, so a
// client checks its connection without a charge for the Actor's time.
export const COLLABORATION_PING = "satyr.ping";
export const COLLABORATION_PONG = "satyr.pong";
export const COLLABORATION_PING_INTERVAL_MS = 30_000;
export const COLLABORATION_PONG_TIMEOUT_MS = 75_000;
export const COLLABORATION_PRESENCE_EXPIRY_MS = 90_000;
export const COLLABORATION_POINTER_IDLE_MS = 5_000;

/**
 * The frame limit of a document whose full snapshot and state vector travel
 * together as base64 in one frame.
 */
export function snapshotFrameLimit(
  snapshotLimit: number,
  stateVectorLimit: number,
): number {
  return (
    4 * (Math.ceil(snapshotLimit / 3) + Math.ceil(stateVectorLimit / 3)) + 1024
  );
}

export type CollaborationPresenceState = "viewing" | "editing";
export type CollaborationPointerPosition = Readonly<{ x: number; y: number }>;
export type CollaborationPointer = Readonly<{
  position: CollaborationPointerPosition;
  updatedAt: number;
}>;
export type CollaborationParticipant<Selection> = Readonly<{
  sessionId: string;
  userId: string;
  displayName: string;
  state: CollaborationPresenceState;
  selection: Selection | null;
  activeAt: number;
  pointer: CollaborationPointer | null;
}>;

export function encodeProtocolFrame(
  protocolVersion: string,
  value: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify({ protocolVersion, ...value });
}

export function parseProtocolFrame(
  frame: unknown,
  protocolVersion: string,
  frameLimit = COLLABORATION_FRAME_LIMIT,
): Record<string, unknown> | null {
  if (
    typeof frame !== "string" ||
    frame.length > frameLimit ||
    new TextEncoder().encode(frame).byteLength > frameLimit
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(frame);
    return isRecord(parsed) && parsed.protocolVersion === protocolVersion ? parsed : null;
  } catch {
    return null;
  }
}

export function hasExactMessageFields(
  value: Record<string, unknown>,
  ...payloadFields: string[]
): boolean {
  return Object.keys(value).length === payloadFields.length + 2 &&
    payloadFields.every(Object.hasOwn.bind(null, value));
}

export function encodeProtocolBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeProtocolBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const bytes = decodeBase64Url(value);
  return bytes !== null && encodeProtocolBytes(bytes) === value ? bytes : null;
}

export function isShortProtocolText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isCollaborationOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

export function isCollaborationPresenceState(value: unknown): value is CollaborationPresenceState {
  return value === "viewing" || value === "editing";
}

export function isCollaborationPointerPosition(
  value: unknown,
): value is CollaborationPointerPosition | null {
  return value === null ||
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isUnitCoordinate(value.x) &&
    isUnitCoordinate(value.y);
}

export function isCollaborationPointer(value: unknown): value is CollaborationPointer | null {
  return value === null ||
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.position !== null &&
    isCollaborationPointerPosition(value.position) &&
    typeof value.updatedAt === "number" &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= 0;
}

export function isTextPresenceSelection(value: unknown): value is TextPresenceSelection | null {
  return value === null ||
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isRelativePositionBytes(value.start) &&
    isRelativePositionBytes(value.end) &&
    (value.direction === "forward" || value.direction === "backward" || value.direction === "none");
}

function isUnitCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRelativePositionBytes(value: unknown): value is number[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(isPositionByte);
}

function isPositionByte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}
