import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CanvasResize } from "../workflow-simulator/canvas-resize";
import { disposePhysicsObject } from "../workflow-simulator/spatial/physics-model";

/** The renderer setup of a recipe station. The simulator's lighting rig sets its own. */
type StationLook = Readonly<{
  exposure: number;
  /** The clear colour, or null for a transparent canvas. */
  background: number | null;
  /** The intensity of the room environment map, or null for the three.js default. */
  environmentIntensity: number | null;
  /** Black Sesame and Ginger Tea set the output colour space by name. */
  outputColorSpace?: THREE.ColorSpace;
}>;

type SceneHostOptions = Readonly<{
  /** The element that holds the canvas; the canvas follows its size. */
  view: HTMLElement;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  renderer?: THREE.WebGLRendererParameters;
  /** Set for a recipe station: tone mapping, soft shadows and a room environment. */
  look?: StationLook;
  /**
   * "pan": a left drag pans and a right drag rotates; Alt with a left drag
   * rotates, and Ctrl, Cmd or Shift with a right drag pans. One finger pans.
   */
  pointer?: "pan";
  /** "replace" removes the view's other children; "append" keeps them. */
  attach?: "append" | "replace" | "none";
  size?: Readonly<{
    /** The smallest drawing height in CSS pixels. */
    minHeight?: number;
    /** false keeps the canvas CSS size to the stylesheet. */
    style?: boolean;
    /** "settle" waits until a layout animation ends to reallocate the buffer. */
    buffer?: "now" | "settle";
  }>;
  /** Changes the camera and the scene after a size change, before the frame. */
  resized?: (width: number, height: number) => void;
  /** Moves the scene content for one frame; true asks for one more frame. */
  step?: (now: number) => boolean;
  /** Draws the frame; the default renders the scene with the camera. */
  draw?: () => void;
  /**
   * false keeps the scene content on dispose: the simulator scenes hold
   * cached models and dispose their own parts. The default disposes it all.
   */
  disposeContent?: boolean;
}>;

type CameraMove = Readonly<{
  startedAt: number;
  durationMs: number;
  ease: "cubic" | "smooth";
  fromPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toPosition: THREE.Vector3;
  toTarget: THREE.Vector3;
}>;

/**
 * Owns the renderer, the environment, the camera controls, the resize and the
 * frames of one 3D view. A scene changes its content and asks for a frame.
 * Frames are drawn on demand: requests coalesce into one frame, and the next
 * frame waits at least as long as the last one took, because one frame can
 * take seconds without a GPU. A paused, unchanged scene draws no frame.
 */
export class SceneHost {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly orbit: OrbitControls;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly environment: THREE.WebGLRenderTarget | null = null;
  private readonly observer: ResizeObserver;
  private readonly settle: CanvasResize | null;
  private readonly abort = new AbortController();
  private cameraMove: CameraMove | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEnd = 0;
  private lastCost = 0;
  private size = { width: 0, height: 0 };
  /** A frame was asked for while the view was hidden. */
  private missed = false;
  private disposed = false;

  constructor(private readonly options: SceneHostOptions) {
    this.camera = options.camera;
    this.renderer = new THREE.WebGLRenderer(
      options.renderer ?? { antialias: true },
    );
    const look = options.look;
    if (look !== undefined) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      if (look.outputColorSpace !== undefined)
        this.renderer.outputColorSpace = look.outputColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = look.exposure;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      if (look.background !== null)
        this.scene.background = new THREE.Color(look.background);
      const generator = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.environment = generator.fromScene(room, 0.04);
      this.scene.environment = this.environment.texture;
      if (look.environmentIntensity !== null)
        this.scene.environmentIntensity = look.environmentIntensity;
      generator.dispose();
      room.dispose();
    }
    const attach = options.attach ?? "append";
    if (attach === "replace")
      options.view.replaceChildren(this.renderer.domElement);
    else if (attach === "append") options.view.append(this.renderer.domElement);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    if (options.pointer === "pan") this.panFirst();
    this.orbit.addEventListener("start", this.stopCameraMove.bind(this));
    this.orbit.addEventListener("change", this.requestFrame.bind(this));
    this.settle =
      options.size?.buffer === "settle"
        ? new CanvasResize(this.renderer, this.requestFrame.bind(this))
        : null;
    this.observer = new ResizeObserver(this.resize.bind(this));
    this.observer.observe(options.view);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** The signal of this view: it aborts on dispose. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Asks for one frame. Requests before the frame join it. */
  requestFrame(): void {
    if (this.disposed || this.frame !== 0 || this.timer !== null) return;
    const wait = Math.max(0, this.lastEnd + this.lastCost - performance.now());
    if (wait === 0) {
      this.frame = requestAnimationFrame(this.draw);
      return;
    }
    this.timer = setTimeout(this.afterWait, wait);
  }

