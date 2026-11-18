export type HomeDestination =
  | { readonly kind: "home" }
  | { readonly kind: "commerce" }
  | { readonly kind: "orders" }
  | { readonly kind: "product"; readonly resourceId: string }
  | { readonly kind: "customer_order"; readonly resourceId: string }
  | { readonly kind: "operations" }
  | { readonly kind: "integrations" }
  | { readonly kind: "settings" };

export type HomeSourceObservation = {
  readonly kind: "commerce" | "governed_work" | "workspace_readiness";
  readonly status: "current" | "delayed" | "unavailable";
  readonly observedAt: string | null;
};

export type HomeAttentionItem = {
  readonly kind:
    "governed_action" | "commerce_exception" | "integration_health";
  readonly urgency: "urgent" | "high";
  readonly status: "awaiting_review" | "blocked" | "failed" | "uncertain";
  readonly title: string;
  readonly reason: string;
  readonly resource: {
    readonly kind:
      | "customer_order"
      | "inventory"
      | "payment"
      | "fulfillment"
      | "shipment"
      | "catalog"
      | "integration";
    readonly label: string;
  };
  readonly observedAt: string;
  readonly assignee: { readonly kind: "unassigned" };
  readonly nextAction: HomeAvailableAction;
};

export type HomeTodayFact = {
  readonly kind:
    | "open_customer_orders"
    | "low_stock_products"
    | "payment_failures"
    | "delayed_shipments";
  readonly label: string;
  readonly value: number;
  readonly observedAt: string;
  readonly destination: HomeDestination;
};

export type HomeBlocker = {
  readonly kind:
    "workspace" | "authentication" | "synchronization" | "permission";
  readonly title: string;
  readonly reason: string;
  readonly consequence: string;
  readonly observedAt: string | null;
  readonly nextAction: HomeAvailableAction;
};

export type HomeAvailableAction = {
  readonly kind:
    | "review_operations"
    | "open_commerce"
    | "resolve_blocker"
    | "manage_workspace";
  readonly label: string;
  readonly destination: HomeDestination;
};
