/** The wake phrase and speech detection files, kept only while voice control is on. */
const CACHE_NAME = "pantry-voice-v1";

/**
 * A voice file, from the cache when the cache holds the real file. The Portal
 * answers a missing file with its own page and status 200. A page is never a
 * voice file, so it is not kept, and a page that a device kept earlier is
 * fetched again.
 */
export async function cachedBytes(url: string): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME);
  const stored = await cache.match(url);
  if (stored !== undefined && !isPortalPage(stored))
    return stored.arrayBuffer();
  const response = await fetch(url);
  if (!response.ok || isPortalPage(response))
    throw new Error(`Voice file ${url} is missing (${response.status})`);
  await cache.put(url, response.clone());
  return response.arrayBuffer();
}

function isPortalPage(response: Response): boolean {
  return response.headers.get("content-type")?.startsWith("text/html") === true;
}

/**
 * Drops each kept file that the Portal no longer loads, for example the model
 * of an earlier wake phrase or an earlier runtime build.
 */
export async function keepOnlyVoiceFiles(
  urls: readonly string[],
): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  const keep = new Set(urls.map((url) => new URL(url, location.href).href));
  const stale = (await cache.keys()).filter(
    (request) => !keep.has(request.url),
  );
  await Promise.all(stale.map((request) => cache.delete(request)));
}

export async function deleteVoiceModels(): Promise<void> {
  await caches.delete(CACHE_NAME);
}
