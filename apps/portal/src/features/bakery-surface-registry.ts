import type {
  BakerySurfaceAttachmentV1,
  BakerySurfaceCommandResultV1,
  BakerySurfaceEffectV1,
  ExecutableBakerySurfaceEffectV1,
  BakerySurfaceReceiptV1,
} from "@purin-labs/bakery-model/bakery-surface";
import {
  createBakerySurfaceReceipt,
  isExecutableBakerySurfaceEffect,
  parseBakerySurfaceReceipt,
  verifyBakerySurfaceEffect,
  verifyBakerySurfaceReceipt,
} from "@purin-labs/bakery-model/bakery-surface";
import { isRecord, parseJsonOrNull } from "@purin-labs/std";

export type MountedBakerySurface = Readonly<{
  organisationId: string;
  surfaceSessionId(): string;
  surfaceEpoch(): number;
  capture(): Promise<BakerySurfaceAttachmentV1>;
  attachFile(
    file: File,
  ): Promise<Readonly<{ name: string; digest: string; bytes: number }>>;
  execute(
    effect: ExecutableBakerySurfaceEffectV1,
  ): Promise<BakerySurfaceCommandResultV1>;
  cancel(effect: BakerySurfaceEffectV1): void;
}>;

type SurfaceListener = () => void;

const mounted = new Map<string, MountedBakerySurface>();
const listeners = new Set<SurfaceListener>();
const ledgers = new WeakMap<
  MountedBakerySurface,
  BakerySurfaceExecutionLedger
>();
const MAX_LEDGER_ENTRIES = 32;

type LedgerEntry = Readonly<{
  dispatchId: string;
  commandDigest: string;
  deadlineAt: number;
  receipt: Promise<BakerySurfaceReceiptV1>;
}>;

export class BakerySurfaceExecutionLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  async execute(
    surface: MountedBakerySurface,
    effect: BakerySurfaceEffectV1,
    now: number = Date.now(),
  ): Promise<BakerySurfaceReceiptV1> {
    this.prune(now);
    if (!(await verifyBakerySurfaceEffect(effect)))
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "effect_invalid",
        message: "The Kitchen effect payload did not match its digest.",
      });
    if (now >= effect.deadlineAt)
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "effect_expired",
        message: "The Kitchen effect expired before execution.",
      });
    const existing = this.entries.get(effect.effectId);
    if (existing !== undefined) {
      if (
        existing.dispatchId !== effect.dispatchId ||
        existing.commandDigest !== effect.commandDigest ||
        existing.deadlineAt !== effect.deadlineAt
      )
        return createBakerySurfaceReceipt(effect, {
          kind: "delivery_failed",
          code: "effect_conflict",
          message: "The Kitchen effect ID was reused with another payload.",
        });
      return existing.receipt;
    }
    if (this.entries.size >= MAX_LEDGER_ENTRIES)
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "ledger_full",
        message: "The Kitchen surface has too many unsettled effects.",
      });
    if (!isExecutableBakerySurfaceEffect(effect))
      throw new Error("Preparation cannot execute a surface command");
    const entry: LedgerEntry = {
      dispatchId: effect.dispatchId,
      commandDigest: effect.commandDigest,
      deadlineAt: effect.deadlineAt,
      receipt: executeBrowserEffect(surface, effect, now),
    };
    this.entries.set(effect.effectId, entry);
    return entry.receipt;
  }

  private prune(now: number): void {
    for (const [effectId, entry] of this.entries)
      if (entry.deadlineAt <= now) this.entries.delete(effectId);
  }
}

async function executeBrowserEffect(
  surface: MountedBakerySurface,
  effect: ExecutableBakerySurfaceEffectV1,
  now: number,
): Promise<BakerySurfaceReceiptV1> {
  const recovered = await readBrowserEffectLedger(effect);
  if (recovered !== null) return recovered;
  pruneBrowserEffectLedger(now);
  sessionStorage.setItem(
    browserEffectKey(effect),
    JSON.stringify({
      kind: "executing",
      commandDigest: effect.commandDigest,
      deadlineAt: effect.deadlineAt,
    }),
  );
  const receipt = await createBakerySurfaceReceipt(effect, {
    kind: "completed",
    result: await surface.execute(effect),
  });
  sessionStorage.setItem(
    browserEffectKey(effect),
    JSON.stringify({ kind: "settled", deadlineAt: effect.deadlineAt, receipt }),
  );
  notifySurfaceListeners();
  return receipt;
}

