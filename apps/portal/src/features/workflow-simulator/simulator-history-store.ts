import React from "react";

export type SimulatorHistoryEntry = Readonly<{
  label: string;
  coalesceKey?: string;
  coalesceWindowMs?: number;
  undo: () => void;
  redo: () => void;
}>;

export type SimulatorHistoryActionFeedback = Readonly<{
  kind: "undo" | "redo" | "clear" | "reset";
  label: string;
  timestamp: number;
}>;

export type SimulatorHistoryTimelineEntry = Readonly<{
  index: number;
  role: "baseline" | "undo" | "redo";
  label: string;
  timestamp: number | null;
  isCurrent: boolean;
}>;

export type SimulatorHistorySnapshot = Readonly<{
  version: number;
  canUndo: boolean;
  canRedo: boolean;
  hasCustomLayout: boolean;
  undoCount: number;
  redoCount: number;
  cursor: number;
  entries: readonly SimulatorHistoryTimelineEntry[];
  undoLabel: string | null;
  redoLabel: string | null;
  lastAction: SimulatorHistoryActionFeedback | null;
}>;

type SimulatorHistoryStoreHooks = Readonly<{
  hasCustomLayout: () => boolean;
  clearCustomLayout: () => void;
}>;

type StoredHistoryItem = {
  label: string;
  coalesceKey?: string;
  timestamp: number;
  undo: () => void;
  redo: () => void;
};

/** Owns bounded undo/redo history, coalescing, timeline snapshots and layout reset coordination. */
export class SimulatorHistoryStore {
  private readonly hooks: SimulatorHistoryStoreHooks;
  private readonly undoStack: StoredHistoryItem[] = [];
  private readonly redoStack: StoredHistoryItem[] = [];
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private isRestoring = false;
  private lastAction: SimulatorHistoryActionFeedback | null = null;
  private snapshot: SimulatorHistorySnapshot = {
    version: 0,
    canUndo: false,
    canRedo: false,
    hasCustomLayout: false,
    undoCount: 0,
    redoCount: 0,
    cursor: 0,
    entries: [
      {
        index: 0,
        role: "baseline",
        label: "Initial shift layout",
        timestamp: null,
        isCurrent: true,
      },
    ],
    undoLabel: null,
    redoLabel: null,
    lastAction: null,
  };

  constructor(hooks: SimulatorHistoryStoreHooks) {
    this.hooks = hooks;
  }

  readonly canUndo = (): boolean => this.undoStack.length > 0;

  readonly canRedo = (): boolean => this.redoStack.length > 0;

  readonly getUndoLabel = (): string | null =>
    this.undoStack[this.undoStack.length - 1]?.label ?? null;

  readonly getRedoLabel = (): string | null =>
    this.redoStack[this.redoStack.length - 1]?.label ?? null;

  readonly getVersion = (): number => this.version;

