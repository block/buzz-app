import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [
  root,
  out,
  harness = fileURLToPath(new URL("./benchmark.mjs", import.meta.url)),
] = process.argv.slice(2);
const require = createRequire(
  resolve(process.env.TOOL_ROOT ?? root, "package.json"),
);
const { rolldown } = await import(require.resolve("rolldown"));
const relayPrefix = "../../../src/features/relay/";
const build = await rolldown({
  input: harness,
  platform: "node",
  transform: {
    define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false }) },
  },
  plugins: [
    {
      name: "experiment-source",
      resolveId(id, importer) {
        if (id.startsWith(relayPrefix))
          return resolve(
            root,
            "src/features/relay",
            id.slice(relayPrefix.length),
          );
        if (
          importer?.startsWith(resolve(root, "src")) &&
          !id.startsWith(".") &&
          !id.startsWith("/") &&
          !id.startsWith("node:")
        )
          return require.resolve(id);
      },
    },
  ],
});
await build.write({
  file: out,
  format: "esm",
  sourcemap: true,
  codeSplitting: false,
});
await build.close();