  /** Moves the camera to a new view in a short animation. */
  moveCamera(
    position: THREE.Vector3,
    target: THREE.Vector3,
    durationMs = 260,
    ease: CameraMove["ease"] = "cubic",
  ): void {
    this.cameraMove = {
      startedAt: performance.now(),
      durationMs,
      ease,
      fromPosition: this.camera.position.clone(),
      fromTarget: this.orbit.target.clone(),
      toPosition: position,
      toTarget: target,
    };
    this.requestFrame();
  }

  /** Places the camera at its first view and sets the damped orbit's limits. */
  startAt(
    view: Readonly<{
      position: readonly [number, number, number];
      target: readonly [number, number, number];
    }>,
    limits: Readonly<{
      minDistance: number;
      maxDistance: number;
      maxPolarAngle?: number;
    }>,
  ): void {
    this.camera.position.set(...view.position);
    this.orbit.target.set(...view.target);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    if (limits.maxPolarAngle !== undefined) {
      this.orbit.maxPolarAngle = limits.maxPolarAngle;
    }
    this.orbit.minDistance = limits.minDistance;
    this.orbit.maxDistance = limits.maxDistance;
    this.orbit.update();
  }

  /** Moves the camera to a preset view, for example a station close-up. */
  moveCameraTo(
    view: Readonly<{
      position: readonly [number, number, number];
      target: readonly [number, number, number];
    }>,
    durationMs?: number,
    ease?: CameraMove["ease"],
  ): void {
    this.moveCamera(
      new THREE.Vector3(...view.position),
      new THREE.Vector3(...view.target),
      durationMs,
      ease,
    );
  }

  stopCameraMove(): void {
    this.cameraMove = null;
  }

  /** Uses another camera, for example an orthographic top view. */
  useCamera(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void {
    if (this.camera === camera) return;
    this.camera = camera;
    this.orbit.object = camera;
    this.requestFrame();
  }

  /** Measures the view again now, for example after a layout change. */
  resize(): void {
    if (this.disposed) return;
    const view = this.options.view;
    // A hidden view keeps its buffer; it draws again when it shows.
    if (view.getClientRects().length === 0) return;
    if (this.missed) {
      this.missed = false;
      this.requestFrame();
    }
    const width = Math.max(1, view.clientWidth);
    const height = Math.max(
      this.options.size?.minHeight ?? 1,
      view.clientHeight,
    );
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.options.resized?.(width, height);
    if (this.settle !== null) this.settle.resize(width, height);
    else this.renderer.setSize(width, height, this.options.size?.style ?? true);
    this.requestFrame();
  }

  /** Reallocates a deferred drawing buffer now. */
  flushResize(): void {
    this.settle?.flush();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.observer.disconnect();
    this.settle?.dispose();
    this.orbit.dispose();
    if (this.options.disposeContent !== false)
      this.scene.traverse(disposePhysicsObject);
    this.environment?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private panFirst(): void {
    const orbit = this.orbit;
    orbit.mouseButtons.LEFT = THREE.MOUSE.PAN;
    orbit.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    orbit.touches.ONE = THREE.TOUCH.PAN;
    orbit.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    orbit.screenSpacePanning = true;
    this.canvas.addEventListener(
      "pointerdown",
      (event: PointerEvent) => {
        const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
        orbit.mouseButtons.LEFT =
          !modifier && event.altKey ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
        orbit.mouseButtons.RIGHT = modifier
          ? THREE.MOUSE.PAN
          : THREE.MOUSE.ROTATE;
      },
      { capture: true, signal: this.abort.signal },
    );
  }

  private readonly afterWait = (): void => {
    this.timer = null;
    if (!this.disposed) this.frame = requestAnimationFrame(this.draw);
  };

  private readonly draw = (now: number): void => {
    this.frame = 0;
    if (this.disposed) return;
    // A hidden view draws nothing; its resize asks for a frame when it shows.
    if (this.options.view.getClientRects().length === 0) {
      this.missed = true;
      return;
    }
    const started = performance.now();
    let more = this.stepCameraMove(started);
    if (this.options.step?.(now) === true) more = true;
    // With damping, the controls keep moving after a gesture and report it.
    if (this.orbit.update()) more = true;
    if (this.options.draw !== undefined) this.options.draw();
    else this.renderer.render(this.scene, this.camera);
    this.lastEnd = performance.now();
    this.lastCost = this.lastEnd - started;
    if (more) this.requestFrame();
  };

  private stepCameraMove(now: number): boolean {
    const move = this.cameraMove;
    if (move === null) return false;
    const t = Math.min(1, (now - move.startedAt) / move.durationMs);
    const eased =
      move.ease === "cubic" ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
    this.camera.position.lerpVectors(move.fromPosition, move.toPosition, eased);
    this.orbit.target.lerpVectors(move.fromTarget, move.toTarget, eased);
    if (t < 1) return true;
    this.cameraMove = null;
    return false;
  }
}
