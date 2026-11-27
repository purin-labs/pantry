import { deliverWhatsAppOperatorNotice } from "@purin-labs/surface-slack/server/actors/whatsapp-operator-notice";
import {
  dispatchWhatsAppReply,
  previewWhatsAppProposal,
} from "@purin-labs/area-inbox/server/actors/connector-whatsapp-proposal";
import {
  acceptWhatsAppEvent,
  dispatchWhatsAppReplyFor,
  previewWhatsAppProposalFor,
  readWhatsAppCasePanel,
  type WhatsAppRpcDeps,
  type WhatsAppReplyOrigin,
  type WhatsAppReplyExecutionDeps,
} from "@purin-labs/area-inbox/server/actors/connector-whatsapp-rpc";

declare const preview: Parameters<typeof previewWhatsAppProposal>[0];
declare const dispatch: Parameters<typeof dispatchWhatsAppReply>[0];
declare const deps: WhatsAppRpcDeps;
declare const command: Parameters<typeof dispatchWhatsAppReplyFor>[1];

// @ts-expect-error A direct preview input requires captured placement authority.
void previewWhatsAppProposal({
  sql: preview.sql,
  cipher: preview.cipher,
  proposalId: preview.proposalId,
  now: preview.now,
});

const { scope, ...dispatchWithoutScope } = dispatch;
void scope;
// @ts-expect-error A spread cannot omit the send's placement authority.
void dispatchWhatsAppReply({ ...dispatchWithoutScope });

// @ts-expect-error The RPC send boundary requires the same captured scope.
void dispatchWhatsAppReplyFor(deps, command);
// @ts-expect-error The RPC preview boundary requires the same captured scope.
void previewWhatsAppProposalFor(deps, preview.proposalId, preview.now);

// @ts-expect-error Protected Case contents require captured placement authority.
void readWhatsAppCasePanel({ ...deps }, "case_p55");

declare const notice: Parameters<typeof deliverWhatsAppOperatorNotice>[0];
const { scope: noticeScope, ...noticeWithoutScope } = notice;
void noticeScope;
// @ts-expect-error Notice dispatch requires the caller's captured scope.
void deliverWhatsAppOperatorNotice({ ...noticeWithoutScope });
declare const event: Parameters<typeof acceptWhatsAppEvent>[1];
// @ts-expect-error Webhook admission must retain captured authority through notices.
void acceptWhatsAppEvent(deps, event, 0);

declare const replyDeps: WhatsAppReplyExecutionDeps;
const { origin: replyOrigin, ...replyWithoutOrigin } = replyDeps;
void replyOrigin;
// @ts-expect-error Directed replies retain a required origin through RPC preparation.
void dispatchWhatsAppReplyFor(replyWithoutOrigin, command);
const { authorizeExecution: replyAuthorization, ...replyWithoutAuthorization } =
  dispatch;
void replyAuthorization;
// @ts-expect-error Credential awaits must be followed by required origin authorization.
void dispatchWhatsAppReply(replyWithoutAuthorization);
const sessionReplyFields = { execution: {} };
// @ts-expect-error An automatic reply cannot carry Session authority through a spread.
const invalidAutomaticReply: WhatsAppReplyOrigin = {
  kind: "automatic",
  ...sessionReplyFields,
};
void invalidAutomaticReply;
