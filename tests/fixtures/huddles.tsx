// Local presentation/capture fixture. No identity, relay connection, or remote write.
import { createRoot } from "react-dom/client";
import { useState, useSyncExternalStore } from "react";
import { HuddleCapsule } from "../../src/bundled/huddles/HuddleCapsule";
import { HuddleWindowView } from "../../src/bundled/huddles/HuddleWindowView";
import { ChannelMembersButton } from "../../src/bundled/channels/ChannelMembersDialog";
import { HuddleLauncher } from "../../src/bundled/huddles/HuddleLauncher";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import {
  MagnifyingGlassIcon,
  SlidersHorizontalIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  UserIcon,
  XIcon,
} from "../../src/shared/design-system/icons";
import {
  createHuddleWindow,
  type HuddleView,
  type HuddleWindowAction,
} from "../../src/features/huddle/window";
import { createHuddles } from "../../src/features/huddle/service";
import { openHuddleAudio } from "../../src/features/huddle/audio";
import type {
  HuddleBridge,
  HuddleUpdate,
} from "../../src/features/huddle/bridge";
import { createRelaySession } from "../../src/features/relay/session";
import type { Profile } from "../../src/features/relay/contracts";
import type { RelayData } from "../../src/features/relay/service";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { Button } from "../../src/shared/design-system/ui/Button";
import "../../src/shared/styles/globals.css";

const viewer = "ab".repeat(32),
  peer = "cd".repeat(32);
