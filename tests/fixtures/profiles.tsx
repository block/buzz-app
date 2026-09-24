import { controlFixture } from "../../src/features/agents/control-testing";
// Real ChannelsPage, thread reader, shared directory, panel registry and plugin lifecycle.
// Only the transport is synthetic. No dev broker, saved identity or live relay.
import { StrictMode, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Context } from "@deepseek-ai/cordis";
import { createPluginManager } from "../../src/plugins/manager";
import { bundledPlugins } from "../../src/bundled";
import {
  PanelsService,
  type PanelContext,
  type PanelProps,
} from "../../src/features/panels/service";
import { PagesService } from "../../src/features/pages/service";
import { TemplateProvidersService } from "../../src/features/channel-templates/provider";
import { ChannelWorkspaceFixture } from "./channel-workspace";
import { createRelaySession } from "../../src/features/relay/session";
import { createAgentControl } from "../../src/features/agents/control";
import { provideNavigation } from "../../src/features/navigation/service";
import type {
  RelayData,
  RelaySnapshot,
} from "../../src/features/relay/service";
import {
  bounds,
  keypair,
  message,
  profile,
  roster,
  signed,
  summary,
} from "../../src/features/relay/testing";
import { profileTarget } from "../../src/features/profiles/target";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

const viewer = keypair(),
  authority = keypair(),
  mic = keypair(),
  pinky = keypair(),
  missing = keypair();
