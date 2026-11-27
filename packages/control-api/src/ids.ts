declare const userIdBrand: unique symbol;
declare const conversationIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: "UserId" };
export type ConversationId = string & {
  readonly [conversationIdBrand]: "ConversationId";
};
export type ProjectId = string & {
  readonly [projectIdBrand]: "ProjectId";
};

type IdParseError = Readonly<{ code: "invalid"; value: string }>;
type ParsedId<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: IdParseError }>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_ID = new RegExp(`^user_${UUID}$`, "u");
const CONVERSATION_ID = new RegExp(`^conv_${UUID}$`, "u");
const PROJECT_ID = new RegExp(`^project_${UUID}$`, "u");

export function isUserId(raw: unknown): raw is UserId {
  return typeof raw === "string" && USER_ID.test(raw);
}

export function isConversationId(raw: unknown): raw is ConversationId {
  return typeof raw === "string" && CONVERSATION_ID.test(raw);
}

export function isProjectId(raw: unknown): raw is ProjectId {
  return typeof raw === "string" && PROJECT_ID.test(raw);
}

export function parseUserId(raw: string): ParsedId<UserId> {
  return isUserId(raw)
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "invalid", value: raw } };
}

export function parseConversationId(raw: string): ParsedId<ConversationId> {
  return isConversationId(raw)
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "invalid", value: raw } };
}

export function parseProjectId(raw: string): ParsedId<ProjectId> {
  return isProjectId(raw)
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "invalid", value: raw } };
}

export function newUserId(): UserId {
  const parsed = parseUserId(`user_${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("user_id_generation_failed");
  return parsed.value;
}

export function newConversationId(): ConversationId {
  const parsed = parseConversationId(`conv_${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("conversation_id_generation_failed");
  return parsed.value;
}

export function newProjectId(): ProjectId {
  const parsed = parseProjectId(`project_${crypto.randomUUID()}`);
  if (!parsed.ok) throw new Error("project_id_generation_failed");
  return parsed.value;
}