const destination = {
  scope: `https://fixture.example:${viewer}`,
  relayUrl: "wss://fixture.example",
  viewer,
  channelId: "00000000-0000-4000-8000-000000000001",
  channelName: "Design",
};
const store = createRelaySession(null);
const guestKeys = ["de", "ef", "fa", "bc"].map((key) => key.repeat(32));
const profiles = new Map<string, Profile>([
  [viewer, { name: "Kenneth" }],
  [
    peer,
    {
      name: "Alex",
      picture: "/tests/fixtures/design-system/assets/avatar.png",
    },
  ],
  ...guestKeys.map((key, index): [string, Profile] => [
    key,
    { name: ["Sam", "Jo", "Robin", "Taylor"][index] ?? "Guest" },
  ]),
]);
const dmId = "00000000-0000-4000-8000-000000000003";
const channelList = {
  status: "ready" as const,
  channels: [
    {
      id: destination.channelId,
      name: "Design",
      channelType: "stream" as const,
      members: [viewer, peer],
    },
    {
      id: dmId,
      name: "Alex",
      channelType: "dm" as const,
      members: [viewer, peer],
    },
  ],
};
const session = {
  ...store.session,
  channels: {
    ...store.session.channels,
    list: () => channelList,
  },
  profiles: {
    ...store.session.profiles,
    snapshot: () => profiles,
    ensure: async () => {},
  },
  read: async () => [],
  media: (url: string) => url,
};
const snapshot = {
  status: "ready" as const,
  generation: 1,
  viewer,
  scope: destination.scope,
  session,
};
const relay: RelayData = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
  retry() {},
  disconnect() {},
  async clearCache() {},
};
let receive = (_: HuddleUpdate) => {};
const stats = {
  opens: 0,
  closes: 0,
  frames: 0,
  lastFrameLength: 0,
  audioClosed: 0,
};
let connect = () => {};
const deferConnection = new URLSearchParams(location.search).has(
  "deferConnection",
);
const bridge: HuddleBridge = {
  available: true,
  async open(_id, _context, _room, fn) {
    stats.opens++;
    receive = fn;
    connect = () =>
      fn({
        type: "connected",
        room: "00000000-0000-4000-8000-000000000002",
        participants: [viewer, peer],
      });
    if (!deferConnection) connect();
  },
  async close() {
    stats.closes++;
  },
  async touch() {},
  async send(_id, samples) {
    stats.frames++;
    stats.lastFrameLength = samples.length;
  },
};
const realAudio = new URLSearchParams(location.search).has("audio");
const huddles = createHuddles(relay, bridge, async (...args) => {
  const audio = realAudio
    ? await openHuddleAudio(...args)
    : { mute() {}, play() {}, participants() {}, close() {} };
  return {
    ...audio,
    close() {
      stats.audioClosed++;
      audio.close();
    },
  };
});
let windowView: HuddleView | null = null;
const windowListeners = new Set<() => void>();
const setWindowView = (view: HuddleView | null) => {
  windowView = view;
  for (const listener of windowListeners) listener();
};
let windowAction = (_id: string, _action: HuddleWindowAction) => {};
const companion = createHuddleWindow(huddles, relay, {
  async open(view, act) {
    windowAction = act;
    setWindowView(view);
  },
  async update(id, view) {
    if (windowView?.id === id) setWindowView(view);
  },
});
const closeWindow = () => {
  const id = windowView?.id;
  setWindowView(null);
  if (id) windowAction(id, "closed");
};
declare global {
  interface Window {
    huddleFixture: {
      stats: typeof stats;
      connect(): void;
      participants(keys: string[]): void;
      speak(peer: string, level?: number): void;
      disconnect(error?: string): void;
      dispose(): Promise<void>;
    };
  }
}
window.huddleFixture = {
  stats,
  connect: () => connect(),
  speak: (peer, level = 0.06) =>
    receive({ type: "audio", peer, samples: Array(960).fill(level) }),
  participants: (participants) =>
    receive({ type: "participants", participants }),
  disconnect: (error = "Huddle disconnected. You can join again.") =>
    receive({ type: "ended", error }),
  dispose: async () => {
    await huddles.dispose();
    await companion.dispose();
  },
};
function Fixture() {
  const [dm, setDm] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const view = useSyncExternalStore(
    (listener) => {
      windowListeners.add(listener);
      return () => {
        windowListeners.delete(listener);
      };
    },
    () => windowView,
  );
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "var(--surface-base)",
        padding: 24,
      }}
    >
      <p className="text-caption text-secondary">
        Huddles fixture ·{" "}
        {realAudio ? "local microphone capture" : "simulated call"} · no relay
      </p>
      {
        <header
          className="shell-header"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 12,
            height: 48,
          }}
        >
          <IconButton
            variant="chrome"
            aria-label="Go back"
            icon={<ArrowLeftIcon size={16} />}
          />
          <IconButton
            variant="chrome"
            aria-label="Go forward"
            icon={<ArrowRightIcon size={16} />}
          />
          <HuddleCapsule
            huddles={huddles}
            relay={relay}
            companion={companion}
          />
          <IconButton
            variant="chrome"
            aria-label="Search Buzz"
            icon={<MagnifyingGlassIcon size={16} />}
          />
          <IconButton
            variant="avatar"
            aria-label="Your profile"
            icon={<UserIcon size={16} />}
          />
        </header>
      }
      {view && (
        <aside
          aria-label="Huddle window preview"
          style={{
            maxWidth: 520,
            height: 560,
            margin: "24px auto",
            border: "1px solid var(--border-standard)",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div style={{ position: "absolute", right: 8, top: 8, zIndex: 2 }}>
            <IconButton
              size="toolbar"
              variant="ghost"
              aria-label="Close Huddle window"
              onClick={closeWindow}
              icon={<XIcon size={16} />}
            />
          </div>
          <HuddleWindowView
            view={view}
            act={(action) =>
              action === "mute" ? huddles.mute() : void huddles.leave()
            }
          />
        </aside>
      )}
      <section
        aria-label="Conversation"
        style={{
          marginTop: 24,
          minHeight: 220,
          background: "var(--surface-panel)",
          color: "var(--text-standard)",
        }}
      >
        <header
          style={{ display: "flex", alignItems: "center", gap: 4, padding: 12 }}
        >
          <h2 className="text-label text-primary" style={{ flex: 1 }}>
            {dm ? "Alex" : "Design"}
          </h2>
          <ChannelMembersButton
            session={session}
            channelId={dm ? dmId : destination.channelId}
            open={membersOpen}
            onOpenChange={setMembersOpen}
          />
          <HuddleLauncher
            context={{
              ...destination,
              channelId: dm ? dmId : destination.channelId,
              channelName: dm ? "Alex" : "Design",
            }}
            available={() => true}
            openMembers={() => setMembersOpen(true)}
            huddles={huddles}
            showWindow={companion.open}
          />
          <IconButton
            size="toolbar"
            aria-label="Channel settings"
            icon={<SlidersHorizontalIcon size={16} />}
          />
        </header>
        <p className="text-body text-secondary" style={{ padding: 12 }}>
          The conversation stays open while you talk.
        </p>
        <Button variant="ghost" onClick={() => setDm((value) => !value)}>
          Switch conversation
        </Button>
        {call.phase === "connected" && (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                let frames = 0;
                const speech = setInterval(() => {
                  if (
                    huddles.snapshot().phase !== "connected" ||
                    frames++ >= 30
                  ) {
                    clearInterval(speech);
                    return;
                  }
                  window.huddleFixture.speak(
                    peer,
                    0.035 + Math.abs(Math.sin(frames / 3)) * 0.08,
                  );
                }, 100);
              }}
            >
              Simulate Alex speaking
            </Button>
            <Button
              variant="ghost"
              disabled={guestKeys.every((key) =>
                call.participants.includes(key),
              )}
              onClick={() => {
                const next = guestKeys.find(
                  (key) => !call.participants.includes(key),
                );
                if (next)
                  window.huddleFixture.participants([
                    ...call.participants,
                    next,
                  ]);
              }}
            >
              Simulate someone joining
            </Button>
            <Button
              variant="ghost"
              disabled={call.participants.length <= 2}
              onClick={() =>
                window.huddleFixture.participants(
                  call.participants.slice(0, -1),
                )
              }
            >
              Simulate someone leaving
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ToastProvider>
      <Fixture />
    </ToastProvider>,
  );