export function registerBakerySurface(
  surface: MountedBakerySurface,
): () => void {
  mounted.set(surface.organisationId, surface);
  notifySurfaceListeners();
  return unregisterBakerySurface.bind(null, surface);
}

export function bakerySurfaceForOrganisation(
  organisationId: string,
): MountedBakerySurface | null {
  return mounted.get(organisationId) ?? null;
}

export async function deliverBakerySurfaceEffect(
  organisationId: string,
  effect: BakerySurfaceEffectV1,
): Promise<BakerySurfaceReceiptV1> {
  const surface = bakerySurfaceForOrganisation(organisationId);
  if (surface === null)
    return createBakerySurfaceReceipt(effect, {
      kind: "delivery_failed",
      code: "surface_unavailable",
      message: "The targeted Kitchen surface is no longer mounted.",
    });
  let ledger = ledgers.get(surface);
  if (ledger === undefined) {
    ledger = new BakerySurfaceExecutionLedger();
    ledgers.set(surface, ledger);
  }
  return ledger.execute(surface, effect);
}

export function subscribeBakerySurface(listener: SurfaceListener): () => void {
  listeners.add(listener);
  return unsubscribeBakerySurface.bind(null, listener);
}

function unregisterBakerySurface(surface: MountedBakerySurface): void {
  if (mounted.get(surface.organisationId) !== surface) return;
  mounted.delete(surface.organisationId);
  notifySurfaceListeners();
}

function unsubscribeBakerySurface(listener: SurfaceListener): void {
  listeners.delete(listener);
}

export function notifySurfaceListeners(): void {
  for (const listener of listeners) listener();
}

const reveals = new Map<string, () => Promise<void>>();

export function registerBakeryWorkspaceReveal(
  organisationId: string,
  reveal: () => Promise<void>,
): () => void {
  reveals.set(organisationId, reveal);
  return unregisterBakeryWorkspaceReveal.bind(null, organisationId, reveal);
}

function unregisterBakeryWorkspaceReveal(
  organisationId: string,
  reveal: () => Promise<void>,
): void {
  if (reveals.get(organisationId) === reveal) reveals.delete(organisationId);
}

export function revealBakeryWorkspace(organisationId: string): Promise<void> {
  const reveal = reveals.get(organisationId);
  return reveal === undefined
    ? Promise.reject(
        new Error(
          "The current page cannot preserve its work during activation.",
        ),
      )
    : reveal();
}

function browserEffectKey(effect: BakerySurfaceEffectV1): string {
  return `satyr:bakery-effect:${effect.effectId}`;
}

async function readBrowserEffectLedger(
  effect: BakerySurfaceEffectV1,
): Promise<BakerySurfaceReceiptV1 | null> {
  const stored = sessionStorage.getItem(browserEffectKey(effect));
  if (stored === null) return null;
  const raw = parseJsonOrNull(stored);
  const parsed = parseBakerySurfaceReceipt(isRecord(raw) ? raw.receipt : null);
  if (
    parsed.kind === "valid" &&
    parsed.value.effectId === effect.effectId &&
    parsed.value.dispatchId === effect.dispatchId &&
    parsed.value.commandDigest === effect.commandDigest &&
    (await verifyBakerySurfaceReceipt(parsed.value))
  )
    return parsed.value;
  return createBakerySurfaceReceipt(effect, {
    kind: "delivery_failed",
    code: "effect_indeterminate",
    message:
      "This browser began the command before refresh. Reconcile its saved outcome before retrying simulation or save.",
  });
}

function pruneBrowserEffectLedger(now: number): void {
  for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = sessionStorage.key(index);
    if (key === null || !key.startsWith("satyr:bakery-effect:")) continue;
    const raw = parseJsonOrNull(sessionStorage.getItem(key) ?? "");
    if (
      isRecord(raw) &&
      typeof raw.deadlineAt === "number" &&
      raw.deadlineAt <= now
    )
      sessionStorage.removeItem(key);
  }
}
