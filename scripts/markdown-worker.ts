import { createRequire } from "node:module";
import type { PluginOption } from "vite";

/** Shared by the production app and production browser-fixture builds. */
export function markdownWorkerPlugins(): PluginOption[] {
  return [
    {
      name: "markdown-worker-entities",
      enforce: "pre",
      resolveId(source: string) {
        if (source !== "decode-named-character-reference") return;
        // The official default export is DOM-free. Resolve only worker
        // bundles; the page keeps its smaller browser entity decoder.
        const require = createRequire(import.meta.url);
        return createRequire(
          require.resolve("mdast-util-from-markdown"),
        ).resolve(source);
      },
    },
  ];
}
