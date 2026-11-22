import { assertNever } from "@purin-labs/std";
import {
  authorizeEmailDraftRequest,
  matchEmailDraftRoute,
} from "../control/admission/email-draft";
import {
  authorizeMailReplyDraftRequest,
  matchMailReplyDraftRoute,
} from "../control/admission/mail-reply-draft";
import type {
  CollaborationRoomRoute,
  CollaborationSocketRooms,
} from "@purin-labs/collaboration/worker/collaboration-room-dispatch";
import type { EmailDraftRooms } from "./email-draft";
import type { MailReplyDraftRooms } from "./mail-reply-draft";

/**
 * The shared documents of the Inbox in the Organisation actor: the reply
 * draft of a mail proposal and the email draft. Each route is the path match,
 * the admission check and the room.
 */
export function inboxCollaborationRooms(
  rooms: Readonly<{
    emailDrafts: EmailDraftRooms;
    mailReplyDrafts: MailReplyDraftRooms;
  }>,
) {
  const mailReplyDraft: CollaborationRoomRoute = (pathname) => {
    const route = matchMailReplyDraftRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeMailReplyDraftRequest(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond: (scope) =>
            rooms.mailReplyDrafts.open(authorized, route.proposalId, scope),
        };
      },
    };
  };
  const emailDraft: CollaborationRoomRoute = (pathname) => {
    const route = matchEmailDraftRoute(pathname);
    if (route === null) return null;
    return {
      checksOrganisationRecord: true,
      async authorize(request, env) {
        const authorized = await authorizeEmailDraftRequest(
          request,
          env,
          route,
        );
        if (!authorized.ok) return authorized;
        return {
          ok: true,
          organisationId: authorized.organisationId,
          respond(scope) {
            switch (route.transport) {
              case "snapshot":
                return rooms.emailDrafts.snapshot();
              case "socket":
                return rooms.emailDrafts.open(authorized, scope);
              case "review":
                return rooms.emailDrafts.review(authorized);
              case "shared-thread":
                return rooms.emailDrafts.shareThread(
                  request,
                  authorized,
                  scope,
                );
              default:
                return assertNever(route.transport);
            }
          },
        };
      },
    };
  };
  const sockets: Pick<
    CollaborationSocketRooms,
    "email_draft" | "mail_reply_draft"
  > = {
    email_draft: (organisationId, key) =>
      rooms.emailDrafts.socketRoom(organisationId, key),
    mail_reply_draft: (organisationId, key) =>
      rooms.mailReplyDrafts.socketRoom(organisationId, key),
  };
  return { routes: { mailReplyDraft, emailDraft }, sockets };
}
