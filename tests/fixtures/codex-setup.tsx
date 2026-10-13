import { PanelSubviewHost } from "../../src/features/panels/PanelSubview";
import type { RelayData } from "../../src/features/relay/service";
import { createRoot } from "react-dom/client";
import type { AgentViewProps } from "../../src/features/agents/service";
import type { Config } from "../../src/bundled/codex/config";
import { createTabs } from "../../src/bundled/codex/tabs";
import { CodexRuntime } from "../../src/bundled/codex/runtime";
import type { Spawn, Wire } from "../../src/bundled/codex/rpc";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";

const partial = new URLSearchParams(location.search).has("partial-history");
const signedOut = new URLSearchParams(location.search).has("signed-out");
const spawn: Spawn = async (_id, options) => {
  if (partial && options?.args?.at(-1) === "isolated")
    throw new Error("Conflicting private configuration file");
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
        wire.method === "thread/list"
          ? { data: [] }
          : wire.method === "thread/turns/list"
            ? {
                data: [
                  {
                    id: "fixture-turn",
                    status: "completed",
                    startedAt: 1,
                    completedAt: 2,
                    items: [
                      {
                        type: "agentMessage",
                        id: "reply",
                        text: "The existing conversation history is available.",
                      },
                    ],
                  },
                ],
                nextCursor: null,
              }
            : wire.method === "account/read"
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
const runtime = new CodexRuntime(
  spawn,
  () =>
    partial
      ? ({
          snapshot: () => ({
            status: "ready",
            session: {
              channels: {
                list: () => ({
                  channels: [{ id: "fixture-channel", name: "Demo channel" }],
                }),
              },
              names: { resolve: () => undefined },
              profiles: { snapshot: () => new Map() },
            },
          }),
        } as unknown as RelayData)
      : undefined,
  partial
    ? ({
        getItem: () =>
          JSON.stringify({
            [JSON.stringify(["fixture-channel", "channel"])]: {
              threadId: "fixture-thread",
              workspace: "/fixture",
            },
          }),
        setItem: () => undefined,
      } as unknown as Storage)
    : undefined,
);
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
    <PanelSubviewHost close={() => undefined}>
      <CodexTab agent={agent} />
    </PanelSubviewHost>
  </main>,
);
