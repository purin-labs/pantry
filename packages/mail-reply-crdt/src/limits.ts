// The body limit is the limit of a reviewed reply edit (`MailReplyEdit`).
export const BODY_LIMIT = 20_000;
export const STATE_LIMIT = 384 * 1024;
/** A sync sends the whole stored state as one update to a new client. */
export const UPDATE_LIMIT = STATE_LIMIT;
export const STATE_VECTOR_LIMIT = 16 * 1024;
