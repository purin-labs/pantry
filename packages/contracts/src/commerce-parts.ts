/**
 * The commerce types that the records of this package carry (Refactor 17,
 * step A1.11): the scope and the target of a commerce grant, the commerce
 * proposal and the source provenance of a Case. The package names no commerce
 * package. The Platform declares each member with a declaration merge
 * (`areas/commerce/server/contract/types.ts`), as it does for
 * `CommerceTypeParts`. A program without the merge sees an opaque part: the
 * record keeps its shape, and commerce checks the part.
 */
export interface ContractCommerceParts {}

/** The member `Name` of the merge, or `Opaque` when no program declares it. */
export type ContractCommercePart<
  Name extends string,
  Opaque = unknown,
> = ContractCommerceParts extends { readonly [Key in Name]: infer Part }
  ? Part
  : Opaque;
