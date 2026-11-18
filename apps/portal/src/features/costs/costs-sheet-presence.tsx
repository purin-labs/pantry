import React from "react";
import { MousePointer2, Sparkles } from "lucide-react";
import {
  COLLABORATION_POINTER_IDLE_MS,
  type CollaborationAgentActivity,
} from "@seams/collaboration";
import type { CostsSheetTab } from "@seams/costs-sheet-crdt";
import type { CostsSheetPresence, CostsSheetView } from "./costs-sheet-client";

const FIGMA_PRESENCE_PALETTE = [
  "#0d9488",
  "#e11d48",
  "#2563eb",
  "#d97706",
  "#7c3aed",
  "#16a34a",
  "#dc2626",
  "#0284c7",
] as const;

const AGENT_COLOR = "#7c3aed";

export type CellPeerBadge = Readonly<{
  id: string;
  label: string;
  color: string;
  isAgent: boolean;
}>;

export type PresenceIndex = Readonly<{
  colorBySession: ReadonlyMap<string, string>;
  peersByCell: ReadonlyMap<string, readonly CellPeerBadge[]>;
  peersByTab: Readonly<Record<CostsSheetTab, readonly CellPeerBadge[]>>;
}>;

export function buildPresenceIndex(
  participants: readonly CostsSheetPresence[],
  agents: readonly CollaborationAgentActivity[],
): PresenceIndex {
  const colorBySession = assignParticipantColors(participants);
  const peersByCell = new Map<string, CellPeerBadge[]>();
  const peersByTab: Record<CostsSheetTab, CellPeerBadge[]> = {
    margins: [],
    weekly: [],
    actuals: [],
    forecast: [],
    supplies: [],
  };

  for (const participant of participants) {
    if (participant.isSelf) continue;
    const color =
      colorBySession.get(participant.sessionId) ?? FIGMA_PRESENCE_PALETTE[0];
    const badge: CellPeerBadge = {
      id: participant.sessionId,
      label: participant.displayName,
      color,
      isAgent: false,
    };
    const selection = participant.selection;
    if (selection !== null) {
      peersByTab[selection.sheet].push(badge);
      if (selection.cellKey !== null) {
        const list = peersByCell.get(selection.cellKey) ?? [];
        list.push(badge);
        peersByCell.set(selection.cellKey, list);
      }
    }
  }

  for (const activity of agents) {
    const badge: CellPeerBadge = {
      id: `agent:${activity.operationId}`,
      label: activity.agent.displayName,
      color: AGENT_COLOR,
      isAgent: true,
    };
    const target = activity.target;
    if (target.length > 0) {
      const list = peersByCell.get(target) ?? [];
      list.push(badge);
      peersByCell.set(target, list);
      const sheet = inferSheetFromCellKey(target);
      if (sheet !== null) {
        peersByTab[sheet].push(badge);
      }
    }
  }

  return { colorBySession, peersByCell, peersByTab };
}

export function CostsPresenceBar(
  props: Readonly<{
    view: CostsSheetView;
    presence: PresenceIndex;
    unsavedCount?: number;
    onJumpToTab: (sheet: CostsSheetTab) => void;
    onRetry: () => void;
    actions?: React.ReactNode;
  }>,
): React.ReactNode {
  const { view, presence, unsavedCount = 0 } = props;
  const statusLabel = syncStatusLabel(view);
  const liveCount = view.participants.length + view.agents.length;

  const summaryText =
    unsavedCount > 0
      ? `${liveCount > 0 ? `${liveCount} live · ` : ""}${unsavedCount} unsaved`
      : liveCount > 1
        ? `${liveCount} live · ${statusLabel}`
        : statusLabel;

  return (
    <div
      className="costs-header-actions"
      role="region"
      aria-label="Live workbook collaborators"
    >
      <div className="costs-presence-cluster">
        {liveCount > 0 && (
          <div className="costs-avatar-stack">
            {view.agents.map((activity) => (
              <span
                key={activity.operationId}
                className="costs-peer-avatar is-agent"
                style={{ backgroundColor: AGENT_COLOR }}
                title={`${activity.agent.displayName} · editing`}
              >
                <Sparkles size={11} aria-hidden="true" />
              </span>
            ))}
            {view.participants.map((participant) => {
              const color = participant.isSelf
                ? "#18181b"
                : (presence.colorBySession.get(participant.sessionId) ??
                  FIGMA_PRESENCE_PALETTE[0]);
              const initials = avatarInitials(participant.displayName);
              const tabBadge =
                !participant.isSelf && participant.selection !== null
                  ? shortTabLabel(participant.selection.sheet)
                  : null;
              const tooltip = participant.isSelf
                ? `${participant.displayName} (you)`
                : tabBadge !== null
                  ? `${participant.displayName} · ${tabBadge} (click to jump)`
                  : participant.displayName;

              if (!participant.isSelf && participant.selection !== null) {
                const targetSheet = participant.selection.sheet;
                return (
                  <button
                    key={participant.sessionId}
                    type="button"
                    className="costs-peer-avatar is-clickable"
                    style={{ backgroundColor: color }}
                    title={tooltip}
                    aria-label={tooltip}
                    onClick={() => props.onJumpToTab(targetSheet)}
                  >
                    {initials}
                  </button>
                );
              }

              return (
                <span
                  key={participant.sessionId}
                  className="costs-peer-avatar"
                  style={{ backgroundColor: color }}
                  title={tooltip}
                >
                  {initials}
                </span>
              );
            })}
          </div>
        )}

        <span
          className="costs-presence-status"
          data-sync-state={view.kind}
          data-has-unsaved={unsavedCount > 0}
        >
          <span className="costs-status-dot" aria-hidden="true" />
          <span>{summaryText}</span>
        </span>

        {view.kind === "failed" && view.recovery === "retry" && (
          <button
            type="button"
            className="costs-retry-inline"
            onClick={props.onRetry}
          >
            Retry
          </button>
        )}
      </div>

      {props.actions}
    </div>
  );
}

