import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The shop screen's player answers at /tv, as Workers assets serve tv.html.
  plugins: [
    {
      name: "satyr-tv-page",
      configureServer(server) {
        server.middlewares.use(serveTvPage);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveTvPage);
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        portal: fileURLToPath(new URL("./index.html", import.meta.url)),
        eagle: fileURLToPath(
          new URL("./eagle-rehearsal.html", import.meta.url),
        ),
        linea: fileURLToPath(
          new URL("./linea-rehearsal.html", import.meta.url),
        ),
        tv: fileURLToPath(new URL("./tv.html", import.meta.url)),
      },
    },
  },
  resolve: {
    // Modular sources keep WebGL renderers out of the 2D workspace.
    alias: [{ find: /^three$/, replacement: "three/src/Three.js" }],
  },
  server: {
    port: 3103,
    strictPort: true,
    allowedHosts: ["example.satyr", "example.portal"],
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy: {
      "/v1": { target: "http://127.0.0.1:3101", ws: true },
    },
  },
});

function serveTvPage(
  request: { url?: string },
  _response: unknown,
  next: () => void,
): void {
  if (request.url === "/tv" || request.url?.startsWith("/tv?") === true)
    request.url = `/tv.html${request.url.slice(3)}`;
  next();
}
