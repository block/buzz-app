import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createServer } from "../../browser/vite-server.mjs";

export async function startServer() {
  const server = await createServer({
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    configFile: false,
    envDir: false,
    plugins: [
      react(),
      {
        name: "native-recovery-recording-entry",
        transform(code, id) {
          if (id.endsWith("/src/main.tsx"))
            return code.replace(
              "const services = createServices();",
              "const services = createServices(); window.recordingServices = services;",
            );
        },
        transformIndexHtml: (html) =>
          html.replace(
            'src="/src/main.tsx"',
            'src="/tests/demos/native-recovery/entry.ts"',
          ),
      },
    ],
    define: {
      "import.meta.env.VITE_BUZZ_LIVE": '"0"',
      "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES": "window.recordingAliases",
    },
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  });
  await server.listen();
  return {
    server,
    url: `http://127.0.0.1:${server.httpServer.address().port}`,
  };
}
