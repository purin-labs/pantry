import { fileURLToPath } from "node:url";
import portalConfig from "../../apps/portal/vite.config";

// The Portal from source, for the Kitchen run journey (Plan 81). Requests to the control
// API go to the journey's own Worker, under the browser's own session.
export default {
  ...portalConfig,
  root: fileURLToPath(new URL("../../apps/portal", import.meta.url)),
  server: {
    ...portalConfig.server,
    host: "127.0.0.1",
    port: 3181,
    strictPort: true,
    hmr: false,
    proxy: {
      "/v1": { target: "http://127.0.0.1:8881", ws: true },
      "/test": { target: "http://127.0.0.1:8881" },
    },
  },
};
