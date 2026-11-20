import type { RequestAuthority } from "@purin-labs/contracts";
import type { ProjectReference } from "@purin-labs/control-api";
import type { Variant } from "@purin-labs/type-utils";
import { definePort } from "../../port";
import type { Result } from "../../result";
import type { RequestableEntityTypeRead } from "../requestable-capabilities";
import type { AccessGrant } from "./types";

/** The grants and the authority of one commerce read. */
type CommerceGrantSelectionInput = Readonly<{
  organisationId: string;
  merchantId: string;
  grants: readonly AccessGrant[];
  requestAuthority: RequestAuthority;
  causationId: string;
  now: string;
}>;

/**
 * Why no grant was selected: no active grant covers the read (`denied`), or
 * the read could not be checked (`unavailable`).
 */
export type CommerceGrantSelectionError = Readonly<{
  code: "denied" | "unavailable";
}>;

/**
 * The selection of the source grant of a commerce read. The access model
 * asks it which requestable reads an audience cannot do, and a Project asks
 * it for the grant of a commerce record that it names. Commerce owns the
 * graph queries and their authority, so it gives the implementation, and the
 * Worker registers it (`worker-ports.ts`).
 */
export type CommerceGrantSelection = Readonly<{
  /** The grant that covers every record of a requestable read. */
  selectRequestableReadGrant(
    input: CommerceGrantSelectionInput &
      Readonly<{ read: RequestableEntityTypeRead }>,
  ): Result<AccessGrant, CommerceGrantSelectionError>;
  /** The grant that covers one system record, at the public level. */
  selectRecordGrant(
    input: CommerceGrantSelectionInput &
      Readonly<{
        recordType: Variant<ProjectReference, "commerce_record">["type"];
        recordId: string;
      }>,
  ): Result<AccessGrant, CommerceGrantSelectionError>;
}>;

export const commerceGrantSelection = definePort<CommerceGrantSelection>(
  "commerce_grant_selection",
);
