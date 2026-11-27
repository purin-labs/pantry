/** The write that the checkout profiles page sends through the Portal. */
export type CheckoutProfileMutationTransport = (
  path: string,
  method: "POST" | "PUT",
  body: unknown,
  intent: string,
) => Promise<unknown>;
