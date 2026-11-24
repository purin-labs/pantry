import { PROVIDER_ADAPTERS } from "@purin-labs/area-integrations/server/provider-adapters/catalogue";
import type { ProviderAdapter } from "@purin-labs/area-integrations-contract/server/provider-adapter";
import type { ActiveIntegrationProvider } from "@purin-labs/connections/data/integration-provider-directory";
import type { MailProviderAdapter } from "@purin-labs/connections/mail/provider-adapter";
import type { GmailAuthorizationProduct } from "@purin-labs/connections/mail/gmail-authorization";

type GmailProducts = MailProviderAdapter<"gmail">["products"];

const { mail: gmailMail, ...gmailConnection } = PROVIDER_ADAPTERS.gmail;

// @ts-expect-error Gmail requires its mail facet even when connection fields are spread.
const missingMail: ProviderAdapter<"gmail"> = gmailConnection;

const nonMailWithFacet: ProviderAdapter<"shopify"> = {
  ...PROVIDER_ADAPTERS.shopify,
  // @ts-expect-error A non-mail provider cannot acquire mail operations through a spread.
  mail: gmailMail,
};

// @ts-expect-error A provider union must keep the mail facet correlated with Gmail.
const invalidProviderUnion: ProviderAdapter<ActiveIntegrationProvider> = {
  ...PROVIDER_ADAPTERS.shopify,
  mail: gmailMail,
};

// @ts-expect-error Full Inbox requires reads, observation and drafts.
const incompleteInbox: GmailProducts["full_mailbox_pilot"] = {
  product: "full_mailbox_pilot",
  submission: gmailMail.products.full_mailbox_pilot.submission,
};

const sendOnlyWithReads: GmailProducts["send_only"] = {
  ...gmailMail.products.send_only,
  // @ts-expect-error Send-only has no mailbox reads.
  reads: gmailMail.products.full_mailbox_pilot.reads,
};

const sendOnlyWithObservation: GmailProducts["send_only"] = {
  product: "send_only",
  submission: gmailMail.products.send_only.submission,
  // @ts-expect-error Send-only has no observation operations.
  observation: gmailMail.products.full_mailbox_pilot.observation,
};

const sendOnlyWithDrafts: GmailProducts["send_only"] = {
  product: "send_only",
  submission: gmailMail.products.send_only.submission,
  // @ts-expect-error Send-only has no native draft operations.
  drafts: gmailMail.products.full_mailbox_pilot.drafts,
};

const sendOnlyWithReply: GmailProducts["send_only"] = {
  product: "send_only",
  submission: {
    sendMessage: gmailMail.products.send_only.submission.sendMessage,
    // @ts-expect-error Send-only cannot submit threaded replies.
    sendReply: gmailMail.products.full_mailbox_pilot.submission.sendReply,
  },
};

// @ts-expect-error A full-Inbox branch cannot be cast directly into send-only authority.
const invalidProductCast = gmailMail.products
  .full_mailbox_pilot as GmailProducts["send_only"];

declare const product: GmailAuthorizationProduct;
const selected = gmailMail.products[product];
// @ts-expect-error A product union must narrow before using mailbox reads.
selected.reads.readMessage;
selected.submission.sendMessage;
if (selected.product === "full_mailbox_pilot") {
  selected.reads.readMessage;
  selected.drafts.read;
}

void missingMail;
void nonMailWithFacet;
void invalidProviderUnion;
void incompleteInbox;
void sendOnlyWithReads;
void sendOnlyWithObservation;
void sendOnlyWithDrafts;
void sendOnlyWithReply;
void invalidProductCast;
