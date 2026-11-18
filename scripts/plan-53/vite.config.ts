import { fileURLToPath } from "node:url";
import portalConfig from "../../apps/portal/vite.config";

export default {
  ...portalConfig,
  root: fileURLToPath(new URL("../../apps/portal", import.meta.url)),
  server: {
    ...portalConfig.server,
    host: "127.0.0.1",
    port: 3115,
    strictPort: true,
    hmr: false,
  },
};
