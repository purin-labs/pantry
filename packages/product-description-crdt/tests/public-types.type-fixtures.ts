import { ProductDescriptionDoc, type ProductDescriptionState, type ProductDescriptionUpdate, type ProductDescriptionCrdtResult } from "../src/index";

export function rejectedInputs(doc: ProductDescriptionDoc, state: ProductDescriptionState): void {
  // @ts-expect-error Raw bytes must pass the update boundary.
  doc.apply(new Uint8Array());
  // @ts-expect-error State and update encodings have distinct identities.
  doc.apply(state);
  // @ts-expect-error Callers cannot add shared types through the feature handle.
  doc.getMap("price");
  // @ts-expect-error Only validated factory methods create feature handles.
  new ProductDescriptionDoc();
}

export function requireNarrowing(result: ProductDescriptionCrdtResult<ProductDescriptionUpdate>): void {
  // @ts-expect-error A failed operation has no value.
  result.value.encode();
  // @ts-expect-error Private bytes prevent structural construction of a parsed update.
  const forged: ProductDescriptionUpdate = { kind: "update", encode: bytes };
  void forged;
}

function bytes(): Uint8Array { return new Uint8Array(); }

export function rejectMixedResultBranches(value: ProductDescriptionUpdate): void {
  const accepted: ProductDescriptionCrdtResult<ProductDescriptionUpdate> = { ok: true, value };
  const rejected: ProductDescriptionCrdtResult<ProductDescriptionUpdate> = { ok: false, error: { code: "invalid_update" } };
  // @ts-expect-error Success cannot carry failure state through a broad spread.
  const mixedSuccess: ProductDescriptionCrdtResult<ProductDescriptionUpdate> = { ...accepted, error: rejected.error };
  // @ts-expect-error Failure cannot carry an accepted update through a broad spread.
  const mixedFailure: ProductDescriptionCrdtResult<ProductDescriptionUpdate> = { ...rejected, value };
  void mixedSuccess;
  void mixedFailure;
}
