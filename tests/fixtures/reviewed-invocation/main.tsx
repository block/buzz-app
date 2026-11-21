import "../../../src/shared/styles/globals.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationService } from "../../../src/features/conversation/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../../src/features/relay/session";
import type { RelayData } from "../../../src/features/relay/service";
import type { ChannelMessage } from "../../../src/features/relay/contracts";
import { Button } from "../../../src/shared/design-system/ui/Button";
import { TooltipProvider } from "../../../src/shared/design-system/ui/Tooltip";
import { useKeyboardFocusVisibility } from "../../../src/shared/design-system/useKeyboardFocusVisibility";
import { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import {
  HostService,
  type ReviewedInvocationReceipt,
} from "../../../src/features/host/service";
import { createModuleLoader } from "../../../src/plugins/modules";
import { PluginRuntime } from "../../../src/plugins/runtime";
import type { PluginModule } from "../../../src/plugins/api";
import type { StorageResult } from "../../../src/plugins/types";

const status = document.getElementById("status");
if (!status) throw new Error("Fixture status surface is missing");
const root = new Context();
new HostService(root);
const local = createRelaySession(null);
// Synthetic reader identity only: no signer, transport, or relay publication.
const session = Object.freeze({
  ...local.session,
  viewer: "fixture-viewer",
  scope: "fixture-community:fixture-viewer",
}) as RelaySession;
root.provide("relay", {
  snapshot: () => ({ session, origin: "fixture-community" }),
  subscribe: () => () => {},
} as unknown as RelayData);
let conversation: ConversationService;
const container = document.getElementById("card");
if (!container) throw new Error("Fixture card surface is missing");
const react = createRoot(container);
const message = {
  id: "synthetic-message",
  channelId: "fixture-channel",
  content: "Synthetic draft",
  authorId: "ab".repeat(32),
  createdAt: 1,
  replyCount: 0,
  attachments: [],
  mentions: [],
  reactions: [],
  participants: [],
} as unknown as ChannelMessage;
function Card() {
  useKeyboardFocusVisibility();
  const [dark, setDark] = useState(false);
  const [large, setLarge] = useState(false);
  return (
    <div
      data-color-mode={dark ? "dark" : "light"}
      className="bg-panel p-4 text-default"
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setDark(!dark)}>Switch theme</Button>
        <Button
          onClick={() => {
            document.documentElement.style.fontSize = large ? "100%" : "150%";
            setLarge(!large);
          }}
        >
          Change text size
        </Button>
      </div>
      <conversation.ui.Message
        row={message}
        session={session}
        reviewRoot={null}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />
    </div>
  );
}
let loaded:
  | (PluginModule & { result(): Promise<ReviewedInvocationReceipt> })
  | undefined;
const load = createModuleLoader({}, (id, revision) =>
  invoke("plugin_module", { id, revision }),
);
const runtime = new PluginRuntime(root, async (plugin) => {
  const module = (await load(plugin)) as PluginModule & {
    result(): Promise<ReviewedInvocationReceipt>;
  };
  loaded = module;
  return module;
});
conversation = new ConversationService(root);
react.render(
  <StrictMode>
    <TooltipProvider>
      <Card />
    </TooltipProvider>
  </StrictMode>,
);
let observed = false;
runtime.subscribe(() => {
  if (
    !observed &&
    loaded &&
    Object.values(runtime.snapshot()).some((entry) => entry.status === "active")
  ) {
    observed = true;
    status.textContent =
      "Host review requested. Only the Buzz-owned card action may dispatch the synthetic recipient once.";
    void loaded.result().then(
      (receipt) => {
        status.textContent = JSON.stringify(receipt, null, 2);
      },
      () => {
        status.textContent =
          "Refused or consumed with unknown outcome. No retry was attempted.";
      },
    );
  }
});
window.addEventListener(
  "pagehide",
  () => {
    react.unmount();
    local.dispose();
    void runtime.dispose();
  },
  { once: true },
);
try {
  const catalog = await invoke<StorageResult>("plugin_catalog");
  if (catalog.status !== "ready")
    throw new Error("Fixture catalog unavailable");
  const plugins = catalog.catalog.plugins.filter(
    (plugin) =>
      plugin.manifest.id === "example.reviewed-fixture" && plugin.enabled,
  );
  if (plugins.length !== 1)
    throw new Error("Expected one installed fixture plugin");
  runtime.reconcile(plugins);
} catch {
  status.textContent =
    "Fixture setup failed. No review or retry was requested.";
}
