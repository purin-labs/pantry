import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3104,
    strictPort: true,
    proxy: {
      // A journey runner may start its own Commerce on another port.
      "/v1":
        process.env.STOREFRONT_COMMERCE_ORIGIN ?? "http://127.0.0.1:3102",
    },
    allowedHosts: [
      "example.cafe",
      "example.store",
      "cafe.localhost",
      "store.localhost",
    ],
  },
});
