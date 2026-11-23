/**
 * A release replaces the Portal's hashed code files. A tab opened before the
 * release still asks for the old files when it opens a page, and the server
 * answers with the Portal's HTML page, so the page cannot load. Reload once to
 * get the current release.
 *
 * The marker names the release that failed. If the reloaded page belongs to
 * the same release, the file is missing from the current release itself, and
 * the error page stays instead of reloading again.
 */
const RELOADED_RELEASE_KEY = "pantry:stale-release-reload";

export function installStaleReleaseRecovery(): void {
  window.addEventListener("vite:preloadError", reloadOnPreloadError);
}

function reloadOnPreloadError(event: Event): void {
  if (reloadForNewRelease()) event.preventDefault();
}

/** Whether an error comes from a module that the browser could not load. */
export function isModuleLoadError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /dynamically imported module|Importing a module script failed/iu.test(
      error.message,
    )
  );
}

/** Reloads the page once per release. Answers whether it reloads. */
export function reloadForNewRelease(): boolean {
  const release = currentRelease();
  if (release === null) return false;
  try {
    if (window.sessionStorage.getItem(RELOADED_RELEASE_KEY) === release)
      return false;
    window.sessionStorage.setItem(RELOADED_RELEASE_KEY, release);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** The built entry file's name changes with each release; development has none. */
function currentRelease(): string | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>(
    'script[type="module"][src]',
  )) {
    const path = new URL(script.src, window.location.href).pathname;
    if (path.startsWith("/assets/")) return path;
  }
  return null;
}
