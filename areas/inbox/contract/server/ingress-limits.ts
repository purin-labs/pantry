/**
 * A published ingress limit of a channel account that paused its agent
 * work: the open Cases, the messages of the hour, the daily token budget or
 * the size of one message. A mailbox and a WhatsApp number add their own
 * reasons to these.
 */
export type IngressLimitPauseReason =
  | {
      readonly kind: "active_case_limit";
      readonly observed: number;
      readonly limit: number;
    }
  | {
      readonly kind: "hourly_message_limit";
      readonly observed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "daily_token_budget";
      readonly reserved: number;
      readonly consumed: number;
      readonly limit: number;
      readonly windowEndsAt: number;
    }
  | {
      readonly kind: "message_too_large";
      readonly providerMessageId: string;
      readonly observedBytes: number;
      readonly limitBytes: number;
    };
