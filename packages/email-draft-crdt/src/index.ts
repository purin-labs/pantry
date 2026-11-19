import {
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
  type TextSelectionRange,
} from "@purin-labs/collaboration";
import * as Y from "yjs";
import {
  EMAIL_AGGREGATE_LIMIT,
  EMAIL_BODY_LIMIT,
  EMAIL_PREVIEW_LIMIT,
  EMAIL_STATE_LIMIT,
  EMAIL_STATE_VECTOR_LIMIT,
  EMAIL_SUBJECT_LIMIT,
  EMAIL_UPDATE_LIMIT,
} from "./limits.ts";


export const EMAIL_DRAFT_SCHEMA = "email_draft_crdt.v1";

export type EmailDraftField = "subject" | "preview" | "body";
export type EmailDraftSnapshot = Readonly<Record<EmailDraftField, string>>;
export type EmailDraftSelection = Readonly<{
  field: EmailDraftField;
  anchor: TextPresenceSelection;
}>;

export type EmailDraftCrdtError = Readonly<{
  code:
    | "invalid_state"
    | "invalid_update"
    | "invalid_state_vector"
    | "invalid_document_shape"
    | "field_too_long"
    | "draft_too_long"
    | "update_too_large"
    | "state_too_large"
    | "state_vector_too_large";
}>;

export type EmailDraftCrdtResult<T> =
  | Readonly<{ ok: true; value: T; error?: never }>
  | Readonly<{ ok: false; error: EmailDraftCrdtError; value?: never }>;

type EncodingKind = "state" | "update" | "state_vector";

const EMAIL_FIELDS: readonly EmailDraftField[] = ["subject", "preview", "body"];
const ENCODING_LIMITS = {
  state: EMAIL_STATE_LIMIT,
  update: EMAIL_UPDATE_LIMIT,
  stateVector: EMAIL_STATE_VECTOR_LIMIT,
} as const;

class EmailEncoding<K extends EncodingKind> {
  readonly #encoding: ParsedYjsEncoding<K>;
  readonly kind: K;

  private constructor(encoding: ParsedYjsEncoding<K>) {
    this.#encoding = encoding;
    this.kind = encoding.kind;
  }

  encode(): Uint8Array {
    return this.#encoding.encode();
  }

  static parse<K extends EncodingKind>(kind: K, bytes: Uint8Array): EmailDraftCrdtResult<EmailEncoding<K>> {
    const parsed = parseYjsEncoding(kind, bytes, ENCODING_LIMITS);
    if (!parsed.ok) return parsed;
    if (kind !== "state_vector" && !hasValidUpdateShape(parsed.value.encode())) {
      return failure("invalid_document_shape");
    }
    return success(new EmailEncoding(parsed.value));
  }
}

export type EmailDraftState = EmailEncoding<"state">;
export type EmailDraftUpdate = EmailEncoding<"update">;
export type EmailDraftStateVector = EmailEncoding<"state_vector">;

export function parseEmailDraftState(bytes: Uint8Array): EmailDraftCrdtResult<EmailDraftState> {
  return EmailEncoding.parse("state", bytes);
}

export function parseEmailDraftUpdate(bytes: Uint8Array): EmailDraftCrdtResult<EmailDraftUpdate> {
  return EmailEncoding.parse("update", bytes);
}

export function parseEmailDraftStateVector(bytes: Uint8Array): EmailDraftCrdtResult<EmailDraftStateVector> {
  return EmailEncoding.parse("state_vector", bytes);
}

export class EmailDraftDoc {
  #doc: Y.Doc;

  private constructor(doc: Y.Doc) {
    this.#doc = doc;
  }

  static create(initial: EmailDraftSnapshot = { subject: "", preview: "", body: "" }): EmailDraftCrdtResult<EmailDraftDoc> {
    const normalized = normalizeSnapshot(initial);
    const valid = validateSnapshot(normalized);
    if (!valid.ok) return valid;
    const doc = createEmptyDocument();
    for (const field of EMAIL_FIELDS) {
      if (normalized[field].length > 0) doc.getText(field).insert(0, normalized[field]);
    }
    return success(new EmailDraftDoc(doc));
  }

  static restore(state: EmailDraftState): EmailDraftCrdtResult<EmailDraftDoc> {
    const doc = createEmptyDocument();
    try {
      Y.applyUpdate(doc, state.encode());
      const valid = validateDocument(doc);
      if (!valid.ok) {
        doc.destroy();
        return valid;
      }
      return success(new EmailDraftDoc(doc));
    } catch {
      doc.destroy();
      return failure("invalid_state");
    }
  }

  read(): EmailDraftSnapshot {
    return {
      subject: this.#doc.getText("subject").toString(),
      preview: this.#doc.getText("preview").toString(),
      body: this.#doc.getText("body").toString(),
    };
  }

  readField(field: EmailDraftField): string {
    return this.#doc.getText(field).toString();
  }

