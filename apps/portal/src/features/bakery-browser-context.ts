import type { BakeryBrowserContext } from "@seams/bakery-model/bakery-context";

const BROWSER_KEY = "satyr:bakery-browser-instance";
let identity: Promise<string> | null = null;
let releaseBrowserLock: (() => void) | null = null;

export function bakeryBrowserInstanceId(): Promise<string> {
  identity ??= acquireBrowserIdentity();
  return identity;
}

async function acquireBrowserIdentity(): Promise<string> {
  const stored = sessionStorage.getItem(BROWSER_KEY);
  const candidate = stored ?? crypto.randomUUID();
  if (!navigator.locks) return saveBrowserIdentity(crypto.randomUUID());
  const claim = { publish: ignoreIdentity };
  const acquired = new Promise<string>(
    captureIdentityResolver.bind(null, claim),
  );
  void navigator.locks.request(
    `satyr-browser:${candidate}`,
    { ifAvailable: true },
    holdBrowserIdentity.bind(null, candidate, claim.publish),
  );
  return acquired;
}

function captureIdentityResolver(
  claim: { publish: (id: string) => void },
  resolve: (id: string) => void,
): void {
  claim.publish = resolve;
}
function ignoreIdentity(_value: string): void {}

async function holdBrowserIdentity(
  candidate: string,
  publish: (id: string) => void,
  lock: Lock | null,
): Promise<void> {
  if (lock === null) {
    const fresh = crypto.randomUUID();
    await navigator.locks.request(
      `satyr-browser:${fresh}`,
      holdBrowserIdentity.bind(null, fresh, publish),
    );
    return;
  }
  publish(saveBrowserIdentity(candidate));
  await new Promise<void>(captureLockRelease);
}

function captureLockRelease(resolve: () => void): void {
  releaseBrowserLock = resolve;
  window.addEventListener("pagehide", releaseLock, { once: true });
}

function releaseLock(): void {
  releaseBrowserLock?.();
  releaseBrowserLock = null;
  identity = null;
}
function saveBrowserIdentity(id: string): string {
  sessionStorage.setItem(BROWSER_KEY, id);
  return id;
}

/**
 * The browser that can run Kitchen commands for a chat message. The
 * composer chip decides at send time if the message keeps the Kitchen out
 * (Plan 87 phase 2); it replaced the Kitchen switch of this tab.
 */
export async function captureBakeryBrowserContext(
  _organisationId: string,
  conversationId: string,
): Promise<BakeryBrowserContext> {
  return {
    kind: "available",
    binding: {
      browserInstanceId: await bakeryBrowserInstanceId(),
      conversationId,
    },
  };
}
