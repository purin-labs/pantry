import {
  openExecutionWorker as openWorker,
  type ExecutionWorker,
} from "@purin-labs/area-kitchen/ui/features/production-run/execution-client";
import { isRecord } from "@purin-labs/std";

export type { ExecutionWorker };

/** Evidence fixtures collect strings for their portable JSON comparisons. */
class CollectingWorker implements ExecutionWorker {
  private readonly collected = new Set<string>();
  constructor(private readonly worker: ExecutionWorker) {}
  get manifest() {
    return this.worker.manifest;
  }
  get artifacts() {
    return this.worker.artifacts;
  }
  terminate(): void {
    this.worker.terminate();
  }
  async request(request: Readonly<Record<string, unknown>>): Promise<unknown> {
    const reply = await this.worker.request(request);
    if (!isRecord(reply) || reply.kind !== "saved") return reply;
    if (!isRecord(reply.document) || !Array.isArray(reply.document.artifacts))
      throw new Error("The saved document has no artifact index.");
    const artifacts = [];
    for (const entry of reply.document.artifacts) {
      if (!isRecord(entry) || typeof entry.digest !== "string")
        throw new Error("The saved document has an invalid artifact entry.");
      const file = this.artifacts.files.get(entry.digest);
      if (file === undefined || this.collected.has(entry.digest)) continue;
      artifacts.push({ ...entry, content: await file.read() });
      this.collected.add(entry.digest);
    }
    return { kind: "saved", document: reply.document, artifacts };
  }
}

export async function openExecutionWorker() {
  const opened = await openWorker();
  return opened.ok
    ? { ok: true as const, value: new CollectingWorker(opened.value) }
    : opened;
}
