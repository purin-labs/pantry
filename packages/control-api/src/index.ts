/**
 * Request and response shapes shared by the platform's control routes and the
 * portal that calls them. Both sides import these instead of keeping copies,
 * so changing a wire shape is a compile error on whichever side lags behind.
 */
export type * from "./access.ts";
export type * from "./agents.ts";
export * from "./chat.ts";
export * from "./portal-page-view.ts";
export * from "./surface-observation.ts";
export * from "./slack-names.ts";
export * from "./surface-command.ts";
export * from "./case-screen-observations.ts";
export * from "./screen-relevance.ts";
export * from "./agent-permission-requests.ts";
export * from "./permission-required.ts";
export * from "./projects.ts";
export * from "./project-context.ts";
export type * from "./commerce.ts";
export * from "./supplier-id.ts";
export type * from "./home.ts";
export type * from "./payouts.ts";
export type * from "./schedule.ts";
export type * from "./terminals.ts";
export type * from "./whatsapp.ts";
export * from "./inbox";
export * from "./mail-inbox";
export * from "./mail-reply-document";
export * from "./mail-organization";
export * from "./mail-assistant";
export * from "./mail-work";
export * from "./mail-reply";
export * from "./mail-sender-link";
export * from "./email-review";
export * from "./inventory-receipt";

export * from "./inventory-production";

export * from "./chat-forks";
export * from "./chat-side-cases";
export * from "./chat-signals";

export * from "./ids";

export * from "./project-access";

export * from "./user-preferences";

export * from "./mailbox-setup";
export * from "./home-region";

export * from "./chat-disclosure";
export * from "./case-context-collections";
export * from "./memory";
export * from "./evals";
export * from "./case-execution";
export * from "./case-timeline";
export * from "./menu-boards";
export * from "./menu-board-reviews";
export * from "./failed-payments";
export * from "./payments";
export * from "./bank-payouts";
export * from "./order-queue";
export * from "./brain";
export * from "./message-attachments";

export type {
  ChatGoalCommand,
  ChatGoalSupport,
  ChatGoalView,
} from "./chat-goal";

export { parseChatGoalView } from "./chat-goal";

export * from "./claude";
export * from "./slack-reasoning-effort";
export * from "./account-onboarding";
export * from "./vault";
export * from "./voice";
export * from "./voice-engines";
export * from "./voice-text-check";
export * from "./devices";
export * from "./recipes";
export * from "./costs";
