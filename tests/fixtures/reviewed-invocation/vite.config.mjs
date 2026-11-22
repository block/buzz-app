import { fileURLToPath } from "node:url";

// No ordinary app/broker config, env files, credentials, identity or provider.
export default {
  root: fileURLToPath(new URL("../../../", import.meta.url)),
  envDir: false,
  server: { host: "127.0.0.1", port: 1439, strictPort: true },
  build: {
    outDir: "dist/reviewed-fixture-web",
    rollupOptions: { input: "tests/fixtures/reviewed-invocation/index.html" },
  },
};
