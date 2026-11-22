import { RequestDeadline } from "@purin-labs/kernel/request-deadline";

/**
 * An answer to one Slack interaction through its response URL. Slack accepts
 * it for 30 minutes after the click. False when the answer did not reach
 * Slack; the caller decides what to record.
 */
export async function replyToInteraction(
  responseUrl: string,
  body: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  const deadline = new RequestDeadline(5_000);
  try {
    const response = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      signal: deadline.signal,
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  } finally {
    deadline.end();
  }
}

/** A message that only the person who clicked sees. */
export function tellClicker(
  responseUrl: string,
  text: string,
): Promise<boolean> {
  return replyToInteraction(responseUrl, {
    response_type: "ephemeral",
    replace_original: false,
    text,
  });
}
