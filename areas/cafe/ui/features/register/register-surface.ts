import {
  REGISTER_VIEW_COMMANDS,
  type CounterRegisterBasketLine,
  type CounterRegisterSnapshot,
  type PortalPageViewV1,
  type RegisterViewCommand,
  type SurfacePageCommandV1,
} from "@purin-labs/control-api";
import type { CounterSale } from "@purin-labs/control-api/portal/counter-sale";
import {
  registerSurfaceView,
  type SurfaceCommandOutcome,
  type SurfaceViewSource,
} from "@purin-labs/ui/features/surface-observation";
import { formatMoneyMinorEnglish as formatMoney } from "@purin-labs/ui/formatting";

export type RegisterSurfaceState = Readonly<{
  snapshot: CounterRegisterSnapshot;
  basket: readonly CounterRegisterBasketLine[];
  activeSale: CounterSale | null;
}>;

export class RegisterPageViewSource implements SurfaceViewSource {
  state: RegisterSurfaceState | null = null;
  private unregisterView: (() => void) | null = null;

  constructor(
    private readonly organisationId: string,
    private readonly runRegisterCommand: (
      command: RegisterViewCommand,
    ) => Promise<SurfaceCommandOutcome>,
  ) {}

  pageOrganisationId(): string {
    return this.organisationId;
  }

  surfacePage(): "register" {
    return "register";
  }

  surfaceCommands(): readonly string[] {
    return this.state === null || this.state.activeSale !== null
      ? []
      : REGISTER_VIEW_COMMANDS;
  }

  async runSurfaceCommand(
    command: SurfacePageCommandV1["command"],
  ): Promise<SurfaceCommandOutcome> {
    switch (command.name) {
      case "register_add_item":
      case "register_update_line":
      case "register_remove_line":
      case "register_clear_basket":
        return this.runRegisterCommand(command);
      default:
        return {
          kind: "rejected",
          message: "Register only accepts basket staging commands.",
        };
    }
  }

  capturePageView(): PortalPageViewV1 | null {
    const current = this.state;
    if (current === null) return null;
    const { snapshot, basket, activeSale } = current;
    const totalMinor = basket.reduce(
      (sum, line) => sum + line.unitPriceMinor * line.quantity,
      0,
    );
    const menuRows =
      snapshot.menu?.sections.flatMap((section) =>
        section.entries.map((entry) => [
          entry.menuEntryId,
          entry.title,
          section.name,
          formatMoney(entry.unitPrice.amountMinor, entry.unitPrice.currency),
          entry.available ? "on sale" : "sold out",
        ]),
      ) ?? [];

    return {
      kind: "portal-page-view",
      schemaVersion: 1,
      page: "register",
      title: "Register",
      path: window.location.pathname,
      capturedAt: Date.now(),
      sections: [
        {
          title: "Register status",
          facts: [
            { label: "Location", value: snapshot.pantryLocationId || "Unset" },
            {
              label: "Cash tender",
              value: snapshot.policy?.cashEnabled ? "Enabled" : "Disabled",
            },
            {
              label: "Terminal",
              value: snapshot.terminal.assigned
                ? `${snapshot.terminal.provider ?? "terminal"} (${snapshot.terminal.ready ? "ready" : snapshot.terminal.blockedReason ?? "unavailable"})`
                : "Not assigned",
            },
            {
              label: "Open pickup queue",
              value: String(snapshot.openQueueCount),
            },
            ...(activeSale === null
              ? []
              : [
                  {
                    label: "Active sale",
                    value: `${activeSale.checkoutId} (${activeSale.state}${activeSale.pickupCode ? `, pickup ${activeSale.pickupCode}` : ""})`,
                  },
                ]),
          ],
          table: null,
        },
        {
          title: "Current basket",
          facts: [
            {
              label: "Basket total",
              value: formatMoney(totalMinor, snapshot.currency),
            },
            {
              label: "Human confirmation",
              value:
                "Sous Chef may stage basket lines only; staff press Cash or Charge terminal.",
            },
          ],
          table:
            basket.length === 0
              ? null
              : {
                  columns: ["Line key", "Item", "Modifiers", "Qty", "Subtotal"],
                  rows: basket.map((line) => [
                    line.lineKey,
                    line.title,
                    line.modifierLabels.join(", ") || "—",
                    String(line.quantity),
                    formatMoney(line.unitPriceMinor * line.quantity, line.currency),
                  ]),
                  totalRows: basket.length,
                },
        },
        {
          title: "Menu items",
          facts: [],
          table:
            menuRows.length === 0
              ? null
              : {
                  columns: ["Entry ID", "Item", "Section", "Price", "Status"],
                  rows: menuRows.slice(0, 100),
                  totalRows: menuRows.length,
                },
        },
      ],
    };
  }

  register(): void {
    this.unregisterView ??= registerSurfaceView(this);
  }

  unregister(): void {
    this.unregisterView?.();
    this.unregisterView = null;
    this.state = null;
  }
}
