/** The write that the supplier payouts page sends through the Portal. */
export type PayoutMutationTransport = (
  path: string,
  method: "POST",
  body: unknown,
  intent: string,
) => Promise<unknown>;
