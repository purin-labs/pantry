// Evidence fixtures deliberately collect portable JSON at Save. Product hosts
// persist each acknowledged artifact and keep file references instead.
import assert from "node:assert/strict";

export function collectingExecutionHost(engine, transport) {
  const host = engine.createExecutionHost(transport);
  return engine.HOST_PROTOCOL_VERSION === 1
    ? host
    : new CollectingExecutionHost(host);
}

class CollectingExecutionHost {
  protocolVersion;
  #host;
  #pending = new Map();
  constructor(host) {
    this.#host = host;
    this.protocolVersion = host.protocolVersion;
  }
  async handle(request) {
    const reply = await this.#host.handle(request);
    if (reply.kind === "refused" || reply.kind === "disposed") return reply;
    let acknowledged = null;
    for (;;) {
      const next = await this.#host.handle({ kind: "artifact", acknowledged });
      assert.equal(next.kind, "artifact");
      if (next.artifact === null) break;
      this.#pending.set(next.artifact.digest, next.artifact);
      acknowledged = next.artifact.digest;
    }
    if (reply.kind !== "saved") return reply;
    const artifacts = [...this.#pending.values()];
    this.#pending.clear();
    return { kind: "saved", document: reply.document, artifacts };
  }
}
