// The ids of a commerce engine resource in Pantry: `underclerk:<merchant>:<id>`.

export function commerceCanonicalResourceId(
  merchantId: string,
  resourceId: string,
): string {
  return `underclerk:${merchantId}:${resourceId}`;
}

export function commerceProviderResourceId(
  merchantId: string,
  canonicalResourceId: string,
): string | null {
  const prefix = `underclerk:${merchantId}:`;
  if (!canonicalResourceId.startsWith(prefix)) return null;
  const resourceId = canonicalResourceId.slice(prefix.length);
  return resourceId.length === 0 ? null : resourceId;
}
