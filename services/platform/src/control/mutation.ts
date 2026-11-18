export function controlCausationId(request: Request): string {
  const requestId = request.headers.get("x-request-id");
  return requestId !== null &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)
    ? requestId
    : `request_${crypto.randomUUID()}`;
}
