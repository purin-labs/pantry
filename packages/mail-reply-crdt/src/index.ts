import {
  RelativeTextSelection,
  captureTextPresenceSelection,
  hasValidPlainTextShape,
  normalizePlainText,
  parseYjsEncoding,
  resolveTextPresenceSelection,
  splicePlainText,
  type ParsedYjsEncoding,
  type TextInputRange,
  type TextPresenceSelection,
  type TextSelectionDirection,
} from "@purin-labs/collaboration";
import * as Y from "yjs";
import {
  BODY_LIMIT,
  UPDATE_LIMIT,
  STATE_LIMIT,
  STATE_VECTOR_LIMIT,
} from "./limits.ts";
export { BODY_LIMIT, STATE_LIMIT } from "./limits.ts";
export { RelativeTextSelection as MailReplySelection } from "@purin-labs/collaboration";

export const MAIL_REPLY_SCHEMA = "mail_reply_crdt.v1";

const ENCODING_LIMITS = {
  state: STATE_LIMIT,
  update: UPDATE_LIMIT,
  stateVector: STATE_VECTOR_LIMIT,
} as const;

export type MailReplyCrdtError = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "invalid_document_shape"
    | "body_too_long"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;

export type MailReplyCrdtResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: MailReplyCrdtError; value?: never }>;

type EncodingKind = "state" | "update" | "state_vector";

// Private bytes prevent callers from mutating a parsed value after validation.
class BodyEncoding<K extends EncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.kind = encoding.kind;
    this.#encoding = encoding;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends EncodingKind>(
    kind: K,
    bytes: Uint8Array,
  ): MailReplyCrdtResult<BodyEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, ENCODING_LIMITS);
    if (!parsed.ok) {
      return parsed;
    }

    if (kind !== "state_vector") {
      const decoded = Y.decodeUpdate(parsed.value.encode());
      for (const struct of decoded.structs) {
        if (
          struct instanceof Y.Item &&
          ((typeof struct.parent === "string" && struct.parent !== "body") ||
            struct.parentSub !== null ||
            !(
              struct.content instanceof Y.ContentString ||
              struct.content instanceof Y.ContentDeleted
            ))
        ) {
          return failure("invalid_document_shape");
        }
      }
    }
    return success(new BodyEncoding(parsed.value));
  }
}

export type MailReplyState = BodyEncoding<"state">;
export type MailReplyUpdate = BodyEncoding<"update">;
export type MailReplyStateVector = BodyEncoding<"state_vector">;

export function parseMailReplyState(
  bytes: Uint8Array,
): MailReplyCrdtResult<MailReplyState> {
  return BodyEncoding.parse("state", bytes);
}

export function parseMailReplyUpdate(
  bytes: Uint8Array,
): MailReplyCrdtResult<MailReplyUpdate> {
  return BodyEncoding.parse("update", bytes);
}

export function parseMailReplyStateVector(
  bytes: Uint8Array,
): MailReplyCrdtResult<MailReplyStateVector> {
  return BodyEncoding.parse("state_vector", bytes);
}

export type MailReplyChange =
  | Readonly<{ origin: "local"; body: string; update: MailReplyUpdate }>
  | Readonly<{ origin: "remote"; body: string; update?: never }>;

export type MailReplyListener = (change: MailReplyChange) => void;
export type MailReplyInputRange = TextInputRange;
export type MailReplyPresenceSelection = TextPresenceSelection;