  state(): EmailDraftCrdtResult<EmailDraftState> {
    return parseEmailDraftState(Y.encodeStateAsUpdate(this.#doc));
  }

  stateVector(): EmailDraftCrdtResult<EmailDraftStateVector> {
    return parseEmailDraftStateVector(Y.encodeStateVector(this.#doc));
  }

  syncUpdate(remoteStateVector: EmailDraftStateVector): EmailDraftCrdtResult<EmailDraftUpdate> {
    try {
      return parseEmailDraftUpdate(Y.encodeStateAsUpdate(this.#doc, remoteStateVector.encode()));
    } catch {
      return failure("invalid_state_vector");
    }
  }

  apply(update: EmailDraftUpdate): EmailDraftCrdtResult<null> {
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
    return success(null);
  }

  edit(field: EmailDraftField, nextValue: string, inputRange?: TextInputRange): EmailDraftCrdtResult<EmailDraftUpdate> {
    const next = normalizePlainText(nextValue);
    const validField = validateField(field, next);
    if (!validField.ok) return validField;
    const current = this.read();
    const candidateSnapshot = { ...current, [field]: next };
    const validSnapshot = validateSnapshot(candidateSnapshot);
    if (!validSnapshot.ok) return validSnapshot;
    const candidate = cloneDocument(this.#doc);
    try {
      candidate.transact(splicePlainText.bind(null, candidate.getText(field), current[field], next, inputRange));
      const valid = validateDocument(candidate);
      if (!valid.ok) {
        candidate.destroy();
        return valid;
      }
      const update = parseEmailDraftUpdate(Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.#doc)));
      if (!update.ok) {
        candidate.destroy();
        return update;
      }
      this.#replace(candidate);
      return update;
    } catch {
      candidate.destroy();
      return failure("invalid_update");
    }
  }

  captureSelection(
    field: EmailDraftField,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): EmailDraftSelection {
    return {
      field,
      anchor: captureTextPresenceSelection(this.#doc.getText(field), start, end, direction),
    };
  }

  resolveSelection(selection: EmailDraftSelection): TextSelectionRange | null {
    return resolveTextPresenceSelection(
      this.#doc,
      this.#doc.getText(selection.field),
      selection.anchor,
    );
  }

  destroy(): void {
    this.#doc.destroy();
  }

  #replace(candidate: Y.Doc): void {
    this.#doc.destroy();
    this.#doc = candidate;
  }
}

export function isEmailDraftField(value: unknown): value is EmailDraftField {
  return value === "subject" || value === "preview" || value === "body";
}

function createEmptyDocument(): Y.Doc {
  const doc = new Y.Doc();
  for (const field of EMAIL_FIELDS) doc.getText(field);
  return doc;
}

function cloneDocument(source: Y.Doc): Y.Doc {
  const candidate = createEmptyDocument();
  Y.applyUpdate(candidate, Y.encodeStateAsUpdate(source));
  candidate.clientID = source.clientID;
  return candidate;
}

function normalizeSnapshot(snapshot: EmailDraftSnapshot): EmailDraftSnapshot {
  return {
    subject: normalizePlainText(snapshot.subject),
    preview: normalizePlainText(snapshot.preview),
    body: normalizePlainText(snapshot.body),
  };
}

function validateDocument(doc: Y.Doc): EmailDraftCrdtResult<null> {
  if (doc.share.size !== EMAIL_FIELDS.length) return failure("invalid_document_shape");
  for (const field of EMAIL_FIELDS) {
    if (!(doc.share.get(field) instanceof Y.Text)) return failure("invalid_document_shape");
  }
  return validateSnapshot({
    subject: doc.getText("subject").toString(),
    preview: doc.getText("preview").toString(),
    body: doc.getText("body").toString(),
  });
}

function validateSnapshot(snapshot: EmailDraftSnapshot): EmailDraftCrdtResult<null> {
  for (const field of EMAIL_FIELDS) {
    const valid = validateField(field, snapshot[field]);
    if (!valid.ok) return valid;
  }
  if (snapshot.subject.length + snapshot.preview.length + snapshot.body.length > EMAIL_AGGREGATE_LIMIT) {
    return failure("draft_too_long");
  }
  return success(null);
}

function validateField(field: EmailDraftField, value: string): EmailDraftCrdtResult<null> {
  const limit = field === "subject"
    ? EMAIL_SUBJECT_LIMIT
    : field === "preview"
      ? EMAIL_PREVIEW_LIMIT
      : EMAIL_BODY_LIMIT;
  if (value.length > limit) return failure("field_too_long");
  return hasValidPlainTextShape(value) ? success(null) : failure("invalid_document_shape");
}

function hasValidUpdateShape(bytes: Uint8Array): boolean {
  try {
    const decoded = Y.decodeUpdate(bytes);
    for (const struct of decoded.structs) {
      if (!(struct instanceof Y.Item)) continue;
      if (
        typeof struct.parent === "string" && !isEmailDraftField(struct.parent) ||
        struct.parentSub !== null ||
        !(struct.content instanceof Y.ContentString || struct.content instanceof Y.ContentDeleted)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function success<T>(value: T): EmailDraftCrdtResult<T> {
  return { ok: true, value };
}

function failure(code: EmailDraftCrdtError["code"]): EmailDraftCrdtResult<never> {
  return { ok: false, error: { code } };
}
