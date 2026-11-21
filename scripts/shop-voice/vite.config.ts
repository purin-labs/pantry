import { fileURLToPath } from "node:url";
import portalConfig from "../../apps/portal/vite.config";
import { safariProbe } from "./safari-probe.mjs";

// The Portal from source, for the voice journey (Plan 82 Phase 2). Requests go to
// the journey's own Worker, under the browser's own session.
const worker = "http://127.0.0.1:8891";

export default {
  ...portalConfig,
  plugins: [
    ...(portalConfig.plugins ?? []),
    ...(process.env.SHOP_VOICE_SAFARI ? [safariProbe({ macPort: 18443 })] : []),
  ],
  root: fileURLToPath(new URL("../../apps/portal", import.meta.url)),
  server: {
    ...portalConfig.server,
    host: "127.0.0.1",
    port: 3191,
    strictPort: true,
    hmr: false,
    proxy: {
      "/v1": { target: worker, ws: true },
      "/test": { target: worker },
      "/shop-voice": { target: worker },
    },
  },
};
