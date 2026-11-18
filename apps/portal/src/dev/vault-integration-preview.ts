import type { VaultEvent, VaultStoreView } from "@seams/control-api";

/**
 * The Vault store routes for the integrations preview (Plan 79). The token
 * "ops_preview" connects; "ops_two" reaches two vaults and asks to choose.
 * The preview Vault holds no items, so a move has nothing to move.
 */
export function installVaultIntegrationPreview(organisationId: string): void {
  document.cookie = `satyr_control_csrf=preview; path=${window.location.pathname}; SameSite=Strict`;
  const base = `/v1/control/organisations/${organisationId}/vault`;
  let store: VaultStoreView = { kind: "satyr" };
  const events: VaultEvent[] = [];
  const record = (kind: VaultEvent["kind"]): void => {
    events.unshift({
      eventId: crypto.randomUUID().replaceAll("-", ""),
      kind,
      itemId: null,
      itemLabel: null,
      store: "onepassword",
      at: Date.now(),
    });
  };
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      window.location.origin,
    );
    if (!url.pathname.startsWith(`${base}/`)) return original(input, init);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (url.pathname === `${base}/items`)
      return Response.json({ ok: true, store, items: [] });
    if (url.pathname === `${base}/events`)
      return Response.json({ ok: true, events });
    if (url.pathname !== `${base}/store`)
      return Response.json({ error: "not_found" }, { status: 404 });
    if ((init?.method ?? "GET") === "GET")
      return Response.json({
        ok: true,
        store:
          store.kind === "satyr"
            ? store
            : {
                kind: "onepassword",
                vaultTitle: store.vaultTitle,
                connectedAt: store.connectedAt,
              },
      });
    const command = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    if (command.kind === "connect_onepassword") {
      if (command.token !== "ops_preview" && command.token !== "ops_two")
        return Response.json(
          { error: "vault_store_auth_failed" },
          { status: 409 },
        );
      if (command.token === "ops_two" && command.vaultId === null)
        return Response.json({
          ok: true,
          kind: "choose_vault",
          vaults: [
            {
              vaultId: "previewvaultsatyr000000000",
              title: "Seams",
              itemCount: 0,
            },
            {
              vaultId: "previewvaultprivate0000000",
              title: "Private",
              itemCount: 12,
            },
          ],
        });
      store = {
        kind: "onepassword",
        vaultTitle:
          command.vaultId === "previewvaultprivate0000000"
            ? "Private"
            : "Seams",
        connectedAt: Date.now(),
        reachable: true,
      };
      record("store_connected");
      return Response.json({ ok: true, kind: "store", store });
    }
    if (command.kind === "disconnect_onepassword") {
      store = { kind: "satyr" };
      record("store_disconnected");
      return Response.json({ ok: true, kind: "store", store });
    }
    return Response.json({
      ok: true,
      kind: "moved",
      store,
      moved: 0,
      remaining: 0,
    });
  };
}