  readonly getSnapshot = (): SimulatorHistorySnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return this.unsubscribe.bind(this, listener);
  };

  private unsubscribe(listener: () => void): void {
    this.listeners.delete(listener);
  }

  readonly refresh = (): void => {
    this.version += 1;
    const undoCount = this.undoStack.length;
    const redoCount = this.redoStack.length;
    const topUndo = this.undoStack[undoCount - 1];
    const topRedo = this.redoStack[redoCount - 1];
    const hasCustomLayout = this.hooks.hasCustomLayout();
    const baselineLabel =
      undoCount === 0 && hasCustomLayout
        ? "Saved shift layout"
        : "Initial shift layout";
    const entries: SimulatorHistoryTimelineEntry[] = [
      {
        index: 0,
        role: "baseline",
        label: baselineLabel,
        timestamp: null,
        isCurrent: undoCount === 0,
      },
    ];
    for (let i = 0; i < undoCount; i += 1) {
      const item = this.undoStack[i]!;
      const index = i + 1;
      entries.push({
        index,
        role: "undo",
        label: item.label,
        timestamp: item.timestamp,
        isCurrent: index === undoCount,
      });
    }
    for (let step = 1; step <= redoCount; step += 1) {
      const item = this.redoStack[redoCount - step]!;
      entries.push({
        index: undoCount + step,
        role: "redo",
        label: item.label,
        timestamp: item.timestamp,
        isCurrent: false,
      });
    }
    this.snapshot = {
      version: this.version,
      canUndo: topUndo !== undefined,
      canRedo: topRedo !== undefined,
      hasCustomLayout,
      undoCount,
      redoCount,
      cursor: undoCount,
      entries,
      undoLabel: topUndo?.label ?? null,
      redoLabel: topRedo?.label ?? null,
      lastAction: this.lastAction,
    };
    for (const listener of this.listeners) listener();
  };

  readonly record = (entry: SimulatorHistoryEntry): void => {
    if (this.isRestoring) return;
    this.lastAction = null;
    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      entry.coalesceKey !== undefined &&
      top !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      (entry.coalesceWindowMs === undefined ||
        now - top.timestamp <= entry.coalesceWindowMs)
    ) {
      top.label = entry.label;
      top.redo = entry.redo;
      top.timestamp = now;
      this.redoStack.length = 0;
      this.refresh();
      return;
    }
    this.undoStack.push({
      label: entry.label,
      ...(entry.coalesceKey !== undefined
        ? { coalesceKey: entry.coalesceKey }
        : {}),
      timestamp: now,
      undo: entry.undo,
      redo: entry.redo,
    });
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this.refresh();
  };

  readonly undo = (): boolean => {
    const entry = this.undoStack.pop();
    if (entry === undefined) return false;
    this.isRestoring = true;
    try {
      entry.undo();
    } finally {
      this.isRestoring = false;
    }
    this.redoStack.push(entry);
    this.lastAction = {
      kind: "undo",
      label: entry.label,
      timestamp: Date.now(),
    };
    this.refresh();
    return true;
  };

  readonly redo = (): boolean => {
    const entry = this.redoStack.pop();
    if (entry === undefined) return false;
    this.isRestoring = true;
    try {
      entry.redo();
    } finally {
      this.isRestoring = false;
    }
    this.undoStack.push(entry);
    this.lastAction = {
      kind: "redo",
      label: entry.label,
      timestamp: Date.now(),
    };
    this.refresh();
    return true;
  };

  readonly jumpTo = (targetIndex: number): number => {
    const cursor = this.undoStack.length;
    const maxIndex = cursor + this.redoStack.length;
    if (
      !Number.isInteger(targetIndex) ||
      targetIndex < 0 ||
      targetIndex > maxIndex ||
      targetIndex === cursor
    ) {
      return 0;
    }
    if (targetIndex < cursor) {
      const steps = cursor - targetIndex;
      let singleLabel = "";
      this.isRestoring = true;
      try {
        for (let i = 0; i < steps; i += 1) {
          const entry = this.undoStack.pop();
          if (entry === undefined) break;
          if (i === 0) singleLabel = entry.label;
          entry.undo();
          this.redoStack.push(entry);
        }
      } finally {
        this.isRestoring = false;
      }
      this.lastAction = {
        kind: "undo",
        label: steps === 1 ? singleLabel : `${steps} steps`,
        timestamp: Date.now(),
      };
      this.refresh();
      return -steps;
    }
    const steps = targetIndex - cursor;
    let lastAppliedLabel = "";
    this.isRestoring = true;
    try {
      for (let i = 0; i < steps; i += 1) {
        const entry = this.redoStack.pop();
        if (entry === undefined) break;
        lastAppliedLabel = entry.label;
        entry.redo();
        this.undoStack.push(entry);
      }
    } finally {
      this.isRestoring = false;
    }
    this.lastAction = {
      kind: "redo",
      label: steps === 1 ? lastAppliedLabel : `${steps} steps`,
      timestamp: Date.now(),
    };
    this.refresh();
    return steps;
  };

  readonly clear = (): void => {
    if (this.undoStack.length === 0 && this.redoStack.length === 0) return;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastAction = {
      kind: "clear",
      label: "History cleared",
      timestamp: Date.now(),
    };
    this.refresh();
  };

  readonly resetToInitialLayout = (): void => {
    const hadHistory = this.undoStack.length > 0 || this.redoStack.length > 0;
    const hadCustomBefore = this.hooks.hasCustomLayout();
    if (!hadHistory && !hadCustomBefore) return;
    if (this.undoStack.length > 0) {
      this.isRestoring = true;
      try {
        while (this.undoStack.length > 0) {
          const entry = this.undoStack.pop();
          entry?.undo();
        }
      } finally {
        this.isRestoring = false;
      }
    }
    this.redoStack.length = 0;
    if (this.hooks.hasCustomLayout()) {
      this.hooks.clearCustomLayout();
    }
    this.lastAction = {
      kind: "reset",
      label: "Reset to initial layout",
      timestamp: Date.now(),
    };
    this.refresh();
  };
}

export function useSimulatorHistoryStore(
  store: SimulatorHistoryStore,
): SimulatorHistorySnapshot &
  Readonly<{
    undo: () => boolean;
    redo: () => boolean;
    jumpTo: (targetIndex: number) => number;
    clear: () => void;
    resetLayout: () => void;
  }> {
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return React.useMemo(
    () => ({
      ...snapshot,
      undo: store.undo,
      redo: store.redo,
      jumpTo: store.jumpTo,
      clear: store.clear,
      resetLayout: store.resetToInitialLayout,
    }),
    [snapshot, store],
  );
}
