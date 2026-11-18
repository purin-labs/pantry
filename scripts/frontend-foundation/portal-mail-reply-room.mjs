// Local WebSocket adapter for the production Inbox shared-draft client.
import { MailReplyDoc } from "@seams/mail-reply-crdt";
import {
  encodeDraftServerMessage,
  parseDraftClientMessage,
} from "@seams/mail-reply-crdt/protocol";
import { COLLABORATION_PING, COLLABORATION_PONG } from "@seams/collaboration";

const INITIAL_BODY =
  "Hi Mika,\n\nPlease confirm Friday arrival and the quantity. We need to check the impact on our pastry orders.\n\nCafeOS";

class MailReplyRoom {
  constructor() {
    const created = MailReplyDoc.create(INITIAL_BODY);
    if (!created.ok)
      throw new Error("The reply document could not be created.");
    this.document = created.value;
    this.savedBody = INITIAL_BODY;
    this.savedVersion = 2;
  }

  connect(socket) {
    socket.onMessage(this.receive.bind(this, socket));
  }

  receive(socket, frame) {
    if (frame === COLLABORATION_PING) {
      socket.send(COLLABORATION_PONG);
      return;
    }
    const parsed = parseDraftClientMessage(frame);
    if (!parsed.ok) throw new Error("The reply client sent an invalid frame.");
    const message = parsed.value;
    switch (message.kind) {
      case "sync_request": {
        const vector = this.document.stateVector();
        const update = this.document.syncUpdate(message.stateVector);
        if (!vector.ok || !update.ok)
          throw new Error("The shared reply could not sync.");
        socket.send(
          encodeDraftServerMessage({
            kind: "sync_response",
            serverStateVector: vector.value,
            missingUpdate: update.value,
            access: "edit",
            sessionId: "reply_visual_review",
            savedVersion: this.savedVersion,
            unsaved: this.document.read() !== this.savedBody,
          }),
        );
        return;
      }
      case "submit_update": {
        if (!this.document.apply(message.update).ok)
          throw new Error("The editor sent an invalid update.");
        socket.send(
          encodeDraftServerMessage({
            kind: "update_accepted",
            updateId: message.updateId,
          }),
        );
        return;
      }
      case "presence_update":
      case "pointer_update":
        return;
    }
  }

  save() {
    this.savedBody = this.document.read();
    this.savedVersion += 1;
    return { body: this.savedBody, version: this.savedVersion };
  }
}

export async function installMailReplyRoom(page) {
  const room = new MailReplyRoom();
  await page.routeWebSocket(
    "**/email-replies/proposal_supplier_reply/draft/socket",
    room.connect.bind(room),
  );
  await page.exposeFunction("saveMailReplyDraft", room.save.bind(room));
}
