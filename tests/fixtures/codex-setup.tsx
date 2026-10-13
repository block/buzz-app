import { createRoot } from "react-dom/client";
import type { AgentViewProps } from "../../src/features/agents/service";
import type { Config } from "../../src/bundled/codex/config";
import { createTabs } from "../../src/bundled/codex/tabs";
import { CodexRuntime } from "../../src/bundled/codex/runtime";
import type { Spawn, Wire } from "../../src/bundled/codex/rpc";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";

const signedOut = new URLSearchParams(location.search).has("signed-out");
const spawn: Spawn = async (_id, options) => {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  return {
    exited,
    write: async (text) => {
      const wire: Wire = JSON.parse(text);
      if (wire.id == null) return;
      const result =
        wire.method === "account/read"
          ? { account: signedOut ? null : { type: "ChatGPT" } }
          : wire.method === "model/list"
            ? { data: [], nextCursor: null }
            : {};
      options?.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
    },
    end: async () => exit(0),
    kill: async () => exit(0),
  };
};
const runtime = new CodexRuntime(spawn, () => undefined);
const { CodexTab } = createTabs(spawn, runtime);
const agent = {
  pubkey: "fixture",
  name: "Demo agent",
  config: {},
} as AgentViewProps<Config>["agent"];
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <main data-buzz-ui="" className="mx-auto max-w-3xl p-8">
    <CodexTab agent={agent} />
  </main>,
);
