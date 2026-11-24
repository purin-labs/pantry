import { textLimit } from "@purin-labs/contract-schema";
import { Type } from "typebox";

/** The shapes that the Devices page and the gateway protocols share. */

export const strict = { additionalProperties: false } as const;
export const shortText = textLimit(
  Type.String({ minLength: 1, maxLength: 120 }),
);
/** A gateway's own name for one of its devices. */
export const sourceKey = textLimit(
  Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
  }),
);