export class MailReplyDoc {
  #doc: Y.Doc;
  readonly #listeners = new Set<MailReplyListener>();

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
  }

  static create(initialBody: string): MailReplyCrdtResult<MailReplyDoc> {
    const body = normalizePlainText(initialBody);
    const valid = validateBody(body);
    if (!valid.ok) return valid;
    const doc = new Y.Doc();
    doc.getText("body").insert(0, body);
    return success(new MailReplyDoc(doc));
  }

  static restore(state: MailReplyState): MailReplyCrdtResult<MailReplyDoc> {
    const doc = new Y.Doc();
    doc.getText("body");
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validateDocument(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return success(new MailReplyDoc(doc));
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
  }

  read(): string {
    return this.#doc.getText("body").toString();
  }

  state(): MailReplyCrdtResult<MailReplyState> {
    return parseMailReplyState(Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): MailReplyCrdtResult<MailReplyStateVector> {
    return parseMailReplyStateVector(Y.encodeStateVector(this.#doc));
  }

  syncUpdate(
    remoteStateVector: MailReplyStateVector,
  ): MailReplyCrdtResult<MailReplyUpdate> {
    try {
      return parseMailReplyUpdate(
        Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()),
      );
    } catch {
      return failure("invalid_state_vector");
    }
  }

  apply(update: MailReplyUpdate): MailReplyCrdtResult<null> {
    const candidate = cloneDocument(this.#doc);
    try {
      Y.applyUpdate(candidate, update.encode());
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    this.#replace(candidate);
    this.#notify({ origin: "remote", body: this.read() });
    return success(null);
  }

  edit(
    nextValue: string,
    inputRange?: MailReplyInputRange,
  ): MailReplyCrdtResult<MailReplyUpdate> {
    const next = normalizePlainText(nextValue);
    const validText = validateBody(next);
    if (!validText.ok) return validText;
    const candidate = cloneDocument(this.#doc);
    let update: MailReplyUpdate;
    try {
      candidate.transact(
        splicePlainText.bind(
          null,
          candidate.getText("body"),
          this.read(),
          next,
          inputRange,
        ),
      );
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
      const encoded = parseMailReplyUpdate(
        Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.#doc)),
      );
      if (!encoded.ok) {
        candidate.destroy();
        return encoded;
      }
      update = encoded.value;
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
    this.#replace(candidate);
    this.#notify({ origin: "local", body: next, update });
    return success(update);
  }

  captureSelection(
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): RelativeTextSelection {
    return RelativeTextSelection.capture(
      this.#doc.getText("body"),
      start,
      end,
      direction,
    );
  }

  resolveSelection(
    selection: RelativeTextSelection,
  ): Readonly<{
    start: number;
    end: number;
    direction: TextSelectionDirection;
  }> {
    return selection.resolve(this.#doc);
  }

  capturePresenceSelection(
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): MailReplyPresenceSelection {
    return captureTextPresenceSelection(
      this.#doc.getText("body"),
      start,
      end,
      direction,
    );
  }

  resolvePresenceSelection(
    selection: MailReplyPresenceSelection,
  ): Readonly<{
    start: number;
    end: number;
    direction: TextSelectionDirection;
  }> | null {
    const text = this.#doc.getText("body");
    return resolveTextPresenceSelection(this.#doc, text, selection);
  }

  subscribe(listener: MailReplyListener): void {
    this.#listeners.add(listener);
  }

  unsubscribe(listener: MailReplyListener): void {
    this.#listeners.delete(listener);
  }

  destroy(): void {
    this.#listeners.clear();
    this.#doc.destroy();
  }

  #replace(candidate: Y.Doc): void {
    this.#doc.destroy();
    this.#doc = candidate;
  }

  #notify(change: MailReplyChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const candidate = new Y.Doc();
  candidate.getText("body");
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  // Keep this replica's identity while staging an edit; reject by discarding the clone.
  candidate.clientID = source.clientID;
  return candidate;
}

function validateBody(value: string): MailReplyCrdtResult<null> {
  if (value.length > BODY_LIMIT) return failure("body_too_long");
  if (!hasValidPlainTextShape(value)) {
    return failure("invalid_document_shape");
  }
  return success(null);
}

function validateDocument(doc: Y.Doc): MailReplyCrdtResult<null> {
  if (doc.share.size !== 1 || !doc.share.has("body"))
    return failure("invalid_document_shape");
  const text = doc.getText("body");
  if (Object.keys(text.getAttributes()).length !== 0)
    return failure("invalid_document_shape");
  for (const part of text.toDelta()) {
    if (
      typeof part.insert !== "string" ||
      (part.attributes && Object.keys(part.attributes).length !== 0)
    )
      return failure("invalid_document_shape");
  }
  const validText = validateBody(text.toString());
  if (!validText.ok) return validText;
  if (Y.encodeStateVector(doc).byteLength > STATE_VECTOR_LIMIT)
    return failure("state_vector_too_large");
  const state = parseMailReplyState(Y.encodeStateAsUpdate(doc));
  return state.ok ? success(null) : state;
}

function success<T>(value: T): MailReplyCrdtResult<T> {
  return { ok: true, value };
}

function failure(code: MailReplyCrdtError["code"]): MailReplyCrdtResult<never> {
  return { ok: false, error: { code } };
}
