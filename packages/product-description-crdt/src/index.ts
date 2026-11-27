import {
  definePlainTextDoc,
  type PlainTextDocError,
  type SharedDocEncoding,
  type SharedDocResult,
  type TextInputRange,
  type TextPresenceSelection,
} from "@purin-labs/collaboration";
import {
  DESCRIPTION_LIMIT,
  UPDATE_LIMIT,
  STATE_LIMIT,
  STATE_VECTOR_LIMIT,
} from "./limits.ts";
export {
  DESCRIPTION_LIMIT,
  UPDATE_LIMIT,
  STATE_LIMIT,
  STATE_VECTOR_LIMIT,
} from "./limits.ts";
export { RelativeTextSelection as ProductDescriptionSelection } from "@purin-labs/collaboration";

export const PRODUCT_DESCRIPTION_SCHEMA = "product_description_crdt.v1";

/** The one text of a product description, in the root `description`. */
export const productDescriptionDocument = definePlainTextDoc({
  schema: PRODUCT_DESCRIPTION_SCHEMA,
  root: "description",
  limits: {
    state: STATE_LIMIT,
    update: UPDATE_LIMIT,
    stateVector: STATE_VECTOR_LIMIT,
  },
  textLimit: DESCRIPTION_LIMIT,
  tooLongFailure: "description_too_long",
});

type Schema = typeof PRODUCT_DESCRIPTION_SCHEMA;

export type ProductDescriptionCrdtError =
  PlainTextDocError<"description_too_long">;
export type ProductDescriptionCrdtResult<T> = SharedDocResult<
  T,
  ProductDescriptionCrdtError["code"]
>;

export type ProductDescriptionState = SharedDocEncoding<"state", Schema>;
export type ProductDescriptionUpdate = SharedDocEncoding<"update", Schema>;
export type ProductDescriptionStateVector = SharedDocEncoding<
  "state_vector",
  Schema
>;

export const parseProductDescriptionState =
  productDescriptionDocument.parseState;
export const parseProductDescriptionUpdate =
  productDescriptionDocument.parseUpdate;
export const parseProductDescriptionStateVector =
  productDescriptionDocument.parseStateVector;

export type ProductDescriptionInputRange = TextInputRange;
export type ProductDescriptionPresenceSelection = TextPresenceSelection;

export const ProductDescriptionDoc = productDescriptionDocument.Doc;
export type ProductDescriptionDoc = typeof ProductDescriptionDoc.prototype;
