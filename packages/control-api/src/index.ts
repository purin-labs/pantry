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
export * from "./inbox.ts";
export * from "./mail-inbox.ts";
export * from "./mail-reply-document.ts";
export * from "./mail-organization.ts";
export * from "./mail-assistant.ts";
export * from "./mail-work.ts";
export * from "./mail-reply.ts";
export * from "./mail-sender-link.ts";
export * from "./email-review.ts";
export * from "./inventory-receipt.ts";

export * from "./inventory-production.ts";

export * from "./chat-forks.ts";
export * from "./chat-side-cases.ts";
export * from "./chat-signals.ts";

export * from "./ids.ts";

export * from "./project-access.ts";

export * from "./user-preferences.ts";

export * from "./mailbox-setup.ts";
export * from "./home-region.ts";

export * from "./chat-disclosure.ts";
export * from "./case-context-collections.ts";
export * from "./memory.ts";
export * from "./evals.ts";
export * from "./case-execution.ts";
export * from "./case-timeline.ts";
export * from "./menu-boards.ts";
export * from "./menu-board-reviews.ts";
export * from "./failed-payments.ts";
export * from "./payments.ts";
export * from "./bank-payouts.ts";
export * from "./order-queue.ts";
export * from "./counter-register.ts";
export * from "./counter-receipt.ts";
export * from "./brain.ts";
export * from "./message-attachments.ts";

export type {
  ChatGoalCommand,
  ChatGoalSupport,
  ChatGoalView,
} from "./chat-goal.ts";

export { parseChatGoalView } from "./chat-goal.ts";

export * from "./claude.ts";
export * from "./slack-reasoning-effort.ts";
export * from "./account-onboarding.ts";
export * from "./vault.ts";
export * from "./voice.ts";
export * from "./voice-engines.ts";
export * from "./voice-text-check.ts";
export * from "./devices.ts";
export * from "./recipes.ts";
export * from "./costs.ts";
