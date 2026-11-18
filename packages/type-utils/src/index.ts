/**
 * The members of the discriminated union `U` whose `kind` is `K`.
 *
 * Prefer this to `Extract<U, { kind: K }>`: a misspelled or renamed `K` is a
 * compile error here, where `Extract` silently yields `never`.
 */
export type Variant<
  U extends { readonly kind: unknown },
  K extends U["kind"],
> = Extract<U, { readonly kind: K }>;

/**
 * {@link Variant} for unions discriminated by a field other than `kind`, such
 * as `VariantBy<ActionLedgerEntry, "state", "executing">`.
 */
export type VariantBy<U, F extends keyof U, V extends U[F]> = Extract<
  U,
  { readonly [P in F]: V }
>;

/** The keys of every object member of the union `U`. */
export type UnionKeys<U> = U extends object ? keyof U : never;

/**
 * Makes an object union exclusive: each member forbids the keys that only the
 * other members carry, so an object literal or spread cannot mix members.
 * Non-object members pass through unchanged.
 */
export type StrictUnion<U> = StrictUnionMember<U, U>;

type StrictUnionMember<TMember, TUnion> = TMember extends TUnion
  ? TMember extends object
    ? TMember &
        Partial<Record<Exclude<UnionKeys<TUnion>, keyof TMember>, never>>
    : TMember
  : never;
