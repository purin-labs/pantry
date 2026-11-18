import type { PhysicsModel } from "./physics-model";

/** Presentation-only articulation. The recorded model is restored on every exit. */
export class DoorInspection {
  readonly element = document.createElement("details");
  private readonly angle = document.createElement("input");
  private readonly status = document.createElement("p");
  private readonly restore = document.createElement("button");
  private readonly opening = document.createElement("p");
  private previewDegrees: number | null = null;

  constructor(
    private readonly model: PhysicsModel,
    private readonly pause: () => void,
    private readonly changed: () => void,
    private readonly control: ((degrees: number | null) => void) | null,
  ) {
    this.element.className = "spatial-door-inspection";
    const summary = document.createElement("summary");
    summary.textContent = "Inspect oven door";
    const label = document.createElement("label");
    label.append("Preview door angle (degrees)");
    this.angle.type = "range";
    this.angle.min = "0";
    this.angle.max = "110";
    this.angle.step = "1";
    this.angle.value = String(
      Math.round(((model.recordedDoorAngle() ?? 0) * 180) / Math.PI),
    );
    this.angle.addEventListener("input", this.preview.bind(this));
    label.append(this.angle);
    this.restore.type = "button";
    this.restore.textContent = "Return to recorded door pose";
    this.restore.disabled = true;
    this.restore.addEventListener("click", this.restorePose.bind(this));
    this.status.setAttribute("role", "status");
    this.status.textContent =
      "Recorded door pose. Moving the slider pauses playback.";
    const note = document.createElement("p");
    note.textContent =
      "Preview only. The dashed envelope shows the modeled door-opening space. An envelope overlap alone is unchecked; red findings require intersecting solids at an identified angle. Access space and manufacturer clearances remain unknown. This pose cannot become simulation evidence.";
    this.element.append(
      summary,
      this.opening,
      label,
      this.status,
      this.restore,
      note,
    );
    this.element.addEventListener("toggle", this.toggled.bind(this));
  }

  private preview(): void {
    this.requestPreview(this.angle.valueAsNumber);
  }

  private toggled(): void {
    this.opening.textContent = this.model.inspectDoorOpening(this.element.open);
    if (!this.element.open) this.close();
    this.changed();
  }

  private restorePose(): void {
    this.requestPreview(null);
  }

  reset(): boolean {
    return this.setPreview(null);
  }

  close(): void {
    if (this.previewDegrees !== null) this.requestPreview(null);
  }

  setPreview(degrees: number | null): boolean {
    if (degrees === this.previewDegrees) return false;
    this.previewDegrees = degrees;
    this.model.previewDoor(degrees === null ? null : (degrees * Math.PI) / 180);
    if (degrees === null) {
      this.angle.value = String(
        Math.round(((this.model.recordedDoorAngle() ?? 0) * 180) / Math.PI),
      );
      this.status.textContent = "Recorded door pose restored.";
    } else {
      this.element.open = true;
      this.angle.value = String(degrees);
      this.status.textContent = `Door preview · ${degrees}° · Playback paused`;
    }
    this.restore.disabled = degrees === null;
    return true;
  }

  private requestPreview(degrees: number | null): void {
    if (this.control !== null) this.control(degrees);
    else {
      if (degrees !== null && this.previewDegrees === null) this.pause();
      if (this.setPreview(degrees)) this.changed();
    }
  }
}
