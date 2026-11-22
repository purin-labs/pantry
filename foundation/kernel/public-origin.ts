export function requirePublicOrigin(rawOrigin: string): string {
  const url = new URL(rawOrigin);
  const loopbackHttp =
    url.protocol === "http:" && isLoopbackHostname(url.hostname);
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "PANTRY_PUBLIC_ORIGIN must be an HTTPS or loopback HTTP origin",
    );
  }
  return url.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
