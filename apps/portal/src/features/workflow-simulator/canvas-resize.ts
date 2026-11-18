import * as THREE from "three";

// Reallocating a WebGL drawing buffer blocks the main thread for several
// milliseconds at 2x density, so a layout animation that resizes the viewport
// on every frame (the sidebar rail, the chat underlay) drops frames. While the
// size keeps changing, the existing buffer is shown at the new CSS size. The
// caller sets the camera to the new aspect, so the image stays in proportion
// and is only briefly soft; the buffer is reallocated once the size settles.
const settleDelay = 150;

export class CanvasResize {
  private readonly buffer = new THREE.Vector2();
  private timer = 0;
  private pending: { width: number; height: number } | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly reallocated: () => void,
  ) {}

  resize(width: number, height: number): void {
    window.clearTimeout(this.timer);
    this.pending = null;
    this.renderer.getSize(this.buffer);
    // A buffer under half the new size would look blurred; reallocate now.
    if (this.buffer.x < width / 2 || this.buffer.y < height / 2) {
      this.renderer.setSize(width, height);
      return;
    }
    const style = this.renderer.domElement.style;
    style.width = `${width}px`;
    style.height = `${height}px`;
    if (this.buffer.x !== width || this.buffer.y !== height) {
      this.pending = { width, height };
      this.timer = window.setTimeout(
        this.reallocate.bind(this, width, height),
        settleDelay,
      );
    }
  }

  // Reallocates a deferred buffer now, for a caller that hides the canvas.
  flush(): void {
    if (this.pending === null) return;
    window.clearTimeout(this.timer);
    this.reallocate(this.pending.width, this.pending.height);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
  }

  private reallocate(width: number, height: number): void {
    this.pending = null;
    this.renderer.setSize(width, height);
    this.reallocated();
  }
}
