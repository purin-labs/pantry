import type { SavedBakeryRunQuery } from "@purin-labs/area-kitchen/server/bakery/saved-runs";

declare const exactRead: Readonly<{ kind: "read"; id: string }>;

// @ts-expect-error Latest selection cannot also carry an exact identity.
const latestWithId: SavedBakeryRunQuery = { kind: "latest", id: "run" };
// @ts-expect-error Exact reads require an identity.
const missingIdentity: SavedBakeryRunQuery = { kind: "read" };
// @ts-expect-error Catalogue cursors cannot be mixed into latest selection.
const latestWithCursor: SavedBakeryRunQuery = { kind: "latest", cursor: null };
// @ts-expect-error Spreading an exact read cannot retain its ID in latest selection.
const spreadRead: SavedBakeryRunQuery = { ...exactRead, kind: "latest" };

void latestWithId;
void missingIdentity;
void latestWithCursor;
void spreadRead;