export function CostsTabPresenceDots(
  props: Readonly<{ peers: readonly CellPeerBadge[] }>,
): React.ReactNode {
  if (props.peers.length === 0) return null;
  return (
    <span className="costs-tab-peers" aria-hidden="true">
      {props.peers.slice(0, 4).map((peer) => (
        <span
          key={peer.id}
          className="costs-tab-peer-dot"
          style={{ backgroundColor: peer.color }}
          title={peer.label}
        />
      ))}
    </span>
  );
}

export function CostsMousePointerLayer(
  props: Readonly<{
    participants: readonly CostsSheetPresence[];
    colorBySession: ReadonlyMap<string, string>;
  }>,
): React.ReactNode {
  const [, setClock] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="costs-mouse-layer" aria-hidden="true">
      {props.participants.map((participant) => {
        const pointer = participant.pointer;
        if (
          participant.isSelf ||
          pointer === null ||
          Date.now() - pointer.updatedAt >= COLLABORATION_POINTER_IDLE_MS
        ) {
          return null;
        }
        const color =
          props.colorBySession.get(participant.sessionId) ??
          FIGMA_PRESENCE_PALETTE[0];
        const { x, y } = pointer.position;
        const flipLeft = x > 0.78 ? " label-left" : "";
        const flipAbove = y > 0.88 ? " label-above" : "";
        return (
          <span
            key={participant.sessionId}
            className={`costs-mouse-pointer${flipLeft}${flipAbove}`}
            style={{
              ...peerColorStyle(color),
              left: `${x * 100}%`,
              top: `${y * 100}%`,
            }}
          >
            <MousePointer2
              size={16}
              fill="currentColor"
              stroke="#ffffff"
              strokeWidth={1.7}
            />
            <span className="costs-mouse-name">{participant.displayName}</span>
          </span>
        );
      })}
    </div>
  );
}

export function CellPeerOutline(
  props: Readonly<{
    peers: readonly CellPeerBadge[] | undefined;
    below?: boolean;
  }>,
): React.ReactNode {
  const peers = props.peers;
  if (peers === undefined || peers.length === 0) return null;
  const primary = peers[0];
  if (primary === undefined) return null;
  const extraCount = peers.length - 1;
  const text =
    extraCount > 0 ? `${primary.label} +${extraCount}` : primary.label;

  return (
    <span
      className={`costs-cell-peer-tag${props.below === true ? " is-below" : ""}`}
      style={peerColorStyle(primary.color)}
      aria-hidden="true"
    >
      {primary.isAgent && <Sparkles size={9.5} />}
      <span>{text}</span>
    </span>
  );
}

export function peerCellStyle(
  peers: readonly CellPeerBadge[] | undefined,
): React.CSSProperties | undefined {
  const primary = peers?.[0];
  if (primary === undefined) return undefined;
  return peerColorStyle(primary.color);
}

function peerColorStyle(color: string): React.CSSProperties {
  return {
    ["--peer-color" as string]: color,
    ["--peer-tint" as string]: `${color}12`,
  };
}

function assignParticipantColors(
  participants: readonly CostsSheetPresence[],
): ReadonlyMap<string, string> {
  const ordered = [...participants].sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  );
  const usedIndices = new Set<number>();
  const map = new Map<string, string>();

  for (const participant of ordered) {
    let idx = hashString(participant.userId) % FIGMA_PRESENCE_PALETTE.length;
    for (let step = 0; step < FIGMA_PRESENCE_PALETTE.length; step += 1) {
      const candidate = (idx + step) % FIGMA_PRESENCE_PALETTE.length;
      if (!usedIndices.has(candidate)) {
        idx = candidate;
        usedIndices.add(candidate);
        break;
      }
    }
    map.set(
      participant.sessionId,
      FIGMA_PRESENCE_PALETTE[idx] ?? FIGMA_PRESENCE_PALETTE[0],
    );
  }
  return map;
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (const ch of input) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  }
  return Math.abs(hash);
}

function avatarInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    return (words[0] ?? "?").slice(0, 2).toUpperCase();
  }
  const first = words[0]?.[0] ?? "";
  const last = words[words.length - 1]?.[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

function syncStatusLabel(view: CostsSheetView): string {
  switch (view.kind) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "syncing":
      return "Syncing";
    case "synced":
      return view.access === "read" ? "View only" : "Synced";
    case "failed":
      return "Paused";
  }
}

function shortTabLabel(sheet: CostsSheetTab): string {
  switch (sheet) {
    case "margins":
      return "Product margins";
    case "weekly":
      return "Weekly plan";
    case "actuals":
      return "Plan vs actuals";
    case "forecast":
      return "12-week P&L & cash";
    case "supplies":
      return "Supplier packs";
  }
}

function inferSheetFromCellKey(cellKey: string): CostsSheetTab | null {
  if (cellKey.startsWith("supply:")) return "supplies";
  if (cellKey.startsWith("actuals:")) return "actuals";
  if (cellKey.startsWith("forecast:")) return "forecast";
  if (cellKey.startsWith("product:") && /:day:[0-6]$/u.test(cellKey))
    return "weekly";
  if (cellKey.startsWith("product:")) return "margins";
  return null;
}
