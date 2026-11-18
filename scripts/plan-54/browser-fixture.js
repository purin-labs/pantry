const plan54NativeFetch = window.fetch.bind(window);
Object.defineProperty(window, "fetch", {
  configurable: true,
  get: plan54RealFetchGetter,
  set: plan54IgnorePreviewFetch,
});
function plan54RealFetchGetter() {
  return plan54RealFetch;
}
function plan54IgnorePreviewFetch() {}
function plan54RealFetch(input, init) {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  );
  if (!url.pathname.startsWith("/v1/")) return plan54NativeFetch(input, init);
  return plan54NativeFetch(
    `http://127.0.0.1:8834${url.pathname}${url.search}`,
    { ...init, credentials: "include" },
  );
}
