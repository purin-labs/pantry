/**
 * The runtime's fetch, safe to pass as a value.
 *
 * The Workers runtime throws "Illegal invocation" when its fetch is called as
 * a property of another object, for example `input.fetcher(url)` after
 * `{ fetcher: fetch }`. Pass this function wherever a fetch is injected, and
 * never the global itself. The lint rule `no-restricted-syntax` enforces it.
 *
 * The global is read at each call, so a test that replaces it still applies.
 */
export const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);