const actionsProbe = new URLSearchParams(location.search).has("agent-actions");
const root = message(viewer, "one", "Hello @Mic", 10, [["p", mic.pubkey]]);
const unknown = message(missing, "one", "Unknown author", 11);
const reply = message(viewer, "one", "Thread @Pinky", 12, [
  ["e", root.id, "", "reply"],
  ["p", pinky.pubkey],
]);
const picture = "https://images.test/avatar.png";
const pinkyPicture = "https://images.test/pinky-animated.gif";
const pictureFixture = "/tests/fixtures/design-system/assets/avatar.png";
const pinkyPictureFixture = "/tests/fixtures/design-system/assets/avatar.png";
const report = {
  profileReads: [] as string[][],
  media: [] as [string, "small" | undefined][],
  publications: 0,
  memoryReads: [] as string[],
};
let failMissing = true;
const data = [
  profile(viewer, { name: "Viewer", about: "Human profile", picture }),
  profile(mic, { name: "Mic", about: "Mic biography" }),
  profile(pinky, {
    name: "Pinky",
    about: "Agent profile",
    is_agent: true,
    picture: pinkyPicture,
  }),
];
function session() {
  return createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: authority.pubkey,
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return { update() {}, retry() {}, dispose() {} };
    },
    async readAgentMemories(agent) {
      report.memoryReads.push(agent);
      return {
        partial: false,
        entries: [
          {
            slug: "core",
            body:
              "<script>not executable</script>\n" +
              "long-memory-text".repeat(60),
            eventId: "a".repeat(64),
            createdAt: 1,
          },
        ],
      };
    },
    media: (url, size) => {
      report.media.push([url, size]);
      return url === picture
        ? pictureFixture
        : url === pinkyPicture
          ? pinkyPictureFixture
          : url;
    },
    async query(filters) {
      return filters.flatMap((filter) => {
        if (filter.kinds?.includes(39002))
          return [
            roster(authority, "one", [viewer.pubkey, mic.pubkey, pinky.pubkey]),
            roster(authority, "two", [viewer.pubkey]),
          ];
        if (filter.kinds?.includes(39000))
          return [
            signed(authority, {
              kind: 39000,
              content: JSON.stringify({ name: "One" }),
              tags: [
                ["d", "one"],
                ["name", "One"],
                ["t", "stream"],
              ],
            }),
            signed(authority, {
              kind: 39000,
              content: JSON.stringify({ name: "Two" }),
              tags: [
                ["d", "two"],
                ["name", "Two"],
                ["t", "stream"],
              ],
            }),
          ];
        if (filter.kinds?.includes(30315))
          return filter.authors?.includes(mic.pubkey)
            ? [
                signed(mic, {
                  kind: 30315,
                  content: "In a meeting",
                  tags: [
                    ["d", "general"],
                    ["emoji", "📅"],
                  ],
                }),
              ]
            : [];
        if (filter.kinds?.includes(0)) {
          report.profileReads.push([...(filter.authors ?? [])]);
          if (
            failMissing &&
            filter.authors?.length === 1 &&
            filter.authors[0] === missing.pubkey
          )
            throw new Error("Fixture profile failure");
          return data.filter((event) => filter.authors?.includes(event.pubkey));
        }
        if (filter.ids)
          return [root, unknown, reply].filter((event) =>
            filter.ids?.includes(event.id),
          );
        if (filter.depth_limit) return [reply];
        if (filter.kinds?.includes(9))
          return filter["#h"]?.includes("two")
            ? [
                bounds(authority, "two", "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ]
            : [
                root,
                unknown,
                summary(authority, "one", root.id, {
                  reply_count: 1,
                  participants: [viewer.pubkey],
                }),
                bounds(authority, "one", "head", {
                  has_more: false,
                  next_cursor: null,
                }),
              ];
        return [];
      });
    },
  });
}
let owner = session();
let snapshot: RelaySnapshot = {
  status: "ready",
  generation: 1,
  scope: `https://relay.example.test:${viewer.pubkey}`,
  viewer: viewer.pubkey,
  session: owner.session,
};
const listeners = new Set<() => void>();
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  retry() {},
  disconnect() {},
  clearCache: () => owner.clearCache(),
};
const context = new Context();
context.provide("relay", relay);
const navigationHost = provideNavigation(context, undefined);
const native = controlFixture();
native.agent.pubkey = mic.pubkey;
native.agent.status = "stopped";
native.agent.enabled = false;
let releaseLaunch: (() => void) | undefined;
const commands: string[] = [];
const action = native.host.action;
native.host.action = async (id, command) => {
  commands.push(command);
  if (command === "start" || command === "restart")
    await new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
  return action(id, command);
};
const agentControl = createAgentControl(actionsProbe ? native.host : null);
context.provide("agentControl", agentControl);
context.effect(() => () => agentControl.dispose());
const contexts: PanelContext[] = [];
function ContextProbe({ context }: PanelProps) {
  useLayoutEffect(() => {
    if (context && contexts.at(-1) !== context) contexts.push(context);
  }, [context]);
  return <p>Context probe</p>;
}
const probing = new URLSearchParams(location.search).has("context-probe");
const manager = createPluginManager(context, {
  bundled: probing
    ? [
        {
          manifest: {
            id: "context.probe",
            name: "Context probe",
            apiVersion: 1,
          },
          module: {
            inject: ["panels"],
            apply(ctx) {
              ctx.panels.register({
                id: "probe",
                title: "Context probe",
                matches: (target) => target.startsWith("nostr:"),
                component: ContextProbe,
              });
            },
          },
        },
      ]
    : bundledPlugins.filter(({ manifest }) => manifest.id === "buzz.profiles"),
});
const panels = new PanelsService(context);
const pages = new PagesService(context);
const providers = new TemplateProvidersService(context);
Object.assign(window, {
  profilesFixture: {
    report,
    commands: () => [...commands],
    launchPending: () => !!releaseLaunch,
    finishLaunch: () => {
      releaseLaunch?.();
      releaseLaunch = undefined;
    },
    contexts,
    targets: {
      viewer: profileTarget(viewer.pubkey),
      mic: profileTarget(mic.pubkey),
    },
    disconnect() {
      snapshot = { ...snapshot, status: "disconnected" };
      for (const listener of listeners) listener();
    },
    npubs: Object.fromEntries(
      Object.entries({ viewer, mic, pinky, missing }).map(([name, key]) => [
        name,
        profileTarget(key.pubkey)?.slice(6),
      ]),
    ),
    keys: {
      viewer: viewer.pubkey,
      mic: mic.pubkey,
      pinky: pinky.pubkey,
      missing: missing.pubkey,
    },
    change: manager.change,
    recover() {
      failMissing = false;
      data.push(
        profile(missing, { name: "Recovered", about: "Recovered biography" }),
      );
    },
    replace() {
      owner.dispose();
      owner = session();
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: owner.session,
      };
      for (const listener of listeners) listener();
    },
  },
});
function Fixture() {
  const [dark, setDark] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          document.documentElement.dataset.colorMode = dark ? "light" : "dark";
          setDark(!dark);
        }}
      >
        Toggle appearance
      </button>
      <div style={{ height: "calc(100vh - 50px)", padding: 16 }}>
        <ChannelWorkspaceFixture
          host={navigationHost}
          relay={relay}
          panels={panels}
          pages={pages}
          providers={providers}
        />
      </div>
    </>
  );
}
const element = document.getElementById("root");
if (!element) throw new Error("Missing root");
createRoot(element).render(
  <StrictMode>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </StrictMode>,
);
