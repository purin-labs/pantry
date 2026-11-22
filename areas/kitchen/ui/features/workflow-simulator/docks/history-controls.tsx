import React from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Redo2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  useSimulatorHistory,
  type SimulatorHistoryActionFeedback,
} from "../floor-plan-workspace";

function formatHistoryTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

export function SimulatorHistoryControls(): React.ReactNode {
  const history = useSimulatorHistory();
  const hasHistory = history.canUndo || history.canRedo;
  const canOpenPopover = hasHistory || history.hasCustomLayout;
  const [open, setOpen] = React.useState(false);
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const [anchorPos, setAnchorPos] = React.useState<{
    top: number;
    left: number;
  } | null>(null);
  const [feedback, setFeedback] =
    React.useState<SimulatorHistoryActionFeedback | null>(null);

  const groupRef = React.useRef<HTMLDivElement | null>(null);
  const popoverRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!canOpenPopover && open) {
      setOpen(false);
      setHoverIndex(null);
    }
  }, [canOpenPopover, open]);

  React.useEffect(() => {
    if (history.lastAction === null) {
      setFeedback(null);
      return;
    }
    setFeedback(history.lastAction);
    const timer = window.setTimeout(() => {
      setFeedback((cur) =>
        cur?.timestamp === history.lastAction?.timestamp ? null : cur,
      );
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [history.lastAction]);

  const updateAnchorPosition = React.useCallback(() => {
    const groupEl = groupRef.current;
    if (groupEl === null) return;
    const rect = groupEl.getBoundingClientRect();
    const popoverWidth = Math.min(316, window.innerWidth - 24);
    const preferredLeft = rect.right - popoverWidth;
    const clampedLeft = Math.max(
      12,
      Math.min(preferredLeft, window.innerWidth - popoverWidth - 12),
    );
    setAnchorPos({
      top: Math.round(rect.bottom + 8),
      left: Math.round(clampedLeft),
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    updateAnchorPosition();
    window.addEventListener("resize", updateAnchorPosition);
    window.addEventListener("scroll", updateAnchorPosition, true);
    return () => {
      window.removeEventListener("resize", updateAnchorPosition);
      window.removeEventListener("scroll", updateAnchorPosition, true);
    };
  }, [open, updateAnchorPosition]);

  React.useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        groupRef.current?.contains(target) ||
        popoverRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      setHoverIndex(null);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setHoverIndex(null);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);

  const togglePopover = React.useCallback(() => {
    if (!canOpenPopover) return;
    setOpen((prev) => {
      const next = !prev;
      if (!next) setHoverIndex(null);
      return next;
    });
  }, [canOpenPopover]);

  const handleContextMenu = React.useCallback(
    (event: React.MouseEvent) => {
      if (!canOpenPopover) return;
      event.preventDefault();
      togglePopover();
    },
    [canOpenPopover, togglePopover],
  );

  const handleListKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const container = popoverRef.current;
      if (container === null) return;
      const items = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button.workflow-history-entry:not(:disabled), button.workflow-history-reset:not(:disabled), button.workflow-history-clear:not(:disabled)",
        ),
      );
      if (items.length === 0) return;
      event.preventDefault();
      const currentIdx = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIdx =
        currentIdx === -1
          ? delta > 0
            ? 0
            : items.length - 1
          : (currentIdx + delta + items.length) % items.length;
      items[nextIdx]?.focus();
    },
    [],
  );

  const undoTitle =
    history.undoLabel !== null ? `Undo: ${history.undoLabel}` : "Undo";
  const redoTitle =
    history.redoLabel !== null ? `Redo: ${history.redoLabel}` : "Redo";
  const undoTooltip =
    history.undoLabel !== null
      ? `Undo: ${history.undoLabel} (⌘Z)`
      : "Undo (⌘Z)";
  const redoTooltip =
    history.redoLabel !== null
      ? `Redo: ${history.redoLabel} (⇧⌘Z)`
      : "Redo (⇧⌘Z)";

  let summaryText: string;
  if (hoverIndex === null || hoverIndex === history.cursor) {
    if (!hasHistory && history.hasCustomLayout) {
      summaryText = "Custom layout";
    } else {
      summaryText =
        history.redoCount > 0
          ? `${history.undoCount} undo · ${history.redoCount} redo`
          : `${history.undoCount} ${history.undoCount === 1 ? "step" : "steps"}`;
    }
  } else if (hoverIndex < history.cursor) {
    const steps = history.cursor - hoverIndex;
    summaryText = `Undo ${steps} ${steps === 1 ? "step" : "steps"}`;
  } else {
    const steps = hoverIndex - history.cursor;
    summaryText = `Redo ${steps} ${steps === 1 ? "step" : "steps"}`;
  }

  const orderedEntries = React.useMemo(
    () => [...history.entries].reverse(),
    [history.entries],
  );

  return (
    <div
      ref={groupRef}
      className="workflow-history-controls"
      role="group"
      aria-label="History"
      data-has-history={hasHistory ? "true" : undefined}
      data-popover-open={open ? "true" : undefined}
      data-feedback-active={!open && feedback !== null ? "true" : undefined}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        className="workflow-history-button"
        aria-label="Undo"
        title={undoTitle}
        data-tooltip={undoTooltip}
        data-count={history.undoCount > 0 ? history.undoCount : undefined}
        disabled={!history.canUndo}
        onClick={history.undo}
      >
        <Undo2 size={15} aria-hidden="true" />
        {history.undoCount > 1 && (
          <span className="workflow-history-badge" aria-hidden="true">
            {history.undoCount > 9 ? "9+" : history.undoCount}
          </span>
        )}
      </button>
      <button
        type="button"
        className="workflow-history-button"
        aria-label="Redo"
        title={redoTitle}
        data-tooltip={redoTooltip}
        data-count={history.redoCount > 0 ? history.redoCount : undefined}
        disabled={!history.canRedo}
        onClick={history.redo}
      >
        <Redo2 size={15} aria-hidden="true" />
        {history.redoCount > 1 && (
          <span className="workflow-history-badge" aria-hidden="true">
            {history.redoCount > 9 ? "9+" : history.redoCount}
          </span>
        )}
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="workflow-history-trigger"
        aria-label="Edit history"
        title="Edit history"
        data-tooltip="Edit history"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={open ? "open" : "closed"}
        disabled={!canOpenPopover}
        onClick={togglePopover}
      >
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {!open && feedback !== null && (
        <span
          className="workflow-history-feedback"
          role="status"
          aria-live="polite"
          data-kind={feedback.kind}
        >
          {feedback.kind === "clear" || feedback.kind === "reset"
            ? feedback.label
            : `${feedback.kind === "undo" ? "Undone:" : "Redone:"} ${feedback.label}`}
        </span>
      )}
      {open &&
        anchorPos !== null &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="workflow-history-popover"
            role="dialog"
            aria-label="Edit history"
            style={{
              top: `${anchorPos.top}px`,
              left: `${anchorPos.left}px`,
            }}
            onKeyDown={handleListKeyDown}
          >
            <div className="workflow-history-popover-header">
              <span className="workflow-history-popover-title">
                Edit history
              </span>
              <span
                className="workflow-history-popover-summary"
                data-preview-active={
                  hoverIndex !== null && hoverIndex !== history.cursor
                    ? "true"
                    : undefined
                }
              >
                {summaryText}
              </span>
            </div>
            <div
              className="workflow-history-list"
              onMouseLeave={() => setHoverIndex(null)}
            >
              {orderedEntries.map((entry) => {
                const hasPreview =
                  hoverIndex !== null && hoverIndex !== history.cursor;
                const isTarget = hasPreview && entry.index === hoverIndex;
                const willUndo =
                  hasPreview &&
                  hoverIndex < history.cursor &&
                  entry.index > hoverIndex &&
                  entry.index <= history.cursor;
                const willRedo =
                  hasPreview &&
                  hoverIndex > history.cursor &&
                  entry.index > history.cursor &&
                  entry.index <= hoverIndex;
                const previewState = willUndo
                  ? "undo"
                  : willRedo
                    ? "redo"
                    : isTarget
                      ? "target"
                      : undefined;

                let metaLabel: string;
                if (isTarget && hoverIndex < history.cursor) {
                  metaLabel = "Jump here";
                } else if (willUndo) {
                  metaLabel = "Undo";
                } else if (willRedo) {
                  metaLabel = "Redo";
                } else if (entry.isCurrent) {
                  metaLabel = "Current";
                } else if (entry.role === "redo") {
                  metaLabel = "Redo";
                } else if (entry.timestamp !== null) {
                  metaLabel = formatHistoryTimestamp(entry.timestamp);
                } else {
                  metaLabel = "Start";
                }

                return (
                  <button
                    key={entry.index}
                    type="button"
                    className="workflow-history-entry"
                    data-history-index={entry.index}
                    data-role={entry.role}
                    data-current={entry.isCurrent ? "true" : undefined}
                    data-preview={previewState}
                    data-target={isTarget ? "true" : undefined}
                    aria-current={entry.isCurrent ? "step" : undefined}
                    onMouseEnter={() => setHoverIndex(entry.index)}
                    onFocus={() => setHoverIndex(entry.index)}
                    onBlur={() => setHoverIndex(null)}
                    onClick={() => {
                      setOpen(false);
                      setHoverIndex(null);
                      history.jumpTo(entry.index);
                    }}
                  >
                    <span
                      className="workflow-history-dot"
                      aria-hidden="true"
                    />
                    <span className="workflow-history-label">
                      {entry.label}
                    </span>
                    <span className="workflow-history-meta">{metaLabel}</span>
                  </button>
                );
              })}
            </div>
            <div className="workflow-history-popover-footer">
              <button
                type="button"
                className="workflow-history-reset"
                title="Restore default appliance positions and clear edit history"
                onMouseEnter={() => setHoverIndex(null)}
                onFocus={() => setHoverIndex(null)}
                onClick={() => {
                  setOpen(false);
                  setHoverIndex(null);
                  history.resetLayout();
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>Reset to initial layout</span>
              </button>
              <button
                type="button"
                className="workflow-history-clear"
                title="Clear Undo and Redo history (keeps current layout)"
                disabled={!hasHistory}
                onMouseEnter={() => setHoverIndex(null)}
                onFocus={() => setHoverIndex(null)}
                onClick={() => {
                  setOpen(false);
                  setHoverIndex(null);
                  history.clear();
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                <span>Clear history</span>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
