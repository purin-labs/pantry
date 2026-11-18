export type WhatsAppCasePanelEntry = {
  readonly direction: "inbound" | "outbound";
  readonly occurredAt: number;
  readonly providerMessageId: string;
  readonly text: string;
};

export type WhatsAppProviderHealth =
  | { readonly kind: "pending" }
  | { readonly kind: "healthy"; readonly webhookVerifiedAt: number }
  | { readonly kind: "degraded"; readonly reasonCode: string }
  | { readonly kind: "unsubscribed" }
  | { readonly kind: "revoked" };
