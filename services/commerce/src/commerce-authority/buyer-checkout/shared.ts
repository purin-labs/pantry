export function requireIdentity(value: string, field: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new Error(field + " must be normalized text");
  }
  return value;
}

export function timestampAfter(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

export function timestampBefore(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}
