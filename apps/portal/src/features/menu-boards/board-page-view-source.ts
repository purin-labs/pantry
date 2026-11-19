import type { PortalPageViewV1 } from "@purin-labs/control-api";
import { registerSurfaceView, type SurfaceViewSource } from "../surface-observation";
import { boardPageView, type BoardPageSnapshot } from "./board-page-view";

/** Registers Menus › Boards with the chat while the board editor is open. */
export class BoardPageViewSource implements SurfaceViewSource {
  snapshot: BoardPageSnapshot | null = null;
  #unregister: (() => void) | null = null;

  pageOrganisationId(): string {
    return this.snapshot?.organisationId ?? "";
  }

  surfacePage(): "menus" {
    return "menus";
  }

  capturePageView(): PortalPageViewV1 | null {
    return this.snapshot === null ? null : boardPageView(this.snapshot, window.location.pathname);
  }

  register(): void {
    this.#unregister ??= registerSurfaceView(this);
  }

  unregister(): void {
    this.#unregister?.();
    this.#unregister = null;
    this.snapshot = null;
  }
}

