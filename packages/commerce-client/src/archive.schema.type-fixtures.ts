// Plan 78 step 2: each client type equals its schema type.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
import type * as apiArchive from "@purin-labs/commerce-contracts/records/api-archive";
import type {
  CommerceArchiveFileV1,
  CommerceArchiveLocationV1,
  CommerceArchiveRunV1,
  CommerceOrderRecordV1,
} from "./archive.ts";
export type CommerceArchiveFileV1Parity = Assert<
  Equal<CommerceArchiveFileV1, apiArchive.CommerceArchiveFileV1>
>;
export type CommerceArchiveLocationV1Parity = Assert<
  Equal<CommerceArchiveLocationV1, apiArchive.CommerceArchiveLocationV1>
>;
export type CommerceArchiveRunV1Parity = Assert<
  Equal<CommerceArchiveRunV1, apiArchive.CommerceArchiveRunV1>
>;
export type CommerceOrderRecordV1Parity = Assert<
  Equal<CommerceOrderRecordV1, apiArchive.CommerceOrderRecordV1>
>;
