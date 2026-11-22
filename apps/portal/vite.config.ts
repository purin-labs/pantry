import { defineConfig, normalizePath } from "vite";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The shop screen's player answers at /tv, as Workers assets serve tv.html.
  plugins: [
    {
      name: "pantry-tv-page",
      configureServer(server) {
        server.middlewares.use(serveTvPage);
      },
      configurePreviewServer(server) {
        server.middlewares.use(serveTvPage);
      },
    },
    // A browser journey mounts a page from its source files. A file of
    // areas/, foundation/ or packages/ has no fixed address on the dev
    // server: Vite serves it below /@fs/ and the folder of the checkout.
    // /source-url.js gives the address of a source file from its path in the
    // repository. It is the address that the imports of the Portal get, so
    // the journey and the Portal share one instance of the module.
    {
      name: "pantry-source-url",
      apply: "serve",
      configureServer(server) {
        const module = sourceUrlModule(server.config.root);
        server.middlewares.use("/source-url.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript");
          response.end(module);
        });
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
  optimizeDeps: {
    // The scan does not read the voice wake worker. Without this, the first
    // voice start finds the dependency late, and Vite reloads the page.
    include: ["onnxruntime-web/wasm"],
  },
  server: {
    port: 3103,
    strictPort: true,
    allowedHosts: ["example.pantry", "example.portal"],
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy: {
      "/v1": { target: "http://127.0.0.1:3101", ws: true },
    },
  },
});

// Vite gives a file below its root the path from the root, and each other
// file /@fs/ and its real absolute path.
function sourceUrlModule(portalRoot: string): string {
  const real = (path: string) => normalizePath(realpathSync(path));
  const repository = `${real(fileURLToPath(new URL("../../", import.meta.url)))}/`;
  const portal = `${real(portalRoot).slice(repository.length)}/`;
  return `const portal = ${JSON.stringify(portal)};
export function sourceUrl(path) {
  return path.startsWith(portal)
    ? path.slice(portal.length - 1)
    : ${JSON.stringify(`/@fs${repository}`)} + path;
}
`;
}

function serveTvPage(
  request: { url?: string },
  _response: unknown,
  next: () => void,
): void {
  if (request.url === "/tv" || request.url?.startsWith("/tv?") === true)
    request.url = `/tv.html${request.url.slice(3)}`;
  next();
}
