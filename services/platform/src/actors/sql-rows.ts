/** A Durable Object SQL row from `SELECT COUNT(*) AS count`. */
export type CountRow = Record<string, SqlStorageValue> & {
  readonly count: number;
};
