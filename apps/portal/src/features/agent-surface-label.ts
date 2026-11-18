import "./agent-surface-label.css";

/**
 * The agent's label on the element that its command acted on (Plan 87
 * phase 4). A page marks its elements with `data-surface-target`; the label
 * follows the element for 5 seconds, as a room holds an agent's label after
 * an edit (`AGENT_ACTIVITY_HOLD_MS`).
 */
const AGENT_LABEL_HOLD_MS = 5_000;

type ShownLabel = {
  readonly overlay: HTMLElement;
  readonly target: string;
  frame: number;
  readonly timer: ReturnType<typeof setTimeout>;
};

let shown: ShownLabel | null = null;

export function showAgentLabel(target: string, label: string): void {
  clearAgentLabel();
  const element = targetElement(target);
  if (element === null) return;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  const overlay = document.createElement("div");
  overlay.className = "agent-surface-label";
  overlay.dataset.surfaceLabelFor = target;
  overlay.setAttribute("aria-hidden", "true");
  const tag = document.createElement("span");
  tag.className = "agent-surface-label-tag";
  tag.textContent = label;
  overlay.append(tag);
  document.body.append(overlay);
  shown = {
    overlay,
    target,
    frame: 0,
    timer: setTimeout(clearAgentLabel, AGENT_LABEL_HOLD_MS),
  };
  follow(shown);
}

function follow(label: ShownLabel): void {
  if (shown !== label) return;
  const element = targetElement(label.target);
  if (element === null) {
    label.overlay.hidden = true;
  } else {
    const rect = element.getBoundingClientRect();
    label.overlay.hidden = false;
    label.overlay.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
    label.overlay.style.width = `${rect.width}px`;
    label.overlay.style.height = `${rect.height}px`;
  }
  label.frame = requestAnimationFrame(follow.bind(null, label));
}

function clearAgentLabel(): void {
  if (shown === null) return;
  cancelAnimationFrame(shown.frame);
  clearTimeout(shown.timer);
  shown.overlay.remove();
  shown = null;
}

function targetElement(target: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-surface-target="${CSS.escape(target)}"]`,
  );
}
