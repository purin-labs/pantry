export const EMAIL_SUBJECT_LIMIT = 200;
export const EMAIL_PREVIEW_LIMIT = 300;
export const EMAIL_BODY_LIMIT = 50_000;
export const EMAIL_AGGREGATE_LIMIT = 50_500;
export const EMAIL_STATE_LIMIT = 512 * 1024;
/** A sync sends the whole stored state as one update to a new client. */
export const EMAIL_UPDATE_LIMIT = EMAIL_STATE_LIMIT;
export const EMAIL_STATE_VECTOR_LIMIT = 64 * 1024;
