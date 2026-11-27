import {
  captureTextPresenceSelection,
  defineSharedDoc,
  hasOnlyPlainTextStructs,
  hasValidPlainTextShape,
  normalizePlainText,
  resolveTextPresenceSelection,
  sharedDocFailure as failure,
  sharedDocSuccess as success,
  splicePlainText,
  type SharedDocEncoding,
  type SharedDocError,
  type SharedDocResult,
  type TextInputRange,
  type TextPresenceSelection,
  type TextSelectionDirection,
  type TextSelectionRange,
} from "@purin-labs/collaboration";
import type * as Y from "yjs";
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

/** The document's own failures, beside the failures of an encoding. */
const FAILURES = [
  "invalid_document_shape",
  "field_too_long",
  "draft_too_long",
] as const;
export type EmailDraftCrdtError = SharedDocError<(typeof FAILURES)[number]>;

export type EmailDraftCrdtResult<T> = SharedDocResult<T, EmailDraftCrdtError["code"]>;

const EMAIL_FIELDS: readonly EmailDraftField[] = ["subject", "preview", "body"];

/** Three plain texts, each in the root of its field. */
export const emailDraftDocument = defineSharedDoc({
  schema: EMAIL_DRAFT_SCHEMA,
  limits: {
    state: EMAIL_STATE_LIMIT,
    update: EMAIL_UPDATE_LIMIT,
    stateVector: EMAIL_STATE_VECTOR_LIMIT,
  },
  failures: FAILURES,
  roots: { subject: "text", preview: "text", body: "text" },
  shapeFailure: "invalid_document_shape",
  validateEncoded: (bytes) =>
    hasOnlyPlainTextStructs(bytes, EMAIL_FIELDS) ? null : "invalid_document_shape",
  validate: validateDocument,
});

type Schema = typeof EMAIL_DRAFT_SCHEMA;
type EmailDraftState = SharedDocEncoding<"state", Schema>;
export type EmailDraftUpdate = SharedDocEncoding<"update", Schema>;
export type EmailDraftStateVector = SharedDocEncoding<"state_vector", Schema>;

export const parseEmailDraftState = emailDraftDocument.parseState;
export const parseEmailDraftUpdate = emailDraftDocument.parseUpdate;

export class EmailDraftDoc extends emailDraftDocument.Doc {
  static create(initial: EmailDraftSnapshot = { subject: "", preview: "", body: "" }): EmailDraftCrdtResult<EmailDraftDoc> {
    const normalized = normalizeSnapshot(initial);
    const valid = validateSnapshot(normalized);
    if (!valid.ok) return valid;
    const doc = emailDraftDocument.emptyDocument();
    for (const field of EMAIL_FIELDS) {
      if (normalized[field].length > 0) doc.getText(field).insert(0, normalized[field]);
    }
    return success(new EmailDraftDoc(doc));
  }

  static restore(state: EmailDraftState): EmailDraftCrdtResult<EmailDraftDoc> {
    const doc = emailDraftDocument.restore(state);
    return doc.ok ? success(new EmailDraftDoc(doc.value)) : doc;
  }

  read(): EmailDraftSnapshot {
    return readSnapshot(this.doc);
  }

  readField(field: EmailDraftField): string {
    return this.doc.getText(field).toString();
  }

  edit(field: EmailDraftField, nextValue: string, inputRange?: TextInputRange): EmailDraftCrdtResult<EmailDraftUpdate> {
    const next = normalizePlainText(nextValue);
    const validField = validateField(field, next);
    if (!validField.ok) return validField;
    const current = this.read();
    const candidateSnapshot = { ...current, [field]: next };
    const validSnapshot = validateSnapshot(candidateSnapshot);
    if (!validSnapshot.ok) return validSnapshot;
    return this.stage((candidate) =>
      candidate.transact(splicePlainText.bind(null, candidate.getText(field), current[field], next, inputRange)),
    );
  }

  captureSelection(
    field: EmailDraftField,
    start: number,
    end: number,
    direction: TextSelectionDirection,
  ): EmailDraftSelection {
    return {
      field,
      anchor: captureTextPresenceSelection(this.doc.getText(field), start, end, direction),
    };
  }

  resolveSelection(selection: EmailDraftSelection): TextSelectionRange | null {
    return resolveTextPresenceSelection(
      this.doc,
      this.doc.getText(selection.field),
      selection.anchor,
    );
  }
}

export function isEmailDraftField(value: unknown): value is EmailDraftField {
  return value === "subject" || value === "preview" || value === "body";
}

function readSnapshot(doc: Y.Doc): EmailDraftSnapshot {
  return {
    subject: doc.getText("subject").toString(),
    preview: doc.getText("preview").toString(),
    body: doc.getText("body").toString(),
  };
}

function normalizeSnapshot(snapshot: EmailDraftSnapshot): EmailDraftSnapshot {
  return {
    subject: normalizePlainText(snapshot.subject),
    preview: normalizePlainText(snapshot.preview),
    body: normalizePlainText(snapshot.body),
  };
}

/** The check of the content. The shared document checks the roots first. */
function validateDocument(doc: Y.Doc): EmailDraftCrdtResult<null> {
  return validateSnapshot(readSnapshot(doc));
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
