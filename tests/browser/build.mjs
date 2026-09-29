import { fixtureAliases } from "../relay-config.ts";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Playwright owns this worker-scoped build. Only compiled assets are shared;
// each test still owns its server, identities, relay state and browser storage.
export async function buildApp(
  { developmentReact, pluginFixtures, agentManagement },
  use,
) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-browser-build-"));
  try {
    const config = {
      root,
      mode: "production",
      configFile: false,
      envFile: false, // Never read the developer's live identity configuration.
      logLevel: "error",
      plugins: [
        react(),
        ...(pluginFixtures
          ? [
              {
                name: "fixture-installed-plugins",
                transform(code, id) {
                  if (id !== join(root, "src/bundled/index.ts")) return;
                  return `import { fixturePlugins } from ${JSON.stringify(join(root, "tests/browser/plugin-fixtures.tsx"))};\n${code.replace("= [", "= [ ...fixturePlugins,")}`;
                },
              },
            ]
          : []),
      ],
      define: {
        ...(developmentReact ? { "import.meta.env.DEV": "true" } : {}),
        "import.meta.env.VITE_BUZZ_LIVE": '"1"',
        "import.meta.env.VITE_BUZZ_COMMUNITY_ALIASES":
          JSON.stringify(fixtureAliases),
        ...(developmentReact
          ? { "process.env.NODE_ENV": '"development"' }
          : {}),
      },
      build: { outDir: join(directory, "dist"), emptyOutDir: true },
    };
    if (agentManagement)
      config.plugins.push({
        name: "fixture-native-agent-control",
        transform(_code, id) {
          if (id !== join(root, "src/features/agents/control-native.ts"))
            return;
          return `
import { createAgentControl } from "./control";
import { controlFixture } from "./control-testing";
export function nativeAgentControlHost() {
  const fixture = controlFixture();
  fixture.agent.relayUrl = "https://primary.example";
  fixture.agent.pubkey = "2f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01";
  Object.assign(window, { agentManagementFixture: fixture });
  return fixture.host;
}
export function createNativeAgentControl() {
  return createAgentControl(nativeAgentControlHost());
}
`;
        },
      });
    const start = performance.now();
    await build(config);
    await use({ config, durationMs: performance.now() - start });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
