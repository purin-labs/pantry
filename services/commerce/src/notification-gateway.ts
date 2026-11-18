// Sends buyer email (Plan 76A step 3). Commerce writes each notification to
// its outbox in the command's transaction and sends it after the commit, so a
// failed email never undoes an order.
export type NotificationMessage = Readonly<{
  notificationId: string;
  to: string;
  subject: string;
  text: string;
}>;

export type NotificationSendResult =
  | Readonly<{ kind: "sent"; providerMessageId: string }>
  | Readonly<{ kind: "failed"; reason: string }>;

export interface NotificationGateway {
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}

/** The Worker binding of Cloudflare Email Service. */
export type CloudflareEmailBinding = Readonly<{
  send: (
    message: Readonly<{
      to: string;
      from: string;
      subject: string;
      text: string;
    }>,
  ) => Promise<unknown>;
}>;

export class CloudflareEmailGateway implements NotificationGateway {
  readonly #binding: CloudflareEmailBinding;
  readonly #from: string;

  constructor(binding: CloudflareEmailBinding, from: string) {
    this.#binding = binding;
    this.#from = from;
  }

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    try {
      const result = await this.#binding.send({
        to: message.to,
        from: this.#from,
        subject: message.subject,
        text: message.text,
      });
      const messageId =
        typeof result === "object" &&
        result !== null &&
        "messageId" in result &&
        typeof result.messageId === "string"
          ? result.messageId
          : message.notificationId;
      return { kind: "sent", providerMessageId: messageId };
    } catch (error) {
      return {
        kind: "failed",
        reason: error instanceof Error ? error.message : "send failed",
      };
    }
  }
}
