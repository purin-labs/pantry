import {
  controlRead,
  controlWrite,
} from "@purin-labs/control/portal/control-client";
import { parseSharedThreadResponse } from "@purin-labs/control-api/portal/slack-thread";

/** The Slack thread link of one shared draft: the link, or null for none. */
export async function readDraftSharedThread(
  path: string,
): Promise<string | null> {
  return parseSharedThreadResponse(await controlRead(path));
}

/** Connects the thread at `threadUrl`, or disconnects the thread for null. */
export async function changeDraftSharedThread(
  path: string,
  threadUrl: string | null,
): Promise<string | null> {
  return parseSharedThreadResponse(
    await controlWrite(
      path,
      threadUrl === null ? "DELETE" : "PUT",
      threadUrl === null ? undefined : { threadUrl },
    ),
  );
}
