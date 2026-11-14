import { Context } from "@deepseek-ai/cordis";
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ConversationService } from "../../src/features/conversation/service";
import type { PluginModule } from "../../src/plugins/api";
import type { HostPage } from "../../src/features/host/service";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { keypair, message } from "../../src/features/relay/testing";
import * as links from "../../src/bundled/links";
import { LinkPreview } from "../../src/bundled/link-previews/LinkPreview";
import { createLoader } from "../../src/bundled/link-previews/loader";
import { wantsCard } from "../../src/bundled/link-previews/safety";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

// The real timeline, Virtua, slot and bundled card, with a loader made on each
// plugin apply as production does. Only the host's reads are faked, and they
// wait until the test opens the gate.
let open = false;
let opened: () => void = () => {};
let gate = new Promise<void>((resolve) => {
  opened = resolve;
});
const asked: string[] = [];
const pass = async () => {
  if (!open) await gate;
  await new Promise((resolve) => setTimeout(resolve, 20));
};
async function png() {
  const canvas = new OffscreenCanvas(160, 160);
  const draw = canvas.getContext("2d");
  if (draw) {
    draw.fillStyle = "#5b8def";
    draw.fillRect(0, 0, 160, 160);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
const host = {
  readPage: async (url: string): Promise<HostPage> => {
    asked.push(url);
    await pass();
    const n = Number(new URL(url).hostname.match(/\d+/)?.[0] ?? 0);
    if (n % 10 === 4) return { status: 404 };
    return {
      status: 200,
      preview: {
        title: `Story ${n}`,
        siteName: "Example",
        ...(n % 3 === 0
          ? {
              description:
                "A longer description that runs to a second line so the card shows every part it can.",
            }
          : {}),
        ...(n % 4 === 0 ? { image: `https://img${n}.example.com/a.png` } : {}),
      },
    };
  },
  requestBytes: async () => {
    await pass();
    return {
      status: 200,
      headers: { "content-type": "image/png" },
      body: await png(),
    };
  },
};
const previews: PluginModule = {
  inject: ["conversation"],
  apply(ctx) {
    const loader = createLoader(host as never);
    ctx.effect(() => () => loader.stop());
    ctx.conversation.registerLinkPreview({
      id: "web",
      title: "Web page preview",
      matches: wantsCard,
      order: 100,
      component: (props) => <LinkPreview {...props} loader={loader} />,
    });
  },
};
const root = new Context();
const runtime = new PluginRuntime(root, async (plugin) =>
  plugin.manifest.id === "buzz.link-previews" ? previews : links,
);
const conversation = new ConversationService(root);
const plugin = (id: string, name: string) => ({
  manifest: { id, name, apiVersion: 1 as const },
  enabled: true,
  source: "bundled" as const,
  revision: "1",
  previous: null,
  reloadable: false,
  error: null,
});
const enable = (on: boolean) =>
  runtime.reconcile([
    plugin("buzz.links", "Links"),
    ...(on ? [plugin("buzz.link-previews", "Link previews")] : []),
  ]);
enable(true);

const viewer = keypair(),
  relay = keypair();
const OLDER = 40;
const events = Array.from({ length: 160 }, (_, i) =>
  message(
    viewer,
    "links",
    i % 2
      ? `Message ${i}. Plain text between the links.`
      : `Message ${i}. Read https://site${i}.example.com/post${
          i % 6 === 0 ? ` and https://more${i + 1}.example.com/` : ""
        }${i % 8 === 0 ? " with https://github.com/block/buzz-app/pull/1" : ""}`,
    1700000000 + i,
    [],
  ),
);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
let setFrom: (from: number) => void = () => {};
Object.assign(window, {
  linkPreviewScroll: {
    asked,
    release() {
      open = true;
      opened();
    },
    hold() {
      open = false;
      gate = new Promise<void>((resolve) => {
        opened = resolve;
      });
    },
    enable,
    loadOlder: () => setFrom(0),
  },
});

function Timeline() {
  const [from, set] = useState(OLDER);
  setFrom = set;
  const rows = useMemo(
    () => foldMessages("links", relay.pubkey, events.slice(from)),
    [from],
  );
  return (
    <ChannelTimeline
      extensions={conversation}
      scope="link-preview-scroll"
      channelId="links"
      queries={owner.session}
      window={{
        channelId: "links",
        rows,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        error: undefined,
        freshness: "fresh",
      }}
      onOpenLink={() => false}
    />
  );
}
const mount = document.getElementById("root");
if (!mount) throw new Error("Missing fixture root");
createRoot(mount).render(
  <StrictMode>
    <ToastProvider>
      <div
        style={{
          height: 700,
          maxWidth: 1100,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Timeline />
      </div>
    </ToastProvider>
  </StrictMode>,
);
