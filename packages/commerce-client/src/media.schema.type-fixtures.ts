// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiMedia from "@purin-labs/commerce-contracts/records/api-media";
import type {
  CreateCommerceMediaV1,
  DeleteCommerceMediaV1,
  CommerceProductMediaItemV1,
  SetCommerceProductMediaV1,
  UpdateCommerceMediaV1,
  CommerceMediaCommandV1,
  CommerceMediaContentType,
  CommerceMediaV1,
  CommerceProductMediaV1,
  CommerceMediaLibraryV1,
  CommerceMediaUploadV1,
} from "./media.ts";
export type CreateCommerceMediaV1Parity = Assert<
  Equal<CreateCommerceMediaV1, apiMedia.CreateCommerceMediaV1>
>;
export type DeleteCommerceMediaV1Parity = Assert<
  Equal<DeleteCommerceMediaV1, apiMedia.DeleteCommerceMediaV1>
>;
export type CommerceProductMediaItemV1Parity = Assert<
  Equal<CommerceProductMediaItemV1, apiMedia.CommerceProductMediaItemV1>
>;
export type SetCommerceProductMediaV1Parity = Assert<
  Equal<SetCommerceProductMediaV1, apiMedia.SetCommerceProductMediaV1>
>;
export type UpdateCommerceMediaV1Parity = Assert<
  Equal<UpdateCommerceMediaV1, apiMedia.UpdateCommerceMediaV1>
>;
export type CommerceMediaCommandV1Parity = Assert<
  Equal<CommerceMediaCommandV1, apiMedia.CommerceMediaCommandV1>
>;
export type CommerceMediaContentTypeParity = Assert<
  Equal<CommerceMediaContentType, apiMedia.CommerceMediaContentType>
>;
export type CommerceMediaV1Parity = Assert<
  Equal<CommerceMediaV1, apiMedia.CommerceMediaV1>
>;
export type CommerceProductMediaV1Parity = Assert<
  Equal<CommerceProductMediaV1, apiMedia.CommerceProductMediaV1>
>;
export type CommerceMediaLibraryV1Parity = Assert<
  Equal<CommerceMediaLibraryV1, apiMedia.CommerceMediaLibraryV1>
>;
export type CommerceMediaUploadV1Parity = Assert<
  Equal<CommerceMediaUploadV1, apiMedia.CommerceMediaUploadV1>
>;
