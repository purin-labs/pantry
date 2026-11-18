export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} must be normalized text`);
  }
  return value;
}

/**
 * Keep stdout for the journey result. The commerce client writes its
 * contract comparison traces with `console.info` (Plan 78); they go to
 * stderr instead.
 */
export function keepStdoutForResult(): void {
  console.info = console.error;
  console.log = console.error;
}
